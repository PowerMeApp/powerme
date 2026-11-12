/**
 * BE-21 — đăng ký / đăng nhập / làm mới token tài xế qua HTTP thật trên Postgres riêng.
 * BE-30 — đăng ký có số điện thoại (chuẩn hoá E.164, 409 `phone_taken`) và đăng nhập bằng số.
 * Chạy bằng `npm run test:driver-discovery -w @powerme/csms` (runner tạo DB mới cho mỗi suite).
 */
import { randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';
import { Logger } from '@nestjs/common';
import { loadConfig, type CsmsConfig } from '../src/config.js';
import { ConsoleServer } from '../src/console/console.server.js';
import { ConsoleQueries } from '../src/console/console.queries.js';
import { ConsoleCommands } from '../src/console/console.commands.js';
import { createDb, type Db } from '../src/db/db.module.js';
import { DriverAccounts } from '../src/driver/driver-account.js';
import { ConnectionRegistry } from '../src/ocpp-gateway/connection-registry.js';
import { ChargeSettlementService } from '../src/sessions/charge-settlement.service.js';
import { loadChargePolicy } from '../src/sessions/charge-policy.config.js';
import { DriverChargingService } from '../src/sessions/driver-charging.service.js';
import { migrate } from './helpers/apply-migrations.js';

const url = process.env['MB03_TEST_DATABASE_URL'];
const describeDb = url ? describe : describe.skip;
const secret = randomBytes(32);
const issuer = 'powerme-be21-test';
const audience = 'powerme-driver-test';
const PASSWORD = 'mat-khau-dai-9';

describeDb('BE-21 driver register / login / refresh over HTTP and dedicated Postgres', () => {
  let db: Db;
  let server: ConsoleServer;
  let config: CsmsConfig;
  let base: string;
  const output: string[] = [];
  const spies: jest.SpyInstance[] = [];
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows;

  async function post(
    route: string,
    body: unknown,
    headers: Record<string, string> = { 'Content-Type': 'application/json' },
    method = 'POST',
  ) {
    const response = await fetch(`${base}/api/driver/v1/auth/${route}`, {
      method,
      headers,
      ...(method === 'GET' || method === 'HEAD'
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    return { response, text, body: text ? (JSON.parse(text) as any) : null };
  }
  async function me(token: string) {
    const response = await fetch(`${base}/api/driver/v1/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { response, body: (await response.json()) as any };
  }
  const registration = (email: string, extra: Record<string, unknown> = {}) => ({
    email,
    password: PASSWORD,
    full_name: 'Tài Xế Thử',
    consent_version: 'tos-2026-11',
    consent: true,
    ...extra,
  });

  beforeAll(async () => {
    if (!url) throw new Error('Missing test database');
    const parsed = new URL(url);
    if (
      process.env['MB03_TEST_ALLOW_EMPTY_DATABASE'] !== 'true' ||
      !['127.0.0.1', '[::1]'].includes(parsed.hostname) ||
      !/^\/powerme_mb03_driver_test_\d+_[a-f0-9]{8}$/.test(parsed.pathname)
    )
      throw new Error('Requires explicit opt-in and a new isolated MB03 loopback test database');
    Logger.overrideLogger(['error']);
    db = createDb(url);
    if ((await q("SELECT to_regclass('public.users') AS table_name"))[0]?.table_name)
      throw new Error('Test database must be new and empty; never reset user data');
    await migrate(db.$client);
    config = {
      ...loadConfig({
        DATABASE_URL: url,
        DRIVER_API_JWT_SECRET_BASE64: secret.toString('base64'),
        DRIVER_API_JWT_ISSUER: issuer,
        DRIVER_API_JWT_AUDIENCE: audience,
      }),
      consolePort: 0,
    };
    const registry = new ConnectionRegistry(db);
    const policy = loadChargePolicy({});
    server = new ConsoleServer(
      config,
      new ConsoleQueries(db, config, registry),
      new ConsoleCommands(db, registry),
      db,
      new DriverChargingService(db, registry, new ChargeSettlementService(db, policy), policy),
    );
    await server.start();
    base = `http://127.0.0.1:${server.port}`;
    // Bắt mọi thứ in ra để kiểm không có mật khẩu / hash / token trong log.
    for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write.bind(stream);
      spies.push(
        jest.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
          output.push(String(chunk));
          return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
        }) as typeof stream.write),
      );
    }
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const)
      spies.push(
        jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          output.push(args.map(String).join(' '));
        }),
      );
  });
  afterAll(async () => {
    for (const spy of spies) spy.mockRestore();
    await server?.stop();
    await db?.$client.end();
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
  });

  it('registers a driver with consent and the access token works at once on /me', async () => {
    const { response, body, text } = await post(
      'register',
      registration('  Tai.Xe@Example.INVALID ', { phone_number: '+84901234567' }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(Object.keys(body).sort()).toEqual(
      ['access_token', 'expires_in', 'refresh_expires_in', 'refresh_token', 'token_type'].sort(),
    );
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 900 });
    expect(body.refresh_expires_in).toBe(30 * 24 * 3600);
    const [row] = await q(
      `SELECT u.id::text AS id,u.email,u.role,u.account_status,u.phone_number,u.password_hash,
        d.consent_version,d.consent_given_at
       FROM users u JOIN drivers d ON d.user_id=u.id WHERE u.email='tai.xe@example.invalid'`,
    );
    expect(row).toMatchObject({
      role: 'driver',
      account_status: 'active',
      phone_number: '+84901234567',
      consent_version: 'tos-2026-11',
    });
    expect(row!.consent_given_at).toBeInstanceOf(Date);
    expect(String(row!.password_hash)).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(String(row!.password_hash));
    // Không tạo ví ở bước đăng ký (ghi chú thiết kế trong driver-account.ts).
    expect(await q('SELECT 1 FROM credit_accounts WHERE driver_id=$1', [row!.id])).toHaveLength(0);
    const profile = await me(body.access_token);
    expect(profile.response.status).toBe(200);
    expect(profile.body).toMatchObject({
      user_id: row!.id,
      full_name: 'Tài Xế Thử',
      role: 'driver',
      account_status: 'active',
      vehicles: [],
    });
  });

  it('rejects registration without consent and stores nothing (BR-P05)', async () => {
    const before = (await q('SELECT count(*)::int AS n FROM users'))[0]!.n;
    for (const consent of [undefined, false, 'true', 1]) {
      const body = registration('no-consent@example.invalid', { consent });
      if (consent === undefined) delete (body as Record<string, unknown>)['consent'];
      const res = await post('register', body);
      expect([res.response.status, res.body.error]).toEqual([400, 'consent_required']);
    }
    const missingVersion = registration('no-consent@example.invalid');
    delete (missingVersion as Record<string, unknown>)['consent_version'];
    expect((await post('register', missingVersion)).body.error).toBe('consent_required');
    expect((await q('SELECT count(*)::int AS n FROM users'))[0]!.n).toBe(before);
    expect(await q("SELECT 1 FROM users WHERE email='no-consent@example.invalid'")).toHaveLength(0);
  });

  it('returns 409 email_taken for a duplicate email in any letter case', async () => {
    const res = await post('register', registration('TAI.XE@example.invalid'));
    expect([res.response.status, res.body]).toEqual([
      409,
      { error: 'email_taken', detail: 'email_taken' },
    ]);
    expect(await q("SELECT 1 FROM users WHERE lower(email)='tai.xe@example.invalid'")).toHaveLength(
      1,
    );
  });

  it('validates password length, email, phone, name and unknown fields', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [registration('short@example.invalid', { password: 'ngan7ky' }), 'invalid_password'],
      [registration('long@example.invalid', { password: 'x'.repeat(129) }), 'invalid_password'],
      [registration('khong-co-a-cong'), 'invalid_email'],
      [registration('phone@example.invalid', { phone_number: '901234567' }), 'invalid_input'],
      [registration('phone@example.invalid', { phone_number: 'goi-cho-toi' }), 'invalid_input'],
      [registration('phone@example.invalid', { phone_number: 84901234567 }), 'invalid_input'],
      [
        registration('phone@example.invalid', { phone_number: '+8490123456789012' }),
        'invalid_input',
      ],
      [registration('name@example.invalid', { full_name: '   ' }), 'invalid_input'],
      [registration('extra@example.invalid', { role: 'admin' }), 'invalid_input'],
    ];
    for (const [body, code] of cases) {
      const res = await post('register', body);
      expect([res.response.status, res.body.error]).toEqual([400, code]);
    }
    expect(
      (await post('register', registration('eight@example.invalid', { password: '12345678' })))
        .response.status,
    ).toBe(201);
  });

  it('logs in with the right password; wrong password and unknown email get the same 401', async () => {
    const ok = await post('login', { email: ' TAI.XE@example.invalid', password: PASSWORD });
    expect(ok.response.status).toBe(200);
    expect(ok.body).toMatchObject({ token_type: 'Bearer', expires_in: 900 });
    expect((await me(ok.body.access_token)).response.status).toBe(200);
    const wrongPassword = await post('login', {
      email: 'tai.xe@example.invalid',
      password: 'sai-mat-khau',
    });
    const unknownEmail = await post('login', {
      email: 'khong-ton-tai@example.invalid',
      password: PASSWORD,
    });
    for (const res of [wrongPassword, unknownEmail]) {
      expect(res.response.status).toBe(401);
      expect(res.body).toEqual({ error: 'invalid_credentials', detail: 'invalid_credentials' });
      expect(res.response.headers.get('www-authenticate')).toBe('Bearer');
    }
  });

  it('refuses login and refresh for a locked account (F-13) and for non-driver users', async () => {
    const reg = await post('register', registration('khoa@example.invalid'));
    const id = (await me(reg.body.access_token)).body.user_id;
    await q("UPDATE users SET account_status='suspended' WHERE id=$1", [id]);
    const login = await post('login', { email: 'khoa@example.invalid', password: PASSWORD });
    expect([login.response.status, login.body.error]).toEqual([403, 'account_locked']);
    // Sai mật khẩu vẫn chỉ là invalid_credentials: không dò được tài khoản bị khoá.
    const wrong = await post('login', { email: 'khoa@example.invalid', password: 'sai-mat-khau' });
    expect([wrong.response.status, wrong.body.error]).toEqual([401, 'invalid_credentials']);
    const refresh = await post('refresh', { refresh_token: reg.body.refresh_token });
    expect([refresh.response.status, refresh.body.error]).toEqual([403, 'account_locked']);
    expect((await me(reg.body.access_token)).response.status).toBe(403);
    await q("UPDATE users SET account_status='active' WHERE id=$1", [id]);
    expect((await post('refresh', { refresh_token: reg.body.refresh_token })).response.status).toBe(
      200,
    );
    // Operator có mật khẩu không đăng nhập được qua Driver API.
    await q("UPDATE users SET role='operator_staff' WHERE id=$1", [id]);
    const op = await post('login', { email: 'khoa@example.invalid', password: PASSWORD });
    expect([op.response.status, op.body.error]).toEqual([401, 'invalid_credentials']);
    const opRefresh = await post('refresh', { refresh_token: reg.body.refresh_token });
    expect([opRefresh.response.status, opRefresh.body.error]).toEqual([403, 'forbidden']);
  });

  it('keeps refresh and access tokens apart and refresh issues a fresh access token only', async () => {
    const login = await post('login', { email: 'tai.xe@example.invalid', password: PASSWORD });
    const { access_token: access, refresh_token: refreshToken } = login.body;
    const asAccess = await me(refreshToken);
    expect([asAccess.response.status, asAccess.body.error]).toEqual([401, 'unauthorized']);
    const asRefresh = await post('refresh', { refresh_token: access });
    expect([asRefresh.response.status, asRefresh.body.error]).toEqual([
      401,
      'invalid_refresh_token',
    ]);
    const refreshed = await post('refresh', { refresh_token: refreshToken });
    expect(refreshed.response.status).toBe(200);
    expect(Object.keys(refreshed.body).sort()).toEqual(
      ['access_token', 'expires_in', 'token_type'].sort(),
    );
    expect((await me(refreshed.body.access_token)).response.status).toBe(200);
    // Refresh token ký bằng khoá khác, hoặc giả typ JWT kèm role, đều bị từ chối.
    const now = Math.floor(Date.now() / 1000);
    const forged = await new SignJWT({ token_use: 'refresh' })
      .setProtectedHeader({ alg: 'HS256', typ: 'refresh+jwt' })
      .setSubject('1')
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(randomBytes(32));
    const wrongTyp = await new SignJWT({ token_use: 'refresh', role: 'driver' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('1')
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(secret);
    for (const token of [forged, wrongTyp, 'not-a-jwt', 42]) {
      const res = await post('refresh', { refresh_token: token });
      expect([res.response.status, res.body.error]).toEqual([401, 'invalid_refresh_token']);
    }
  });

  it('rejects expired access and refresh tokens', async () => {
    // Cùng cấu hình nhưng đồng hồ lùi 31 ngày: token phát ra đã hết hạn theo giờ thật.
    const past = new DriverAccounts(
      db,
      config.driverApi!,
      undefined,
      () => Date.now() - 31 * 24 * 3600 * 1000,
    );
    const old = await past.login(
      { email: 'tai.xe@example.invalid', password: PASSWORD },
      'test-clock',
    );
    expect((await me(old.access_token)).response.status).toBe(401);
    const res = await post('refresh', { refresh_token: old.refresh_token });
    expect([res.response.status, res.body.error]).toEqual([401, 'invalid_refresh_token']);
  });

  it('locks email + IP after 5 failed logins with 429, even for the right password', async () => {
    await post('register', registration('do-mat-khau@example.invalid'));
    for (let i = 0; i < 5; i++) {
      const res = await post('login', {
        email: 'do-mat-khau@example.invalid',
        password: `sai-${i}-mat-khau`,
      });
      expect(res.response.status).toBe(401);
    }
    const locked = await post('login', {
      email: 'do-mat-khau@example.invalid',
      password: PASSWORD,
    });
    expect([locked.response.status, locked.body.error]).toEqual([429, 'too_many_attempts']);
    expect(Number(locked.response.headers.get('retry-after'))).toBeGreaterThan(800);
    // Email khác từ cùng IP vẫn đăng nhập được (khoá theo email + IP, ngưỡng IP là 20).
    expect(
      (await post('login', { email: 'tai.xe@example.invalid', password: PASSWORD })).response
        .status,
    ).toBe(200);
  });

  describe('BE-30 — số điện thoại', () => {
    const PHONE_PASSWORD = 'Demo-password-0001';
    let phoneDriverId: string;

    it('đăng ký với số ở nhiều dạng → lưu E.164', async () => {
      const cases: [string, string, string][] = [
        ['sdt.a@example.invalid', '0912 345 678', '+84912345678'],
        ['sdt.b@example.invalid', '84912.345.679', '+84912345679'],
        ['sdt.c@example.invalid', '+84-912-345-670', '+84912345670'],
        ['sdt.d@example.invalid', '+1 415 555 0123', '+14155550123'],
      ];
      for (const [email, phone, stored] of cases) {
        const res = await post(
          'register',
          registration(email, { phone_number: phone, password: PHONE_PASSWORD }),
        );
        expect(res.response.status).toBe(201);
        const [row] = await q('SELECT id::text AS id, phone_number FROM users WHERE email=$1', [
          email,
        ]);
        expect(row!.phone_number).toBe(stored);
        if (email === 'sdt.a@example.invalid') phoneDriverId = String(row!.id);
      }
      // null và không gửi đều là "không có số".
      expect(
        (await post('register', registration('sdt.null@example.invalid', { phone_number: null })))
          .response.status,
      ).toBe(201);
      expect(
        (await q("SELECT phone_number FROM users WHERE email='sdt.null@example.invalid'"))[0]!
          .phone_number,
      ).toBeNull();
    });

    it('số đã có người dùng (khác định dạng) → 409 phone_taken, không ghi gì', async () => {
      const before = (await q('SELECT count(*)::int AS n FROM users'))[0]!.n;
      for (const phone of ['0912345678', '+84 912 345 678', '84912345678', '+840912345678']) {
        const res = await post(
          'register',
          registration('sdt.trung@example.invalid', { phone_number: phone }),
        );
        expect([res.response.status, res.body]).toEqual([
          409,
          { error: 'phone_taken', detail: 'phone_taken' },
        ]);
      }
      // Email trùng được báo trước số trùng.
      const both = await post(
        'register',
        registration('SDT.A@example.invalid', { phone_number: '0912345678' }),
      );
      expect([both.response.status, both.body.error]).toEqual([409, 'email_taken']);
      expect((await q('SELECT count(*)::int AS n FROM users'))[0]!.n).toBe(before);
    });

    it('hai đăng ký cùng số chạy song song: đúng một 201, bên kia 409 phone_taken', async () => {
      const results = await Promise.all(
        ['sdt.song1@example.invalid', 'sdt.song2@example.invalid'].map((email) =>
          post('register', registration(email, { phone_number: '0987 654 321' })),
        ),
      );
      expect(results.map((r) => r.response.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.response.status === 409)!.body.error).toBe('phone_taken');
      expect(await q("SELECT 1 FROM users WHERE phone_number='+84987654321'")).toHaveLength(1);
    });

    it('đăng nhập bằng số ở mọi dạng → 200 và /me đúng tài khoản; email vẫn đăng nhập như cũ', async () => {
      for (const phone of ['0912345678', '+84912345678', '84912345678', ' 091.234.5678 ']) {
        const res = await post('login', { phone_number: phone, password: PHONE_PASSWORD });
        expect(res.response.status).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual(
          [
            'access_token',
            'expires_in',
            'refresh_expires_in',
            'refresh_token',
            'token_type',
          ].sort(),
        );
        const profile = await me(res.body.access_token);
        expect([profile.response.status, profile.body.user_id]).toEqual([200, phoneDriverId]);
      }
      const byEmail = await post('login', {
        email: 'sdt.a@example.invalid',
        password: PHONE_PASSWORD,
      });
      expect((await me(byEmail.body.access_token)).body.user_id).toBe(phoneDriverId);
      const intl = await post('login', { phone_number: '+14155550123', password: PHONE_PASSWORD });
      expect(intl.response.status).toBe(200);
    });

    it('sai mật khẩu, số không có tài khoản, số không chuẩn hoá được → cùng 401 invalid_credentials', async () => {
      const responses = [
        await post('login', { phone_number: '0912345678', password: 'Sai-password-0001' }),
        await post('login', { phone_number: '0999999999', password: PHONE_PASSWORD }),
        await post('login', { phone_number: 'goi-cho-toi', password: PHONE_PASSWORD }),
        await post('login', { phone_number: '1'.repeat(40), password: PHONE_PASSWORD }),
      ];
      for (const res of responses) {
        expect(res.response.status).toBe(401);
        expect(res.body).toEqual({ error: 'invalid_credentials', detail: 'invalid_credentials' });
        expect(res.response.headers.get('www-authenticate')).toBe('Bearer');
      }
    });

    it('gửi cả email lẫn số, không gửi cái nào, hoặc sai kiểu → 400 invalid_input', async () => {
      const bodies: Record<string, unknown>[] = [
        { email: 'sdt.a@example.invalid', phone_number: '0912345678', password: PHONE_PASSWORD },
        { email: 'sdt.a@example.invalid', phone_number: null, password: PHONE_PASSWORD },
        { password: PHONE_PASSWORD },
        { phone_number: 912345678, password: PHONE_PASSWORD },
        { phone_number: null, password: PHONE_PASSWORD },
        { phone_number: '0912345678' },
        { phone_number: '0912345678', password: PHONE_PASSWORD, otp: '123456' },
      ];
      for (const body of bodies) {
        const res = await post('login', body);
        expect([res.response.status, res.body.error]).toEqual([400, 'invalid_input']);
      }
    });

    it('tài khoản bị khoá: 403 account_locked chỉ khi mật khẩu đúng (đăng nhập bằng số)', async () => {
      await q("UPDATE users SET account_status='suspended' WHERE id=$1", [phoneDriverId]);
      try {
        const ok = await post('login', { phone_number: '0912345678', password: PHONE_PASSWORD });
        expect([ok.response.status, ok.body.error]).toEqual([403, 'account_locked']);
        const wrong = await post('login', {
          phone_number: '0912345678',
          password: 'Sai-password-0002',
        });
        expect([wrong.response.status, wrong.body.error]).toEqual([401, 'invalid_credentials']);
      } finally {
        await q("UPDATE users SET account_status='active' WHERE id=$1", [phoneDriverId]);
      }
    });

    it('giới hạn thử sai tính theo số ĐÃ chuẩn hoá + IP: 5 lần sai ở các dạng khác nhau → 429 kể cả mật khẩu đúng', async () => {
      // Instance riêng (bộ đếm riêng, IP giả) để không cộng vào trần 20 lần / IP của các test HTTP.
      const accounts = new DriverAccounts(db, config.driverApi!);
      const ip = '203.0.113.30';
      const forms = [
        '0912345678',
        '+84912345678',
        '84 912 345 678',
        '091.234.5678',
        '+840912345678',
      ];
      for (const [i, phone] of forms.entries())
        await expect(
          accounts.login({ phone_number: phone, password: `Sai-password-000${i}` }, ip),
        ).rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });
      await expect(
        accounts.login({ phone_number: '0912345678', password: PHONE_PASSWORD }, ip),
      ).rejects.toMatchObject({ status: 429, code: 'too_many_attempts' });
      // Số khác cùng IP và IP khác cùng số vẫn đăng nhập được.
      await expect(
        accounts.login({ phone_number: '0912345679', password: PHONE_PASSWORD }, ip),
      ).resolves.toMatchObject({ token_type: 'Bearer' });
      await expect(
        accounts.login({ phone_number: '0912345678', password: PHONE_PASSWORD }, '203.0.113.31'),
      ).resolves.toMatchObject({ token_type: 'Bearer' });
      // Số không chuẩn hoá được cũng bị đếm (theo chuỗi đã trim) và khoá như thường.
      for (let i = 0; i < 5; i++)
        await expect(
          accounts.login({ phone_number: ' goi-cho-toi ', password: PHONE_PASSWORD }, ip),
        ).rejects.toMatchObject({ status: 401 });
      await expect(
        accounts.login({ phone_number: 'goi-cho-toi', password: PHONE_PASSWORD }, ip),
      ).rejects.toMatchObject({ status: 429 });
    });
  });

  it('enforces POST, JSON content type, body size and known routes', async () => {
    const get = await post('login', null, {}, 'GET');
    expect([get.response.status, get.body.error]).toEqual([405, 'method_not_allowed']);
    expect(get.response.headers.get('allow')).toBe('POST, OPTIONS');
    const form = await post('login', 'email=a', {
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect([form.response.status, form.body.error]).toEqual([415, 'unsupported_media_type']);
    const big = await post('register', {
      ...registration('big@example.invalid'),
      pad: 'x'.repeat(20000),
    });
    expect([big.response.status, big.body.error]).toEqual([413, 'payload_too_large']);
    for (const raw of ['{', '[]', '"x"', 'null']) {
      const res = await post('login', raw);
      expect([res.response.status, res.body.error]).toEqual([400, 'invalid_input']);
    }
    const unknown = await post('logout', {});
    expect([unknown.response.status, unknown.body.error]).toEqual([404, 'not_found']);
    const preflight = await fetch(`${base}/api/driver/v1/auth/login`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    const foreign = await post(
      'login',
      {},
      {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
      },
    );
    expect([foreign.response.status, foreign.body.error]).toEqual([403, 'forbidden_origin']);
  });

  it('answers 503 auth_unavailable when JWT is not configured', async () => {
    const unconfigured = new DriverAccounts(db, { devAuth: false });
    await expect(
      unconfigured.login({ email: 'tai.xe@example.invalid', password: PASSWORD }, 'x'),
    ).rejects.toMatchObject({ status: 503, code: 'auth_unavailable' });
    await expect(unconfigured.refresh({ refresh_token: 'a.b.c' })).rejects.toMatchObject({
      status: 503,
      code: 'auth_unavailable',
    });
  });

  it('never writes passwords, hashes or tokens to logs', async () => {
    const hashes = (await q('SELECT password_hash FROM users WHERE password_hash IS NOT NULL')).map(
      (r) => String(r.password_hash),
    );
    expect(hashes.length).toBeGreaterThan(0);
    const log = output.join('\n');
    expect(log).not.toContain(PASSWORD);
    expect(log).not.toContain('sai-mat-khau');
    expect(log).not.toContain('Demo-password-0001');
    expect(log).not.toContain('Sai-password-000');
    for (const hash of hashes) expect(log).not.toContain(hash.split('$')[5]);
    expect(log).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./);
  });
});
