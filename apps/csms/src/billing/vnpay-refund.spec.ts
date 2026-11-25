/**
 * Unit test refund VNPay (T32 Phần 9a, SD-2e, D1): dựng request, phân loại response (bảng 2.2),
 * phân loại querydr trước khi gửi lại (mục 2.3), `planRound` và `VnpayAdapter` với fetch giả.
 *
 * Vì sao tồn tại: refund không thử được trên sandbox (VNPay trả lời 18/11), nên đây là bằng chứng
 * chính cho chuỗi ký và bảng phân loại. Chuỗi ký mong đợi viết TAY theo thứ tự tài liệu, chữ ký tính
 * độc lập bằng node:crypto.
 */
import { createHmac } from 'node:crypto';
import { planRound } from './refund.service.js';
import {
  classifyRefundQueryResponse,
  classifyRefundResponse,
  RefundInput,
  refundRequest,
  VnpayAdapter,
  vnpDate,
} from './vnpay.adapter.js';
import type { VnpayConfig } from './vnpay.config.js';

const SECRET = 'TESTSECRETNOTREAL';
const CFG: VnpayConfig = {
  configured: true,
  tmnCode: 'TESTTMN1',
  hashSecret: SECRET,
  payUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  returnUrl: 'http://localhost:3000/billing/vnpay/return',
};
const SIGNING = { tmnCode: CFG.tmnCode, hashSecret: SECRET, serverIp: '10.0.0.9' };
const API = { apiUrl: 'https://vnpay.test/api', serverIp: '10.0.0.9' };
const hmac = (data: string, secret = SECRET) =>
  createHmac('sha512', secret).update(data, 'utf8').digest('hex');

const INPUT: RefundInput = {
  refundId: 77,
  gatewayReference: 'PMABC123',
  originalTransactionNo: '14000001',
  originalAmountVnd: 200_000,
  createdAt: new Date('2026-11-12T17:30:00Z'), // GMT+7: 13/11 00:30:00
  amountVnd: 200_000,
  requestedBy: 5,
};
const NOW = new Date('2026-11-23T03:00:00Z'); // GMT+7: 23/11 10:00:00

const REFUND_ORDER = [
  'vnp_ResponseId',
  'vnp_Command',
  'vnp_ResponseCode',
  'vnp_Message',
  'vnp_TmnCode',
  'vnp_TxnRef',
  'vnp_Amount',
  'vnp_BankCode',
  'vnp_PayDate',
  'vnp_TransactionNo',
  'vnp_TransactionType',
  'vnp_TransactionStatus',
  'vnp_OrderInfo',
];
const QUERY_ORDER = [...REFUND_ORDER, 'vnp_PromotionCode', 'vnp_PromotionAmount'];

function signed(
  order: string[],
  base: Record<string, string>,
  over: Record<string, string | undefined>,
  secret = SECRET,
): Record<string, string> {
  const r: Record<string, string | undefined> = { ...base, ...over };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) if (v !== undefined) out[k] = v;
  out['vnp_SecureHash'] = hmac(order.map((k) => r[k] ?? '').join('|'), secret);
  return out;
}

const BASE: Record<string, string> = {
  vnp_ResponseId: 'R1',
  vnp_Command: 'refund',
  vnp_ResponseCode: '00',
  vnp_Message: 'Refund Success',
  vnp_TmnCode: CFG.tmnCode,
  vnp_TxnRef: INPUT.gatewayReference,
  vnp_Amount: '20000000',
  vnp_BankCode: 'NCB',
  vnp_PayDate: '20261123100000',
  vnp_TransactionNo: '15000009',
  vnp_TransactionType: '02',
  vnp_TransactionStatus: '00',
  vnp_OrderInfo: 'Hoan tien PowerMe 77',
};
const refundBody = (over: Record<string, string | undefined> = {}, secret = SECRET) =>
  signed(REFUND_ORDER, BASE, over, secret);
const EXPECT = { tmnCode: CFG.tmnCode, txnRef: INPUT.gatewayReference, amountVnd: 200_000 };
const classify = (body: unknown) => classifyRefundResponse(body, EXPECT, SECRET);

const QUERY_BASE = { ...BASE, vnp_Command: 'querydr', vnp_TransactionNo: '14000001' };
const queryBody = (over: Record<string, string | undefined> = {}, secret = SECRET) =>
  signed(QUERY_ORDER, QUERY_BASE, over, secret);
const QUERY_EXPECT = {
  tmnCode: CFG.tmnCode,
  txnRef: INPUT.gatewayReference,
  transactionNo: '14000001',
  amountVnd: 200_000,
};
const classifyQuery = (body: unknown) => classifyRefundQueryResponse(body, QUERY_EXPECT, SECRET);

describe('refundRequest', () => {
  it('chuỗi ký đúng thứ tự tài liệu (so với chuỗi viết tay)', () => {
    const body = refundRequest(INPUT, SIGNING, NOW, 'REQ1');
    const expected =
      'REQ1|2.1.0|refund|TESTTMN1|02|PMABC123|20000000|14000001|20261113003000|admin:5|' +
      '20261123100000|10.0.0.9|Hoan tien PowerMe 77';
    expect(body['vnp_SecureHash']).toBe(hmac(expected));
  });

  it('02 khi hoàn đủ số gốc, 03 khi một phần; vnp_Amount = VND × 100', () => {
    expect(refundRequest(INPUT, SIGNING, NOW, 'R')['vnp_TransactionType']).toBe('02');
    const part = refundRequest({ ...INPUT, amountVnd: 80_000 }, SIGNING, NOW, 'R');
    expect(part['vnp_TransactionType']).toBe('03');
    expect(part['vnp_Amount']).toBe('8000000');
  });

  it('vnp_CreateBy: admin:<id>, hoặc system khi requested_by NULL', () => {
    expect(refundRequest(INPUT, SIGNING, NOW, 'R')['vnp_CreateBy']).toBe('admin:5');
    expect(refundRequest({ ...INPUT, requestedBy: null }, SIGNING, NOW, 'R')['vnp_CreateBy']).toBe(
      'system',
    );
  });

  it('TransactionDate = created_at, CreateDate = lúc gửi, luôn có TransactionNo gốc', () => {
    const b = refundRequest(INPUT, SIGNING, NOW, 'R');
    expect(b['vnp_TransactionDate']).toBe(vnpDate(INPUT.createdAt));
    expect(b['vnp_CreateDate']).toBe('20261123100000');
    expect(b['vnp_TransactionNo']).toBe('14000001');
    expect(b['vnp_OrderInfo']).toBe('Hoan tien PowerMe 77');
  });

  it('từ chối số tiền vượt giao dịch gốc, số ≤ 0, mã sai dạng', () => {
    expect(() => refundRequest({ ...INPUT, amountVnd: 200_001 }, SIGNING, NOW, 'R')).toThrow(
      'invalid_refund_amount',
    );
    expect(() => refundRequest({ ...INPUT, amountVnd: 0 }, SIGNING, NOW, 'R')).toThrow(
      'invalid_refund_amount',
    );
    expect(() => refundRequest({ ...INPUT, originalTransactionNo: '' }, SIGNING, NOW, 'R')).toThrow(
      'invalid_transaction_no',
    );
    expect(() => refundRequest(INPUT, SIGNING, NOW, 'x'.repeat(33))).toThrow('invalid_request_id');
  });
});

describe('classifyRefundResponse (bảng 2.2)', () => {
  it.each(['00', '05', '06'])('RC 00 + TS %s → accepted, mã hoàn lấy từ response', (ts) => {
    expect(classify(refundBody({ vnp_TransactionStatus: ts }))).toEqual({
      kind: 'accepted',
      refundNo: '15000009',
      transactionStatus: ts,
    });
  });

  it('RC 00 + TS 09 → rejected', () => {
    expect(classify(refundBody({ vnp_TransactionStatus: '09' }))).toMatchObject({
      kind: 'rejected',
      transactionStatus: '09',
    });
  });

  it.each(['02', '03', '91', '95'])('RC %s có chữ ký → rejected', (rc) => {
    expect(classify(refundBody({ vnp_ResponseCode: rc }))).toEqual({
      kind: 'rejected',
      responseCode: rc,
    });
  });

  it('RC 91 không lặp lại TmnCode / TxnRef vẫn rejected; lặp lại mà khác → unknown', () => {
    expect(
      classify(
        refundBody({ vnp_ResponseCode: '91', vnp_TmnCode: undefined, vnp_TxnRef: undefined }),
      ),
    ).toMatchObject({ kind: 'rejected' });
    expect(classify(refundBody({ vnp_ResponseCode: '91', vnp_TxnRef: 'OTHER' }))).toMatchObject({
      kind: 'unknown',
      reason: 'txn_ref',
    });
  });

  it('RC 97 → rejected, kể cả không có chữ ký', () => {
    expect(classify({ vnp_ResponseCode: '97' })).toEqual({ kind: 'rejected', responseCode: '97' });
  });

  it('RC 94 → in_progress, có hay không có chữ ký', () => {
    expect(classify(refundBody({ vnp_ResponseCode: '94' }))).toEqual({
      kind: 'in_progress',
      verified: true,
    });
    expect(classify({ vnp_ResponseCode: '94', vnp_Message: 'dup' })).toEqual({
      kind: 'in_progress',
      verified: false,
    });
  });

  it('RC 99 → unknown', () => {
    expect(classify(refundBody({ vnp_ResponseCode: '99' }))).toMatchObject({
      kind: 'unknown',
      reason: 'response_code',
    });
  });

  it.each([
    ['sai chữ ký', () => refundBody({}, 'WRONG'), 'signature'],
    [
      'thiếu chữ ký',
      () => {
        const b = refundBody();
        delete b['vnp_SecureHash'];
        return b;
      },
      'signature',
    ],
    ['sai TmnCode', () => refundBody({ vnp_TmnCode: 'OTHER' }), 'tmn_code'],
    ['sai TxnRef', () => refundBody({ vnp_TxnRef: 'OTHER' }), 'txn_ref'],
    ['sai số tiền', () => refundBody({ vnp_Amount: '19999900' }), 'amount'],
    ['TS lạ', () => refundBody({ vnp_TransactionStatus: '01' }), 'transaction_status'],
    ['thiếu mã hoàn', () => refundBody({ vnp_TransactionNo: undefined }), 'transaction_no'],
    [
      'mã hoàn quá 20 ký tự',
      () => refundBody({ vnp_TransactionNo: '1'.repeat(21) }),
      'transaction_no',
    ],
  ])('%s → unknown', (_name, body, reason) => {
    expect(classify(body())).toMatchObject({ kind: 'unknown', reason });
  });

  it('body không phải object / có trường lồng → unknown malformed', () => {
    for (const b of [null, [], 'x', { vnp_ResponseCode: { a: 1 } }])
      expect(classify(b)).toEqual({ kind: 'unknown', reason: 'malformed' });
  });
});

describe('classifyRefundQueryResponse (mục 2.3)', () => {
  it.each([
    ['02', '00'],
    ['03', '05'],
    ['02', '06'],
  ])('loại %s + TS %s, khớp mã gốc và số tiền → refunded', (type, ts) => {
    expect(
      classifyQuery(queryBody({ vnp_TransactionType: type, vnp_TransactionStatus: ts })),
    ).toEqual({ kind: 'refunded', transactionType: type, transactionStatus: ts });
  });

  it('loại 02 + TS 09 → refund_rejected', () => {
    expect(
      classifyQuery(queryBody({ vnp_TransactionType: '02', vnp_TransactionStatus: '09' })),
    ).toMatchObject({ kind: 'refund_rejected' });
  });

  it('loại 01 + TS 00 cùng mã → payment_only', () => {
    expect(classifyQuery(queryBody({ vnp_TransactionType: '01' }))).toEqual({
      kind: 'payment_only',
    });
  });

  it.each([
    ['sai chữ ký', () => queryBody({}, 'WRONG'), 'signature'],
    ['RC 94 không chữ ký', () => ({ vnp_ResponseCode: '94' }), 'signature'],
    ['RC 99', () => queryBody({ vnp_ResponseCode: '99' }), 'response_code'],
    ['RC 91', () => queryBody({ vnp_ResponseCode: '91' }), 'response_code'],
    ['TransactionNo khác', () => queryBody({ vnp_TransactionNo: '14999999' }), 'transaction_no'],
    ['sai TxnRef', () => queryBody({ vnp_TxnRef: 'OTHER' }), 'txn_ref'],
    ['sai TmnCode', () => queryBody({ vnp_TmnCode: 'OTHER' }), 'tmn_code'],
    ['02 sai số tiền', () => queryBody({ vnp_Amount: '100' }), 'amount'],
    ['loại lạ', () => queryBody({ vnp_TransactionType: '04' }), 'transaction_type'],
    ['02 + TS lạ', () => queryBody({ vnp_TransactionStatus: '01' }), 'transaction_status'],
    [
      '01 + TS 02',
      () => queryBody({ vnp_TransactionType: '01', vnp_TransactionStatus: '02' }),
      'transaction_status',
    ],
  ])('%s → unresolved', (_name, body, reason) => {
    expect(classifyQuery(body())).toMatchObject({ kind: 'unresolved', reason });
  });
});

describe('planRound', () => {
  const p = (attemptCount: number, lastErrorKind: 'transient' | 'data' | null, claims: number) =>
    planRound({ attemptCount, lastErrorKind, unfinishedClaims: claims });

  it('lượt đầu thật sự → send', () => expect(p(0, null, 1)).toBe('send'));
  it('lượt trước giữ chỗ chưa ra kết quả → query_only, dù attempt_count = 0', () =>
    expect(p(0, null, 2)).toBe('query_only'));
  it('lượt tự động sau lỗi tạm thời → query_only', () =>
    expect(p(1, 'transient', 1)).toBe('query_only'));
  it('sau Admin retry (data) → query_then_send', () =>
    expect(p(1, 'data', 1)).toBe('query_then_send'));
  it('sau Admin retry (hết lượt) → query_then_send', () =>
    expect(p(4, 'transient', 1)).toBe('query_then_send'));
  it('lượt sau Admin retry chạy dở → query_only', () => {
    expect(p(4, 'transient', 2)).toBe('query_only');
    expect(p(1, 'data', 2)).toBe('query_only');
  });
});

describe('VnpayAdapter.refund / queryRefundState', () => {
  const adapter = (fetcher: typeof fetch, cfg: VnpayConfig = CFG, timeout?: number) =>
    new VnpayAdapter(cfg, API, fetcher, timeout);
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

  it('POST JSON tới VNPAY_API_URL với lệnh refund đã ký, RequestId mới mỗi lần', async () => {
    const fetcher = jest.fn(async () => json(refundBody()));
    const a = adapter(fetcher as unknown as typeof fetch);
    expect(await a.refund(INPUT)).toMatchObject({ kind: 'accepted' });
    await a.refund(INPUT);
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![0]).toBe(API.apiUrl);
    expect(calls[0]![1].method).toBe('POST');
    const [b1, b2] = calls.map((c) => JSON.parse(String(c[1].body)) as Record<string, string>);
    expect(b1!['vnp_Command']).toBe('refund');
    expect(b1!['vnp_RequestId']).not.toBe(b2!['vnp_RequestId']);
  });

  it('queryRefundState dùng querydr và không gửi vnp_TransactionNo', async () => {
    const fetcher = jest.fn(async () => json(queryBody()));
    await adapter(fetcher as unknown as typeof fetch).queryRefundState(INPUT);
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    const body = JSON.parse(String(calls[0]![1].body)) as Record<string, string>;
    expect(body['vnp_Command']).toBe('querydr');
    expect(body).not.toHaveProperty('vnp_TransactionNo');
  });

  it('timeout mặc định 10 s; quá hạn → unknown timeout', async () => {
    const spy = jest.spyOn(AbortSignal, 'timeout');
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) => {
        init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    await adapter(jest.fn(async () => json(refundBody())) as unknown as typeof fetch).refund(INPUT);
    expect(spy).toHaveBeenCalledWith(10_000);
    spy.mockRestore();
    expect(await adapter(hang, CFG, 5).refund(INPUT)).toEqual({
      kind: 'unknown',
      reason: 'timeout',
    });
  });

  it('HTTP ≠ 200 → unknown; JSON hỏng → unknown; lỗi mạng → unknown', async () => {
    expect(
      await adapter((async () => json({}, 500)) as unknown as typeof fetch).refund(INPUT),
    ).toEqual({ kind: 'unknown', reason: 'http_status' });
    expect(
      await adapter((async () => new Response('<html>')) as unknown as typeof fetch).refund(INPUT),
    ).toEqual({ kind: 'unknown', reason: 'malformed' });
    expect(
      await adapter((async () => {
        throw new Error('ECONNRESET https://secret');
      }) as unknown as typeof fetch).refund(INPUT),
    ).toEqual({ kind: 'unknown', reason: 'network' });
  });

  it('abort từ bên gọi → unknown, không ném', async () => {
    const ac = new AbortController();
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) => {
        init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
        ac.abort();
      })) as unknown as typeof fetch;
    expect(await adapter(hang).refund(INPUT, ac.signal)).toEqual({
      kind: 'unknown',
      reason: 'network',
    });
  });

  it('chưa cấu hình → ném, không gọi HTTP', async () => {
    const fetcher = jest.fn();
    const a = adapter(fetcher as unknown as typeof fetch, { ...CFG, configured: false });
    await expect(a.refund(INPUT)).rejects.toThrow('vnpay_unconfigured');
    await expect(a.queryRefundState(INPUT)).rejects.toThrow('vnpay_unconfigured');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('response chưa xác thực được: kèm mã thô để log, phân loại giữ nguyên', async () => {
    const bad = refundBody({ vnp_ResponseCode: '00' }, 'WRONG');
    expect(await adapter((async () => json(bad)) as unknown as typeof fetch).refund(INPUT)).toEqual(
      {
        kind: 'unknown',
        reason: 'signature',
        unverified: { responseCode: '00', message: 'Refund Success', hasSecureHash: true },
      },
    );
    expect(
      await adapter((async () =>
        json({ vnp_ResponseCode: '94' })) as unknown as typeof fetch).refund(INPUT),
    ).toEqual({
      kind: 'in_progress',
      verified: false,
      unverified: { responseCode: '94', hasSecureHash: false },
    });
  });
});
