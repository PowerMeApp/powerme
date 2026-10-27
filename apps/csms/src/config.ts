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

export interface CsmsConfig {
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
  /** Cổng HTTP của console (0 = cổng ngẫu nhiên, dùng trong test). */
  consolePort: number;
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
   * ADR-0016 D-A (STM-1 v0.5): thời gian ân hạn (giây) kể từ khi socket đóng trước khi các phiên
   * active/paused/stopping bị kéo sang `orphaned` (#13–#15). Nối lại trong ân hạn thì phiên giữ
   * nguyên. `0` = orphan ngay (hành vi cũ). Không khai báo = {@link DEFAULT_OFFLINE_GRACE_S}.
   */
  offlineGraceS?: number;
}

/**
 * Mặc định của OFFLINE_GRACE_S: 120 s, WP1 chốt ngày 26/10/2026 (ADR-0016, mục "Grace value").
 * 30 s cũ là giá trị tạm của PR T61, quá sát lần thử nối lại đầu tiên của trụ nên rớt mạng
 * bình thường vẫn có thể bị orphan. Demo đặt ngắn hơn (run-demo.mjs).
 */
export const DEFAULT_OFFLINE_GRACE_S = 120;

/** Token DI cho CsmsConfig (dùng `@Inject(CONFIG)`). */
export const CONFIG = Symbol('CSMS_CONFIG');

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

/** Đọc cấu hình; ném lỗi sớm khi thiếu DATABASE_URL thay vì chết lúc query đầu tiên. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): CsmsConfig {
  const databaseUrl = env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('Thiếu DATABASE_URL (xem infra/.env.example)');
  return {
    databaseUrl,
    ocppPort: intEnv(env, 'OCPP_PORT', intEnv(env, 'CSMS_OCPP_WS_PORT', 9000)),
    heartbeatIntervalS: intEnv(env, 'OCPP_HEARTBEAT_INTERVAL_SECONDS', 300),
    sessionStartTimeoutS: intEnv(env, 'SESSION_START_TIMEOUT_S', 120),
    sessionHardCapH: intEnv(env, 'SESSION_HARD_CAP_H', 24),
    replaySkewThresholdS: intEnv(env, 'REPLAY_SKEW_THRESHOLD_S', 5),
    meterValueSampleIntervalS: intEnv(env, 'METER_VALUE_SAMPLE_INTERVAL_S', 10),
    reconcileGapFactor: intEnv(env, 'RECONCILE_GAP_FACTOR', 3),
    reconcileEnergyToleranceWh: intEnv(env, 'RECONCILE_ENERGY_TOLERANCE_WH', 1),
    consoleEnabled: boolEnv(env, 'CONSOLE_ENABLED', true),
    consoleHost: env['CONSOLE_HOST'] || '127.0.0.1',
    consolePort: intEnv(env, 'CONSOLE_PORT', 3000),
    ...(env['OCPP_PUBLIC_URL'] ? { ocppPublicUrl: env['OCPP_PUBLIC_URL'] } : {}),
    allowLegacyNoCredential: boolEnv(env, 'ALLOW_LEGACY_NO_CREDENTIAL', false),
    offlineGraceS: graceEnv(env, 'OFFLINE_GRACE_S', DEFAULT_OFFLINE_GRACE_S),
  };
}

/** Module Nest toàn cục cung cấp CONFIG cho mọi module khác. */
@Global()
@Module({
  providers: [{ provide: CONFIG, useFactory: () => loadConfig() }],
  exports: [CONFIG],
})
export class ConfigModule {}
