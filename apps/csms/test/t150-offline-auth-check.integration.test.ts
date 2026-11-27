/**
 * T150 / BR-P52 — kiểm cấu hình authorize offline sau BootNotification (OfflineAuthCheckService),
 * trên Postgres thật (migration 0030) với trụ giả trả lời GetConfiguration / ChangeConfiguration /
 * SetChargingProfile. Mã ca test đề xuất cho Report 5: TC-BRP52-01 … 06
 * (docs/testing/T150-THE-OFFLINE.md). Cần DATABASE_URL; DROP SCHEMA DB đó.
 */
import { Logger } from '@nestjs/common';
import { loadConfig, type CsmsConfig } from '../src/config.js';
import { createDb, type Db } from '../src/db/db.module.js';
import {
  ConnectionRegistry,
  type OcppClientLike,
} from '../src/ocpp-gateway/connection-registry.js';
import type { InboundContext } from '../src/ocpp-gateway/inbound-context.js';
import {
  OfflineAuthCheckService,
  TX_DEFAULT_PROFILE_ID,
} from '../src/ocpp-gateway/offline-auth-check.service.js';
import { OcppHandlers } from '../src/ocpp-gateway/ocpp-handlers.js';
import type { SessionsService } from '../src/sessions/sessions.service.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

type Key = { value: string; readonly: boolean };
type Answer = (params: any) => unknown;

/** Trụ giả: cấu hình trong bộ nhớ + bảng trả lời theo action; ghi lại mọi lệnh nhận được. */
class FakeStation implements OcppClientLike {
  readonly calls: { method: string; params: any; options?: Record<string, unknown> }[] = [];
  readonly answers: Record<string, Answer> = {};
  constructor(
    readonly identity: string,
    readonly config: Map<string, Key>,
  ) {
    this.answers['GetConfiguration'] = ({ key }: { key: string[] }) => {
      const configurationKey = key
        .filter((k) => this.config.has(k))
        .map((k) => ({ key: k, ...this.config.get(k)! }));
      const unknownKey = key.filter((k) => !this.config.has(k));
      return unknownKey.length ? { configurationKey, unknownKey } : { configurationKey };
    };
    this.answers['ChangeConfiguration'] = ({ key, value }: { key: string; value: string }) => {
      const v = this.config.get(key);
      if (!v) return { status: 'NotSupported' };
      if (v.readonly) return { status: 'Rejected' };
      v.value = value;
      return { status: 'Accepted' };
    };
    this.answers['SetChargingProfile'] = () => ({ status: 'Accepted' });
  }
  async call(method: string, params?: unknown, options?: Record<string, unknown>) {
    this.calls.push({ method, params, ...(options ? { options } : {}) });
    const answer = this.answers[method];
    if (!answer)
      throw Object.assign(new Error(`${method} chua ho tro`), { rpcErrorCode: 'NotImplemented' });
    return answer(params);
  }
  async close() {
    return undefined;
  }
  methods() {
    return this.calls.map(
      (c) =>
        `${c.method}${c.params?.key && c.method === 'ChangeConfiguration' ? ':' + c.params.key : ''}`,
    );
  }
}

const cfg = (entries: [string, string, boolean?][]) =>
  new Map(entries.map(([k, value, readonly]) => [k, { value, readonly: readonly ?? false }]));
/** Trụ "ngoan" mặc định của nhà sản xuất: authorize offline đang bật. */
const factory = (profiles = 'Core,RemoteTrigger') =>
  cfg([
    ['LocalAuthorizeOffline', 'true'],
    ['LocalPreAuthorize', 'false'],
    ['AllowOfflineTxForUnknownId', 'true'],
    ['AuthorizationCacheEnabled', 'true'],
    ['LocalAuthListEnabled', 'true'],
    ['SupportedFeatureProfiles', profiles, true],
  ]);
const timeoutError = () => {
  class TimeoutError extends Error {}
  return new TimeoutError('Call timeout');
};

describeDb('T150 / BR-P52: kiểm authorize offline sau BootNotification', () => {
  let db: Db;
  let registry: ConnectionRegistry;
  let site = 0;
  let n = 0;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as any[];
  const baseConfig: CsmsConfig = loadConfig({
    DATABASE_URL: DATABASE_URL ?? 'postgresql://x',
    OFFLINE_AUTH_CHECK_TIMEOUT_S: '1',
  });
  const service = (over: Partial<CsmsConfig> = {}) =>
    new OfflineAuthCheckService(db, { ...baseConfig, ...over }, registry);

  async function station(config: Map<string, Key>, ratedKw: number | null = 120) {
    const serial = `T150-${++n}`;
    const [row] = await q(
      `INSERT INTO charge_points(serial_number,site_id,lifecycle,rated_power_kw)
       VALUES($1,$2,'in_service',$3) RETURNING id`,
      [serial, site, ratedKw],
    );
    const fake = new FakeStation(serial, config);
    const conn = await registry.open(serial, fake);
    return { serial, id: Number(row.id), fake, conn };
  }
  const latest = async (cpId: number) =>
    (
      await q(
        'SELECT * FROM charge_point_offline_auth_checks WHERE charge_point_id=$1 ORDER BY id DESC LIMIT 1',
        [cpId],
      )
    )[0];
  const commands = async (cpId: number) =>
    q(
      'SELECT action,status,connector_no,requested_by,response,error FROM remote_commands WHERE charge_point_id=$1 ORDER BY id',
      [cpId],
    );

  beforeAll(async () => {
    Logger.overrideLogger(['error']);
    db = createDb(DATABASE_URL!);
    await resetAndMigrate(db.$client);
    const [op] = await q(
      "INSERT INTO operators(tax_code,legal_name) VALUES('0315000150','T150') RETURNING id",
    );
    site = Number(
      (
        await q(
          "INSERT INTO sites(site_code,operator_id,site_name) VALUES('T150',$1,'Tram T150') RETURNING id",
          [op.id],
        )
      )[0].id,
    );
    registry = new ConnectionRegistry(db);
  });
  afterAll(async () => {
    await db?.$client.end();
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
  });

  it('[TC-BRP52-01] Accepted: tắt các key đang bật, bỏ qua key đã false → không rủi ro; ghi đủ bằng chứng', async () => {
    const { id, fake, conn } = await station(factory());
    const r = await service().check(conn);
    expect(r).toMatchObject({ offlineCardRisk: false, riskReason: null });
    expect(fake.methods()).toEqual([
      'GetConfiguration',
      'ChangeConfiguration:LocalAuthorizeOffline',
      'ChangeConfiguration:AllowOfflineTxForUnknownId',
    ]);
    expect(fake.calls[0]!.params.key).toEqual([
      'LocalAuthorizeOffline',
      'LocalPreAuthorize',
      'AllowOfflineTxForUnknownId',
      'AuthorizationCacheEnabled',
      'LocalAuthListEnabled',
      'SupportedFeatureProfiles',
    ]);
    expect(fake.calls[1]!.params).toEqual({ key: 'LocalAuthorizeOffline', value: 'false' });
    expect(fake.calls.every((c) => c.options?.['callTimeoutMs'] === 1000)).toBe(true);
    expect(fake.config.get('LocalAuthorizeOffline')!.value).toBe('false');
    const row = await latest(id);
    expect(row).toMatchObject({
      epoch: conn.epoch,
      offline_card_risk: false,
      risk_reason: null,
      supported_feature_profiles: 'Core,RemoteTrigger',
      fallback_profile_status: null,
      change_results: {
        LocalAuthorizeOffline: 'Accepted',
        LocalPreAuthorize: 'skipped',
        AllowOfflineTxForUnknownId: 'Accepted',
      },
    });
    expect(row.config_values['AuthorizationCacheEnabled']).toEqual({
      value: 'true',
      readonly: false,
    });
    expect(row.completed_at.getTime()).toBeGreaterThanOrEqual(row.started_at.getTime());
    // Mỗi lệnh một dòng remote_commands do CSMS tự phát sinh (requested_by NULL).
    expect((await commands(id)).map((c) => [c.action, c.status, c.requested_by])).toEqual([
      ['GetConfiguration', 'accepted', null],
      ['ChangeConfiguration', 'accepted', null],
      ['ChangeConfiguration', 'accepted', null],
    ]);
  });

  it('[TC-BRP52-02] Rejected: key readonly vẫn bật → offline_card_risk, lý do rejected', async () => {
    const config = factory();
    config.set('AllowOfflineTxForUnknownId', { value: 'true', readonly: true });
    const { id, conn } = await station(config);
    const r = await service().check(conn);
    expect(r).toMatchObject({ offlineCardRisk: true, riskReason: 'rejected' });
    expect((await latest(id)).change_results).toEqual({
      LocalAuthorizeOffline: 'Accepted',
      LocalPreAuthorize: 'skipped',
      AllowOfflineTxForUnknownId: 'Rejected',
    });
    expect((await commands(id)).at(-1)).toMatchObject({
      status: 'rejected',
      response: { status: 'Rejected' },
    });
  });

  it('[TC-BRP52-03] NotSupported: key không có → key_missing; key có mà NotSupported → not_supported; RebootRequired cũng là rủi ro', async () => {
    const missing = factory();
    missing.delete('AllowOfflineTxForUnknownId');
    const a = await station(missing);
    expect(await service().check(a.conn)).toMatchObject({
      offlineCardRisk: true,
      riskReason: 'key_missing',
      configValues: expect.objectContaining({ AllowOfflineTxForUnknownId: null }),
      changeResults: expect.objectContaining({ AllowOfflineTxForUnknownId: 'NotSupported' }),
    });

    const b = await station(factory());
    b.fake.answers['ChangeConfiguration'] = ({ key }: { key: string }) => ({
      status: key === 'LocalAuthorizeOffline' ? 'NotSupported' : 'Accepted',
    });
    expect(await service().check(b.conn)).toMatchObject({ riskReason: 'not_supported' });

    const c = await station(factory());
    c.fake.answers['ChangeConfiguration'] = () => ({ status: 'RebootRequired' });
    expect(await service().check(c.conn)).toMatchObject({
      offlineCardRisk: true,
      riskReason: 'reboot_required',
    });
    // Boot sau khi trụ khởi động lại đọc được false → cờ tắt (dòng mới nhất quyết định).
    for (const k of ['LocalAuthorizeOffline', 'AllowOfflineTxForUnknownId'])
      c.fake.config.get(k)!.value = 'false';
    expect(await service().check(c.conn)).toMatchObject({ offlineCardRisk: false });
    expect((await latest(c.id)).offline_card_risk).toBe(false);
  });

  it('[TC-BRP52-04] timeout / CALLERROR: không xác nhận được → cờ bật, CSMS không lỗi', async () => {
    const a = await station(factory());
    a.fake.answers['GetConfiguration'] = () => {
      throw timeoutError();
    };
    expect(await service().check(a.conn)).toEqual({
      offlineCardRisk: true,
      riskReason: 'no_response',
      configValues: null,
      changeResults: {},
      supportedFeatureProfiles: null,
      fallbackProfileStatus: null,
    });
    expect(await latest(a.id)).toMatchObject({ offline_card_risk: true, config_values: null });
    expect(await commands(a.id)).toEqual([
      expect.objectContaining({
        action: 'GetConfiguration',
        status: 'timeout',
        error: expect.stringMatching(/timeout/i),
      }),
    ]);

    const b = await station(factory());
    delete b.fake.answers['GetConfiguration']; // trụ trả CALLERROR NotImplemented
    expect(await service().check(b.conn)).toMatchObject({ riskReason: 'no_response' });
    expect((await commands(b.id))[0]).toMatchObject({ status: 'failed' });

    const c = await station(factory());
    c.fake.answers['ChangeConfiguration'] = () => {
      throw timeoutError();
    };
    expect(await service().check(c.conn)).toMatchObject({
      riskReason: 'no_response',
      changeResults: { LocalAuthorizeOffline: 'timeout', LocalPreAuthorize: 'skipped' },
    });
  });

  it('[TC-BRP52-04] Boot không bị chặn: phản hồi Boot trả ngay, bước kiểm chạy sau đó; tắt bằng env thì không gửi gì', async () => {
    const { serial, id, fake, conn } = await station(factory());
    let release: (v: unknown) => void = () => undefined;
    const get = fake.answers['GetConfiguration']!;
    fake.answers['GetConfiguration'] = (p) =>
      new Promise((resolve) => {
        release = () => resolve(get(p));
      });
    const svc = service();
    svc.afterBootDelayMs = 0;
    const handlers = new OcppHandlers({} as SessionsService, baseConfig, undefined, undefined, svc);
    const ctx = {
      identity: serial,
      chargePointId: id,
      epoch: conn.epoch,
      epochOpenedAt: conn.epochOpenedAt,
      receivedAt: new Date(),
      cpTimestamp: null,
      messageId: 'b1',
      messageLogId: 0,
      replay: { replayed: false, reason: null, skewS: null },
    } satisfies InboundContext;
    const boot = await handlers.dispatch(
      'BootNotification',
      { chargePointVendor: 'Ruihua', chargePointModel: 'D1-120' },
      ctx,
    );
    expect(boot).toMatchObject({ status: 'Accepted', interval: baseConfig.heartbeatIntervalS });
    expect(fake.calls).toEqual([]); // chưa gửi gì khi Boot.conf đã có
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.methods()).toEqual(['GetConfiguration']); // đang chờ trụ trả lời
    expect(await latest(id)).toBeUndefined();
    release(undefined);
    await new Promise((r) => setTimeout(r, 300));
    expect((await latest(id)).offline_card_risk).toBe(false);

    const off = await station(factory());
    const disabled = service({ offlineAuthCheckEnabled: false });
    disabled.afterBootDelayMs = 0;
    await new OcppHandlers(
      {} as SessionsService,
      baseConfig,
      undefined,
      undefined,
      disabled,
    ).dispatch(
      'BootNotification',
      { chargePointVendor: 'Ruihua', chargePointModel: 'D1-120' },
      { ...ctx, identity: off.serial, chargePointId: off.id, epoch: off.conn.epoch },
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(off.fake.calls).toEqual([]);
  });

  it('[TC-BRP52-06] giới hạn dự phòng: tắt mặc định; bật + SmartCharging → TxDefaultProfile về 0 sau N s, phiên online ghi đè bằng TxProfile', async () => {
    // Mặc định (OFFLINE_TX_FALLBACK_S=0): trụ rủi ro có SmartCharging vẫn không nhận SetChargingProfile.
    expect(baseConfig.offlineTxFallbackS).toBe(0);
    const stubborn = () => {
      const c = factory('Core,SmartCharging');
      c.set('LocalAuthorizeOffline', { value: 'true', readonly: true });
      return c;
    };
    const off = await station(stubborn());
    await service().check(off.conn);
    expect(off.fake.methods()).not.toContain('SetChargingProfile');
    expect(await service().liftForOnlineSession(off.conn, 1, 1)).toBeNull();

    const on = service({ offlineTxFallbackS: 90 });
    const a = await station(stubborn(), 60);
    const r = await on.check(a.conn);
    expect(r).toMatchObject({ offlineCardRisk: true, fallbackProfileStatus: 'Accepted' });
    const set = a.fake.calls.find((c) => c.method === 'SetChargingProfile')!;
    expect(set.params).toEqual({
      connectorId: 0,
      csChargingProfiles: {
        chargingProfileId: TX_DEFAULT_PROFILE_ID,
        stackLevel: 0,
        chargingProfilePurpose: 'TxDefaultProfile',
        chargingProfileKind: 'Relative',
        chargingSchedule: {
          chargingRateUnit: 'W',
          chargingSchedulePeriod: [
            { startPeriod: 0, limit: 60000 },
            { startPeriod: 90, limit: 0 },
          ],
        },
      },
    });
    expect((await latest(a.id)).fallback_profile_status).toBe('Accepted');
    // Phiên bắt đầu online trên súng 2, transactionId 42 → TxProfile không giới hạn.
    expect(await on.liftForOnlineSession(a.conn, 2, 42)).toBe('Accepted');
    expect(a.fake.calls.at(-1)!.params).toMatchObject({
      connectorId: 2,
      csChargingProfiles: {
        transactionId: 42,
        chargingProfilePurpose: 'TxProfile',
        chargingSchedule: { chargingSchedulePeriod: [{ startPeriod: 0, limit: 60000 }] },
      },
    });
    expect((await commands(a.id)).at(-1)).toMatchObject({
      action: 'SetChargingProfile',
      connector_no: 2,
      status: 'accepted',
    });

    // Không có SmartCharging → không gửi, ghi 'unsupported'. Không rủi ro → không cần dự phòng.
    const noSc = await station(
      (() => {
        const c = factory();
        c.set('LocalAuthorizeOffline', { value: 'true', readonly: true });
        return c;
      })(),
    );
    expect(await on.check(noSc.conn)).toMatchObject({ fallbackProfileStatus: 'unsupported' });
    expect(noSc.fake.methods()).not.toContain('SetChargingProfile');
    const safe = await station(factory('Core,SmartCharging'));
    expect(await on.check(safe.conn)).toMatchObject({
      offlineCardRisk: false,
      fallbackProfileStatus: null,
    });
    expect(await on.liftForOnlineSession(safe.conn, 1, 7)).toBeNull();
  });

  it('migration 0030: CHECK risk_reason đi cùng offline_card_risk', async () => {
    const { id } = await station(factory());
    await expect(
      q(
        `INSERT INTO charge_point_offline_auth_checks(charge_point_id,epoch,started_at,completed_at,offline_card_risk)
         VALUES($1,1,now(),now(),true)`,
        [id],
      ),
    ).rejects.toThrow(/reason_check/);
    await expect(
      q(
        `INSERT INTO charge_point_offline_auth_checks(charge_point_id,epoch,started_at,completed_at,offline_card_risk,risk_reason)
         VALUES($1,1,now(),now(),false,'rejected')`,
        [id],
      ),
    ).rejects.toThrow(/reason_check/);
  });
});
