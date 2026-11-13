/**
 * Cấu hình CSMS đọc từ biến môi trường — một chỗ duy nhất, không rải `process.env` khắp code.
 *
 * Vì sao tồn tại: T13 mục 1.3 chốt ba timeout của state machine phiên là BIẾN MÔI TRƯỜNG,
 * không phải bảng cấu hình trong DB. `infra/.env.example` là nơi ghi giá trị mẫu.
 *
 * Liên quan: T13 (SESSION_START_TIMEOUT_S, SESSION_HARD_CAP_H, REPLAY_SKEW_THRESHOLD_S),
 * ADR-0009 (ngưỡng skew là tín hiệu phụ phát hiện phát lại), ADR-0008 (DATABASE_URL cho Drizzle).
 */
import { Global, Module } from '@nestjs/common';
import { SmartSearchConfig, loadSmartSearchConfig } from './sessions/smart-search.js';
import { DriverApiConfig, loadDriverApiConfig } from './driver/driver-auth.js';

export const DEFAULT_REPLAY_SKEW_S = 5;

export interface CsmsConfig {
  driverApi?: DriverApiConfig;
  smartSearch?: SmartSearchConfig;
  /** Chuỗi kết nối Postgres. Bắt buộc khi chạy app; test unit không cần. */
  databaseUrl: string;
  /** Cổng WebSocket OCPP-J. Lab dùng 9000 (`ws://localhost:9000/ocpp/{serialNumber}`). */
  ocppPort: number;
  /** `interval` trả trong BootNotification.conf — nhịp Heartbeat trụ phải giữ. */
  heartbeatIntervalS: number;
  /** T13 #4: pending quá ngưỡng này mà chưa có StartTransaction → failed. */
  sessionStartTimeoutS: number;
  /** T13 #16a: orphaned quá ngưỡng này mà không có StopTransaction → review. */
  sessionHardCapH: number;
  /** ADR-0009 / T13: received_at − cp_timestamp vượt ngưỡng này là ứng viên phát lại. */
  replaySkewThresholdS: number;
  tariffClockToleranceS?: number;
  /** MeterValueSampleInterval của trụ (SAP template powerme-d1: 10 s). */
  meterValueSampleIntervalS: number;
  /** Lỗ hổng chuỗi MeterValues = khoảng cách hai mẫu > gapFactor × sampleInterval. */
  reconcileGapFactor: number;
  /** Dung sai Wh khi so meterStop với mẫu cuối (bù làm tròn Wh thập phân của trụ). */
  reconcileEnergyToleranceWh: number;
  /** Bảng điều khiển vận hành (BE-08): bật/tắt. Mặc định bật. */
  consoleEnabled: boolean;
  /** Host bind của console. Mặc định 127.0.0.1 vì CHƯA có xác thực — không bind 0.0.0.0. */
  consoleHost: string;
  /**
   * Cho phép console/Driver API bind host không phải loopback (vd `0.0.0.0` trong container Docker).
   * Mặc định false: `ConsoleServer.start()` từ chối. Chỉ đặt true khi mạng bên ngoài đã chặn (cổng
   * publish chỉ ra 127.0.0.1, reverse proxy không chuyển tiếp console) — xem infra/staging/docker-compose.yml.
   */
  consoleAllowNonLoopback?: boolean;
  /** Cổng HTTP của console (0 = cổng ngẫu nhiên, dùng trong test). */
  consolePort: number;
  /**
   * WF-05 (T119): user id of the Admin the console acts as for `POST /api/admin/charge-points`.
   * No default: not set → that route returns 503. Interim until RolesGuard (T103) uses the
   * logged-in user instead; the service still checks the role of this id.
   */
  consoleActorAdminId?: number | null;
  /** WF-05 (T119): user id of the operator staff for `POST /api/operator/charge-points/onboard`. */
  consoleActorStaffId?: number | null;
  /**
   * WF-05: public OCPP base URL given to the operator at onboarding (e.g.
   * `wss://staging.powerme.vn/ocpp`). Optional; default `ws://localhost:{ocppPort}/ocpp`.
   */
  ocppPublicUrl?: string;
  /**
   * Cho phép trụ CHƯA có credential (seed trước WF-05, trace WF-03) kết nối không cần Basic auth.
   * Mặc định `false`: trụ không có hash bị từ chối 401. `npm run demo` đặt `true` vì seed demo
   * chưa đi qua `onboard()`. KHÔNG bật trên staging/production — ai biết serial là vào được.
   * (Review PR #33, quyết định 2.) Không khai báo = false.
   */
  allowLegacyNoCredential?: boolean;
  /**
   * G6 / BM02 F30 (thí nghiệm ablation): bật/tắt engine đối soát. Tắt = tin `meterStop` của trụ,
   * không ghi `reconciliation_records` (xem đầu `reconciliation.service.ts`). Không khai báo = true.
   */
  reconciliationEnabled?: boolean;
  /**
   * CSMS đứng sau reverse proxy (Caddy trên staging): IP trụ cho bộ giới hạn đăng nhập sai (#40)
   * lấy từ giá trị cuối của X-Forwarded-For thay vì địa chỉ socket. Không khai báo = false.
   */
  ocppTrustProxy?: boolean;
  /**
   * ADR-0016 D-A (STM-1 v0.5; bản vẽ lại v1.0): thời gian ân hạn (giây) kể từ khi socket đóng trước khi các phiên
   * active/paused/stopping bị kéo sang `orphaned` (#13–#15). Nối lại trong ân hạn thì phiên giữ
   * nguyên. `0` = orphan ngay (hành vi cũ). Không khai báo = {@link DEFAULT_OFFLINE_GRACE_S}.
   */
  offlineGraceS?: number;
  /**
   * WF-04 / STM-6 t6 (FE-04): hạn chờ (giây) sau khi gửi Reset từ xa. Hết hạn mà súng chưa báo
   * Available thì sự cố `resetting → acknowledged` và lệnh `remote_commands` thành `timeout`.
   * Không khai báo = {@link DEFAULT_FAULT_RESET_TIMEOUT_S}.
   */
  faultResetTimeoutS?: number;
  /**
   * G10 / NFR-OCPP-07 (FE-10): số giây trụ `in_service` im lặng (không frame nào) trước khi mở một
   * FaultEvent `Offline` cho cả trụ. Không khai báo = {@link DEFAULT_OFFLINE_ALERT_S}.
   */
  offlineAlertS?: number;
  /** G10: nhịp quét trụ im lặng (giây). Không khai báo = {@link DEFAULT_OFFLINE_ALERT_SWEEP_S}. */
  offlineAlertSweepS?: number;
}

/**
 * Mặc định của OFFLINE_GRACE_S: 120 s, WP1 chốt ngày 26/10/2026 (ADR-0016, mục "Grace value").
 * 30 s cũ là giá trị tạm của PR T61, quá sát lần thử nối lại đầu tiên của trụ nên rớt mạng
 * bình thường vẫn có thể bị orphan. Demo đặt ngắn hơn (run-demo.mjs).
 */
export const DEFAULT_OFFLINE_GRACE_S = 120;

/**
 * Mặc định của FAULT_RESET_TIMEOUT_S: 120 s = trụ khởi động lại + BootNotification +
 * StatusNotification (WF-04 câu hỏi mở 3, đề xuất của FE-04; simulator D1 khởi động lại ~3 s).
 */
export const DEFAULT_FAULT_RESET_TIMEOUT_S = 120;

/**
 * Mặc định của OFFLINE_ALERT_S: 900 s = ngưỡng của NFR-OCPP-07 (SRS §3.1.4 dòng 13, Commitment
 * NFR-06), tức 3 nhịp Heartbeat 300 s. Khác OFFLINE_GRACE_S (120 s, chỉ quyết định phiên orphan).
 */
export const DEFAULT_OFFLINE_ALERT_S = 900;

/** Mặc định của OFFLINE_ALERT_SWEEP_S: 60 s → cảnh báo chậm nhất 900 + 60 s sau frame cuối. */
export const DEFAULT_OFFLINE_ALERT_SWEEP_S = 60;

/** Token DI cho CsmsConfig (dùng `@Inject(CONFIG)`). */
export const CONFIG = Symbol('CSMS_CONFIG');

export const DEFAULT_TARIFF_CLOCK_TOLERANCE_S = 300;

function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Biến môi trường ${key} không phải số: "${raw}"`);
  return n;
}

function boolEnv(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`Biến môi trường ${key} không phải true/false: "${env[key]}"`);
}

/** Số nguyên giây >= 0 (0 hợp lệ = tắt ân hạn). Âm / thập phân / không phải số → ném lỗi rõ. */
function graceEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const n = intEnv(env, key, fallback);
  if (!Number.isInteger(n) || n < 0)
    throw new Error(
      `Biến môi trường ${key} phải là số nguyên giây >= 0 (0 = tắt ân hạn): "${env[key]}"`,
    );
  return n;
}

/** Số nguyên giây > 0. 0 / âm / thập phân / không phải số → ném lỗi rõ. */
function positiveSecondsEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const n = intEnv(env, key, fallback);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`Biến môi trường ${key} phải là số nguyên giây > 0: "${env[key]}"`);
  return n;
}

/**
 * Số giờ > 0 (cho phép lẻ, vd 0.5). BE-18: 0 hoặc âm sẽ khiến bộ quét hard cap đẩy mọi phiên
 * orphaned sang review ngay, nên từ chối khi khởi động thay vì chạy sai âm thầm.
 */
function positiveHoursEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const n = intEnv(env, key, fallback);
  if (n <= 0) throw new Error(`Biến môi trường ${key} phải là số giờ > 0: "${env[key]}"`);
  return n;
}

/** Optional positive integer id; unset/empty → null. */
function optionalIdEnv(env: NodeJS.ProcessEnv, key: string): number | null {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1)
    throw new Error(`Biến môi trường ${key} phải là số nguyên dương (user id): "${env[key]}"`);
  return n;
}

/** Đọc cấu hình; ném lỗi sớm khi thiếu DATABASE_URL thay vì chết lúc query đầu tiên. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): CsmsConfig {
  const databaseUrl = env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('Thiếu DATABASE_URL (xem infra/.env.example)');
  return {
    driverApi: loadDriverApiConfig(env),
    smartSearch: loadSmartSearchConfig(env),
    databaseUrl,
    ocppPort: intEnv(env, 'OCPP_PORT', intEnv(env, 'CSMS_OCPP_WS_PORT', 9000)),
    heartbeatIntervalS: intEnv(env, 'OCPP_HEARTBEAT_INTERVAL_SECONDS', 300),
    sessionStartTimeoutS: positiveSecondsEnv(env, 'SESSION_START_TIMEOUT_S', 120),
    sessionHardCapH: positiveHoursEnv(env, 'SESSION_HARD_CAP_H', 24),
    replaySkewThresholdS: intEnv(env, 'REPLAY_SKEW_THRESHOLD_S', DEFAULT_REPLAY_SKEW_S),
    tariffClockToleranceS: positiveSecondsEnv(
      env,
      'TARIFF_CLOCK_TOLERANCE_S',
      DEFAULT_TARIFF_CLOCK_TOLERANCE_S,
    ),
    meterValueSampleIntervalS: intEnv(env, 'METER_VALUE_SAMPLE_INTERVAL_S', 10),
    reconcileGapFactor: intEnv(env, 'RECONCILE_GAP_FACTOR', 3),
    reconcileEnergyToleranceWh: intEnv(env, 'RECONCILE_ENERGY_TOLERANCE_WH', 1),
    consoleEnabled: boolEnv(env, 'CONSOLE_ENABLED', true),
    consoleHost: env['CONSOLE_HOST'] || '127.0.0.1',
    consoleAllowNonLoopback: boolEnv(env, 'CONSOLE_ALLOW_NON_LOOPBACK', false),
    consolePort: intEnv(env, 'CONSOLE_PORT', 3000),
    consoleActorAdminId: optionalIdEnv(env, 'CONSOLE_ACTOR_ADMIN_ID'),
    consoleActorStaffId: optionalIdEnv(env, 'CONSOLE_ACTOR_STAFF_ID'),
    ...(env['OCPP_PUBLIC_URL'] ? { ocppPublicUrl: env['OCPP_PUBLIC_URL'] } : {}),
    allowLegacyNoCredential: boolEnv(env, 'ALLOW_LEGACY_NO_CREDENTIAL', false),
    reconciliationEnabled: boolEnv(env, 'RECONCILIATION_ENABLED', true),
    ocppTrustProxy: boolEnv(env, 'OCPP_TRUST_PROXY', false),
    offlineGraceS: graceEnv(env, 'OFFLINE_GRACE_S', DEFAULT_OFFLINE_GRACE_S),
    faultResetTimeoutS: positiveSecondsEnv(
      env,
      'FAULT_RESET_TIMEOUT_S',
      DEFAULT_FAULT_RESET_TIMEOUT_S,
    ),
    offlineAlertS: positiveSecondsEnv(env, 'OFFLINE_ALERT_S', DEFAULT_OFFLINE_ALERT_S),
    offlineAlertSweepS: positiveSecondsEnv(
      env,
      'OFFLINE_ALERT_SWEEP_S',
      DEFAULT_OFFLINE_ALERT_SWEEP_S,
    ),
  };
}

/** Module Nest toàn cục cung cấp CONFIG cho mọi module khác. */
@Global()
@Module({
  providers: [{ provide: CONFIG, useFactory: () => loadConfig() }],
  exports: [CONFIG],
})
export class ConfigModule {}
