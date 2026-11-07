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

describe('loadConfig — RECONCILIATION_ENABLED (G6, ablation)', () => {
  it('mặc định true khi không khai báo hoặc rỗng', () => {
    expect(loadConfig({ ...base }).reconciliationEnabled).toBe(true);
    expect(loadConfig({ ...base, RECONCILIATION_ENABLED: '' }).reconciliationEnabled).toBe(true);
  });

  it.each(['false', '0', 'off', 'NO'])('"%s" tắt engine đối soát', (v) => {
    expect(loadConfig({ ...base, RECONCILIATION_ENABLED: v }).reconciliationEnabled).toBe(false);
  });

  it('giá trị rác ném lỗi nêu tên biến', () => {
    expect(() => loadConfig({ ...base, RECONCILIATION_ENABLED: 'maybe' })).toThrow(
      /RECONCILIATION_ENABLED/,
    );
  });
});

describe('loadConfig — SESSION_START_TIMEOUT_S / SESSION_HARD_CAP_H (BE-18)', () => {
  it('mặc định 120 giây và 24 giờ', () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.sessionStartTimeoutS).toBe(120);
    expect(cfg.sessionHardCapH).toBe(24);
  });

  it('nhận giá trị hợp lệ, hard cap cho phép số giờ lẻ', () => {
    const cfg = loadConfig({ ...base, SESSION_START_TIMEOUT_S: '90', SESSION_HARD_CAP_H: '0.5' });
    expect(cfg.sessionStartTimeoutS).toBe(90);
    expect(cfg.sessionHardCapH).toBe(0.5);
  });

  it.each(['0', '-1', '1.5', 'abc'])('SESSION_START_TIMEOUT_S="%s" ném lỗi', (v) => {
    expect(() => loadConfig({ ...base, SESSION_START_TIMEOUT_S: v })).toThrow(
      /SESSION_START_TIMEOUT_S/,
    );
  });

  it.each(['0', '-3', 'abc'])('SESSION_HARD_CAP_H="%s" ném lỗi', (v) => {
    expect(() => loadConfig({ ...base, SESSION_HARD_CAP_H: v })).toThrow(/SESSION_HARD_CAP_H/);
  });
});
