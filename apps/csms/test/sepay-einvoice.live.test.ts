/**
 * Live test SePay eInvoice sandbox (T144, D5). CI KHÔNG chạy: `describe.skip` khi thiếu
 * `SEPAY_EINVOICE_LIVE=1` hoặc thiếu / sai biến `SEPAY_EINVOICE_*`. Không cần `DATABASE_URL`.
 *
 * Mỗi lần chạy dùng một khoá mới, nên tạo **một hoá đơn thật trên sandbox**:
 *   1. `createInvoice` (`is_draft: false`, người mua chỉ có tên) qua `callProvider` (timeout 10 s);
 *   2. tra chi tiết theo `reference_code` ngay sau đó (làm rõ: lệnh đang chờ thì chi tiết trả 404 hay
 *      trả bản ghi — D5 "Còn mở");
 *   3. gọi lại cùng khoá tới khi ra `issued` (tối đa vài lượt) rồi thêm một lượt: phải cùng `invoiceNo`.
 * Chỉ in kết quả đã che: kind, số hoá đơn, trạng thái, message cắt ngắn. Không in mật khẩu / token.
 */
import { callProvider, EInvoiceInput, EInvoiceResult } from '../src/billing/e-invoice-provider.js';
import { splitVat, vatRateAt } from '../src/billing/e-invoice.js';
import {
  loadSepayEInvoiceConfig,
  SepayEInvoiceConfig,
} from '../src/billing/sepay-einvoice.config.js';
import {
  SepayEInvoiceProvider,
  sepayReferenceCode,
} from '../src/billing/sepay-einvoice.provider.js';

function liveConfig(): SepayEInvoiceConfig | null {
  if (process.env['SEPAY_EINVOICE_LIVE'] !== '1') return null;
  try {
    return loadSepayEInvoiceConfig();
  } catch (e) {
    // Message của loader chỉ nêu tên biến, không nêu giá trị.
    console.log(`sepay live test bỏ qua: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

const config = liveConfig();
const run = config ? describe : describe.skip;

const masked = (r: EInvoiceResult) =>
  r.kind === 'issued'
    ? { kind: r.kind, invoiceNo: r.invoiceNo }
    : { kind: r.kind, message: r.message.slice(0, 160) };

/** Tra chi tiết bằng fetch riêng (không qua adapter), chỉ trả trường không bí mật. */
async function peekDetail(cfg: SepayEInvoiceConfig, ref: string) {
  const basic = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
  const tokenRes = await fetch(`${cfg.apiUrl}/v1/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, accept: 'application/json' },
  });
  const token = ((await tokenRes.json()) as { data?: { access_token?: string } }).data
    ?.access_token;
  const res = await fetch(`${cfg.apiUrl}/v1/invoices/${encodeURIComponent(ref)}`, {
    headers: { authorization: `Bearer ${token ?? ''}`, accept: 'application/json' },
  });
  const json = (await res.json().catch(() => null)) as {
    data?: { status?: unknown; invoice_number?: unknown };
    error?: { code?: unknown };
  } | null;
  return {
    http: res.status,
    status: json?.data?.status,
    invoice_number: json?.data?.invoice_number,
    error_code: json?.error?.code,
  };
}

// testTimeout chung của jest.config.js là 120 s, đủ cho 6 lượt × (10 s + 5 s chờ).
run('SePay eInvoice sandbox (live)', () => {
  it('tạo + phát hành một bước, gọi lại cùng khoá → cùng invoiceNo', async () => {
    const cfg = config!;
    const provider = new SepayEInvoiceProvider(cfg);
    const now = new Date();
    const amountVnd = 10_000;
    const vatRate = vatRateAt(now);
    const input: EInvoiceInput = {
      idempotencyKey: `live${now.getTime()}`,
      description: 'Trả trước dịch vụ sạc xe điện',
      amountVnd,
      vatRate,
      vatAmountVnd: splitVat(amountVnd, vatRate),
      paidAt: now,
    };
    const ref = sepayReferenceCode(cfg.refPrefix, input.idempotencyKey);
    console.log(`sepay live: reference_code=${ref}`);

    const first = await callProvider(provider, input);
    console.log('sepay live lượt 1:', JSON.stringify(masked(first)));
    console.log('sepay live chi tiết ngay sau lượt 1:', JSON.stringify(await peekDetail(cfg, ref)));
    expect(first.kind).not.toBe('data');

    let last = first;
    for (let i = 2; last.kind !== 'issued' && i <= 6; i++) {
      await new Promise((r) => setTimeout(r, 5_000));
      last = await callProvider(provider, input);
      console.log(`sepay live lượt ${i}:`, JSON.stringify(masked(last)));
    }
    expect(last.kind).toBe('issued');

    const again = await callProvider(provider, input);
    console.log('sepay live gọi lại cùng khoá:', JSON.stringify(masked(again)));
    expect(again).toEqual(last);
  });
});
