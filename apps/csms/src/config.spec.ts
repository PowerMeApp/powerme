/**
 * Test cho `loadConfig` — chỉ phần ALLOW_LEGACY_NO_CREDENTIAL (review PR #33, quyết định 2).
 * Mặc định phải là `false`: trụ không có credential bị từ chối, không phải "mở cho tiện".
 */
import { loadConfig } from './config.js';

const base = { DATABASE_URL: 'postgresql://x:x@localhost:5432/x' };

describe('loadConfig — ALLOW_LEGACY_NO_CREDENTIAL', () => {
  it('mặc định false khi không khai báo', () => {
    expect(loadConfig({ ...base }).allowLegacyNoCredential).toBe(false);
  });

  it('chuỗi rỗng cũng là false', () => {
    expect(loadConfig({ ...base, ALLOW_LEGACY_NO_CREDENTIAL: '' }).allowLegacyNoCredential).toBe(
      false,
    );
  });

  it.each(['true', '1', 'yes', 'on', 'TRUE'])('"%s" bật', (v) => {
    expect(loadConfig({ ...base, ALLOW_LEGACY_NO_CREDENTIAL: v }).allowLegacyNoCredential).toBe(
      true,
    );
  });

  it('giá trị lạ ném lỗi thay vì lặng lẽ mở', () => {
    expect(() => loadConfig({ ...base, ALLOW_LEGACY_NO_CREDENTIAL: 'maybe' })).toThrow(
      /true\/false/,
    );
  });
});

describe('loadConfig — OFFLINE_GRACE_S (ADR-0016 D-A)', () => {
  it('mặc định 120 giây (ADR-0016) khi không khai báo hoặc rỗng', () => {
    expect(loadConfig({ ...base }).offlineGraceS).toBe(120);
    expect(loadConfig({ ...base, OFFLINE_GRACE_S: '' }).offlineGraceS).toBe(120);
  });

  it('"0" hợp lệ = tắt ân hạn (orphan ngay)', () => {
    expect(loadConfig({ ...base, OFFLINE_GRACE_S: '0' }).offlineGraceS).toBe(0);
  });

  it('đọc số nguyên dương', () => {
    expect(loadConfig({ ...base, OFFLINE_GRACE_S: '20' }).offlineGraceS).toBe(20);
  });

  it.each(['-1', '1.5', 'abc', 'NaN'])('"%s" ném lỗi rõ ràng', (v) => {
    expect(() => loadConfig({ ...base, OFFLINE_GRACE_S: v })).toThrow(/OFFLINE_GRACE_S/);
  });
});

describe('loadConfig — FAULT_RESET_TIMEOUT_S (WF-04, STM-6 t6)', () => {
  it('mặc định 120 giây khi không khai báo hoặc rỗng', () => {
    expect(loadConfig({ ...base }).faultResetTimeoutS).toBe(120);
    expect(loadConfig({ ...base, FAULT_RESET_TIMEOUT_S: '' }).faultResetTimeoutS).toBe(120);
  });

  it('đọc số nguyên dương', () => {
    expect(loadConfig({ ...base, FAULT_RESET_TIMEOUT_S: '45' }).faultResetTimeoutS).toBe(45);
  });

  it.each(['0', '-1', '1.5', 'abc'])('"%s" ném lỗi rõ ràng (hạn chờ phải > 0)', (v) => {
    expect(() => loadConfig({ ...base, FAULT_RESET_TIMEOUT_S: v })).toThrow(
      /FAULT_RESET_TIMEOUT_S/,
    );
  });
});
