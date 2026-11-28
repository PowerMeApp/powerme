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
  callAdjustProvider,
  callProvider,
  EINVOICE_PROVIDER_TIMEOUT_MS,
  EInvoiceAdjustmentInput,
  EInvoiceInput,
  EInvoiceProviderAdapter,
  loadEInvoiceStubConfig,
  StubEInvoiceProvider,
} from './e-invoice-provider.js';
import { INVOICE_ADJUSTMENT_ISSUE_WORK } from './e-invoice-rows.js';
import { E_INVOICE_ISSUE_WORK, EInvoiceService } from './e-invoice.service.js';
import {
  adjustmentVat,
  checkAdjustmentSendable,
  splitVat,
  STUB_ADJUSTMENT_KEY_MAX,
  stubAdjustmentNo,
  stubInvoiceNo,
  VAT_RATE_CHANGE_AT,
  vatRateAt,
} from './e-invoice.js';
import { InvoiceAdjustmentService } from './invoice-adjustment.service.js';

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
      adjustInvoice: jest.fn(),
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
      adjustInvoice: jest.fn(),
      createInvoice: async () => ({ kind: 'issued', invoiceNo: ' INV-1 ' }),
    };
    await expect(callProvider(ok, INPUT)).resolves.toEqual({ kind: 'issued', invoiceNo: 'INV-1' });
  });

  it('nhà cung cấp ném → transient kèm message', async () => {
    const boom: EInvoiceProviderAdapter = {
      adjustInvoice: jest.fn(),
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
        adjustInvoice: jest.fn(),
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
    const provider = { createInvoice: jest.fn(), adjustInvoice: jest.fn() };
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

// -------------------------------------------------------------------------------------------------
// T32 Phần 9b: hoá đơn điều chỉnh khi hoàn tiền (D5)
// -------------------------------------------------------------------------------------------------

const ADJ_INPUT: EInvoiceAdjustmentInput = {
  idempotencyKey: '42',
  originalInvoiceNo: 'STUB-1',
  adjustmentNo: 1,
  reason: 'Điều chỉnh giảm do hoàn tiền (refund 7)',
  amountVnd: -100_000,
  vatRate: 8,
  vatAmountVnd: -7_407,
  refundedAt: new Date('2026-11-25T08:00:00+07:00'),
};

describe('adjustmentVat — thuế của điều chỉnh giảm theo thuế suất hoá đơn gốc', () => {
  it.each([
    [-100_000, 8, -7_407],
    [-100_000, 10, -9_091],
    [-25_000, 8, -1_852],
    [-2_000_000, 10, -181_818],
  ])('%i @ %i%% → %i', (amount, rate, vat) => {
    expect(adjustmentVat(amount, rate)).toBe(vat);
  });

  it('0 → 0 (không phải −0)', () => {
    expect(Object.is(adjustmentVat(0, 8), 0)).toBe(true);
  });

  it('số dương / không nguyên / thuế suất sai → RangeError', () => {
    expect(() => adjustmentVat(1, 8)).toThrow(RangeError);
    expect(() => adjustmentVat(-1.5, 8)).toThrow(RangeError);
    expect(() => adjustmentVat(-100, 7)).toThrow(RangeError);
  });
});

describe('checkAdjustmentSendable — trần theo hoá đơn gốc và chờ gốc issued', () => {
  const base = {
    originalStatus: 'issued' as const,
    originalAmountVnd: 100_000,
    otherAdjustmentsAbsVnd: 0,
    amountVnd: -100_000,
  };

  it('gốc issued, đúng bằng số gốc → gửi được', () => {
    expect(checkAdjustmentSendable(base)).toBeNull();
  });

  it('cộng các điều chỉnh khác đúng bằng số gốc → gửi được', () => {
    expect(
      checkAdjustmentSendable({ ...base, otherAdjustmentsAbsVnd: 60_000, amountVnd: -40_000 }),
    ).toBeNull();
  });

  it('vượt 1 đồng → data adjustment_exceeds_original', () => {
    expect(checkAdjustmentSendable({ ...base, amountVnd: -100_001 })).toEqual({
      kind: 'data',
      message: 'adjustment_exceeds_original',
    });
    expect(
      checkAdjustmentSendable({ ...base, otherAdjustmentsAbsVnd: 60_001, amountVnd: -40_000 }),
    ).toEqual({ kind: 'data', message: 'adjustment_exceeds_original' });
  });

  it.each(['requested', 'failed', 'needs_review'] as const)(
    'gốc %s → transient original_not_issued',
    (originalStatus) => {
      expect(checkAdjustmentSendable({ ...base, originalStatus })).toEqual({
        kind: 'transient',
        message: 'original_not_issued',
      });
    },
  );

  it('vượt trần và gốc chưa issued → báo vượt trần (lỗi vĩnh viễn trước)', () => {
    expect(
      checkAdjustmentSendable({ ...base, originalStatus: 'failed', amountVnd: -100_001 }),
    ).toEqual({ kind: 'data', message: 'adjustment_exceeds_original' });
  });

  it.each([0, 1])('amount %i (không phải giảm) → data adjustment_not_decrease', (amountVnd) => {
    expect(checkAdjustmentSendable({ ...base, amountVnd })).toEqual({
      kind: 'data',
      message: 'adjustment_not_decrease',
    });
  });
});

describe('stubAdjustmentNo — số điều chỉnh giả của stub', () => {
  it('STUBADJ- + base36 chữ hoa, ổn định theo khoá', () => {
    expect(stubAdjustmentNo('42')).toBe('STUBADJ-16');
    expect(stubAdjustmentNo('42')).toBe(stubAdjustmentNo('42'));
    expect(stubAdjustmentNo('43')).not.toBe(stubAdjustmentNo('42'));
  });

  it('khoá lớn nhất cho phép (36^12 − 1) → đúng 20 ký tự', () => {
    expect(STUB_ADJUSTMENT_KEY_MAX).toBe(36n ** 12n - 1n);
    const no = stubAdjustmentNo(String(STUB_ADJUSTMENT_KEY_MAX));
    expect(no).toBe('STUBADJ-ZZZZZZZZZZZZ');
    expect(no.length).toBe(20);
  });

  it.each(['0', '-1', 'abc', '', String(36n ** 12n)])('khoá %p → RangeError', (key) => {
    expect(() => stubAdjustmentNo(key)).toThrow(RangeError);
  });
});

describe('StubEInvoiceProvider.adjustInvoice', () => {
  const signal = new AbortController().signal;

  it('success: idempotent theo khoá', async () => {
    const stub = new StubEInvoiceProvider({ mode: 'success', delayMs: 0 });
    const a = await stub.adjustInvoice(ADJ_INPUT, signal);
    expect(a).toEqual({ kind: 'issued', adjustmentNo: 'STUBADJ-16' });
    expect(await stub.adjustInvoice(ADJ_INPUT, signal)).toEqual(a);
  });

  it.each(['transient', 'data'] as const)('mode %s → lỗi cùng loại', async (mode) => {
    const r = await new StubEInvoiceProvider({ mode, delayMs: 0 }).adjustInvoice(ADJ_INPUT, signal);
    expect(r.kind).toBe(mode);
  });

  it('độ trễ dài → callAdjustProvider trả transient sau 10 s', async () => {
    jest.useFakeTimers();
    try {
      const p = callAdjustProvider(
        new StubEInvoiceProvider({ mode: 'success', delayMs: 60_000 }),
        ADJ_INPUT,
      );
      await jest.advanceTimersByTimeAsync(EINVOICE_PROVIDER_TIMEOUT_MS);
      await expect(p).resolves.toEqual({ kind: 'transient', message: 'provider_timeout' });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('callAdjustProvider — timeout 10 s và chuẩn hoá kết quả', () => {
  const adapter = (adjustInvoice: EInvoiceProviderAdapter['adjustInvoice']) =>
    ({ createInvoice: jest.fn(), adjustInvoice }) as EInvoiceProviderAdapter;

  afterEach(() => jest.useRealTimers());

  it('treo quá 10 s → transient provider_timeout, signal bị huỷ', async () => {
    jest.useFakeTimers();
    let seen: AbortSignal | undefined;
    const p = callAdjustProvider(
      adapter((_i, s) => {
        seen = s;
        return new Promise(() => undefined);
      }),
      ADJ_INPUT,
    );
    await jest.advanceTimersByTimeAsync(EINVOICE_PROVIDER_TIMEOUT_MS - 1);
    expect(seen!.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toEqual({ kind: 'transient', message: 'provider_timeout' });
    expect(seen!.aborted).toBe(true);
  });

  it('trả kịp → số đã trim', async () => {
    await expect(
      callAdjustProvider(
        adapter(async () => ({ kind: 'issued', adjustmentNo: ' ADJ-1 ' })),
        ADJ_INPUT,
      ),
    ).resolves.toEqual({ kind: 'issued', adjustmentNo: 'ADJ-1' });
  });

  it('adapter ném → transient kèm message', async () => {
    await expect(
      callAdjustProvider(
        adapter(async () => {
          throw new Error('ECONNRESET');
        }),
        ADJ_INPUT,
      ),
    ).resolves.toEqual({ kind: 'transient', message: 'ECONNRESET' });
  });

  it.each(['', '   ', 'X'.repeat(21)])(
    'số điều chỉnh %p không ghi được vào varchar(20) → data invalid_adjustment_no',
    async (no) => {
      const r = await callAdjustProvider(
        adapter(async () => ({ kind: 'issued', adjustmentNo: no })),
        ADJ_INPUT,
      );
      expect(r.kind).toBe('data');
      expect(r.kind === 'data' && r.message).toMatch(/^invalid_adjustment_no/);
    },
  );

  it('không gọi createInvoice', async () => {
    const a = adapter(async () => ({ kind: 'issued', adjustmentNo: 'ADJ-1' }));
    await callAdjustProvider(a, ADJ_INPUT);
    expect(a.createInvoice).not.toHaveBeenCalled();
  });
});

describe('InvoiceAdjustmentService — việc nền invoice-adjustment-issue (đăng ký, cấu hình)', () => {
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
    const provider = { createInvoice: jest.fn(), adjustInvoice: jest.fn() };
    const service = new InvoiceAdjustmentService(
      db,
      provider,
      runner,
      withConfig ? WORK : undefined,
    );
    return { service, register, kick, connect, query, provider };
  }

  it('onModuleInit đăng ký chính service với tên invoice-adjustment-issue', () => {
    const { service, register } = make(true);
    service.onModuleInit();
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(service);
    expect(service.name).toBe(INVOICE_ADJUSTMENT_ISSUE_WORK);
    expect(INVOICE_ADJUSTMENT_ISSUE_WORK).toBe('invoice-adjustment-issue');
  });

  it('thiếu workConfig → runDue ném, không giữ chỗ, không gọi nhà cung cấp', async () => {
    const { service, connect, query, provider } = make(false);
    await expect(service.runDue(10, new AbortController().signal)).rejects.toThrow(
      'invoice_adjustment_issue_missing_config',
    );
    expect(connect).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(provider.adjustInvoice).not.toHaveBeenCalled();
  });

  it('EInvoiceService.kickAdjust → runner.kick(invoice-adjustment-issue)', () => {
    const kick = jest.fn();
    const runner = { register: jest.fn(), kick } as unknown as BackgroundWorkRunner;
    const db = { $client: { connect: jest.fn(), query: jest.fn() } } as unknown as Db;
    const provider = { createInvoice: jest.fn(), adjustInvoice: jest.fn() };
    new EInvoiceService(db, provider, runner).kickAdjust();
    expect(kick).toHaveBeenCalledWith('invoice-adjustment-issue');
  });
});
