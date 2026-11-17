/**
 * Unit test phần thuần của hoá đơn điện tử (T32 Phần 7, D5), không cần DB: thuế suất theo thời điểm
 * thu tiền (mốc 01/01/2027 giờ Việt Nam), tách VAT bằng số nguyên, số hoá đơn giả, cấu hình stub,
 * timeout 10 s bọc ngoài nhà cung cấp, đăng ký việc nền `e-invoice-issue`.
 */
import { Logger } from '@nestjs/common';
import type { Db } from '../db/db.module.js';
import type { BackgroundWorkRunner } from './background-work.js';
import type { BackgroundWorkConfig } from './background-work.config.js';
import {
  callProvider,
  EINVOICE_PROVIDER_TIMEOUT_MS,
  EInvoiceInput,
  EInvoiceProviderAdapter,
  loadEInvoiceStubConfig,
  StubEInvoiceProvider,
} from './e-invoice-provider.js';
import { E_INVOICE_ISSUE_WORK, EInvoiceService } from './e-invoice.service.js';
import { splitVat, stubInvoiceNo, VAT_RATE_CHANGE_AT, vatRateAt } from './e-invoice.js';

const INPUT: EInvoiceInput = {
  idempotencyKey: '42',
  description: 'Trả trước dịch vụ sạc xe điện',
  amountVnd: 100_000,
  vatRate: 8,
  vatAmountVnd: 7_407,
  paidAt: new Date('2026-11-17T08:00:00+07:00'),
};

describe('vatRateAt — thuế suất theo thời điểm thu tiền (giờ Việt Nam)', () => {
  it('mốc = 2027-01-01T00:00:00+07:00 = 2026-12-31T17:00:00Z', () => {
    expect(VAT_RATE_CHANGE_AT.toISOString()).toBe('2026-12-31T17:00:00.000Z');
  });

  it.each([
    ['2026-11-17T08:00:00+07:00', 8],
    ['2026-12-31T23:59:59.999+07:00', 8],
    ['2026-12-31T16:59:59.999Z', 8],
    ['2027-01-01T00:00:00+07:00', 10],
    // 17:30 UTC ngày 31/12 đã là 00:30 ngày 01/01 ở Việt Nam.
    ['2026-12-31T17:30:00Z', 10],
    ['2027-06-01T12:00:00+07:00', 10],
  ])('%s → %i%%', (iso, rate) => {
    expect(vatRateAt(new Date(iso))).toBe(rate);
  });

  it('ngày không hợp lệ → RangeError', () => {
    expect(() => vatRateAt(new Date('x'))).toThrow(RangeError);
  });
});

describe('splitVat — phần thuế nằm trong tổng đã gồm VAT, làm tròn nửa lên', () => {
  it.each([
    [100_000, 8, 7_407], // 7 407,41
    [100_000, 10, 9_091], // 9 090,91
    [25_000, 8, 1_852], // 1 851,85 (50 000 trả nửa bằng điểm)
    [50_000, 10, 4_545], // 4 545,45
    [2_000_000, 8, 148_148], // trần một lần nạp BR-P22
    [2_000_000, 10, 181_818],
    [108, 8, 8], // vừa đúng
    [54, 8, 4], // 4,0
    [1, 8, 0],
    [0, 8, 0],
  ])('%i VND, %i%% → %i', (amount, rate, vat) => {
    expect(splitVat(amount, rate)).toBe(vat);
  });

  it('khớp round(a·r/(100+r)) trên một dải số; thuế suất 0 → 0', () => {
    // Với số nguyên a và r ∈ {5, 8, 10} không có ca ",5" chính xác (2·a·r = (2k+1)(100+r) vô
    // nghiệm), nên so với làm tròn thường bằng số thực trên dải nhỏ là đủ.
    for (let a = 0; a <= 5_000; a += 7)
      for (const r of [5, 8, 10])
        expect(splitVat(a, r)).toBe(Math.floor((a * r) / (100 + r) + 0.5));
    expect(splitVat(500, 0)).toBe(0);
  });

  it('số lớn gần trần Number vẫn đúng (BigInt, không tràn)', () => {
    const big = Number.MAX_SAFE_INTEGER;
    expect(splitVat(big, 10)).toBe(Number((2n * BigInt(big) * 10n + 110n) / 220n));
  });

  it.each([
    [-1, 8],
    [1.5, 8],
    [100, 7],
    [100, 100],
  ])('đầu vào sai (%p, %p) → RangeError', (a, r) => {
    expect(() => splitVat(a, r)).toThrow(RangeError);
  });
});

describe('stubInvoiceNo', () => {
  it('ổn định theo khoá, khác khoá khác số, ≤ 20 ký tự kể cả id lớn nhất', () => {
    expect(stubInvoiceNo('42')).toBe(stubInvoiceNo('42'));
    expect(stubInvoiceNo('42')).not.toBe(stubInvoiceNo('43'));
    expect(stubInvoiceNo('42')).toBe('STUB-16');
    const max = stubInvoiceNo(String(2n ** 63n - 1n));
    expect(max.length).toBeLessThanOrEqual(20);
  });

  it.each(['', '0', '-1', 'abc', '01', String(2n ** 63n)])('khoá sai %p → RangeError', (k) => {
    expect(() => stubInvoiceNo(k)).toThrow(RangeError);
  });
});

describe('loadEInvoiceStubConfig', () => {
  it('mặc định success, không trễ', () => {
    expect(loadEInvoiceStubConfig({})).toEqual({ mode: 'success', delayMs: 0 });
    expect(loadEInvoiceStubConfig({ EINVOICE_STUB_MODE: '', EINVOICE_STUB_DELAY_MS: '' })).toEqual({
      mode: 'success',
      delayMs: 0,
    });
  });

  it.each(['success', 'transient', 'data'])('mode %s', (mode) => {
    expect(
      loadEInvoiceStubConfig({ EINVOICE_STUB_MODE: mode, EINVOICE_STUB_DELAY_MS: '250' }),
    ).toEqual({ mode, delayMs: 250 });
  });

  it.each([
    [{ EINVOICE_STUB_MODE: 'ok' }],
    [{ EINVOICE_STUB_MODE: 'SUCCESS' }],
    [{ EINVOICE_STUB_DELAY_MS: '-1' }],
    [{ EINVOICE_STUB_DELAY_MS: '1.5' }],
    [{ EINVOICE_STUB_DELAY_MS: 'abc' }],
    [{ EINVOICE_STUB_DELAY_MS: '60001' }],
  ])('giá trị sai %p → invalid_einvoice_config', (env) => {
    expect(() => loadEInvoiceStubConfig(env)).toThrow('invalid_einvoice_config');
  });
});

describe('StubEInvoiceProvider', () => {
  const signal = new AbortController().signal;

  it('success → số hoá đơn suy từ khoá; gọi lại cùng khoá → cùng số', async () => {
    const stub = new StubEInvoiceProvider({ mode: 'success', delayMs: 0 });
    const a = await stub.createInvoice(INPUT, signal);
    expect(a).toEqual({ kind: 'issued', invoiceNo: stubInvoiceNo('42') });
    expect(await stub.createInvoice(INPUT, signal)).toEqual(a);
  });

  it.each(['transient', 'data'] as const)('%s → lỗi cùng loại', async (mode) => {
    const r = await new StubEInvoiceProvider({ mode, delayMs: 0 }).createInvoice(INPUT, signal);
    expect(r.kind).toBe(mode);
  });
});

describe('callProvider — timeout 10 s bọc ngoài nhà cung cấp', () => {
  afterEach(() => jest.useRealTimers());

  it('hằng timeout = 10 000 ms (D5)', () => {
    expect(EINVOICE_PROVIDER_TIMEOUT_MS).toBe(10_000);
  });

  it('nhà cung cấp treo (không tôn trọng signal) quá 10 s → transient provider_timeout, signal bị huỷ', async () => {
    jest.useFakeTimers();
    let seen: AbortSignal | undefined;
    const hang: EInvoiceProviderAdapter = {
      createInvoice: (_i, s) => {
        seen = s;
        return new Promise(() => undefined);
      },
    };
    const p = callProvider(hang, INPUT);
    await jest.advanceTimersByTimeAsync(EINVOICE_PROVIDER_TIMEOUT_MS - 1);
    expect(seen!.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toEqual({ kind: 'transient', message: 'provider_timeout' });
    expect(seen!.aborted).toBe(true);
  });

  it('stub có độ trễ 60 s → transient sau 10 s', async () => {
    jest.useFakeTimers();
    const p = callProvider(new StubEInvoiceProvider({ mode: 'success', delayMs: 60_000 }), INPUT);
    await jest.advanceTimersByTimeAsync(EINVOICE_PROVIDER_TIMEOUT_MS);
    await expect(p).resolves.toEqual({ kind: 'transient', message: 'provider_timeout' });
  });

  it('trả kịp trước 10 s → kết quả của nhà cung cấp', async () => {
    const ok: EInvoiceProviderAdapter = {
      createInvoice: async () => ({ kind: 'issued', invoiceNo: ' INV-1 ' }),
    };
    await expect(callProvider(ok, INPUT)).resolves.toEqual({ kind: 'issued', invoiceNo: 'INV-1' });
  });

  it('nhà cung cấp ném → transient kèm message', async () => {
    const boom: EInvoiceProviderAdapter = {
      createInvoice: async () => {
        throw new Error('ECONNRESET');
      },
    };
    await expect(callProvider(boom, INPUT)).resolves.toEqual({
      kind: 'transient',
      message: 'ECONNRESET',
    });
  });

  it.each(['', '   ', 'X'.repeat(21)])(
    'số hoá đơn %p không ghi được vào varchar(20) → data invalid_invoice_no',
    async (no) => {
      const bad: EInvoiceProviderAdapter = {
        createInvoice: async () => ({ kind: 'issued', invoiceNo: no }),
      };
      const r = await callProvider(bad, INPUT);
      expect(r.kind).toBe('data');
      expect(r.kind === 'data' && r.message).toMatch(/^invalid_invoice_no/);
    },
  );

  it('signal của worker huỷ (shutdown) → adapter thấy signal huỷ', async () => {
    const ctrl = new AbortController();
    const stub = new StubEInvoiceProvider({ mode: 'success', delayMs: 60_000 });
    const p = callProvider(stub, INPUT, ctrl.signal);
    ctrl.abort();
    await expect(p).resolves.toMatchObject({ kind: 'transient' });
  });
});

describe('EInvoiceService — việc nền e-invoice-issue (đăng ký, cấu hình)', () => {
  const WORK: BackgroundWorkConfig = {
    enabled: true,
    intervalMs: 30_000,
    batchSize: 20,
    leaseMs: 120_000,
  };

  function make(withConfig: boolean) {
    const connect = jest.fn();
    const query = jest.fn();
    const db = { $client: { connect, query } } as unknown as Db;
    const register = jest.fn();
    const kick = jest.fn();
    const runner = { register, kick } as unknown as BackgroundWorkRunner;
    const provider = { createInvoice: jest.fn() };
    const service = new EInvoiceService(db, provider, runner, withConfig ? WORK : undefined);
    return { service, register, kick, connect, query, provider };
  }

  it('onModuleInit đăng ký chính service với tên e-invoice-issue', () => {
    const { service, register } = make(true);
    service.onModuleInit();
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(service);
    expect(service.name).toBe(E_INVOICE_ISSUE_WORK);
    expect(E_INVOICE_ISSUE_WORK).toBe('e-invoice-issue');
  });

  it('kickIssue → runner.kick(e-invoice-issue)', () => {
    const { service, kick } = make(true);
    service.kickIssue();
    expect(kick).toHaveBeenCalledWith('e-invoice-issue');
  });

  it('thiếu workConfig → runDue ném e_invoice_issue_missing_config, không giữ chỗ, không gọi nhà cung cấp', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, connect, query, provider } = make(false);
    await expect(service.runDue(10, new AbortController().signal)).rejects.toThrow(
      'e_invoice_issue_missing_config',
    );
    expect(connect).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(provider.createInvoice).not.toHaveBeenCalled();
  });
});
