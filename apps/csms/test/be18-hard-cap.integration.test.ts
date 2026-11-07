/**
 * BE-18 — STM-1 #16a HARD_CAP_EXCEEDED trên Postgres thật (powerme_test).
 *
 * Phiên được đưa vào `orphaned` bằng SessionsService.onStationOffline (đường thật, `at` lùi về
 * quá khứ để mô phỏng thời gian trôi), không INSERT thẳng status. Bộ quét là
 * SessionTimersService.expireHardCapped; kỳ vọng lấy từ DB sau khi chạy.
 */
import { Logger } from '@nestjs/common';
import type { CsmsConfig } from '../src/config.js';
import { createDb, Db } from '../src/db/db.module.js';
import { ConnectionRegistry } from '../src/ocpp-gateway/connection-registry.js';
import { ReconciliationService } from '../src/reconciliation/reconciliation.service.js';
import { ChargeRecoveryService } from '../src/sessions/charge-recovery.service.js';
import { ChargeSettlementService } from '../src/sessions/charge-settlement.service.js';
import { ChargePolicy } from '../src/sessions/charge-start-policy.js';
import { DriverChargingService } from '../src/sessions/driver-charging.service.js';
import { SessionStateMachine } from '../src/sessions/session-state-machine.js';
import { SessionTimersService } from '../src/sessions/session-timers.service.js';
import { SessionsService } from '../src/sessions/sessions.service.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const url = process.env['DATABASE_URL'];
const describeDb = url ? describe : describe.skip;
const HOUR = 3_600_000;
const policy: ChargePolicy = {
  minimumStartVnd: 50000,
  cutoffReserveVnd: 10000,
  pointsExpiryMonths: 12,
  commandTimeoutMs: 150,
  stationStaleAfterMs: 600000,
};

describeDb('BE-18 hard cap orphaned → review (STM-1 #16a)', () => {
  let db: Db;
  let cpId: number;
  let connectorId: number;
  let config: CsmsConfig;
  let sessionsService: SessionsService;
  let timers: SessionTimersService;
  let seq = 0;
  const q = async (sql: string, args: unknown[] = []) => (await db.$client.query(sql, args)).rows;

  const makeConfig = (over: Partial<CsmsConfig> = {}): CsmsConfig => ({
    databaseUrl: url!,
    ocppPort: 0,
    heartbeatIntervalS: 300,
    sessionStartTimeoutS: 120,
    sessionHardCapH: 24,
    replaySkewThresholdS: 5,
    meterValueSampleIntervalS: 10,
    reconcileGapFactor: 3,
    reconcileEnergyToleranceWh: 1,
    consoleEnabled: false,
    consoleHost: '127.0.0.1',
    consolePort: 0,
    ...over,
  });
  const build = (cfg: CsmsConfig) => {
    const recon = new ReconciliationService(db, cfg);
    const driverCharging = new DriverChargingService(
      db,
      new ConnectionRegistry(db),
      new ChargeSettlementService(db, policy),
      policy,
    );
    return new SessionTimersService(db, cfg, driverCharging, recon);
  };

  /** Phiên `active` thật rồi cho trụ offline lúc `ago` ms trước → orphaned (đường #13). */
  async function orphanedAgo(ago: number): Promise<number> {
    const n = ++seq;
    const id = Number(
      (
        await q(
          `INSERT INTO sessions(connector_id,charge_point_id,connector_no,id_tag,origin,payment_mode,
             status,cp_started_at,meter_start_wh) VALUES($1,$2,1,$3,'rfid','unattributed','active',now(),$4)
           RETURNING id`,
          [connectorId, cpId, `TAG${n}`, n],
        )
      )[0]!.id,
    );
    await sessionsService.onStationOffline(cpId, new Date(Date.now() - ago));
    // onStationOffline kéo MỌI phiên mở của trụ; các test tạo từng phiên một nên chấp nhận được.
    expect((await q('SELECT status FROM sessions WHERE id=$1', [id]))[0]!.status).toBe('orphaned');
    return id;
  }
  const row = async (id: number) =>
    (await q('SELECT status,orphaned_at FROM sessions WHERE id=$1', [id]))[0]!;
  const history = (id: number) =>
    q(
      'SELECT from_status,to_status,event,actor,note FROM session_status_history WHERE session_id=$1 ORDER BY id',
      [id],
    );

  beforeAll(async () => {
    if (!url || new URL(url).pathname !== '/powerme_test')
      throw new Error('BE-18 requires powerme_test');
    Logger.overrideLogger(['error']);
    db = createDb(url);
  });
  beforeEach(async () => {
    seq = 0;
    await resetAndMigrate(db.$client);
    const op = (
      await q("INSERT INTO operators(tax_code,legal_name) VALUES('B18','BE-18') RETURNING id")
    )[0]!.id;
    const site = (
      await q(
        "INSERT INTO sites(site_code,operator_id,site_name) VALUES('B18',$1,'B18') RETURNING id",
        [op],
      )
    )[0]!.id;
    cpId = Number(
      (
        await q(
          `INSERT INTO charge_points(serial_number,display_code,site_id,lifecycle)
           VALUES('B18-CP','PM-D1-HCM-0018',$1,'in_service') RETURNING id`,
          [site],
        )
      )[0]!.id,
    );
    connectorId = Number(
      (
        await q('INSERT INTO connectors(charge_point_id,connector_no) VALUES($1,1) RETURNING id', [
          cpId,
        ])
      )[0]!.id,
    );
    config = makeConfig();
    sessionsService = new SessionsService(
      db,
      new SessionStateMachine(),
      new ReconciliationService(db, config),
      config,
    );
    timers = build(config);
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  it('moves only sessions past the cap, writes history and an operator-visible record', async () => {
    const fresh = await orphanedAgo(23 * HOUR + 59 * 60_000);
    expect(await timers.expireHardCapped()).toBe(0);
    expect((await row(fresh)).status).toBe('orphaned');
    const old = await orphanedAgo(24 * HOUR + 60_000);
    expect(await timers.expireHardCapped()).toBe(1);
    expect((await row(old)).status).toBe('review');
    const h = await history(old);
    expect(h.map((r) => `${r.from_status}>${r.to_status}:${r.event}`)).toEqual([
      'active>orphaned:STATION_OFFLINE',
      'orphaned>review:HARD_CAP_EXCEEDED',
    ]);
    expect(h[1]).toMatchObject({ actor: 'system' });
    expect(h[1]!.note).toMatch(/^orphaned_since=\d{4}-.+ cap_h=24$/);
    const records = await q(
      'SELECT record_type,resolution,reviewed_at FROM reconciliation_records WHERE session_id=$1',
      [old],
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ record_type: 'conflict', reviewed_at: null });
    expect(records[0]!.resolution).toMatch(
      /^hard_cap_exceeded: orphaned_since=.+ cap_h=24 no_stop_transaction$/,
    );
  });

  it('is idempotent and safe to run concurrently', async () => {
    const id = await orphanedAgo(30 * HOUR);
    const counts = await Promise.all([timers.expireHardCapped(), timers.expireHardCapped()]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await timers.expireHardCapped()).toBe(0);
    expect((await history(id)).filter((r) => r.event === 'HARD_CAP_EXCEEDED')).toHaveLength(1);
    expect(await q('SELECT 1 FROM reconciliation_records WHERE session_id=$1', [id])).toHaveLength(
      1,
    );
  });

  it('survives a restart: a fresh service instance reaches the same decision from the DB', async () => {
    const id = await orphanedAgo(25 * HOUR);
    const restarted = build(makeConfig());
    expect(await restarted.expireHardCapped()).toBe(1);
    expect((await row(id)).status).toBe('review');
  });

  it('counts from the latest entry into orphaned, not the first (orphaned_at)', async () => {
    const id = await orphanedAgo(30 * HOUR);
    const firstOrphanedAt = (await row(id)).orphaned_at as Date;
    // #18: trụ nối lại, bản tin live đưa phiên về active; rồi mất kết nối lần nữa 1 giờ trước.
    await q("UPDATE sessions SET status='active' WHERE id=$1", [id]);
    await q(
      "INSERT INTO session_status_history(session_id,from_status,to_status,event,occurred_at) VALUES($1,'orphaned','active','LIVE_MESSAGE',now()-interval '29 hours')",
      [id],
    );
    await sessionsService.onStationOffline(cpId, new Date(Date.now() - HOUR));
    const after = await row(id);
    expect(after.status).toBe('orphaned');
    expect((after.orphaned_at as Date).getTime()).toBe(firstOrphanedAt.getTime()); // cột giữ lần đầu
    expect(await timers.expireHardCapped()).toBe(0); // vẫn chỉ 1 giờ kể từ lần orphaned mới
    expect((await row(id)).status).toBe('orphaned');
  });

  it('falls back to orphaned_at then updated_at for legacy rows without history', async () => {
    const id = await orphanedAgo(HOUR);
    // history là append-only (trigger) nên không xoá được: kiểm nhánh dự phòng bằng phiên chèn thẳng.
    const n = ++seq;
    const legacy = Number(
      (
        await q(
          `INSERT INTO sessions(connector_id,charge_point_id,connector_no,id_tag,origin,payment_mode,
             status,cp_started_at,meter_start_wh,orphaned_at) VALUES($1,$2,1,$3,'rfid','unattributed','orphaned',now(),$4,now()-interval '25 hours')
           RETURNING id`,
          [connectorId, cpId, `TAG${n}`, n],
        )
      )[0]!.id,
    );
    expect(await timers.expireHardCapped()).toBe(1);
    expect((await row(legacy)).status).toBe('review');
    expect((await row(id)).status).toBe('orphaned');
  });

  it.each(['pending', 'active', 'paused', 'stopping', 'closed', 'review', 'reconciled', 'failed'])(
    'never touches a %s session however old',
    async (status) => {
      const n = ++seq;
      const id = Number(
        (
          await q(
            `INSERT INTO sessions(connector_id,charge_point_id,connector_no,id_tag,origin,payment_mode,
               status,cp_started_at,meter_start_wh,orphaned_at,updated_at)
             VALUES($1,$2,1,$3,'rfid','unattributed',$4,now()-interval '90 hours',$5,now()-interval '80 hours',now()-interval '70 hours')
             RETURNING id`,
            [connectorId, cpId, `TAG${n}`, status, n],
          )
        )[0]!.id,
      );
      expect(await timers.expireHardCapped()).toBe(0);
      expect((await row(id)).status).toBe(status);
      expect(
        await q('SELECT 1 FROM session_status_history WHERE session_id=$1', [id]),
      ).toHaveLength(0);
    },
  );

  it('still moves to review with the reconciliation engine off (ablation) but writes no record', async () => {
    const off = makeConfig({ reconciliationEnabled: false });
    const id = await orphanedAgo(26 * HOUR);
    expect(await build(off).expireHardCapped()).toBe(1);
    expect((await row(id)).status).toBe('review');
    expect(await q('SELECT 1 FROM reconciliation_records')).toHaveLength(0);
    expect((await history(id)).map((r) => r.event)).toContain('HARD_CAP_EXCEEDED');
  });

  it('a configurable cap (hours) is honoured and an invalid cap is refused', async () => {
    const id = await orphanedAgo(2 * HOUR);
    expect(await build(makeConfig({ sessionHardCapH: 3 })).expireHardCapped()).toBe(0);
    expect(await build(makeConfig({ sessionHardCapH: 1.5 })).expireHardCapped()).toBe(1);
    expect((await row(id)).status).toBe('review');
    await expect(build(makeConfig({ sessionHardCapH: 0 })).expireHardCapped()).rejects.toThrow(
      'invalid_session_hard_cap',
    );
  });

  it('ChargeRecoveryService.tick drives both sweeps', async () => {
    const id = await orphanedAgo(48 * HOUR);
    const driverCharging = new DriverChargingService(
      db,
      new ConnectionRegistry(db),
      new ChargeSettlementService(db, policy),
      policy,
    );
    const recovery = new ChargeRecoveryService(
      new ChargeSettlementService(db, policy),
      driverCharging,
      timers,
    );
    await recovery.tick();
    expect((await row(id)).status).toBe('review');
  });
});
