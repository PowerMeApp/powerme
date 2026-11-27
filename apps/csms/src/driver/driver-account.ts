/**
 * BE-21 — đăng ký / đăng nhập / làm mới token cho tài xế bằng email + mật khẩu (F-01, UC-ACC-01).
 * Trí viết hỗ trợ Sơn (chủ F-01); Sơn review.
 * BE-30 — đăng nhập bằng email HOẶC số điện thoại + mật khẩu; số điện thoại chuẩn hoá về E.164
 * (`phone-number.ts`) và duy nhất (migration 0017). Không có OTP/SMS hay đăng nhập Google (ADR-0017).
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
 * BE-49 — thu hồi: mọi token mang claim `ver` = `users.token_version` lúc phát (migration 0033;
 * token cũ không có `ver` coi là 0). `authenticateDriver` và `refresh()` so lại với DB mỗi lần.
 * `logout()` tăng `token_version` → mọi access + refresh token đã phát cho tài xế đó bị từ chối ngay
 * (đăng xuất mọi thiết bị; không có bảng refresh token nên không thu hồi riêng từng máy). Khoá tài
 * khoản (account_status ≠ active) cũng có hiệu lực ngay vì mọi request kiểm lại DB. Refresh không
 * xoay vòng (không phát refresh token mới), nên hết 30 ngày phải đăng nhập lại.
 *
 * BE-49 — `updateProfile()` (UC-ACC-02, PATCH /me): đổi họ tên và số điện thoại; email là định danh
 * đăng nhập, chưa có luồng xác minh nên không đổi qua API này.
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
import {
  DEFAULT_DRIVER_REFRESH_TTL_S,
  DriverApiConfig,
  DriverApiError,
  tokenVersionClaim,
} from './driver-auth.js';
import { normalizePhoneNumber } from './phone-number.js';

/** Bằng giới hạn trên của `authenticateDriver` (maxTokenAge 900). */
export const DRIVER_ACCESS_TTL_S = 900;
const REFRESH_TYP = 'refresh+jwt';

/**
 * Giới hạn thử sai đăng nhập: theo định danh (email đã chuẩn hoá, hoặc số E.164 — BE-30) + IP 5 lần
 * / 60 s → khoá 15 phút; theo IP 20 lần / 60 s. Email luôn có `@`, số E.164 không bao giờ có, nên
 * hai loại khoá không đụng nhau; một tài khoản có cả hai định danh thì mỗi định danh đếm riêng (trần
 * theo IP vẫn chung).
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
const LOGIN_KEYS = ['email', 'phone_number', 'password'] as const;
const PROFILE_KEYS = ['full_name', 'phone_number'] as const;
/** Chuỗi số điện thoại dài hơn mức này không thể chuẩn hoá được (phone-number.ts: 32). */
const MAX_PHONE_INPUT = 32;

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

/** Họ tên: trim, 1–100 ký tự (code point), không ký tự điều khiển. Sai → 400 `invalid_input`. */
function checkFullName(raw: unknown): string {
  const fullName = typeof raw === 'string' ? raw.trim() : '';
  if (!fullName || [...fullName].length > 100 || CONTROL.test(fullName))
    throw new DriverApiError(400, 'invalid_input');
  return fullName;
}

/** BE-30: chuỗi số điện thoại → E.164 (phone-number.ts); không nhận ra → 400 `invalid_input`. */
function checkPhone(raw: unknown): string {
  const phone = typeof raw === 'string' ? normalizePhoneNumber(raw) : null;
  if (!phone) throw new DriverApiError(400, 'invalid_input');
  return phone;
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
    const fullName = checkFullName(body['full_name']);
    // BE-30: tuỳ chọn; có thì chuẩn hoá về E.164 (phone-number.ts), không nhận ra → 400.
    const phoneRaw = body['phone_number'];
    const phone = phoneRaw === undefined || phoneRaw === null ? null : checkPhone(phoneRaw);

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
      // BE-30: số đã chuẩn hoá nên `0901…` và `+84901…` là cùng một số; mọi role đều tính.
      if (phone) {
        const phoneTaken = await client.query('SELECT 1 FROM users WHERE phone_number=$1 LIMIT 1', [
          phone,
        ]);
        if (phoneTaken.rowCount) throw new DriverApiError(409, 'phone_taken');
      }
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
      // Hai đăng ký cùng email (hoặc cùng số) chạy song song: bên sau vấp UNIQUE
      // users_email_key / users_phone_number_key (0017).
      const pg = error as { code?: string; constraint?: string };
      if (pg.code === '23505')
        throw new DriverApiError(
          409,
          pg.constraint === 'users_phone_number_key' ? 'phone_taken' : 'email_taken',
        );
      throw error;
    } finally {
      client.release();
    }
    return this.issue(userId, 0);
  }

  /**
   * Body là `{email, password}` (BE-21, giữ nguyên) HOẶC `{phone_number, password}` (BE-30); có cả
   * hai khoá định danh hoặc không có khoá nào → 400 `invalid_input`.
   *
   * Sai định danh và sai mật khẩu cùng trả 401 `invalid_credentials`; khi không có user (hoặc user
   * chưa đặt mật khẩu, hoặc số điện thoại không chuẩn hoá được) vẫn chạy một lần scrypt với hash
   * giả để thời gian xử lý tương đương. Tài khoản không active (F-13) → 403 `account_locked`, chỉ
   * báo SAU khi mật khẩu đúng nên không dùng để dò tài khoản bị khoá. User không phải driver hoặc
   * thiếu dòng `drivers` → 401 như sai.
   */
  async login(body: Record<string, unknown>, ip: string): Promise<DriverTokens> {
    this.assertConfigured();
    onlyKeys(body, LOGIN_KEYS);
    const byEmail = 'email' in body;
    const byPhone = 'phone_number' in body;
    // Đúng MỘT định danh: cả hai hoặc không có cái nào đều là body sai.
    if (byEmail === byPhone) throw new DriverApiError(400, 'invalid_input');
    const raw = byEmail ? body['email'] : body['phone_number'];
    if (typeof raw !== 'string' || typeof body['password'] !== 'string')
      throw new DriverApiError(400, 'invalid_input');
    const password = body['password'];
    if ([...password].length > 128) throw new DriverApiError(401, 'invalid_credentials');
    // `identifier` là khoá của bộ đếm thử sai; `lookup` là giá trị so trong DB (null = chắc chắn
    // không có user, vd số không chuẩn hoá được — vẫn băm giả và tính một lần sai).
    let identifier: string;
    let lookup: string | null;
    if (byEmail) {
      identifier = lookup = raw.trim().toLowerCase();
      if (identifier.length > 254) throw new DriverApiError(401, 'invalid_credentials');
    } else {
      if (raw.length > MAX_PHONE_INPUT) throw new DriverApiError(401, 'invalid_credentials');
      lookup = normalizePhoneNumber(raw);
      identifier = lookup ?? `phone?${raw.trim()}`;
    }

    const lock = this.limiter.check(identifier, ip);
    if (lock.locked) throw new DriverRateLimited(lock.retryAfterS);
    const done = this.limiter.begin(ip);
    try {
      const row =
        lookup === null
          ? undefined
          : (
              await this.db.$client.query<{
                id: string;
                role: string;
                account_status: string;
                password_hash: string | null;
                is_driver: boolean;
                token_version: number;
              }>(
                `SELECT u.id::text AS id,u.role,u.account_status,u.password_hash,u.token_version,
                   (d.user_id IS NOT NULL) AS is_driver
                 FROM users u LEFT JOIN drivers d ON d.user_id=u.id
                 WHERE ${byEmail ? 'u.email' : 'u.phone_number'}=$1`,
                [lookup],
              )
            ).rows[0];
      const ok = await verifyPassword(password, row?.password_hash ?? (await this.dummyHash));
      if (!row?.password_hash || !ok || row.role !== 'driver' || !row.is_driver) {
        this.limiter.recordFailure(identifier, ip);
        throw new DriverApiError(401, 'invalid_credentials');
      }
      this.limiter.recordSuccess(identifier, ip);
      if (row.account_status !== 'active') throw new DriverApiError(403, 'account_locked');
      return this.issue(row.id, row.token_version);
    } finally {
      done();
    }
  }

  /** Refresh token → access token mới (không phát refresh mới). Kiểm lại DB mỗi lần. */
  async refresh(body: Record<string, unknown>): Promise<DriverTokens> {
    this.assertConfigured();
    const { subject, version } = await this.verifyRefresh(body);
    const row = (
      await this.db.$client.query<{
        role: string;
        account_status: string;
        is_driver: boolean;
        token_version: number;
      }>(
        `SELECT u.role,u.account_status,u.token_version,(d.user_id IS NOT NULL) AS is_driver
         FROM users u LEFT JOIN drivers d ON d.user_id=u.id WHERE u.id=$1`,
        [subject],
      )
    ).rows[0];
    if (!row) throw new DriverApiError(401, 'invalid_refresh_token');
    // BE-49: đã đăng xuất (token_version tăng) → refresh token cũ chết như hết hạn.
    if (row.token_version !== version) throw new DriverApiError(401, 'invalid_refresh_token');
    if (row.role !== 'driver' || !row.is_driver) throw new DriverApiError(403, 'forbidden');
    if (row.account_status !== 'active') throw new DriverApiError(403, 'account_locked');
    return this.issue(subject, row.token_version, false);
  }

  /**
   * BE-49 (UC-ACC-05). Body `{refresh_token}` — dùng refresh token chứ không phải access token vì
   * lúc đăng xuất access token (15 phút) thường đã hết hạn. Token hợp lệ → tăng `token_version`:
   * mọi token đã phát cho tài xế này (mọi thiết bị) bị từ chối từ request kế tiếp.
   * Idempotent: token đúng chữ ký nhưng đã bị thu hồi (đăng xuất rồi, gửi lại) → vẫn thành công,
   * không tăng thêm. Token sai chữ ký / sai dạng / hết hạn → 401 `invalid_refresh_token` (app vẫn
   * xoá token cục bộ). Không kiểm account_status: tài khoản bị khoá vẫn đăng xuất được.
   */
  async logout(body: Record<string, unknown>): Promise<void> {
    this.assertConfigured();
    const { subject, version } = await this.verifyRefresh(body);
    // Điều kiện `token_version=$2`: gửi lại / hai lần song song bằng cùng token chỉ tăng một lần.
    await this.db.$client.query(
      `UPDATE users SET token_version=token_version+1,updated_at=now()
       WHERE id=$1 AND token_version=$2`,
      [subject, version],
    );
  }

  /**
   * BE-49 (UC-ACC-02). Body có ít nhất một trong `full_name`, `phone_number`; khoá khác → 400.
   * `phone_number: null` gỡ số (vẫn đăng nhập được bằng email). Số trùng tài khoản khác → 409
   * `phone_taken` (UNIQUE 0017 bắt cả ca hai request song song). Không đổi email.
   * Trả false khi tài xế không còn active (route trả 403 như authenticateDriver).
   */
  async updateProfile(driverId: string, body: Record<string, unknown>): Promise<boolean> {
    onlyKeys(body, PROFILE_KEYS);
    if (Object.keys(body).length === 0) throw new DriverApiError(400, 'invalid_input');
    const sets: string[] = [];
    const params: unknown[] = [driverId];
    if ('full_name' in body) {
      params.push(checkFullName(body['full_name']));
      sets.push(`full_name=$${params.length}`);
    }
    if ('phone_number' in body) {
      const raw = body['phone_number'];
      params.push(raw === null ? null : checkPhone(raw));
      sets.push(`phone_number=$${params.length}`);
    }
    try {
      const updated = await this.db.$client.query(
        `UPDATE users SET ${sets.join(',')},updated_at=now()
         WHERE id=$1 AND role='driver' AND account_status='active'
           AND EXISTS(SELECT 1 FROM drivers d WHERE d.user_id=users.id)`,
        params,
      );
      return updated.rowCount === 1;
    } catch (error) {
      const pg = error as { code?: string; constraint?: string };
      if (pg.code === '23505' && pg.constraint === 'users_phone_number_key')
        throw new DriverApiError(409, 'phone_taken');
      throw error;
    }
  }

  /** Kiểm chữ ký + claim của refresh token; trả `sub` và `ver`. Sai bất cứ gì → 401. */
  private async verifyRefresh(
    body: Record<string, unknown>,
  ): Promise<{ subject: string; version: number }> {
    onlyKeys(body, ['refresh_token']);
    const token = body['refresh_token'];
    if (
      typeof token !== 'string' ||
      token.length > 8192 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
    )
      throw new DriverApiError(401, 'invalid_refresh_token');
    const ttl = this.config.refreshTtlS ?? DEFAULT_DRIVER_REFRESH_TTL_S;
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
      return { subject: payload.sub, version: tokenVersionClaim(payload['ver']) };
    } catch {
      throw new DriverApiError(401, 'invalid_refresh_token');
    }
  }

  private async issue(subject: string, version: number, withRefresh = true): Promise<DriverTokens> {
    const secret = this.config.secret!;
    const now = Math.floor(this.now() / 1000);
    const access = await new SignJWT({ role: 'driver', ver: version })
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
    tokens.refresh_token = await new SignJWT({ token_use: 'refresh', ver: version })
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
