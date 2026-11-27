/**
 * Unit test adapter SePay eInvoice (T144, D5): dựng body, giờ Việt Nam, token, luồng tra trước → tạo →
 * hỏi trạng thái, bảng phân loại lỗi, không lộ mật khẩu / token. Fetch, đồng hồ, sleep đều giả: không
 * gọi mạng, không chờ thật.
 */
import type { EInvoiceInput } from './e-invoice-provider.js';
import type { SepayEInvoiceConfig } from './sepay-einvoice.config.js';
import {
  buildCreateInvoiceBody,
  classifyErrorResponse,
  classifyInvoiceState,
  sepayInvoiceNo,
  SepayEInvoiceProvider,
  sepayReferenceCode,
  vnDateTime,
} from './sepay-einvoice.provider.js';

const PASSWORD = 'PW-SECRET-zz9';
const TOKEN = 'TK-SECRET-qq7';
const UNCONFIRMED = 'Hệ thống chưa xác nhận được kết quả phát hành với nhà cung cấp hóa đơn';

const CONFIG: SepayEInvoiceConfig = {
  apiUrl: 'https://einvoice-api-sandbox.sepay.vn',
  username: 'user-1',
  password: PASSWORD,
  providerAccountId: 'acc-uuid',
  templateCode: '1',
  invoiceSeries: 'C26TSE',
  refPrefix: 'PM-DEV',
  itemCode: 'TOPUP',
  unit: 'Lần',
  buyerName: 'Khách hàng cá nhân',
};

const INPUT: EInvoiceInput = {
  idempotencyKey: '123',
  description: 'Trả trước dịch vụ sạc xe điện',
  amountVnd: 100_000,
  vatRate: 8,
  vatAmountVnd: 7_407,
  paidAt: new Date('2026-11-20T08:00:00+07:00'),
};

type Reply = { status: number; json?: unknown; text?: string } | Error;
type Req = { method: string; path: string; headers: Record<string, string>; body: unknown };
type Handler = (req: Req, n: number) => Reply;

/** Môi trường giả: fetch theo handler, đồng hồ chỉ tiến khi `sleep`, logger ghi lại. */
function harness(handler: Handler, start = Date.parse('2026-11-25T07:00:00Z')) {
  let t = start;
  const calls: Req[] = [];
  const logs: string[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    if (init?.signal?.aborted) throw new Error('aborted');
    const req: Req = {
      method: init?.method ?? 'GET',
      path: u.pathname,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(req);
    const r = handler(req, calls.length);
    if (r instanceof Error) throw r;
    return new Response(r.text ?? (r.json === undefined ? '' : JSON.stringify(r.json)), {
      status: r.status,
    });
  }) as typeof fetch;
  const provider = new SepayEInvoiceProvider(CONFIG, {
    fetch: fetchFn,
    now: () => t,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw new Error('aborted');
      t += ms;
    },
    logger: {
      warn: (m: unknown) => void logs.push(String(m)),
      error: (m: unknown) => void logs.push(String(m)),
    },
  });
  return {
    provider,
    calls,
    logs,
    advance: (ms: number) => (t += ms),
    paths: () => calls.map((c) => `${c.method} ${c.path}`),
  };
}

const tokenOk = (expiresIn = 86_400): Reply => ({
  status: 200,
  json: {
    success: true,
    data: { access_token: TOKEN, token_type: 'Bearer', expires_in: expiresIn },
  },
});
const issued = (n: string | number = '357431', status = 'issued') => ({
  reference_code: 'PM-DEV-123',
  invoice_number: n,
  status,
});
const detail = (inv: unknown): Reply => ({ status: 200, json: { success: true, data: inv } });
const check = (status: string, inv?: unknown, message = ''): Reply => ({
  status: 200,
  json: { success: true, data: { reference_code: 'PM-DEV-123', status, message, invoice: inv } },
});
const err = (status: number, code?: string, message = 'lỗi'): Reply => ({
  status,
  json: { success: false, error: { code, message } },
});
const created: Reply = {
  status: 200,
  json: { success: true, data: { tracking_code: 'trk-1', tracking_url: 'https://x/trk-1' } },
};

/** Router theo path; `create` / `check` / `detail` có thể là dãy trả lần lượt. */
function router(r: {
  token?: Reply | Reply[];
  detail?: Reply | Reply[];
  create?: Reply | Reply[];
  check?: Reply | Reply[];
}): Handler {
  const seq = (k: keyof typeof r) => {
    let i = 0;
    return () => {
      const v = r[k];
      if (v === undefined) throw new Error(`unexpected ${k}`);
      if (!Array.isArray(v)) return v;
      return v[Math.min(i++, v.length - 1)]!;
    };
  };
  const tk = seq('token');
  const de = seq('detail');
  const cr = seq('create');
  const ch = seq('check');
  return (req) => {
    if (req.path === '/v1/token') return r.token === undefined ? tokenOk() : tk();
    if (req.path === '/v1/invoices/create') return cr();
    if (req.path.startsWith('/v1/invoices/create/check/')) return ch();
    if (req.path.startsWith('/v1/invoices/')) return de();
    throw new Error(`unexpected path ${req.path}`);
  };
}

const signal = () => new AbortController().signal;

describe('hàm thuần', () => {
  it('reference_code = <prefix>-<khoá>; invoice_no = <ký hiệu>-<số>', () => {
    expect(sepayReferenceCode('PM-STG', '42')).toBe('PM-STG-42');
    expect(sepayInvoiceNo('C26TSE', '357431')).toBe('C26TSE-357431');
  });

  it('vnDateTime theo giờ Việt Nam, kể cả 23:30 UTC = sáng hôm sau và qua năm mới', () => {
    expect(vnDateTime(Date.parse('2026-11-25T07:03:07Z'))).toBe('2026-11-25 14:03:07');
    expect(vnDateTime(Date.parse('2026-11-25T23:30:00Z'))).toBe('2026-11-26 06:30:00');
    expect(vnDateTime(Date.parse('2026-12-31T17:00:00Z'))).toBe('2027-01-01 00:00:00');
  });

  it('body create: số tiền / thuế lấy đúng từ input, is_draft là boolean false, người mua chỉ có tên', () => {
    const body = buildCreateInvoiceBody(
      INPUT,
      CONFIG,
      'PM-DEV-123',
      Date.parse('2026-11-25T23:30:00Z'),
    );
    expect(body).toEqual({
      provider_account_id: 'acc-uuid',
      template_code: '1',
      invoice_series: 'C26TSE',
      issued_date: '2026-11-26 06:30:00',
      currency: 'VND',
      is_draft: false,
      reference_code: 'PM-DEV-123',
      payment_method: 'CK',
      total_amount: 100_000,
      buyer: { type: 'personal', name: 'Khách hàng cá nhân' },
      items: [
        {
          line_number: 1,
          line_type: 1,
          item_code: 'TOPUP',
          item_name: 'Trả trước dịch vụ sạc xe điện',
          unit: 'Lần',
          quantity: 1,
          unit_price: 92_593,
          tax_rate: 8,
          tax_amount: 7_407,
          total_amount: 100_000,
        },
      ],
    });
    expect(typeof body['is_draft']).toBe('boolean');
  });

  it('classifyInvoiceState: chỉ issued + số khác "0" mới là xong', () => {
    expect(classifyInvoiceState(issued(), 'C26TSE')).toEqual({
      state: 'issued',
      invoiceNo: 'C26TSE-357431',
    });
    expect(classifyInvoiceState(issued(357431), 'C26TSE')).toEqual({
      state: 'issued',
      invoiceNo: 'C26TSE-357431',
    });
    expect(classifyInvoiceState({ ...issued(), invoice_series: 'C27TSE' }, 'C26TSE')).toEqual({
      state: 'issued',
      invoiceNo: 'C27TSE-357431',
    });
    expect(classifyInvoiceState(issued('0'), 'C26TSE')).toEqual({ state: 'pending' });
    expect(classifyInvoiceState(issued('1', 'draft'), 'C26TSE')).toEqual({ state: 'pending' });
    expect(classifyInvoiceState({ status: 'Pending', invoice: null }, 'C26TSE')).toEqual({
      state: 'pending',
    });
    expect(classifyInvoiceState({ status: 'Success', invoice: issued() }, 'C26TSE')).toMatchObject({
      state: 'issued',
    });
    expect(classifyInvoiceState({ status: 'Failed', message: 'sai' }, 'C26TSE')).toEqual({
      state: 'failed',
      message: 'sai',
    });
    expect(
      classifyInvoiceState({ status: 'Pending', message: UNCONFIRMED }, 'C26TSE'),
    ).toMatchObject({ state: 'failed' });
    expect(classifyInvoiceState('x', 'C26TSE')).toEqual({ state: 'malformed' });
  });
});

describe('classifyErrorResponse — bảng phân loại', () => {
  it.each([
    [400, 'VALIDATION_ERROR', 'data'],
    [400, 'INVALID_IS_DRAFT_TYPE', 'data'],
    [400, undefined, 'data'],
    [405, 'METHOD_NOT_ALLOWED', 'data'],
    [422, 'REGISTRATION_NOT_TAX_APPROVED', 'data'],
    [422, 'INVOICE_DATE_BEFORE_TAX_APPROVAL', 'data'],
    [500, 'QUOTA_HAS_BEEN_USERD_UP', 'data'],
    [500, 'REGISTRATION_NOT_COMPLETE', 'data'],
    [500, 'BILLING_IS_UNPAID', 'data'],
    [400, 'EINVOICE_ACCOUNT_NOT_FOUND', 'data'],
    // Đồng hồ máy chủ nhanh hơn SePay vài giây → "ngày tương lai"; lượt sau gửi giờ mới là qua.
    [400, 'ISSUED_DATE_INVALID', 'transient'],
    [400, 'INVALID_ISSUED_DATE', 'transient'],
    [500, undefined, 'transient'],
    [500, 'CREATE_INVOICE_DATA_FAIL', 'transient'],
    [502, undefined, 'transient'],
    [503, undefined, 'transient'],
    [429, undefined, 'transient'],
  ] as const)('HTTP %s %s → %s', (status, code, kind) => {
    const r = classifyErrorResponse(status, { success: false, error: { code, message: 'm' } });
    expect(r.kind).toBe(kind);
    expect(r.message).toContain(`http=${status}`);
    if (code) expect(r.message).toContain(code);
  });

  it('message "chưa xác nhận được kết quả phát hành" → data, kể cả 500', () => {
    expect(
      classifyErrorResponse(500, { success: false, error: { message: UNCONFIRMED } }).kind,
    ).toBe('data');
  });

  it('body không phải JSON vẫn phân loại theo status; message SePay bị cắt ngắn', () => {
    expect(classifyErrorResponse(502, undefined).kind).toBe('transient');
    expect(classifyErrorResponse(400, undefined).kind).toBe('data');
    const long = classifyErrorResponse(400, { error: { code: 'X', message: 'a'.repeat(1000) } });
    expect(long.message.length).toBeLessThan(300);
  });
});

describe('SepayEInvoiceProvider.createInvoice', () => {
  it('đã issued từ lượt trước → không gọi create, trả đúng invoice_no', async () => {
    const h = harness(router({ detail: detail(issued()) }));
    await expect(h.provider.createInvoice(INPUT, signal())).resolves.toEqual({
      kind: 'issued',
      invoiceNo: 'C26TSE-357431',
    });
    expect(h.paths()).toEqual(['POST /v1/token', 'GET /v1/invoices/PM-DEV-123']);
    expect(h.calls[0]!.headers['authorization']).toBe(
      `Basic ${Buffer.from(`user-1:${PASSWORD}`).toString('base64')}`,
    );
    expect(h.calls[1]!.headers['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('tra trước thấy có mà chưa xong → transient sepay_pending, không create', async () => {
    const h = harness(router({ detail: detail(issued('0', 'draft')) }));
    await expect(h.provider.createInvoice(INPUT, signal())).resolves.toEqual({
      kind: 'transient',
      message: 'sepay_pending',
    });
    expect(h.paths()).not.toContain('POST /v1/invoices/create');
  });

  it('404 → create (is_draft false) → check Pending rồi Success → issued', async () => {
    const h = harness(
      router({
        detail: err(404),
        create: created,
        check: [check('Pending'), check('Success', issued())],
      }),
    );
    await expect(h.provider.createInvoice(INPUT, signal())).resolves.toEqual({
      kind: 'issued',
      invoiceNo: 'C26TSE-357431',
    });
    expect(h.paths()).toEqual([
      'POST /v1/token',
      'GET /v1/invoices/PM-DEV-123',
      'POST /v1/invoices/create',
      'GET /v1/invoices/create/check/trk-1',
      'GET /v1/invoices/create/check/trk-1',
    ]);
    const body = h.calls[2]!.body as Record<string, unknown>;
    expect(body['is_draft']).toBe(false);
    expect(body['reference_code']).toBe('PM-DEV-123');
  });

  it('409 EINVOICE_DOCUMENT_EXISTED → tra theo ref → issued', async () => {
    const h = harness(
      router({
        detail: [err(404), detail(issued())],
        create: err(409, 'EINVOICE_DOCUMENT_EXISTED'),
      }),
    );
    await expect(h.provider.createInvoice(INPUT, signal())).resolves.toEqual({
      kind: 'issued',
      invoiceNo: 'C26TSE-357431',
    });
  });

  it('409 rồi tra theo ref vẫn 404 → transient, chỉ một lần POST', async () => {
    const h = harness(router({ detail: err(404), create: err(409, 'EINVOICE_DOCUMENT_EXISTED') }));
    await expect(h.provider.createInvoice(INPUT, signal())).resolves.toEqual({
      kind: 'transient',
      message: 'sepay_pending',
    });
    expect(h.paths().filter((p) => p === 'POST /v1/invoices/create')).toHaveLength(1);
  });

  it('check mãi Pending → transient sepay_pending trong ngân sách (4 lần hỏi)', async () => {
    const h = harness(router({ detail: err(404), create: created, check: check('Pending') }));
    await expect(h.provider.createInvoice(INPUT, signal())).resolves.toEqual({
      kind: 'transient',
      message: 'sepay_pending',
    });
    expect(h.paths().filter((p) => p.includes('/check/'))).toHaveLength(4);
  });

  it('check issued nhưng số "0" → chưa xong', async () => {
    const h = harness(
      router({ detail: err(404), create: created, check: check('Success', issued('0')) }),
    );
    await expect(h.provider.createInvoice(INPUT, signal())).resolves.toMatchObject({
      kind: 'transient',
    });
  });

  it('check Failed → data; câu "chưa xác nhận" → data (không gửi lại)', async () => {
    for (const msg of ['Chữ ký lỗi', UNCONFIRMED]) {
      const h = harness(
        router({ detail: err(404), create: created, check: check('Failed', null, msg) }),
      );
      const r = await h.provider.createInvoice(INPUT, signal());
      expect(r.kind).toBe('data');
      expect(r.kind !== 'issued' && r.message).toContain(msg);
      expect(h.paths().filter((p) => p === 'POST /v1/invoices/create')).toHaveLength(1);
    }
  });

  it.each([
    [err(400, 'VALIDATION_ERROR'), 'data'],
    [err(400, 'ISSUED_DATE_INVALID'), 'transient'],
    [err(500, 'QUOTA_HAS_BEEN_USERD_UP'), 'data'],
    [err(503), 'transient'],
    [{ status: 200, text: '{hỏng' } as Reply, 'transient'],
    [{ status: 200, json: { success: true, data: {} } } as Reply, 'transient'],
    [new Error('ECONNRESET https://x?pw'), 'transient'],
  ])('create trả %j → %s', async (reply, kind) => {
    const h = harness(router({ detail: err(404), create: reply }));
    const r = await h.provider.createInvoice(INPUT, signal());
    expect(r.kind).toBe(kind);
  });

  it('JSON hỏng ở tra trước → transient sepay_malformed_response', async () => {
    const h = harness(router({ detail: { status: 200, text: '<html>' } }));
    await expect(h.provider.createInvoice(INPUT, signal())).resolves.toEqual({
      kind: 'transient',
      message: 'sepay_malformed_response',
    });
  });

  it('signal huỷ giữa lúc chờ hỏi trạng thái → transient, không gọi thêm', async () => {
    const ctrl = new AbortController();
    const h = harness((req) => {
      const r = router({ detail: err(404), create: created, check: check('Pending') })(req, 0);
      if (req.path.includes('/check/')) ctrl.abort();
      return r;
    });
    const r = await h.provider.createInvoice(INPUT, ctrl.signal);
    expect(r.kind).toBe('transient');
    expect(h.paths().filter((p) => p.includes('/check/'))).toHaveLength(1);
  });
});

describe('token', () => {
  it('cache: hai lần gọi chỉ xin token một lần; còn < 5 phút thì xin mới', async () => {
    const h = harness(router({ token: tokenOk(3_600), detail: detail(issued()) }));
    await h.provider.createInvoice(INPUT, signal());
    await h.provider.createInvoice(INPUT, signal());
    expect(h.paths().filter((p) => p === 'POST /v1/token')).toHaveLength(1);
    h.advance(3_600_000 - 4 * 60_000);
    await h.provider.createInvoice(INPUT, signal());
    expect(h.paths().filter((p) => p === 'POST /v1/token')).toHaveLength(2);
  });

  it('hai lời gọi song song chỉ xin token một lần', async () => {
    const h = harness(router({ detail: detail(issued()) }));
    await Promise.all([
      h.provider.createInvoice(INPUT, signal()),
      h.provider.createInvoice(INPUT, signal()),
    ]);
    expect(h.paths().filter((p) => p === 'POST /v1/token')).toHaveLength(1);
  });

  it('401 trên API → xin token mới đúng một lần rồi thành công', async () => {
    const h = harness(router({ detail: [err(401, 'TOKEN_EXPIRED'), detail(issued())] }));
    await expect(h.provider.createInvoice(INPUT, signal())).resolves.toMatchObject({
      kind: 'issued',
    });
    expect(h.paths()).toEqual([
      'POST /v1/token',
      'GET /v1/invoices/PM-DEV-123',
      'POST /v1/token',
      'GET /v1/invoices/PM-DEV-123',
    ]);
  });

  it('401 cả sau khi xin token mới → transient sepay_unauthorized, log error', async () => {
    const h = harness(router({ detail: err(401) }));
    await expect(h.provider.createInvoice(INPUT, signal())).resolves.toEqual({
      kind: 'transient',
      message: 'sepay_unauthorized',
    });
    expect(h.paths().filter((p) => p === 'POST /v1/token')).toHaveLength(2);
    expect(h.logs.join('\n')).toContain('sepay_einvoice_unauthorized');
  });

  it('/v1/token trả 401 (sai mật khẩu) → transient sepay_unauthorized', async () => {
    const h = harness(router({ token: err(401) }));
    await expect(h.provider.createInvoice(INPUT, signal())).resolves.toEqual({
      kind: 'transient',
      message: 'sepay_unauthorized',
    });
  });
});

describe('không lộ mật khẩu / token', () => {
  const scenarios: Record<string, Handler> = {
    issued: router({ detail: detail(issued()) }),
    unauthorized: router({ detail: err(401) }),
    tokenFail: router({ token: err(401) }),
    network: router({ detail: new Error(`fetch failed Bearer ${TOKEN} ${PASSWORD}`) }),
    malformed: router({ detail: { status: 200, text: `{${TOKEN}` } }),
    pending: router({ detail: err(404), create: created, check: check('Pending') }),
  };

  it.each(Object.keys(scenarios))('%s', async (name) => {
    const h = harness(scenarios[name]!);
    const r = await h.provider.createInvoice(INPUT, signal());
    const text = JSON.stringify(r) + h.logs.join('\n');
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toMatch(/Basic |Bearer /);
  });
});
