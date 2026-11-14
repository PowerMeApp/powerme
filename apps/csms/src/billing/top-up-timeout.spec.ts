/**
 * Unit test phần đăng ký / bảo vệ của vòng quét `top-up-timeout` (T32 Phần 8, D7), không cần DB:
 * `TopUpService` luôn tự đăng ký trong `onModuleInit`; thiếu cấu hình worker thì `runDue` ném lỗi rõ
 * thay vì giữ chỗ với `leaseMs` undefined (chốt Khang 14/11); VNPay chưa cấu hình thì không đụng DB.
 */
import { Logger } from '@nestjs/common';
import type { BackgroundWorkRunner } from './background-work.js';
import type { BackgroundWorkConfig } from './background-work.config.js';
import type { CreditLedgerService } from './credit-ledger.service.js';
import type { LoyaltyService } from './loyalty.service.js';
import {
  QUERYDR_FIRST_DELAY_MS,
  QUERYDR_SCHEDULE_MIN,
  TOP_UP_TIMEOUT_WORK,
  TopUpService,
} from './top-up.service.js';
import type { VnpayAdapter } from './vnpay.adapter.js';
import type { Db } from '../db/db.module.js';

const WORK: BackgroundWorkConfig = {
  enabled: true,
  intervalMs: 30_000,
  batchSize: 20,
  leaseMs: 120_000,
};

function make(opts: { configured: boolean; withConfig: boolean }) {
  const connect = jest.fn();
  const query = jest.fn();
  const db = { $client: { connect, query } } as unknown as Db;
  const queryTransaction = jest.fn();
  const vnpay = { configured: opts.configured, queryTransaction } as unknown as VnpayAdapter;
  const register = jest.fn();
  const runner = { register } as unknown as BackgroundWorkRunner;
  const service = new TopUpService(
    db,
    {} as CreditLedgerService,
    {} as LoyaltyService,
    vnpay,
    runner,
    opts.withConfig ? WORK : undefined,
  );
  return { service, register, connect, query, queryTransaction };
}

describe('TopUpService — việc nền top-up-timeout (T32 Phần 8)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('lịch querydr tính từ expires_at: +2, 5, 10, 20, 40, 60 phút; mốc đầu = QUERYDR_FIRST_DELAY_MS', () => {
    expect(QUERYDR_SCHEDULE_MIN).toEqual([2, 5, 10, 20, 40, 60]);
    expect(QUERYDR_SCHEDULE_MIN[0]! * 60_000).toBe(QUERYDR_FIRST_DELAY_MS);
  });

  it('onModuleInit đăng ký chính service với tên top-up-timeout', () => {
    const { service, register } = make({ configured: true, withConfig: true });
    service.onModuleInit();
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(service);
    expect(service.name).toBe(TOP_UP_TIMEOUT_WORK);
    expect(TOP_UP_TIMEOUT_WORK).toBe('top-up-timeout');
  });

  it('thiếu workConfig → runDue ném top_up_timeout_missing_config, không giữ chỗ, không gọi querydr', async () => {
    const { service, connect, query, queryTransaction } = make({
      configured: true,
      withConfig: false,
    });
    await expect(service.runDue(10, new AbortController().signal)).rejects.toThrow(
      'top_up_timeout_missing_config',
    );
    expect(connect).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(queryTransaction).not.toHaveBeenCalled();
  });

  it('VNPay chưa cấu hình → runDue trả 0, không đụng DB, warn đúng một lần mỗi tiến trình', async () => {
    const { service, connect, query, queryTransaction } = make({
      configured: false,
      withConfig: true,
    });
    const signal = new AbortController().signal;
    await expect(service.runDue(10, signal)).resolves.toBe(0);
    await expect(service.runDue(10, signal)).resolves.toBe(0);
    expect(connect).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(queryTransaction).not.toHaveBeenCalled();
    const events = warn.mock.calls.map((c) => String(c[0]));
    expect(events.filter((m) => m.includes('"event":"top_up_timeout_unconfigured"'))).toHaveLength(
      1,
    );
  });
});
