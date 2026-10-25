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
