/**
 * Unit test VnpayAdapter.buildPaymentUrl (T32 Phần 5) và kiểm chữ ký IPN / phân loại kết quả /
 * `parseVnpDate` (T32 Phần 6). Chuỗi ký mong đợi viết TAY theo tài liệu
 * VNPay 2.1.0 (sắp xếp tên, encode kiểu PHP urlencode, dấu cách → `+`), chữ ký tính độc lập bằng
 * node:crypto — không gọi lại hàm của adapter để so.
 */
import { createHmac } from 'node:crypto';
import {
  buildPaymentUrl,
  classifyIpn,
  clientIp,
  newGatewayReference,
  parseVnpDate,
  verifyIpnSignature,
  vnpDate,
  vnpEncode,
  VnpayAdapter,
} from './vnpay.adapter.js';
import { loadVnpayConfig, VNPAY_DEFAULT_RETURN_URL, VNPAY_SANDBOX_URL } from './vnpay.config.js';

const CFG = {
  tmnCode: 'TESTTMN1',
  hashSecret: 'TESTSECRETNOTREAL',
  payUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  returnUrl: 'https://app.powerme.test/billing/vnpay/return?x=1&y=a b',
};
const TOP_UP = {
  gatewayReference: 'PMABC123',
  amountPaidVnd: 200_000,
  createdAt: new Date('2026-11-12T17:30:00Z'), // GMT+7: 13/11 00:30:00
  expiresAt: new Date('2026-11-12T17:45:00Z'),
};
const EXPECTED_SIGN_DATA = [
  'vnp_Amount=20000000',
  'vnp_Command=pay',
  'vnp_CreateDate=20261113003000',
  'vnp_CurrCode=VND',
  'vnp_ExpireDate=20261113004500',
  'vnp_IpAddr=10.0.0.5',
  'vnp_Locale=vn',
  'vnp_OrderInfo=Nap+tien+PowerMe+PMABC123',
  'vnp_OrderType=other',
  'vnp_ReturnUrl=https%3A%2F%2Fapp.powerme.test%2Fbilling%2Fvnpay%2Freturn%3Fx%3D1%26y%3Da+b',
  'vnp_TmnCode=TESTTMN1',
  'vnp_TxnRef=PMABC123',
  'vnp_Version=2.1.0',
].join('&');

describe('VnpayAdapter.buildPaymentUrl (VNPay 2.1.0)', () => {
  const originalTz = process.env['TZ'];
  afterEach(() => {
    if (originalTz === undefined) delete process.env['TZ'];
    else process.env['TZ'] = originalTz;
  });

  it('bộ dữ liệu cố định → chuỗi ký sắp xếp + encode đúng, vnp_SecureHash = HMAC-SHA512 độc lập', () => {
    const url = buildPaymentUrl(TOP_UP, CFG, '10.0.0.5');
    const expectedHash = createHmac('sha512', CFG.hashSecret)
      .update(EXPECTED_SIGN_DATA, 'utf8')
      .digest('hex');
    expect(url).toBe(`${CFG.payUrl}?${EXPECTED_SIGN_DATA}&vnp_SecureHash=${expectedHash}`);
    expect(expectedHash).toMatch(/^[0-9a-f]{128}$/);
    expect(url).not.toContain('vnp_SecureHashType');
  });

  it('vnp_Amount = amount_paid_vnd × 100 (giá sau giảm điểm), vnp_TxnRef = gateway_reference', () => {
    const params = new URL(buildPaymentUrl({ ...TOP_UP, amountPaidVnd: 194_000 }, CFG, '10.0.0.5'))
      .searchParams;
    expect(params.get('vnp_Amount')).toBe('19400000');
    expect(params.get('vnp_TxnRef')).toBe('PMABC123');
    expect(() => buildPaymentUrl({ ...TOP_UP, amountPaidVnd: 0 }, CFG, '1.2.3.4')).toThrow(
      'invalid_payment_amount',
    );
    expect(() => buildPaymentUrl({ ...TOP_UP, gatewayReference: 'PM-1' }, CFG, '1.2.3.4')).toThrow(
      'invalid_gateway_reference',
    );
  });

  it('ngày giờ GMT+7 đúng cả khi máy chạy UTC hoặc múi giờ khác, kể cả qua ranh ngày / năm', () => {
    for (const tz of ['UTC', 'America/New_York', 'Asia/Ho_Chi_Minh']) {
      process.env['TZ'] = tz;
      expect(vnpDate(new Date('2026-11-12T17:30:00Z'))).toBe('20261113003000');
      expect(vnpDate(new Date('2026-12-31T16:59:59Z'))).toBe('20261231235959');
      expect(vnpDate(new Date('2026-12-31T17:00:00Z'))).toBe('20270101000000');
      expect(vnpDate(new Date('2026-03-05T01:02:03Z'))).toBe('20260305080203');
    }
  });

  it('ký tự đặc biệt được encode như PHP urlencode (chỉ giữ A-Za-z0-9-_.)', () => {
    expect(vnpEncode("Thanh toan: 100,000 VND (don #5) ~*!'")).toBe(
      'Thanh+toan%3A+100%2C000+VND+%28don+%235%29+%7E%2A%21%27',
    );
    expect(vnpEncode('a-b_c.d/é')).toBe('a-b_c.d%2F%C3%A9');
    expect(vnpEncode('x=1&y=2+3')).toBe('x%3D1%26y%3D2%2B3');
  });

  it('URL dựng lại từ cùng dòng + cùng IP cho cùng kết quả (không lưu DB)', () => {
    expect(buildPaymentUrl(TOP_UP, CFG, '10.0.0.5')).toBe(buildPaymentUrl(TOP_UP, CFG, '10.0.0.5'));
    expect(buildPaymentUrl(TOP_UP, CFG, '10.0.0.6')).not.toBe(
      buildPaymentUrl(TOP_UP, CFG, '10.0.0.5'),
    );
  });

  it('VnpayAdapter dùng cấu hình được cấp', () => {
    const adapter = new VnpayAdapter({ configured: true, ...CFG });
    expect(adapter.configured).toBe(true);
    expect(adapter.buildPaymentUrl(TOP_UP, '10.0.0.5')).toBe(
      buildPaymentUrl(TOP_UP, CFG, '10.0.0.5'),
    );
  });
});

describe('newGatewayReference / clientIp', () => {
  it('vnp_TxnRef: PM + 14 ký tự [0-9A-Z], khác nhau giữa các lần sinh', () => {
    const refs = new Set(Array.from({ length: 500 }, () => newGatewayReference()));
    expect(refs.size).toBe(500);
    for (const r of refs) expect(r).toMatch(/^PM[0-9A-Z]{14}$/);
  });

  it('IPv4 dạng ánh xạ IPv6 bỏ tiền tố; thiếu địa chỉ → 127.0.0.1', () => {
    expect(clientIp('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(clientIp('2001:db8::1')).toBe('2001:db8::1');
    expect(clientIp(undefined)).toBe('127.0.0.1');
  });
});

describe('loadVnpayConfig', () => {
  it('thiếu TMN code hoặc hash secret → configured = false; mặc định sandbox + return D8', () => {
    expect(loadVnpayConfig({})).toEqual({
      configured: false,
      tmnCode: '',
      hashSecret: '',
      payUrl: VNPAY_SANDBOX_URL,
      returnUrl: VNPAY_DEFAULT_RETURN_URL,
    });
    expect(loadVnpayConfig({ VNPAY_TMN_CODE: 'X' }).configured).toBe(false);
    expect(loadVnpayConfig({ VNPAY_HASH_SECRET: 'Y' }).configured).toBe(false);
    expect(loadVnpayConfig({ VNPAY_TMN_CODE: 'X', VNPAY_HASH_SECRET: 'Y' }).configured).toBe(true);
    expect(VNPAY_DEFAULT_RETURN_URL).toBe('http://localhost:3000/billing/vnpay/return');
  });

  it('URL sai dạng → ném lúc khởi động', () => {
    expect(() => loadVnpayConfig({ VNPAY_RETURN_URL: 'not a url' })).toThrow(
      'invalid_vnpay_config: VNPAY_RETURN_URL',
    );
    expect(() => loadVnpayConfig({ VNPAY_URL: 'ftp://x' })).toThrow(
      'invalid_vnpay_config: VNPAY_URL',
    );
  });
});

describe('verifyIpnSignature (T32 Phần 6)', () => {
  /** Chữ ký tính độc lập: chuỗi ký viết tay theo code mẫu PHP (urlencode, sắp tên). */
  const IPN: Record<string, string> = {
    vnp_Amount: '20000000',
    vnp_BankCode: 'NCB',
    vnp_OrderInfo: "Nạp tiền #1 & 50% (ưu đãi)! *'~",
    vnp_PayDate: '20261113103000',
    vnp_ResponseCode: '00',
    vnp_TmnCode: 'TESTTMN1',
    vnp_TransactionNo: '14123456',
    vnp_TransactionStatus: '00',
    vnp_TxnRef: 'PMABC123',
  };
  const SIGN_DATA = [
    'vnp_Amount=20000000',
    'vnp_BankCode=NCB',
    'vnp_OrderInfo=N%E1%BA%A1p+ti%E1%BB%81n+%231+%26+50%25+%28%C6%B0u+%C4%91%C3%A3i%29%21+%2A%27%7E',
    'vnp_PayDate=20261113103000',
    'vnp_ResponseCode=00',
    'vnp_TmnCode=TESTTMN1',
    'vnp_TransactionNo=14123456',
    'vnp_TransactionStatus=00',
    'vnp_TxnRef=PMABC123',
  ].join('&');
  const hash = createHmac('sha512', CFG.hashSecret).update(SIGN_DATA, 'utf8').digest('hex');
  const signed = { ...IPN, vnp_SecureHash: hash };

  it('chữ ký đúng (ký tự đặc biệt trong vnp_OrderInfo) → ok', () => {
    expect(verifyIpnSignature(signed, CFG)).toEqual({ ok: true });
  });
  it('chữ ký hex viết hoa vẫn nhận; vnp_SecureHashType và tham số không có tiền tố vnp_ bị bỏ qua', () => {
    expect(
      verifyIpnSignature(
        { ...signed, vnp_SecureHash: hash.toUpperCase(), vnp_SecureHashType: 'HmacSHA512', x: '1' },
        CFG,
      ),
    ).toEqual({ ok: true });
  });
  it.each([
    ['thiếu chữ ký', { ...IPN }],
    ['chữ ký sai độ dài', { ...signed, vnp_SecureHash: 'ab' }],
    ['sửa giá trị sau khi ký', { ...signed, vnp_Amount: '20000001' }],
    ['thêm tham số vnp_ sau khi ký', { ...signed, vnp_Extra: '1' }],
  ])('%s → signature', (_l, params) => {
    expect(verifyIpnSignature(params, CFG)).toEqual({ ok: false, reason: 'signature' });
  });
  it('sai secret → signature', () => {
    expect(verifyIpnSignature(signed, { ...CFG, hashSecret: 'OTHER' })).toEqual({
      ok: false,
      reason: 'signature',
    });
  });
  it('vnp_TmnCode khác cấu hình (ký đúng) → tmn_code', () => {
    expect(verifyIpnSignature(signed, { ...CFG, tmnCode: 'OTHERTMN' })).toEqual({
      ok: false,
      reason: 'tmn_code',
    });
  });
  it('tham số dựng lại từ URL thanh toán (decode + → dấu cách) ký lại vẫn khớp', () => {
    const url = new URL(buildPaymentUrl(TOP_UP, CFG, '10.0.0.5'));
    const params = Object.fromEntries(url.searchParams);
    expect(verifyIpnSignature(params, CFG)).toEqual({ ok: true });
  });
});

describe('classifyIpn (D3, chốt 12–13/11)', () => {
  it.each([
    ['00', '00', 'succeeded', false],
    ['07', '00', 'unresolved', true],
    ['07', '07', 'unresolved', false],
    ['99', '01', 'unresolved', false],
    ['99', '04', 'unresolved', false],
    ['00', '02', 'unresolved', true],
    ['24', '00', 'unresolved', true],
    ['24', '02', 'failed', false],
    ['51', '02', 'failed', false],
    [undefined, undefined, 'failed', false],
  ] as const)(
    'ResponseCode %s, TransactionStatus %s → %s (oneZero %s)',
    (rc, ts, kind, oneZero) => {
      expect(classifyIpn(rc, ts)).toEqual({ kind, oneZero });
    },
  );
});

describe('parseVnpDate', () => {
  it('yyyyMMddHHmmss GMT+7 → UTC; ngược của vnpDate', () => {
    expect(parseVnpDate('20261113003000')?.toISOString()).toBe('2026-11-12T17:30:00.000Z');
    expect(vnpDate(parseVnpDate('20261231235959')!)).toBe('20261231235959');
  });
  it.each([undefined, '', '2026111300300', '20260231120000', '20261113256000', 'abcdefghijklmn'])(
    '%j → null',
    (s) => {
      expect(parseVnpDate(s)).toBeNull();
    },
  );
});
