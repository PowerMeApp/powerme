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
}

/** Token DI cho CsmsConfig (dùng `@Inject(CONFIG)`). */
export const CONFIG = Symbol('CSMS_CONFIG');

function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Biến môi trường ${key} không phải số: "${raw}"`);
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
  };
}

/** Module Nest toàn cục cung cấp CONFIG cho mọi module khác. */
@Global()
@Module({
  providers: [{ provide: CONFIG, useFactory: () => loadConfig() }],
  exports: [CONFIG],
})
export class ConfigModule {}
