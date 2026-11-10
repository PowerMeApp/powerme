/**
 * Cấu hình worker quét DB của billing (decisions D7, T32 Phần 12).
 *
 * - `enabled`: tắt cả vòng quét lẫn kick (instance phụ, test dựng AppModule).
 * - `intervalMs`: khoảng giữa hai vòng quét (1 s – 1 giờ; `setTimeout` quá 2^31−1 ms sẽ chạy sau 1 ms).
 *   Retry tính bằng phút; việc cần đúng giờ thì dùng `kickAt`.
 * - `batchSize`: số việc tối đa một loại xử lý trong một lần `runDue`.
 * - `leaseMs`: thời gian giữ chỗ một dòng. Phải dài hơn hẳn các lời gọi ngoài của một dòng
 *   (querydr + refund, mỗi lời gọi 10 s). Mỗi lease chỉ giữ một dòng (`due-rows.ts`).
 */
export const BACKGROUND_WORK_CONFIG = Symbol('BILLING_BACKGROUND_WORK_CONFIG');

/** Trần của `intervalMs`: 1 giờ. */
export const MAX_INTERVAL_MS = 3_600_000;

export interface BackgroundWorkConfig {
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
  leaseMs: number;
}

function fail(name: string, rule: string): never {
  throw new Error(`invalid_background_work_config: ${name} ${rule}`);
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    fail(name, `phải là số nguyên trong [${min}, ${max}]`);
  }
  return n;
}

export function loadBackgroundWorkConfig(
  env: NodeJS.ProcessEnv = process.env,
): BackgroundWorkConfig {
  const rawEnabled = env['BILLING_WORKER_ENABLED'];
  if (
    rawEnabled !== undefined &&
    rawEnabled !== '' &&
    rawEnabled !== 'true' &&
    rawEnabled !== 'false'
  ) {
    fail('BILLING_WORKER_ENABLED', 'phải là true hoặc false');
  }
  return {
    enabled: rawEnabled !== 'false',
    intervalMs: int(env, 'BILLING_WORKER_INTERVAL_MS', 30_000, 1_000, MAX_INTERVAL_MS),
    batchSize: int(env, 'BILLING_WORKER_BATCH_SIZE', 20, 1, 100),
    leaseMs: int(env, 'BILLING_WORKER_LEASE_MS', 120_000, 30_000, Number.MAX_SAFE_INTEGER),
  };
}
