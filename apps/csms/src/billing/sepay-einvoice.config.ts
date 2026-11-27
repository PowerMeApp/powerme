/**
 * Chọn nhà cung cấp hoá đơn điện tử và cấu hình SePay eInvoice (T144, decisions D5). Cùng mẫu
 * `vnpay.config.ts`: đọc env một lần lúc khởi động, sai → ném `invalid_einvoice_config` (csms không
 * khởi động), message chỉ nêu tên biến, không nêu giá trị.
 *
 * `EINVOICE_PROVIDER`: `stub` (mặc định, kể cả rỗng; test / CI / máy dev không cần mã) | `sepay`.
 * Không ghi mã thật vào repo: tên đăng nhập / mật khẩu lấy ở my.sepay.vn → "API xuất hoá đơn điện
 * tử", chỉ đặt trong `.env` trên máy chạy.
 */
import {
  EInvoiceProviderAdapter,
  loadEInvoiceStubConfig,
  StubEInvoiceProvider,
} from './e-invoice-provider.js';
import { SepayEInvoiceProvider } from './sepay-einvoice.provider.js';

export const SEPAY_EINVOICE_SANDBOX_URL = 'https://einvoice-api-sandbox.sepay.vn';

export interface SepayEInvoiceConfig {
  /** Gốc API, không có `/` cuối. */
  apiUrl: string;
  username: string;
  password: string;
  providerAccountId: string;
  /** Mẫu hoá đơn GTGT (mẫu "2" bán hàng bỏ qua thuế suất). */
  templateCode: string;
  /** Ký hiệu `C{YY}…`, phải đổi theo năm (C26… hết dùng từ 01/01/2027). */
  invoiceSeries: string;
  /** Tiền tố `reference_code`, riêng từng môi trường (PM-DEV, PM-STG): sandbox dùng chung tài khoản. */
  refPrefix: string;
  itemCode: string;
  unit: string;
  buyerName: string;
}

const REQUIRED = {
  username: 'SEPAY_EINVOICE_USERNAME',
  password: 'SEPAY_EINVOICE_PASSWORD',
  providerAccountId: 'SEPAY_EINVOICE_PROVIDER_ACCOUNT_ID',
  templateCode: 'SEPAY_EINVOICE_TEMPLATE_CODE',
  invoiceSeries: 'SEPAY_EINVOICE_INVOICE_SERIES',
  refPrefix: 'SEPAY_EINVOICE_REF_PREFIX',
} as const;

function invalid(name: string, rule: string): Error {
  return new Error(`invalid_einvoice_config: ${name} ${rule}`);
}

export function loadSepayEInvoiceConfig(env: NodeJS.ProcessEnv = process.env): SepayEInvoiceConfig {
  const get = (name: string) => (env[name] ?? '').trim();
  const req = {} as Record<keyof typeof REQUIRED, string>;
  for (const [key, name] of Object.entries(REQUIRED) as [keyof typeof REQUIRED, string][]) {
    const v = get(name);
    if (v === '') throw invalid(name, 'bắt buộc khi EINVOICE_PROVIDER=sepay');
    req[key] = v;
  }
  const apiUrl = (get('SEPAY_EINVOICE_API_URL') || SEPAY_EINVOICE_SANDBOX_URL).replace(/\/+$/, '');
  let protocol = '';
  try {
    protocol = new URL(apiUrl).protocol;
  } catch {
    // giữ rỗng → ném bên dưới
  }
  if (protocol !== 'https:') throw invalid('SEPAY_EINVOICE_API_URL', 'phải là URL https');
  if (!/^[A-Z0-9]{1,10}$/.test(req.invoiceSeries))
    throw invalid('SEPAY_EINVOICE_INVOICE_SERIES', 'chỉ gồm A-Z 0-9, tối đa 10 ký tự');
  if (req.refPrefix.length > 20 || !/^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/.test(req.refPrefix))
    throw invalid(
      'SEPAY_EINVOICE_REF_PREFIX',
      'dạng PM-STG (chữ, số, "-" ở giữa), tối đa 20 ký tự',
    );
  return {
    apiUrl,
    ...req,
    itemCode: get('SEPAY_EINVOICE_ITEM_CODE') || 'TOPUP',
    unit: get('SEPAY_EINVOICE_UNIT') || 'Lần',
    buyerName: get('SEPAY_EINVOICE_BUYER_NAME') || 'Khách hàng cá nhân',
  };
}

/** Factory của `E_INVOICE_PROVIDER` (BillingModule). */
export function createEInvoiceProvider(
  env: NodeJS.ProcessEnv = process.env,
): EInvoiceProviderAdapter {
  const kind = (env['EINVOICE_PROVIDER'] ?? '').trim() || 'stub';
  if (kind === 'stub') return new StubEInvoiceProvider(loadEInvoiceStubConfig(env));
  if (kind === 'sepay') return new SepayEInvoiceProvider(loadSepayEInvoiceConfig(env));
  throw invalid('EINVOICE_PROVIDER', 'phải là stub | sepay');
}
