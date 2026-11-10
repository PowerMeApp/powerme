/**
 * BE-21 — đăng ký / đăng nhập / làm mới token cho tài xế bằng email + mật khẩu (F-01, UC-ACC-01).
 * Trí viết hỗ trợ Sơn (chủ F-01); Sơn review.
 *
 * Token phát ra:
 * - access token: HS256, header `typ: JWT`, claim `sub` (users.id dạng chuỗi), `role: driver`,
 *   `iss`/`aud` cấu hình, `iat`, `exp = iat + 900`, `jti`. Đúng những gì `authenticateDriver`
 *   (driver-auth.ts) đang kiểm, nên không phải sửa logic verify.
 * - refresh token: cùng khoá/issuer/audience nhưng header `typ: refresh+jwt`, claim
 *   `token_use: refresh` và KHÔNG có `role`. `authenticateDriver` đòi `typ: JWT` và claim `role`
 *   nên từ chối refresh token; `refresh()` đòi `typ: refresh+jwt` và `token_use: refresh` nên từ
 *   chối access token. Sống `DRIVER_API_REFRESH_TTL_S` (mặc định 30 ngày).
 *
 * Không có bảng refresh token: không thu hồi được từng token. Logout = app xoá token; khoá tài khoản
 * (account_status ≠ active) có hiệu lực ngay vì `refresh()` và mọi request kiểm lại DB. Refresh không
 * xoay vòng (không phát refresh token mới), nên hết 30 ngày phải đăng nhập lại — tránh phiên kéo dài
 * vô hạn khi chưa có cách thu hồi.
 *
 * Mật khẩu băm bằng scrypt dùng lại `charge-point-credential.ts` (định dạng `scrypt$N$r$p$salt$hash`,
 * ADR-0011). Không log mật khẩu, hash hay token; response không bao giờ chứa hash.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import type { Db } from '../db/db.module.js';
import {
  hashChargePointPassword as hashPassword,
  verifyChargePointPassword as verifyPassword,
} from '../stations/charge-point-credential.js';
import {
  ChargePointLoginLimiter,
  type ChargePointLoginLimits,
} from '../stations/charge-point-login-limiter.js';
import { DEFAULT_DRIVER_REFRESH_TTL_S, DriverApiConfig, DriverApiError } from './driver-auth.js';

/** Bằng giới hạn trên của `authenticateDriver` (maxTokenAge 900). */
export const DRIVER_ACCESS_TTL_S = 900;
const REFRESH_TYP = 'refresh+jwt';

/**
 * Giới hạn thử sai đăng nhập: theo email + IP 5 lần / 60 s → khoá 15 phút; theo IP 20 lần / 60 s.
 * Trong bộ nhớ một tiến trình (giống trụ sạc, ADR-0002): khởi động lại là mất, nhiều instance thì
 * mỗi instance đếm riêng — chuyển sang Redis khi chạy nhiều instance.
 */
export const DRIVER_LOGIN_LIMITS: ChargePointLoginLimits = {
  perSerial: { maxFailures: 5, windowMs: 60_000, lockMs: 15 * 60_000 },
  perIp: { maxFailures: 20, windowMs: 60_000, lockMs: 15 * 60_000 },
};

export interface DriverTokens {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
  refresh_expires_in?: number;
}

/** 429 mang theo số giây chờ để route đặt Retry-After đúng. */
export class DriverRateLimited extends DriverApiError {
  constructor(readonly retryAfterS: number) {
    super(429, 'too_many_attempts');
  }
}

const REGISTER_KEYS = [
  'email',
  'password',
  'full_name',
  'phone_number',
  'consent_version',
  'consent',
] as const;
const CONTROL = /[\u0000-\u001f\u007f]/;

function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]) {
  for (const key of Object.keys(body))
    if (!allowed.includes(key)) throw new DriverApiError(400, 'invalid_input');
}

/** trim + lowercase; độ dài theo RFC 5321 (254 tổng, 64 phần trước @). */
export function normalizeEmail(raw: unknown): string {
  if (typeof raw !== 'string') throw new DriverApiError(400, 'invalid_email');
  const email = raw.trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (
    email.length > 254 ||
    at < 1 ||
    at > 64 ||
    CONTROL.test(email) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@.]+$/.test(email)
  )
    throw new DriverApiError(400, 'invalid_email');
  return email;
}

/** 8–128 ký tự (đếm theo code point); không ép quy tắc chữ hoa / số / ký hiệu. */
function checkPassword(raw: unknown): string {
  if (typeof raw !== 'string') throw new DriverApiError(400, 'invalid_password');
  const length = [...raw].length;
  if (length < 8 || length > 128) throw new DriverApiError(400, 'invalid_password');
  return raw;
}

export class DriverAccounts {
  /** Hash giả cho lượt đăng nhập không có user — tính sẵn một lần để mọi lượt tốn như nhau. */
  private readonly dummyHash = hashPassword(randomBytes(18).toString('base64url'));

  constructor(
    private readonly db: Db,
    private readonly config: DriverApiConfig,
    private readonly limiter = new ChargePointLoginLimiter(DRIVER_LOGIN_LIMITS),
    private readonly now: () => number = Date.now,
  ) {}

  /** Thiếu khoá/issuer/audience → 503 `auth_unavailable`, giống `authenticateDriver`. */
  assertConfigured(): void {
    if (!this.config.secret || !this.config.issuer || !this.config.audience)
      throw new DriverApiError(503, 'auth_unavailable');
  }

  /**
   * UC-ACC-01. BR-P05: không có `consent: true` thì 400 trước khi đọc gì khác và không ghi gì.
   * Một transaction: `users` (role driver, active) + `drivers` (consent). Không tạo ví credit /
   * loyalty ở đây: SRS không yêu cầu, và `CreditLedgerService.ensureAccounts` tạo idempotent khi
   * cần (chưa có ví thì start/Authorize từ chối đúng như số dư 0).
   */
  async register(body: Record<string, unknown>, ip: string): Promise<DriverTokens> {
    this.assertConfigured();
    onlyKeys(body, REGISTER_KEYS);
    if (body['consent'] !== true) throw new DriverApiError(400, 'consent_required');
    const consentVersion = body['consent_version'];
    if (typeof consentVersion !== 'string' || !/^[A-Za-z0-9._-]{1,20}$/.test(consentVersion))
      throw new DriverApiError(400, 'consent_required');
    const email = normalizeEmail(body['email']);
    const password = checkPassword(body['password']);
    const fullNameRaw = body['full_name'];
    const fullName = typeof fullNameRaw === 'string' ? fullNameRaw.trim() : '';
    if (!fullName || [...fullName].length > 100 || CONTROL.test(fullName))
      throw new DriverApiError(400, 'invalid_input');
    const phoneRaw = body['phone_number'];
    if (phoneRaw !== undefined && phoneRaw !== null) {
      if (typeof phoneRaw !== 'string' || !/^\+[1-9][0-9]{6,14}$/.test(phoneRaw))
        throw new DriverApiError(400, 'invalid_input');
    }
    const phone = typeof phoneRaw === 'string' ? phoneRaw : null;

    // Băm scrypt tốn CPU: dùng chung trần "đang xử lý" theo IP của limiter đăng nhập.
    const lock = this.limiter.check(email, ip);
    if (lock.locked) throw new DriverRateLimited(lock.retryAfterS);
    const done = this.limiter.begin(ip);
    let passwordHash: string;
    try {
      passwordHash = await hashPassword(password);
    } finally {
      done();
    }

    const client = await this.db.$client.connect();
    let userId: string;
    try {
      await client.query('BEGIN');
      // Email cũ (seed) có thể còn hoa/thường lẫn lộn; email mới luôn đã chuẩn hoá.
      const taken = await client.query('SELECT 1 FROM users WHERE lower(email)=$1 LIMIT 1', [
        email,
      ]);
      if (taken.rowCount) throw new DriverApiError(409, 'email_taken');
      userId = (
        await client.query<{ id: string }>(
          `INSERT INTO users(email,full_name,phone_number,role,account_status,password_hash)
           VALUES($1,$2,$3,'driver','active',$4) RETURNING id::text AS id`,
          [email, fullName, phone, passwordHash],
        )
      ).rows[0]!.id;
      await client.query(
        'INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,$2,now())',
        [userId, consentVersion],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      // Hai đăng ký cùng email chạy song song: bên sau vấp UNIQUE users_email_key.
      if ((error as { code?: string }).code === '23505')
        throw new DriverApiError(409, 'email_taken');
      throw error;
    } finally {
      client.release();
    }
    return this.issue(userId);
  }

  /**
   * Sai email và sai mật khẩu cùng trả 401 `invalid_credentials`; khi không có user (hoặc user
   * chưa đặt mật khẩu) vẫn chạy một lần scrypt với hash giả để thời gian xử lý tương đương.
   * Tài khoản không active (F-13) → 403 `account_locked`, chỉ báo SAU khi mật khẩu đúng nên không
   * dùng để dò tài khoản bị khoá. User không phải driver hoặc thiếu dòng `drivers` → 401 như sai.
   */
  async login(body: Record<string, unknown>, ip: string): Promise<DriverTokens> {
    this.assertConfigured();
    onlyKeys(body, ['email', 'password']);
    if (typeof body['email'] !== 'string' || typeof body['password'] !== 'string')
      throw new DriverApiError(400, 'invalid_input');
    const email = body['email'].trim().toLowerCase();
    const password = body['password'];
    if (email.length > 254 || [...password].length > 128)
      throw new DriverApiError(401, 'invalid_credentials');

    const lock = this.limiter.check(email, ip);
    if (lock.locked) throw new DriverRateLimited(lock.retryAfterS);
    const done = this.limiter.begin(ip);
    try {
      const row = (
        await this.db.$client.query<{
          id: string;
          role: string;
          account_status: string;
          password_hash: string | null;
          is_driver: boolean;
        }>(
          `SELECT u.id::text AS id,u.role,u.account_status,u.password_hash,
             (d.user_id IS NOT NULL) AS is_driver
           FROM users u LEFT JOIN drivers d ON d.user_id=u.id WHERE u.email=$1`,
          [email],
        )
      ).rows[0];
      const ok = await verifyPassword(password, row?.password_hash ?? (await this.dummyHash));
      if (!row?.password_hash || !ok || row.role !== 'driver' || !row.is_driver) {
        this.limiter.recordFailure(email, ip);
        throw new DriverApiError(401, 'invalid_credentials');
      }
      this.limiter.recordSuccess(email, ip);
      if (row.account_status !== 'active') throw new DriverApiError(403, 'account_locked');
      return this.issue(row.id);
    } finally {
      done();
    }
  }

  /** Refresh token → access token mới (không phát refresh mới). Kiểm lại DB mỗi lần. */
  async refresh(body: Record<string, unknown>): Promise<DriverTokens> {
    this.assertConfigured();
    onlyKeys(body, ['refresh_token']);
    const token = body['refresh_token'];
    if (
      typeof token !== 'string' ||
      token.length > 8192 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
    )
      throw new DriverApiError(401, 'invalid_refresh_token');
    const ttl = this.config.refreshTtlS ?? DEFAULT_DRIVER_REFRESH_TTL_S;
    let subject: string;
    try {
      const { payload } = await jwtVerify(token, this.config.secret!, {
        algorithms: ['HS256'],
        typ: REFRESH_TYP,
        issuer: this.config.issuer!,
        audience: this.config.audience!,
        requiredClaims: ['sub', 'exp', 'iat', 'token_use'],
        maxTokenAge: ttl,
        clockTolerance: 0,
        currentDate: new Date(this.now()),
      });
      if (
        payload.token_use !== 'refresh' ||
        payload.role !== undefined ||
        typeof payload.sub !== 'string' ||
        !/^[1-9][0-9]{0,18}$/.test(payload.sub) ||
        !Number.isSafeInteger(payload.exp) ||
        !Number.isSafeInteger(payload.iat) ||
        payload.exp! - payload.iat! > ttl
      )
        throw new Error('claims');
      subject = payload.sub;
    } catch {
      throw new DriverApiError(401, 'invalid_refresh_token');
    }
    const row = (
      await this.db.$client.query<{ role: string; account_status: string; is_driver: boolean }>(
        `SELECT u.role,u.account_status,(d.user_id IS NOT NULL) AS is_driver
         FROM users u LEFT JOIN drivers d ON d.user_id=u.id WHERE u.id=$1`,
        [subject],
      )
    ).rows[0];
    if (!row) throw new DriverApiError(401, 'invalid_refresh_token');
    if (row.role !== 'driver' || !row.is_driver) throw new DriverApiError(403, 'forbidden');
    if (row.account_status !== 'active') throw new DriverApiError(403, 'account_locked');
    return this.issue(subject, false);
  }

  private async issue(subject: string, withRefresh = true): Promise<DriverTokens> {
    const secret = this.config.secret!;
    const now = Math.floor(this.now() / 1000);
    const access = await new SignJWT({ role: 'driver' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(subject)
      .setIssuer(this.config.issuer!)
      .setAudience(this.config.audience!)
      .setIssuedAt(now)
      .setExpirationTime(now + DRIVER_ACCESS_TTL_S)
      .setJti(randomUUID())
      .sign(secret);
    const tokens: DriverTokens = {
      access_token: access,
      token_type: 'Bearer',
      expires_in: DRIVER_ACCESS_TTL_S,
    };
    if (!withRefresh) return tokens;
    const ttl = this.config.refreshTtlS ?? DEFAULT_DRIVER_REFRESH_TTL_S;
    tokens.refresh_token = await new SignJWT({ token_use: 'refresh' })
      .setProtectedHeader({ alg: 'HS256', typ: REFRESH_TYP })
      .setSubject(subject)
      .setIssuer(this.config.issuer!)
      .setAudience(this.config.audience!)
      .setIssuedAt(now)
      .setExpirationTime(now + ttl)
      .setJti(randomUUID())
      .sign(secret);
    tokens.refresh_expires_in = ttl;
    return tokens;
  }
}
