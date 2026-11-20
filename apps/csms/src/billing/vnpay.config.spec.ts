/**
 * Unit test `loadVnpayConfig` cho `VNPAY_RETURN_URL` bắt buộc https (T32 Phần 8c, Khang 19/11).
 *
 * Vì sao tồn tại: trang return hiện kết quả thanh toán cho tài xế; ở production mà để http thì
 * trình duyệt chuyển từ cổng VNPay (https) về một URL không mã hoá. Điều kiện kèm "VNPay đã cấu
 * hình" để lab `infra/lab/rq1-staging` (`NODE_ENV: production`, không đặt `VNPAY_RETURN_URL`, mặc
 * định `http://localhost`) vẫn khởi động được. Bỏ một trong hai điều kiện thì một ca dưới fail.
 *
 * Test truyền `env` vào, không đụng `process.env`. Giá trị mã là giả.
 */
import { loadVnpayConfig, VNPAY_DEFAULT_RETURN_URL } from './vnpay.config.js';

const CONFIGURED = { VNPAY_TMN_CODE: 'TESTCODE', VNPAY_HASH_SECRET: 'test-secret' };
const HTTP = 'http://csms.example.test/billing/vnpay/return';
const HTTPS = 'https://csms.example.test/billing/vnpay/return';
const ERROR = 'invalid_vnpay_config: VNPAY_RETURN_URL phải là URL https khi production';

describe('loadVnpayConfig — VNPAY_RETURN_URL https khi production (T32 Phần 8c)', () => {
  it('production + đã cấu hình + http → ném lỗi cấu hình', () => {
    expect(() =>
      loadVnpayConfig({ NODE_ENV: 'production', ...CONFIGURED, VNPAY_RETURN_URL: HTTP }),
    ).toThrow(ERROR);
  });

  it('production + đã cấu hình + thiếu VNPAY_RETURN_URL (mặc định http://localhost) → ném', () => {
    expect(VNPAY_DEFAULT_RETURN_URL.startsWith('http:')).toBe(true);
    expect(() => loadVnpayConfig({ NODE_ENV: 'production', ...CONFIGURED })).toThrow(ERROR);
  });

  it('production + chưa cấu hình + http → chạy (lab rq1-staging), configured = false', () => {
    const cfg = loadVnpayConfig({ NODE_ENV: 'production', VNPAY_RETURN_URL: HTTP });
    expect(cfg).toMatchObject({ configured: false, returnUrl: HTTP });
    // Thiếu một trong hai mã vẫn là chưa cấu hình.
    expect(loadVnpayConfig({ NODE_ENV: 'production', VNPAY_TMN_CODE: 'TESTCODE' }).returnUrl).toBe(
      VNPAY_DEFAULT_RETURN_URL,
    );
  });

  it('development + đã cấu hình + http → chạy', () => {
    const cfg = loadVnpayConfig({ NODE_ENV: 'development', ...CONFIGURED, VNPAY_RETURN_URL: HTTP });
    expect(cfg).toMatchObject({ configured: true, returnUrl: HTTP });
  });

  it('không có NODE_ENV (test) + đã cấu hình + http → chạy', () => {
    expect(loadVnpayConfig({ ...CONFIGURED, VNPAY_RETURN_URL: HTTP }).returnUrl).toBe(HTTP);
  });

  it('production + đã cấu hình + https → chạy', () => {
    const cfg = loadVnpayConfig({ NODE_ENV: 'production', ...CONFIGURED, VNPAY_RETURN_URL: HTTPS });
    expect(cfg).toMatchObject({ configured: true, returnUrl: HTTPS });
  });

  it('kiểm http(s) cũ vẫn chạy trước: URL hỏng → lỗi http(s), kể cả khi production', () => {
    expect(() =>
      loadVnpayConfig({ NODE_ENV: 'production', ...CONFIGURED, VNPAY_RETURN_URL: 'not a url' }),
    ).toThrow('invalid_vnpay_config: VNPAY_RETURN_URL phải là URL http(s)');
  });
});
