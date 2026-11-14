/**
 * Unit test querydr VNPay (T32 Phần 8, SD-2d, bảng 3.1 của Ân 12/11): dựng request, kiểm và phân
 * loại response (hàm thuần), `VnpayAdapter.queryTransaction` với fetch giả (không gọi mạng thật),
 * và cấu hình `VNPAY_API_URL` / `VNPAY_SERVER_IP`.
 *
 * Chuỗi ký mong đợi viết TAY theo thứ tự của tài liệu `truy-van-hoan-tien/querydr&refund.html`
 * (nối bằng `|`, không encode); chữ ký tính độc lập bằng node:crypto — không gọi lại hàm ký của
 * adapter để so.
 */
import { createHmac } from 'node:crypto';
import {
  classifyQuerydrResponse,
  newQuerydrRequestId,
  QUERYDR_TIMEOUT_MS,
  querydrRequest,
  VnpayAdapter,
  vnpDate,
} from './vnpay.adapter.js';
import {
  loadVnpayApiConfig,
  VNPAY_DEFAULT_SERVER_IP,
  VNPAY_SANDBOX_API_URL,
  VnpayConfig,
} from './vnpay.config.js';

const SECRET = 'TESTSECRETNOTREAL';
const CFG: VnpayConfig = {
  configured: true,
  tmnCode: 'TESTTMN1',
  hashSecret: SECRET,
  payUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  returnUrl: 'http://localhost:3000/billing/vnpay/return',
};
const TOP_UP = {
  gatewayReference: 'PMABC123',
  createdAt: new Date('2026-11-12T17:30:00Z'), // GMT+7: 13/11 00:30:00
  amountPaidVnd: 200_000,
};
const hmac = (data: string) => createHmac('sha512', SECRET).update(data, 'utf8').digest('hex');

/** Response querydr ký theo thứ tự tài liệu (viết tay), trường thiếu → chuỗi rỗng. */
function signedResponse(
  over: Record<string, string | undefined> = {},
  secret = SECRET,
): Record<string, string> {
  const r: Record<string, string | undefined> = {
    vnp_ResponseId: 'R1',
    vnp_Command: 'querydr',
    vnp_ResponseCode: '00',
    vnp_Message: 'QueryDR Success',
    vnp_TmnCode: CFG.tmnCode,
    vnp_TxnRef: TOP_UP.gatewayReference,
    vnp_Amount: '20000000',
    vnp_BankCode: 'NCB',
    vnp_PayDate: '20261113003500',
    vnp_TransactionNo: '14000001',
    vnp_TransactionType: '01',
    vnp_TransactionStatus: '00',
    vnp_OrderInfo: 'Nap tien PowerMe PMABC123',
    ...over,
  };
  const order = [
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
    'vnp_PromotionCode',
    'vnp_PromotionAmount',
  ];
  const data = order.map((k) => r[k] ?? '').join('|');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) if (v !== undefined) out[k] = v;
  out['vnp_SecureHash'] = createHmac('sha512', secret).update(data, 'utf8').digest('hex');
  return out;
}

const EXPECT = { tmnCode: CFG.tmnCode, txnRef: TOP_UP.gatewayReference, amountPaidVnd: 200_000 };

describe('querydrRequest (T32 Phần 8)', () => {
  const NOW = new Date('2026-11-12T17:47:05Z'); // GMT+7: 13/11 00:47:05

  it('đủ tham số, vnp_TransactionDate = vnpDate(created_at), chuỗi ký đúng thứ tự tài liệu', () => {
    const body = querydrRequest(
      TOP_UP,
      { ...CFG, serverIp: '203.0.113.9' },
      NOW,
      'abc123def4567890abc123def4567890',
    );
    const data = [
      'abc123def4567890abc123def4567890',
      '2.1.0',
      'querydr',
      'TESTTMN1',
      'PMABC123',
      '20261113003000',
      '20261113004705',
      '203.0.113.9',
      'Truy van giao dich PMABC123',
    ].join('|');
    expect(body).toEqual({
      vnp_RequestId: 'abc123def4567890abc123def4567890',
      vnp_Version: '2.1.0',
      vnp_Command: 'querydr',
      vnp_TmnCode: 'TESTTMN1',
      vnp_TxnRef: 'PMABC123',
      vnp_TransactionDate: '20261113003000',
      vnp_CreateDate: '20261113004705',
      vnp_IpAddr: '203.0.113.9',
      vnp_OrderInfo: 'Truy van giao dich PMABC123',
      vnp_SecureHash: hmac(data),
    });
    expect(body['vnp_TransactionDate']).toBe(vnpDate(TOP_UP.createdAt));
  });

  it('vnp_RequestId: 32 ký tự hex, mỗi lần một giá trị; request id / ref sai dạng → ném', () => {
    const a = newQuerydrRequestId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newQuerydrRequestId()).not.toBe(a);
    const cfg = { ...CFG, serverIp: '127.0.0.1' };
    expect(() => querydrRequest(TOP_UP, cfg, NOW, 'x'.repeat(33))).toThrow('invalid_request_id');
    expect(() => querydrRequest({ ...TOP_UP, gatewayReference: 'PM-1' }, cfg, NOW, 'abc')).toThrow(
      'invalid_gateway_reference',
    );
  });
});

describe('classifyQuerydrResponse — bảng 3.1 (Ân 12/11)', () => {
  it('RC 00 + TS 00 → paid (transactionNo, amount VND, payDate GMT+7)', () => {
    expect(classifyQuerydrResponse(signedResponse(), EXPECT, SECRET)).toEqual({
      kind: 'paid',
      transactionNo: '14000001',
      amount: 200_000,
      payDate: new Date('2026-11-12T17:35:00Z'),
    });
  });

  it('paid thiếu vnp_PayDate (tuỳ chọn) → payDate null; trường tuỳ chọn thiếu ký bằng chuỗi rỗng', () => {
    const r = signedResponse({ vnp_PayDate: undefined });
    expect(classifyQuerydrResponse(r, EXPECT, SECRET)).toMatchObject({
      kind: 'paid',
      payDate: null,
    });
  });

  it('có vnp_PromotionCode / vnp_PromotionAmount → nằm trong chuỗi ký', () => {
    const r = signedResponse({ vnp_PromotionCode: 'KM1', vnp_PromotionAmount: '1000' });
    expect(classifyQuerydrResponse(r, EXPECT, SECRET).kind).toBe('paid');
    // Đổi giá trị khuyến mại mà không ký lại → sai chữ ký.
    expect(classifyQuerydrResponse({ ...r, vnp_PromotionAmount: '2000' }, EXPECT, SECRET)).toEqual({
      kind: 'unresolved',
      reason: 'signature',
    });
  });

  it('RC 00 + TS 02 → failed', () => {
    expect(
      classifyQuerydrResponse(signedResponse({ vnp_TransactionStatus: '02' }), EXPECT, SECRET),
    ).toEqual({ kind: 'failed', responseCode: '00', transactionStatus: '02' });
  });

  it('RC 91 → not_found', () => {
    const r = signedResponse({
      vnp_ResponseCode: '91',
      vnp_TransactionStatus: undefined,
      vnp_TransactionNo: undefined,
    });
    expect(classifyQuerydrResponse(r, EXPECT, SECRET)).toEqual({ kind: 'not_found' });
  });

  it.each(['01', '04', '07', '05', '09'])('RC 00 + TS %s → unresolved transaction_status', (ts) => {
    expect(
      classifyQuerydrResponse(signedResponse({ vnp_TransactionStatus: ts }), EXPECT, SECRET),
    ).toEqual({
      kind: 'unresolved',
      reason: 'transaction_status',
      responseCode: '00',
      transactionStatus: ts,
    });
  });

  it.each(['94', '99', '02', '03', '97'])('RC %s → unresolved response_code', (rc) => {
    expect(
      classifyQuerydrResponse(signedResponse({ vnp_ResponseCode: rc }), EXPECT, SECRET),
    ).toEqual({ kind: 'unresolved', reason: 'response_code', responseCode: rc });
  });

  it('vnp_TransactionType ≠ 01 (giao dịch hoàn) → unresolved transaction_type, không đọc TS', () => {
    expect(
      classifyQuerydrResponse(signedResponse({ vnp_TransactionType: '02' }), EXPECT, SECRET),
    ).toMatchObject({ kind: 'unresolved', reason: 'transaction_type' });
  });

  it('paid mà vnp_Amount ≠ amount_paid_vnd × 100 → unresolved amount_mismatch (không cộng)', () => {
    expect(
      classifyQuerydrResponse(signedResponse({ vnp_Amount: '200000' }), EXPECT, SECRET),
    ).toMatchObject({ kind: 'unresolved', reason: 'amount_mismatch' });
  });

  it('chữ ký sai / thiếu / ký bằng secret khác → unresolved signature', () => {
    const r = signedResponse();
    expect(classifyQuerydrResponse({ ...r, vnp_SecureHash: 'ab' }, EXPECT, SECRET)).toEqual({
      kind: 'unresolved',
      reason: 'signature',
    });
    const { vnp_SecureHash: _drop, ...noHash } = r;
    expect(classifyQuerydrResponse(noHash, EXPECT, SECRET).kind).toBe('unresolved');
    expect(classifyQuerydrResponse(signedResponse({}, 'OTHER'), EXPECT, SECRET)).toEqual({
      kind: 'unresolved',
      reason: 'signature',
    });
    // Đổi trường đã ký mà không ký lại.
    expect(classifyQuerydrResponse({ ...r, vnp_TransactionStatus: '02' }, EXPECT, SECRET)).toEqual({
      kind: 'unresolved',
      reason: 'signature',
    });
  });

  it('vnp_TmnCode / vnp_TxnRef khác (dù ký đúng) → unresolved tmn_code / txn_ref', () => {
    expect(
      classifyQuerydrResponse(signedResponse({ vnp_TmnCode: 'OTHER001' }), EXPECT, SECRET),
    ).toEqual({ kind: 'unresolved', reason: 'tmn_code' });
    expect(
      classifyQuerydrResponse(signedResponse({ vnp_TxnRef: 'PMOTHER' }), EXPECT, SECRET),
    ).toEqual({ kind: 'unresolved', reason: 'txn_ref' });
  });

  it('thiếu trường / sai kiểu → unresolved (malformed hoặc chữ ký)', () => {
    expect(classifyQuerydrResponse(null, EXPECT, SECRET)).toEqual({
      kind: 'unresolved',
      reason: 'malformed',
    });
    expect(classifyQuerydrResponse([1], EXPECT, SECRET).kind).toBe('unresolved');
    expect(
      classifyQuerydrResponse(signedResponse({ vnp_TransactionNo: undefined }), EXPECT, SECRET),
    ).toMatchObject({ kind: 'unresolved', reason: 'malformed' });
    expect(
      classifyQuerydrResponse(signedResponse({ vnp_ResponseCode: undefined }), EXPECT, SECRET),
    ).toMatchObject({ kind: 'unresolved', reason: 'response_code' });
  });

  it('chuẩn hoá giá trị JSON: null = thiếu, số hữu hạn → chuỗi; phân loại bình thường khi ký đúng', () => {
    // Ký trên chuỗi sau chuẩn hoá: vnp_PromotionCode null → '', vnp_Amount 20000000 → '20000000'.
    const signed = signedResponse();
    const body: Record<string, unknown> = {
      ...signed,
      vnp_PromotionCode: null,
      vnp_Amount: 20000000,
    };
    expect(classifyQuerydrResponse(body, EXPECT, SECRET)).toEqual({
      kind: 'paid',
      transactionNo: '14000001',
      amount: 200_000,
      payDate: new Date('2026-11-12T17:35:00Z'),
    });
    // Số sai giá trị vẫn bị chữ ký chặn.
    expect(classifyQuerydrResponse({ ...body, vnp_Amount: 20000001 }, EXPECT, SECRET)).toEqual({
      kind: 'unresolved',
      reason: 'signature',
    });
  });

  it.each([
    ['object', { a: 1 }],
    ['array', ['00']],
    ['boolean', true],
    ['số không hữu hạn', Number.POSITIVE_INFINITY],
  ])('giá trị %s → malformed', (_name, value) => {
    expect(
      classifyQuerydrResponse({ ...signedResponse(), vnp_BankCode: value }, EXPECT, SECRET),
    ).toEqual({ kind: 'unresolved', reason: 'malformed' });
  });
});

describe('VnpayAdapter.queryTransaction (fetch giả)', () => {
  const API = {
    apiUrl: 'https://vnpay.test/merchant_webapi/api/transaction',
    serverIp: '10.1.2.3',
  };
  const ok = (body: unknown, status = 200) =>
    jest.fn(
      async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    ) as unknown as jest.Mock & typeof fetch;

  it('POST JSON tới VNPAY_API_URL, body đã ký với vnp_IpAddr cấu hình; response ký đúng → paid', async () => {
    const f = ok(signedResponse());
    const adapter = new VnpayAdapter(CFG, API, f);
    await expect(adapter.queryTransaction(TOP_UP)).resolves.toMatchObject({ kind: 'paid' });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(API.apiUrl);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    const sent = JSON.parse(String(init.body)) as Record<string, string>;
    expect(sent).toMatchObject({
      vnp_Command: 'querydr',
      vnp_TxnRef: 'PMABC123',
      vnp_IpAddr: '10.1.2.3',
      vnp_TransactionDate: '20261113003000',
    });
    expect(sent['vnp_SecureHash']).toMatch(/^[0-9a-f]{128}$/);
  });

  it('HTTP ≠ 200 → unresolved http_status; JSON hỏng → malformed; lỗi mạng → network', async () => {
    await expect(
      new VnpayAdapter(CFG, API, ok('oops', 500)).queryTransaction(TOP_UP),
    ).resolves.toEqual({ kind: 'unresolved', reason: 'http_status' });
    await expect(
      new VnpayAdapter(CFG, API, ok('{not json')).queryTransaction(TOP_UP),
    ).resolves.toEqual({ kind: 'unresolved', reason: 'malformed' });
    const broken = jest.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(new VnpayAdapter(CFG, API, broken).queryTransaction(TOP_UP)).resolves.toEqual({
      kind: 'unresolved',
      reason: 'network',
    });
  });

  it('quá timeout → unresolved timeout (mặc định 10 s)', async () => {
    expect(QUERYDR_TIMEOUT_MS).toBe(10_000);
    const hang = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    ) as unknown as typeof fetch;
    await expect(new VnpayAdapter(CFG, API, hang, 50).queryTransaction(TOP_UP)).resolves.toEqual({
      kind: 'unresolved',
      reason: 'timeout',
    });
  });

  it('signal của bên gọi abort (shutdown) → dừng fetch, unresolved', async () => {
    const hang = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    ) as unknown as typeof fetch;
    const ctl = new AbortController();
    const p = new VnpayAdapter(CFG, API, hang, 60_000).queryTransaction(TOP_UP, ctl.signal);
    ctl.abort();
    await expect(p).resolves.toEqual({ kind: 'unresolved', reason: 'network' });
  });

  it('chưa cấu hình → ném, không gọi HTTP', async () => {
    const f = ok(signedResponse());
    const adapter = new VnpayAdapter({ ...CFG, configured: false }, API, f);
    await expect(adapter.queryTransaction(TOP_UP)).rejects.toThrow('vnpay_unconfigured');
    expect(f).not.toHaveBeenCalled();
  });
});

describe('loadVnpayApiConfig (VNPAY_API_URL, VNPAY_SERVER_IP)', () => {
  it('trống → sandbox + 127.0.0.1', () => {
    expect(loadVnpayApiConfig({})).toEqual({
      apiUrl: VNPAY_SANDBOX_API_URL,
      serverIp: VNPAY_DEFAULT_SERVER_IP,
    });
    expect(VNPAY_SANDBOX_API_URL).toBe(
      'https://sandbox.vnpayment.vn/merchant_webapi/api/transaction',
    );
    expect(VNPAY_DEFAULT_SERVER_IP).toBe('127.0.0.1');
    expect(loadVnpayApiConfig({ VNPAY_SERVER_IP: ' 2001:db8::1 ' }).serverIp).toBe('2001:db8::1');
  });

  it('URL không phải http(s) / IP sai → ném lúc khởi động', () => {
    expect(() => loadVnpayApiConfig({ VNPAY_API_URL: 'ftp://x' })).toThrow(
      'invalid_vnpay_config: VNPAY_API_URL',
    );
    expect(() => loadVnpayApiConfig({ VNPAY_API_URL: 'not a url' })).toThrow(
      'invalid_vnpay_config: VNPAY_API_URL',
    );
    expect(() => loadVnpayApiConfig({ VNPAY_SERVER_IP: 'my-host' })).toThrow(
      'invalid_vnpay_config: VNPAY_SERVER_IP',
    );
  });
});
