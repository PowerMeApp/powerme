import { loadBackgroundWorkConfig } from './background-work.config.js';

describe('loadBackgroundWorkConfig', () => {
  it('mặc định', () => {
    expect(loadBackgroundWorkConfig({})).toEqual({
      enabled: true,
      intervalMs: 30000,
      batchSize: 20,
      leaseMs: 120000,
    });
  });

  it('đọc biến môi trường', () => {
    expect(
      loadBackgroundWorkConfig({
        BILLING_WORKER_ENABLED: 'false',
        BILLING_WORKER_INTERVAL_MS: '1000',
        BILLING_WORKER_BATCH_SIZE: '100',
        BILLING_WORKER_LEASE_MS: '30000',
      }),
    ).toEqual({ enabled: false, intervalMs: 1000, batchSize: 100, leaseMs: 30000 });
    expect(loadBackgroundWorkConfig({ BILLING_WORKER_ENABLED: 'true' }).enabled).toBe(true);
    expect(loadBackgroundWorkConfig({ BILLING_WORKER_INTERVAL_MS: '3600000' }).intervalMs).toBe(
      3_600_000,
    );
  });

  it('chuỗi rỗng ở cả 4 biến → mặc định', () => {
    expect(
      loadBackgroundWorkConfig({
        BILLING_WORKER_ENABLED: '',
        BILLING_WORKER_INTERVAL_MS: '',
        BILLING_WORKER_BATCH_SIZE: '',
        BILLING_WORKER_LEASE_MS: '',
      }),
    ).toEqual(loadBackgroundWorkConfig({}));
  });

  it.each([
    ['BILLING_WORKER_ENABLED', 'yes'],
    ['BILLING_WORKER_INTERVAL_MS', '999'],
    ['BILLING_WORKER_INTERVAL_MS', 'abc'],
    ['BILLING_WORKER_INTERVAL_MS', '3600001'],
    ['BILLING_WORKER_BATCH_SIZE', '0'],
    ['BILLING_WORKER_BATCH_SIZE', '101'],
    ['BILLING_WORKER_BATCH_SIZE', '1.5'],
    ['BILLING_WORKER_LEASE_MS', '29999'],
  ])('từ chối %s=%s', (name, value) => {
    expect(() => loadBackgroundWorkConfig({ [name]: value })).toThrow(
      'invalid_background_work_config',
    );
  });
});
