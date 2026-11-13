/**
 * Unit test VnpayAdapter.buildPaymentUrl (T32 Phần 5). Chuỗi ký mong đợi viết TAY theo tài liệu
 * VNPay 2.1.0 (sắp xếp tên, encode kiểu PHP urlencode, dấu cách → `+`), chữ ký tính độc lập bằng
 * node:crypto — không gọi lại hàm của adapter để so.
 */
import { createHmac } from 'node:crypto';
import {
  buildPaymentUrl,
  clientIp,
  newGatewayReference,
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
