/**
 * Unit test chọn nhà cung cấp hoá đơn (T144, D5): `EINVOICE_PROVIDER` mặc định stub; `sepay` bắt buộc đủ
 * biến, sai → `invalid_einvoice_config` lúc khởi động, message không chứa giá trị bí mật.
 */
import { StubEInvoiceProvider } from './e-invoice-provider.js';
import {
  createEInvoiceProvider,
  loadSepayEInvoiceConfig,
  SEPAY_EINVOICE_SANDBOX_URL,
} from './sepay-einvoice.config.js';
import { SepayEInvoiceProvider } from './sepay-einvoice.provider.js';

const SEPAY_ENV = {
  EINVOICE_PROVIDER: 'sepay',
  SEPAY_EINVOICE_USERNAME: 'user-1',
  SEPAY_EINVOICE_PASSWORD: 'PW-SECRET-zz9',
  SEPAY_EINVOICE_PROVIDER_ACCOUNT_ID: 'acc-uuid',
  SEPAY_EINVOICE_TEMPLATE_CODE: '1',
  SEPAY_EINVOICE_INVOICE_SERIES: 'C26TSE',
  SEPAY_EINVOICE_REF_PREFIX: 'PM-DEV',
};

describe('createEInvoiceProvider', () => {
  it.each([{}, { EINVOICE_PROVIDER: '' }, { EINVOICE_PROVIDER: 'stub' }])('%j → stub', (env) => {
    expect(createEInvoiceProvider(env)).toBeInstanceOf(StubEInvoiceProvider);
  });

  it('stub vẫn kiểm EINVOICE_STUB_*', () => {
    expect(() => createEInvoiceProvider({ EINVOICE_STUB_MODE: 'x' })).toThrow(
      'invalid_einvoice_config',
    );
  });

  it('sepay đủ biến → SepayEInvoiceProvider', () => {
    expect(createEInvoiceProvider(SEPAY_ENV)).toBeInstanceOf(SepayEInvoiceProvider);
  });

  it('giá trị lạ → ném', () => {
    expect(() => createEInvoiceProvider({ EINVOICE_PROVIDER: 'misa' })).toThrow(
      'invalid_einvoice_config: EINVOICE_PROVIDER',
    );
  });
});

describe('loadSepayEInvoiceConfig', () => {
  it('mặc định: URL sandbox, TOPUP, Lần, Khách hàng cá nhân', () => {
    expect(loadSepayEInvoiceConfig(SEPAY_ENV)).toEqual({
      apiUrl: SEPAY_EINVOICE_SANDBOX_URL,
      username: 'user-1',
      password: 'PW-SECRET-zz9',
      providerAccountId: 'acc-uuid',
      templateCode: '1',
      invoiceSeries: 'C26TSE',
      refPrefix: 'PM-DEV',
      itemCode: 'TOPUP',
      unit: 'Lần',
      buyerName: 'Khách hàng cá nhân',
    });
  });

  it('nhận URL https khác, bỏ "/" cuối; tuỳ chọn ghi đè được', () => {
    const c = loadSepayEInvoiceConfig({
      ...SEPAY_ENV,
      SEPAY_EINVOICE_API_URL: 'https://einvoice-api.sepay.vn/',
      SEPAY_EINVOICE_ITEM_CODE: 'NAP',
      SEPAY_EINVOICE_UNIT: 'Gói',
      SEPAY_EINVOICE_BUYER_NAME: 'Người mua',
    });
    expect(c).toMatchObject({
      apiUrl: 'https://einvoice-api.sepay.vn',
      itemCode: 'NAP',
      unit: 'Gói',
      buyerName: 'Người mua',
    });
  });

  it.each([
    'SEPAY_EINVOICE_USERNAME',
    'SEPAY_EINVOICE_PASSWORD',
    'SEPAY_EINVOICE_PROVIDER_ACCOUNT_ID',
    'SEPAY_EINVOICE_TEMPLATE_CODE',
    'SEPAY_EINVOICE_INVOICE_SERIES',
    'SEPAY_EINVOICE_REF_PREFIX',
  ])('thiếu %s → ném, nêu tên biến', (name) => {
    for (const env of [
      { ...SEPAY_ENV, [name]: undefined },
      { ...SEPAY_ENV, [name]: '  ' },
    ]) {
      expect(() => loadSepayEInvoiceConfig(env)).toThrow(`invalid_einvoice_config: ${name}`);
    }
  });

  it.each([
    ['SEPAY_EINVOICE_API_URL', 'http://einvoice-api-sandbox.sepay.vn'],
    ['SEPAY_EINVOICE_API_URL', 'không phải url'],
    ['SEPAY_EINVOICE_REF_PREFIX', 'PM DEV'],
    ['SEPAY_EINVOICE_REF_PREFIX', 'PM-'],
    ['SEPAY_EINVOICE_REF_PREFIX', 'A'.repeat(21)],
    ['SEPAY_EINVOICE_INVOICE_SERIES', 'c26tse'],
  ])('%s = %j → ném', (name, value) => {
    expect(() => loadSepayEInvoiceConfig({ ...SEPAY_ENV, [name]: value })).toThrow(
      `invalid_einvoice_config: ${name}`,
    );
  });

  it('message lỗi không chứa mật khẩu', () => {
    try {
      loadSepayEInvoiceConfig({ ...SEPAY_ENV, SEPAY_EINVOICE_API_URL: 'http://x' });
      throw new Error('không ném');
    } catch (e) {
      expect(String(e)).not.toContain('PW-SECRET-zz9');
    }
  });
});
