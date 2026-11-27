/**
 * OfflineAuthCheckService — T150 / BR-P52: giảm rủi ro thẻ dùng khi trụ offline.
 *
 * Tình huống chặn: trụ mất mạng, tài xế quẹt thẻ lạ hoặc thẻ đã khoá. Trụ còn cho authorize offline
 * (Authorization Cache / Local List / AllowOfflineTxForUnknownId) thì phiên vẫn chạy; CSMS chỉ biết
 * khi trụ nối lại, tiền không thu được → shortfall (BR-P20).
 *
 * Sau mỗi BootNotification đã Accepted (KHÔNG chặn phản hồi Boot, chạy sau đó):
 *   1. GetConfiguration các key ở {@link READ_KEYS}.
 *   2. ChangeConfiguration từng key ở {@link OFFLINE_AUTH_KEYS} về "false" khi trụ chưa đặt false.
 *   3. Ghi một dòng `charge_point_offline_auth_checks` (giá trị đọc được, phản hồi từng lệnh,
 *      SupportedFeatureProfiles, thời điểm). Cờ `offline_card_risk` = KHÔNG xác nhận được cả ba key
 *      đều false (Rejected / NotSupported / RebootRequired / key không có / timeout / CALLERROR).
 *   4. Giới hạn dự phòng (OFFLINE_TX_FALLBACK_S > 0, mặc định tắt): trụ có rủi ro và hỗ trợ
 *      SmartCharging nhận TxDefaultProfile công suất 0 sau N giây kể từ đầu phiên. Phiên bắt đầu
 *      online (StartTransaction không phải phát lại) được ghi đè bằng TxProfile không giới hạn.
 *
 * Ràng buộc giữ nguyên (apps/csms/README.md):
 *   - Mọi frame gửi ra được ocpp-rpc phát sự kiện `message` → OcppServer ghi `ocpp_message_log`
 *     như mọi lệnh khác; ngoài ra mỗi lệnh có một dòng `remote_commands` (requested_by NULL = CSMS
 *     tự phát sinh) để màn chi tiết trụ hiện trong "Lệnh gần đây".
 *   - Không chạy trong InboundSerializer (chờ trụ trả lời trong hàng đợi chiều vào có thể kẹt nếu trụ
 *     chờ CALLRESULT của chính nó); thay vào đó tuần tự theo trụ bằng chuỗi promise riêng, nên hai
 *     lần Boot liền nhau không kiểm chồng nhau. Không đụng phiên, connector hay lifecycle.
 *   - Lỗi/timeout chỉ thành "không xác nhận được" (cờ bật), không bao giờ ném ra ngoài.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CONFIG, CsmsConfig } from '../config.js';
import { DB, Db } from '../db/db.module.js';
import { Connection, ConnectionRegistry } from './connection-registry.js';

/** Ba key phải là "false" thì trụ mới không tự cho phép thẻ khi offline. */
export const OFFLINE_AUTH_KEYS = [
  'LocalAuthorizeOffline',
  'LocalPreAuthorize',
  'AllowOfflineTxForUnknownId',
] as const;
/** Đọc thêm để ghi nhận (không đổi): cache và danh sách cục bộ, profile tính năng. */
export const READ_KEYS = [
  ...OFFLINE_AUTH_KEYS,
  'AuthorizationCacheEnabled',
  'LocalAuthListEnabled',
  'SupportedFeatureProfiles',
] as const;

/**
 * Mã lý do ngắn (cột `risk_reason`, API `offline_card_risk_reason`). `not_checked` chỉ có ở API: trụ
 * chưa từng được kiểm (chưa Boot từ khi có T150).
 */
export type OfflineCardRiskReason =
  | 'not_checked'
  | 'no_response'
  | 'key_missing'
  | 'rejected'
  | 'not_supported'
  | 'reboot_required'
  | 'change_failed';

/** Kết quả một lệnh: status OCPP nguyên văn, hoặc `timeout` / `error` (CALLERROR, mất kết nối). */
export type CommandOutcome =
  'Accepted' | 'Rejected' | 'RebootRequired' | 'NotSupported' | 'timeout' | 'error' | 'skipped';

export interface ConfigValue {
  value: string | null;
  readonly: boolean;
}

export interface OfflineAuthCheckResult {
  offlineCardRisk: boolean;
  riskReason: OfflineCardRiskReason | null;
  configValues: Record<string, ConfigValue | null> | null;
  changeResults: Record<string, CommandOutcome>;
  supportedFeatureProfiles: string | null;
  fallbackProfileStatus: string | null;
}

/** chargingProfileId cố định của CSMS: cùng id thì trụ thay profile cũ (OCPP 1.6 §5.16). */
export const TX_DEFAULT_PROFILE_ID = 15_000;
const TX_PROFILE_ID_BASE = 15_000; // + connectorId (1, 2)
/** Trần "không giới hạn" khi trụ chưa khai rated_power_kw (W). Trụ tự kẹp về công suất thật. */
const UNLIMITED_W = 1_000_000;

interface CallResult {
  outcome: 'ok' | 'timeout' | 'error';
  response: Record<string, unknown> | null;
}

const isFalse = (v: ConfigValue | null | undefined) => v?.value?.trim().toLowerCase() === 'false';

@Injectable()
export class OfflineAuthCheckService {
  private readonly logger = new Logger(OfflineAuthCheckService.name);
  /** Chuỗi việc theo identity: tuần tự hoá các lần kiểm của cùng một trụ. */
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Độ trễ sau Boot để CALLRESULT của Boot chắc chắn đi trước GetConfiguration. */
  afterBootDelayMs = 500;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: CsmsConfig,
    private readonly registry: ConnectionRegistry,
  ) {}

  get enabled(): boolean {
    return this.config.offlineAuthCheckEnabled !== false;
  }

  private get timeoutMs(): number {
    return (this.config.offlineAuthCheckTimeoutS ?? 15) * 1000;
  }

  /** Gọi từ handler BootNotification. Không chờ, không ném. */
  scheduleAfterBoot(identity: string, epoch: number): void {
    if (!this.enabled) return;
    setTimeout(() => {
      const conn = this.registry.get(identity);
      if (!conn || conn.epoch !== epoch) return; // trụ đã ngắt / nối lại: Boot sau sẽ kiểm
      void this.enqueue(conn.identity, () => this.check(conn));
    }, this.afterBootDelayMs).unref?.();
  }

  /** Gọi từ handler StartTransaction (không phải phát lại). Không chờ, không ném. */
  scheduleTxProfile(
    identity: string,
    epoch: number,
    connectorId: number,
    transactionId: number,
  ): void {
    if (!this.enabled || !(this.config.offlineTxFallbackS && this.config.offlineTxFallbackS > 0))
      return;
    setImmediate(() => {
      const conn = this.registry.get(identity);
      if (!conn || conn.epoch !== epoch) return;
      void this.enqueue(conn.identity, () =>
        this.liftForOnlineSession(conn, connectorId, transactionId),
      );
    });
  }

  private enqueue<T>(identity: string, job: () => Promise<T>): Promise<T | undefined> {
    const prev = this.chains.get(identity) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(job)
      .catch((err: unknown) => {
        this.logger.error(`T150 ${identity}: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      });
    this.chains.set(identity, next);
    void next.finally(() => {
      if (this.chains.get(identity) === next) this.chains.delete(identity);
    });
    return next;
  }

  /** Chạy bước kiểm ngay (test gọi thẳng). Luôn ghi một dòng và trả kết quả. */
  async check(conn: Connection): Promise<OfflineAuthCheckResult> {
    const startedAt = new Date();
    const result = await this.inspect(conn);
    await this.db.$client.query(
      `INSERT INTO charge_point_offline_auth_checks(charge_point_id,epoch,started_at,completed_at,
         config_values,change_results,supported_feature_profiles,offline_card_risk,risk_reason,
         fallback_profile_status)
       VALUES($1,$2,$3,greatest(now(),$3),$4,$5,$6,$7,$8,$9)`,
      [
        conn.chargePointId,
        conn.epoch,
        startedAt,
        result.configValues === null ? null : JSON.stringify(result.configValues),
        JSON.stringify(result.changeResults),
        result.supportedFeatureProfiles,
        result.offlineCardRisk,
        result.riskReason,
        result.fallbackProfileStatus,
      ],
    );
    const msg = result.offlineCardRisk
      ? `RỦI RO thẻ offline (${result.riskReason}) ${JSON.stringify(result.changeResults)}`
      : 'đã tắt authorize offline';
    if (result.offlineCardRisk) this.logger.warn(`T150 ${conn.identity}: ${msg}`);
    else this.logger.log(`T150 ${conn.identity}: ${msg}`);
    return result;
  }

  private async inspect(conn: Connection): Promise<OfflineAuthCheckResult> {
    const read = await this.call(conn, 'GetConfiguration', { key: [...READ_KEYS] }, null);
    if (read.outcome !== 'ok') {
      return {
        offlineCardRisk: true,
        riskReason: 'no_response',
        configValues: null,
        changeResults: {},
        supportedFeatureProfiles: null,
        fallbackProfileStatus: null,
      };
    }
    const values = parseConfiguration(read.response);
    const changeResults: Record<string, CommandOutcome> = {};
    for (const key of OFFLINE_AUTH_KEYS) {
      if (isFalse(values[key])) {
        changeResults[key] = 'skipped';
        continue;
      }
      // Key không có / readonly vẫn gửi: phản hồi của trụ (NotSupported / Rejected) là bằng chứng.
      const r = await this.call(conn, 'ChangeConfiguration', { key, value: 'false' }, null);
      changeResults[key] =
        r.outcome === 'ok' ? statusOutcome(r.response?.['status']) : (r.outcome as CommandOutcome);
    }
    const riskReason = riskReasonOf(values, changeResults);
    const profiles = values['SupportedFeatureProfiles']?.value ?? null;
    let fallbackProfileStatus: string | null = null;
    const fallbackS = this.config.offlineTxFallbackS ?? 0;
    if (riskReason !== null && fallbackS > 0) {
      fallbackProfileStatus = hasSmartCharging(profiles)
        ? await this.sendTxDefaultProfile(conn, fallbackS)
        : 'unsupported';
    }
    return {
      offlineCardRisk: riskReason !== null,
      riskReason,
      configValues: values,
      changeResults,
      supportedFeatureProfiles: profiles,
      fallbackProfileStatus,
    };
  }

  private async maxPowerW(chargePointId: number): Promise<number> {
    const { rows } = await this.db.$client.query<{ kw: number | null }>(
      'SELECT rated_power_kw::float8 AS kw FROM charge_points WHERE id=$1',
      [chargePointId],
    );
    const kw = rows[0]?.kw;
    return kw && kw > 0 ? Math.round(kw * 1000) : UNLIMITED_W;
  }

  /** Cả trụ (connector 0): đủ công suất N giây đầu phiên, sau đó 0. */
  private async sendTxDefaultProfile(conn: Connection, fallbackS: number): Promise<string> {
    const maxW = await this.maxPowerW(conn.chargePointId);
    const r = await this.call(
      conn,
      'SetChargingProfile',
      {
        connectorId: 0,
        csChargingProfiles: {
          chargingProfileId: TX_DEFAULT_PROFILE_ID,
          stackLevel: 0,
          chargingProfilePurpose: 'TxDefaultProfile',
          chargingProfileKind: 'Relative',
          chargingSchedule: {
            chargingRateUnit: 'W',
            chargingSchedulePeriod: [
              { startPeriod: 0, limit: maxW },
              { startPeriod: fallbackS, limit: 0 },
            ],
          },
        },
      },
      0,
    );
    return r.outcome === 'ok' ? statusOutcome(r.response?.['status']) : r.outcome;
  }

  /**
   * Phiên bắt đầu khi trụ online: ghi đè TxDefaultProfile bằng TxProfile không giới hạn, chỉ khi lần
   * kiểm mới nhất của trụ đã đặt TxDefaultProfile thành công.
   */
  async liftForOnlineSession(
    conn: Connection,
    connectorId: number,
    transactionId: number,
  ): Promise<string | null> {
    const { rows } = await this.db.$client.query<{ fallback_profile_status: string | null }>(
      `SELECT fallback_profile_status FROM charge_point_offline_auth_checks
       WHERE charge_point_id=$1 ORDER BY id DESC LIMIT 1`,
      [conn.chargePointId],
    );
    if (rows[0]?.fallback_profile_status !== 'Accepted') return null;
    const maxW = await this.maxPowerW(conn.chargePointId);
    const r = await this.call(
      conn,
      'SetChargingProfile',
      {
        connectorId,
        csChargingProfiles: {
          chargingProfileId: TX_PROFILE_ID_BASE + connectorId,
          transactionId,
          stackLevel: 0,
          chargingProfilePurpose: 'TxProfile',
          chargingProfileKind: 'Relative',
          chargingSchedule: {
            chargingRateUnit: 'W',
            chargingSchedulePeriod: [{ startPeriod: 0, limit: maxW }],
          },
        },
      },
      connectorId,
    );
    const status = r.outcome === 'ok' ? statusOutcome(r.response?.['status']) : r.outcome;
    if (status !== 'Accepted')
      this.logger.warn(
        `T150 ${conn.identity} tx ${transactionId}: TxProfile ${status} — phiên online có thể bị cắt công suất`,
      );
    return status;
  }

  /** Gửi một lệnh, ghi `remote_commands` trước và sau. Không ném. */
  private async call(
    conn: Connection,
    action: string,
    payload: Record<string, unknown>,
    connectorNo: number | null,
  ): Promise<CallResult> {
    let commandId: string | null = null;
    try {
      const { rows } = await this.db.$client.query<{ id: string }>(
        `INSERT INTO remote_commands(charge_point_id,connector_no,action,payload,status,sent_at)
         VALUES($1,$2,$3,$4,'sent',now()) RETURNING id::text`,
        [conn.chargePointId, connectorNo, action, JSON.stringify(payload)],
      );
      commandId = rows[0]!.id;
    } catch (err) {
      this.logger.error(
        `T150 ${conn.identity}: không ghi được remote_commands ${action}: ${String(err)}`,
      );
    }
    let result: CallResult;
    let error: string | null = null;
    try {
      const response = (await conn.client.call(action, payload, {
        callTimeoutMs: this.timeoutMs,
      })) as Record<string, unknown> | null;
      result = { outcome: 'ok', response: response ?? {} };
    } catch (err) {
      const e = err as Error & { rpcErrorCode?: string };
      const timeout = !e.rpcErrorCode && /timeout/i.test(`${e.constructor?.name} ${e.message}`);
      result = { outcome: timeout ? 'timeout' : 'error', response: null };
      error = `${e.rpcErrorCode ?? e.constructor?.name ?? 'Error'}: ${e.message}`.slice(0, 500);
    }
    if (commandId !== null) {
      const status =
        result.outcome === 'timeout'
          ? 'timeout'
          : result.outcome === 'error'
            ? 'failed'
            : ['Rejected', 'NotSupported'].includes(String(result.response?.['status']))
              ? 'rejected'
              : 'accepted';
      await this.db.$client
        .query(
          `UPDATE remote_commands SET status=$2::remote_command_status,response=$3,error=$4,
             responded_at=CASE WHEN $2::text IN ('accepted','rejected') THEN greatest(now(),sent_at) END,updated_at=now()
           WHERE id=$1`,
          [commandId, status, result.response ? JSON.stringify(result.response) : null, error],
        )
        .catch((err: unknown) =>
          this.logger.error(
            `T150 ${conn.identity}: không cập nhật remote_commands ${commandId}: ${String(err)}`,
          ),
        );
    }
    return result;
  }
}

/** `configurationKey[]` + `unknownKey[]` → map theo {@link READ_KEYS}; key không trả = null. */
export function parseConfiguration(
  response: Record<string, unknown> | null,
): Record<string, ConfigValue | null> {
  const out: Record<string, ConfigValue | null> = {};
  for (const k of READ_KEYS) out[k] = null;
  const list = Array.isArray(response?.['configurationKey']) ? response['configurationKey'] : [];
  for (const item of list as { key?: unknown; value?: unknown; readonly?: unknown }[]) {
    if (typeof item?.key !== 'string' || !(READ_KEYS as readonly string[]).includes(item.key))
      continue;
    out[item.key] = {
      value: typeof item.value === 'string' ? item.value : null,
      readonly: item.readonly === true,
    };
  }
  return out;
}

function statusOutcome(status: unknown): CommandOutcome {
  return status === 'Accepted' ||
    status === 'Rejected' ||
    status === 'RebootRequired' ||
    status === 'NotSupported'
    ? status
    : 'error';
}

export function hasSmartCharging(profiles: string | null): boolean {
  return (profiles ?? '')
    .split(',')
    .map((p) => p.trim())
    .includes('SmartCharging');
}

/**
 * null = cả ba key đã xác nhận false (đọc được "false", hoặc ChangeConfiguration Accepted). Ngược lại
 * lý do của key đầu tiên không xác nhận được.
 */
export function riskReasonOf(
  values: Record<string, ConfigValue | null>,
  changes: Record<string, CommandOutcome>,
): OfflineCardRiskReason | null {
  for (const key of OFFLINE_AUTH_KEYS) {
    if (isFalse(values[key])) continue;
    const c = changes[key];
    if (c === 'Accepted') continue;
    if (c === 'Rejected') return 'rejected';
    if (c === 'NotSupported') return values[key] ? 'not_supported' : 'key_missing';
    if (c === 'RebootRequired') return 'reboot_required';
    if (c === 'timeout') return 'no_response';
    return 'change_failed';
  }
  return null;
}
