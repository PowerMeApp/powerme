/**
 * Mock "CSMS" trong trình duyệt — dashboard chạy hoàn toàn trên đây cho tới khi có REST API thật.
 *
 * Vì sao tồn tại: chưa nhánh nào có REST API cho operator/admin (Design Brief G1); FE-04 chỉ có
 * route console `/api/admin/faults`. Mock nhận ĐÚNG đường dẫn REST dự kiến (`/api/v1/operator/*`,
 * `/api/admin/*` — UC-ADM-08 §7) và trả mã lỗi HTTP thật (404/409/422/502), áp cùng luật với sơ đồ:
 *   - sự cố: STM-6 (features/alerts/faultStateMachine) + hành vi Reset của WF-04 seq 1/2;
 *   - billing: SD-2c pha D/E, STM-4/7, BR-P21/P44 (features/billing/rules);
 *   - onboarding: WF-05 (serial phải được Admin đăng ký trước, credential chỉ trả một lần);
 *   - phiên: STM-1 #17 (review → reconciled), WP3 T72 (khôi phục lệnh start bị kẹt).
 * Nối API thật = thay `mockBaseQuery` trong core/api, không đổi UI.
 */
import { canRefundTopUp, splitClosureRefund } from '../features/billing/rules';
import { guideFor } from '../features/alerts/errorCodeGuide';
import { nextFaultStatus } from '../features/alerts/faultStateMachine';
import { validateBands } from '../features/tariffs/validateBands';
import type {
  CommandAction,
  FaultEvent,
  Pillar,
  RemoteCommand,
  TariffPeriod,
} from '../types/domain';
import { createSeed, MockDb, MockFault } from './fixtures';

export interface MockRequest {
  url: string;
  method?: string;
  body?: unknown;
}
export interface MockResponse {
  status: number;
  data: unknown;
}

/** Thời gian giả lập (ms). Test đặt latency 0 và dùng fake timer cho reboot / hạn chờ. */
export const mockConfig = {
  latencyMs: import.meta.env.MODE === 'test' ? 0 : 250,
  rebootMs: 4_000,
  resetTimeoutMs: 20_000,
  commandReplyMs: 800,
};

let db: MockDb = createSeed();
let timers: ReturnType<typeof setTimeout>[] = [];

export function resetMockServer(): void {
  timers.forEach(clearTimeout);
  timers = [];
  db = createSeed();
}

/** Cho test đọc thẳng trạng thái mock. */
export function mockDb(): MockDb {
  return db;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string,
  ) {
    super(detail);
  }
}

type Params = Record<string, string>;
type Handler = (p: Params, q: URLSearchParams, body: Record<string, unknown>) => unknown;

const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];

function route(method: string, path: string, handler: Handler): void {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' +
      path.replace(/:([a-zA-Z]+)/g, (_m, k: string) => {
        keys.push(k);
        return '([^/]+)';
      }) +
      '$',
  );
  routes.push({ method, pattern, keys, handler });
}

function later(ms: number, fn: () => void): void {
  timers.push(setTimeout(fn, ms));
}

const nowIso = () => new Date().toISOString();

function idParam(p: Params): number {
  const id = Number(p['id']);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'bad_request', 'id không hợp lệ');
  return id;
}

function text(body: Record<string, unknown>, key: string, min = 1): string {
  const v = body[key];
  if (typeof v !== 'string' || v.trim().length < min) {
    throw new HttpError(422, 'validation', `${key} phải có ít nhất ${min} ký tự`);
  }
  return v.trim();
}

// ---------------------------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------------------------

route('POST', '/api/v1/auth/login', (_p, _q, body) => {
  const email = String(body['email'] ?? '')
    .trim()
    .toLowerCase();
  const password = String(body['password'] ?? '');
  const user = db.users.find((u) => u.email === email && u.password === password);
  if (!user) throw new HttpError(401, 'invalid_credentials', 'Email hoặc mật khẩu không đúng');
  const { password: _pw, ...session } = user;
  return { token: `mock-token-${user.id}`, user: session };
});

// ---------------------------------------------------------------------------------------------
// Operator — trụ, sự cố, lệnh
// ---------------------------------------------------------------------------------------------

function faultView(f: MockFault): FaultEvent {
  const g = guideFor(f.errorCode);
  const pillar = db.pillars.find((p) => p.id === f.pillarId);
  const cmd = f.resetCommandId ? db.commands.find((c) => c.id === f.resetCommandId) : undefined;
  const { resetBehaviour: _b, ...rest } = f;
  return {
    ...rest,
    severity: g.severity,
    hint: g.hint,
    pillarOnline: pillar?.isOnline ?? false,
    resetCommandStatus: cmd?.status ?? null,
  };
}

function pillarOr404(id: number): Pillar {
  const p = db.pillars.find((x) => x.id === id);
  if (!p) throw new HttpError(404, 'not_found', `Không có trụ id=${id}`);
  return p;
}

function faultOr404(id: number): MockFault {
  const f = db.faults.find((x) => x.id === id);
  if (!f) throw new HttpError(404, 'not_found', `Không có sự cố id=${id}`);
  return f;
}

function applyFault(f: MockFault, trigger: Parameters<typeof nextFaultStatus>[1]): void {
  const to = nextFaultStatus(f.status, trigger);
  if (to === null) {
    throw new HttpError(
      409,
      'invalid_transition',
      `Sự cố đang ở trạng thái ${f.status}, không áp được ${trigger} (STM-6)`,
    );
  }
  f.status = to;
}

function setConnectors(f: MockFault, status: 'Available' | 'Faulted' | 'Unavailable'): void {
  const pillar = db.pillars.find((p) => p.id === f.pillarId);
  if (!pillar) return;
  for (const c of pillar.connectors) {
    if (f.connectorNo === 0 || c.connectorNo === f.connectorNo) {
      c.status = status;
      c.errorCode = status === 'Faulted' ? f.errorCode : null;
      c.statusChangedAt = nowIso();
    }
  }
}

function newCommand(
  pillarId: number,
  action: CommandAction,
  connectorNo: number | null,
  payload: Record<string, unknown>,
): RemoteCommand {
  const cmd: RemoteCommand = {
    id: db.seq.command++,
    pillarId,
    action,
    connectorNo,
    payload,
    status: 'sent',
    requestedAt: nowIso(),
    respondedAt: null,
  };
  db.commands.unshift(cmd);
  return cmd;
}

route('GET', '/api/v1/operator/summary', () => {
  const open = db.faults.filter((f) => f.status !== 'resolved').map(faultView);
  const connectors = db.pillars.flatMap((p) => p.connectors);
  return {
    pillars: db.pillars.length,
    online: db.pillars.filter((p) => p.isOnline).length,
    offline: db.pillars.filter((p) => !p.isOnline).length,
    connectors: {
      available: connectors.filter((c) => c.status === 'Available').length,
      charging: connectors.filter(
        (c) => c.status === 'Charging' || c.status.startsWith('Suspended'),
      ).length,
      faulted: connectors.filter((c) => c.status === 'Faulted').length,
      other: connectors.filter(
        (c) =>
          !['Available', 'Charging', 'SuspendedEV', 'SuspendedEVSE', 'Faulted'].includes(c.status),
      ).length,
    },
    openAlerts: {
      total: open.length,
      critical: open.filter((f) => f.severity === 'critical').length,
      major: open.filter((f) => f.severity === 'major').length,
      minor: open.filter((f) => f.severity === 'minor').length,
    },
    sessionsToReview: db.sessions.filter((s) => s.resolvedNote === null).length,
    stuckStarts: db.intents.filter((i) => i.state === 'stuck' || i.state === 'recovering').length,
  };
});

route('GET', '/api/v1/operator/sites', () => db.sites);

route('GET', '/api/v1/operator/pillars', () => db.pillars);

route('GET', '/api/v1/operator/pillars/:id', (p) => {
  const pillar = pillarOr404(idParam(p));
  return {
    pillar,
    faults: db.faults
      .filter((f) => f.pillarId === pillar.id)
      .map(faultView)
      .sort((a, b) => b.raisedAt.localeCompare(a.raisedAt)),
    commands: db.commands.filter((c) => c.pillarId === pillar.id),
    sessions: db.sessions.filter((s) => s.serial === pillar.serial),
  };
});

/** WF-05 / SD-5a: operator onboard serial đã được Admin đăng ký vào site của mình. */
route('POST', '/api/v1/operator/pillars', (_p, _q, body) => {
  const serial = text(body, 'serial', 6).toUpperCase();
  const siteId = Number(body['siteId']);
  const model = body['model'] === 'YJ-EU-60' ? 'YJ-EU-60' : 'D1-120';
  const connectorCount = Number(body['connectorCount']) === 1 ? 1 : 2;
  const site = db.sites.find((s) => s.id === siteId);
  if (!site) throw new HttpError(422, 'validation', 'Chọn một site của operator');
  const device = db.devices.find((d) => d.serial === serial);
  if (!device) {
    throw new HttpError(
      409,
      'not_registered',
      `Serial ${serial} chưa có trong sổ thiết bị — Admin phải đăng ký trước (UC-ADM-03)`,
    );
  }
  if (device.lifecycle !== 'registered') {
    throw new HttpError(409, 'already_onboarded', `Trụ ${serial} đã được onboard`);
  }
  device.lifecycle = 'awaiting_connection';
  device.model = model;
  device.operatorName = 'SaiGon EV Partners';
  const pillar: Pillar = {
    id: db.seq.pillar++,
    serial,
    displayCode: `${site.code.split('-')[1] ?? 'NEW'}-${String(db.pillars.length + 1).padStart(2, '0')}`,
    model,
    firmware: device.firmware,
    siteId: site.id,
    siteName: site.name,
    lifecycle: 'awaiting_connection',
    isOnline: false,
    lastSeenAt: null,
    connectors: Array.from({ length: connectorCount }, (_v, i) => ({
      connectorNo: (i + 1) as 1 | 2,
      status: 'Unavailable' as const,
      errorCode: null,
      statusChangedAt: nowIso(),
      activeSession: null,
    })),
  };
  db.pillars.push(pillar);
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let password = '';
  for (let i = 0; i < 20; i += 1) password += alphabet[Math.floor(Math.random() * alphabet.length)];
  return { pillar, credential: { username: serial, password } };
});

/** UC-OPS-04: lệnh từ xa ngoài luồng sự cố. */
route('POST', '/api/v1/operator/pillars/:id/commands', (p, _q, body) => {
  const pillar = pillarOr404(idParam(p));
  const action = body['action'] as CommandAction;
  if (!['Reset', 'UnlockConnector', 'RemoteStopTransaction'].includes(action)) {
    throw new HttpError(422, 'validation', 'Lệnh không hỗ trợ');
  }
  if (!pillar.isOnline) {
    throw new HttpError(409, 'station_offline', `Trụ ${pillar.serial} đang offline`);
  }
  const connectorNo = typeof body['connectorNo'] === 'number' ? body['connectorNo'] : null;
  const connector = pillar.connectors.find((c) => c.connectorNo === connectorNo);
  if (action !== 'Reset' && !connector) {
    throw new HttpError(422, 'validation', 'Chọn súng cho lệnh này');
  }
  const cmd = newCommand(
    pillar.id,
    action,
    connectorNo,
    action === 'Reset' ? { type: body['type'] === 'Hard' ? 'Hard' : 'Soft' } : {},
  );
  later(mockConfig.commandReplyMs, () => {
    cmd.respondedAt = nowIso();
    if (action === 'RemoteStopTransaction' && connector && !connector.activeSession) {
      cmd.status = 'rejected';
      return;
    }
    cmd.status = 'accepted';
    if (action === 'RemoteStopTransaction' && connector) {
      connector.activeSession = null;
      connector.status = 'Available';
      connector.statusChangedAt = nowIso();
    }
  });
  return cmd;
});

route('GET', '/api/v1/operator/faults', (_p, q) => {
  const filter = q.get('status') ?? 'open';
  return db.faults
    .filter((f) => filter === 'all' || f.status !== 'resolved')
    .map(faultView)
    .sort((a, b) => {
      const openA = a.status === 'resolved' ? 1 : 0;
      const openB = b.status === 'resolved' ? 1 : 0;
      if (openA !== openB) return openA - openB;
      const rank = { critical: 0, major: 1, minor: 2, none: 3 };
      return rank[a.severity] - rank[b.severity] || b.raisedAt.localeCompare(a.raisedAt);
    });
});

/** STM-6 t2. */
route('POST', '/api/v1/operator/faults/:id/acknowledge', (p) => {
  const f = faultOr404(idParam(p));
  applyFault(f, 'ACKNOWLEDGE');
  f.acknowledgedAt = nowIso();
  return faultView(f);
});

/** STM-6 t7 OPERATOR_CLOSE (sau khi kiểm tra tại chỗ). */
route('POST', '/api/v1/operator/faults/:id/close', (p) => {
  const f = faultOr404(idParam(p));
  applyFault(f, 'OPERATOR_CLOSE');
  f.resolvedAt = nowIso();
  return faultView(f);
});

/**
 * STM-6 t4 → (Accepted) chờ súng Available (t5) hoặc hết hạn (t6); (Rejected) → t6 ngay.
 * Cùng hành vi với FE-04: kiểm trước khi ghi (409 chưa acknowledged / trụ offline).
 */
route('POST', '/api/v1/operator/faults/:id/reset', (p, q) => {
  const f = faultOr404(idParam(p));
  if (nextFaultStatus(f.status, 'RESET_SENT') === null) {
    throw new HttpError(
      409,
      'fault_not_acknowledged',
      `Sự cố đang ở trạng thái ${f.status}; chỉ Reset được khi đã xác nhận`,
    );
  }
  const pillar = pillarOr404(f.pillarId);
  if (!pillar.isOnline) {
    throw new HttpError(409, 'station_offline', `Trụ ${pillar.serial} đang offline`);
  }
  const type = q.get('type') === 'Hard' ? 'Hard' : 'Soft';
  applyFault(f, 'RESET_SENT');
  const cmd = newCommand(pillar.id, 'Reset', null, { type });
  f.resetCommandId = cmd.id;
  cmd.respondedAt = nowIso();

  if (f.resetBehaviour === 'rejected') {
    cmd.status = 'rejected';
    applyFault(f, 'RESET_FAILED');
    return { fault: faultView(f), resetStatus: 'Rejected' };
  }

  cmd.status = 'accepted';
  f.resetDeadline = new Date(Date.now() + mockConfig.resetTimeoutMs).toISOString();
  setConnectors(f, 'Unavailable'); // trụ khởi động lại
  const commandId = cmd.id;
  later(mockConfig.rebootMs, () => {
    if (f.status !== 'resetting' || f.resetCommandId !== commandId) return;
    if (f.resetBehaviour === 'recovers') {
      setConnectors(f, 'Available');
      applyFault(f, 'CONNECTOR_AVAILABLE');
      f.resolvedAt = nowIso();
      f.resetDeadline = null;
    } else {
      setConnectors(f, 'Faulted'); // lỗi sống qua reboot (như simulator D1)
    }
  });
  later(mockConfig.resetTimeoutMs, () => {
    if (f.status !== 'resetting' || f.resetCommandId !== commandId) return;
    applyFault(f, 'RESET_FAILED');
    f.resetDeadline = null;
  });
  return { fault: faultView(f), resetStatus: 'Accepted' };
});

// ---------------------------------------------------------------------------------------------
// Operator — phiên cần xử lý (WF-03, UC-OPS-05) và khôi phục lệnh start (WP3 T72)
// ---------------------------------------------------------------------------------------------

route('GET', '/api/v1/operator/sessions', (_p, q) => {
  const queue = q.get('queue') ?? 'review';
  return db.sessions.filter((s) => s.queue === queue && s.resolvedNote === null);
});

route('POST', '/api/v1/operator/sessions/:id/resolve', (p, _q, body) => {
  const id = idParam(p);
  const s = db.sessions.find((x) => x.id === id);
  if (!s) throw new HttpError(404, 'not_found', `Không có phiên id=${id}`);
  if (s.resolvedNote !== null) throw new HttpError(409, 'already_resolved', 'Phiên đã được xử lý');
  const note = text(body, 'note', 5);
  if (s.queue === 'review') s.status = 'reconciled'; // STM-1 #17 OPERATOR_RESOLVED
  s.resolvedNote = note;
  return s;
});

route('GET', '/api/v1/operator/charge-intents', () =>
  db.intents.filter((i) => i.state === 'stuck' || i.state === 'recovering'),
);

function intentOr404(p: Params) {
  const id = idParam(p);
  const it = db.intents.find((x) => x.id === id);
  if (!it) throw new HttpError(404, 'not_found', `Không có yêu cầu sạc id=${id}`);
  return it;
}

route('POST', '/api/v1/operator/charge-intents/:id/begin-recovery', (p, _q, body) => {
  const it = intentOr404(p);
  if (it.state !== 'stuck') throw new HttpError(409, 'invalid_state', 'Yêu cầu không còn bị kẹt');
  it.note = text(body, 'note', 5);
  it.state = 'recovering';
  return it;
});

route('POST', '/api/v1/operator/charge-intents/:id/approve-late-start', (p) => {
  const it = intentOr404(p);
  if (it.state !== 'recovering') {
    throw new HttpError(409, 'invalid_state', 'Phải bắt đầu khôi phục trước');
  }
  if (!it.lateStartSeen) {
    throw new HttpError(
      409,
      'no_late_start',
      'Trụ chưa gửi StartTransaction muộn — chỉ có thể trả súng về trạng thái sẵn sàng',
    );
  }
  it.state = 'late_start_approved';
  return it;
});

route('POST', '/api/v1/operator/charge-intents/:id/restore-connector', (p) => {
  const it = intentOr404(p);
  if (it.state !== 'recovering') {
    throw new HttpError(409, 'invalid_state', 'Phải bắt đầu khôi phục trước');
  }
  it.state = 'connector_restored';
  return it;
});

// ---------------------------------------------------------------------------------------------
// Operator — biểu giá, khuyến mãi, phiếu bảo trì, doanh thu
// ---------------------------------------------------------------------------------------------

route('GET', '/api/v1/operator/tariffs', () => db.tariff);

route('PUT', '/api/v1/operator/tariffs', (_p, _q, body) => {
  const periods = body['periods'] as TariffPeriod[] | undefined;
  if (!Array.isArray(periods)) throw new HttpError(422, 'validation', 'Thiếu danh sách khung giờ');
  const errors = validateBands(periods);
  if (errors.length) throw new HttpError(422, 'validation', errors.join(' · '));
  db.tariff = periods.map((x) => ({ ...x }));
  return db.tariff;
});

route('GET', '/api/v1/operator/promotions', () => db.promotions);
route('GET', '/api/v1/operator/tickets', () => db.tickets);
route('GET', '/api/v1/operator/analytics/revenue', () => db.revenue);

// ---------------------------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------------------------

route('GET', '/api/admin/summary', () => ({
  users: db.accounts.length,
  drivers: db.accounts.filter((a) => a.role === 'driver').length,
  pillars: db.devices.length,
  pillarsAwaitingOnboarding: db.devices.filter((d) => d.lifecycle === 'registered').length,
  rfidCards: db.cards.length,
  billingExceptions: {
    topUps: db.topUps.filter((t) => t.status === 'credited').length,
    latePayments: db.latePayments.filter((l) => !l.refunded).length,
    invoices: db.invoices.filter((i) => i.status === 'needs_review').length,
    closedAccounts: db.closedAccounts.filter((c) => !c.refunded).length,
  },
}));

route('GET', '/api/admin/users', () => db.accounts);

route('PATCH', '/api/admin/users/:id', (p, _q, body) => {
  const id = idParam(p);
  const u = db.accounts.find((a) => a.id === id);
  if (!u) throw new HttpError(404, 'not_found', `Không có người dùng id=${id}`);
  const role = body['role'];
  if (role !== 'driver' && role !== 'operator' && role !== 'admin') {
    throw new HttpError(422, 'validation', 'Vai trò không hợp lệ');
  }
  if (u.id === 1)
    throw new HttpError(409, 'self_role', 'Không đổi vai trò của chính tài khoản admin');
  u.role = role;
  return u;
});

route('GET', '/api/admin/devices', () => db.devices);

/** UC-ADM-03: Admin đăng ký serial trước, operator mới onboard được (WF-05). */
route('POST', '/api/admin/devices', (_p, _q, body) => {
  const serial = text(body, 'serial', 6).toUpperCase();
  if (!/^[A-Z0-9-]{6,32}$/.test(serial)) {
    throw new HttpError(422, 'validation', 'Serial chỉ gồm chữ in hoa, số và dấu gạch');
  }
  if (db.devices.some((d) => d.serial === serial)) {
    throw new HttpError(409, 'duplicate_serial', `Serial ${serial} đã có trong sổ thiết bị`);
  }
  const device = {
    id: db.seq.device++,
    serial,
    model: body['model'] === 'YJ-EU-60' ? ('YJ-EU-60' as const) : ('D1-120' as const),
    firmware: typeof body['firmware'] === 'string' && body['firmware'] ? body['firmware'] : '—',
    lifecycle: 'registered' as const,
    operatorName: null,
    registeredAt: nowIso(),
    warrantyUntil: new Date(Date.now() + 730 * 86_400_000).toISOString(),
  };
  db.devices.unshift(device);
  return device;
});

route('GET', '/api/admin/cards', () => db.cards);
route('GET', '/api/admin/free-vend-tags', () => db.freeVend);

route('GET', '/api/admin/policy-templates', () => [
  { id: 1, name: 'Biểu giá 4 khung giờ EVN 2026', kind: 'tariff', updatedAt: nowIso() },
  { id: 2, name: 'Tích điểm 1 điểm / 1.000 ₫', kind: 'loyalty', updatedAt: nowIso() },
]);

route('GET', '/api/admin/system-health', () => ({
  csms: 'ok',
  database: 'ok',
  ocppConnections: db.pillars.filter((p) => p.isOnline).length,
  messagesLastHour: 1_284,
  reconciliationConflicts: db.sessions.filter((s) => s.queue === 'review' && !s.resolvedNote)
    .length,
}));

// ---- UC-ADM-08 Billing Exceptions ------------------------------------------------------------

route('GET', '/api/admin/billing/top-ups', () => {
  const items = db.topUps
    .filter((t) => t.status === 'credited')
    .map(({ status: _s, ...t }) => ({
      ...t,
      refundable: canRefundTopUp(t.balanceVnd, t.amountVnd),
    }));
  return { items, total: items.length };
});

/** SD-2c pha E: STM-4 #7 credited → refunded; hoàn toàn bộ, chỉ khi số dư đủ. */
route('POST', '/api/admin/billing/top-ups/:id/refund', (p) => {
  const id = idParam(p);
  const t = db.topUps.find((x) => x.id === id);
  if (!t) throw new HttpError(404, 'not_found', `Không có top-up id=${id}`);
  if (t.status !== 'credited') {
    throw new HttpError(409, 'InvalidTransition', 'Top-up này đã được hoàn');
  }
  if (!canRefundTopUp(t.balanceVnd, t.amountVnd)) {
    throw new HttpError(
      422,
      'RefundNotAllowed',
      'Số dư hiện tại thấp hơn số tiền top-up — không hoàn một phần (BR-P21)',
    );
  }
  t.status = 'refunded';
  t.balanceVnd -= t.amountVnd;
  return {
    status: 'refunded',
    refundedVnd: t.amountPaidVnd,
    pointsRestored: t.pointsRedeemed,
  };
});

route('GET', '/api/admin/billing/top-ups/late-payments', () => {
  const items = db.latePayments
    .filter((l) => !l.refunded)
    .map(({ refunded: _r, gatewayFails: _g, ...l }) => l);
  return { items, total: items.length };
});

/** SD-2c pha D: thanh toán sau LATE_WINDOW không được credit — Admin hoàn về nguồn. */
route('POST', '/api/admin/billing/top-ups/:id/late-refund', (p) => {
  const id = idParam(p);
  const l = db.latePayments.find((x) => x.id === id);
  if (!l) throw new HttpError(404, 'not_found', `Không có thanh toán trễ id=${id}`);
  if (l.refunded) throw new HttpError(409, 'LateRefundNotAllowed', 'Khoản này đã được hoàn');
  if (l.gatewayFails) {
    l.gatewayFails = false; // lần sau cổng trả lời bình thường
    throw new HttpError(
      502,
      'GatewayError',
      'VNPay không xác nhận lệnh hoàn — chưa ghi gì, thử lại',
    );
  }
  l.refunded = true;
  return { lateRefundedAt: nowIso() };
});

route('GET', '/api/admin/billing/e-invoices', () => {
  const items = db.invoices
    .filter((i) => i.status === 'needs_review')
    .map(({ status: _s, invoiceNo: _n, nextRetrySucceeds: _x, ...i }) => i);
  return { items, total: items.length };
});

/** STM-7 #6 → #2 issued, hoặc lại needs_review; BR-P44: một lần, không reset bộ đếm. */
route('POST', '/api/admin/billing/e-invoices/:id/retry', (p) => {
  const id = idParam(p);
  const inv = db.invoices.find((x) => x.id === id);
  if (!inv) throw new HttpError(404, 'not_found', `Không có hoá đơn id=${id}`);
  if (inv.status !== 'needs_review') {
    throw new HttpError(409, 'InvalidTransition', 'Hoá đơn không còn chờ xử lý');
  }
  inv.attemptCount += 1;
  inv.updatedAt = nowIso();
  if (inv.nextRetrySucceeds) {
    inv.status = 'issued';
    inv.invoiceNo = `C26TPM${String(inv.id).padStart(8, '0')}`;
    return { status: 'issued', invoiceNo: inv.invoiceNo };
  }
  inv.lastErrorMessage = `${inv.lastErrorMessage.split(' (')[0]} (lần ${inv.attemptCount})`;
  return {
    status: 'needs_review',
    attemptCount: inv.attemptCount,
    lastErrorKind: inv.lastErrorKind,
    lastErrorMessage: inv.lastErrorMessage,
  };
});

route('GET', '/api/admin/billing/credit-accounts', () => {
  const items = db.closedAccounts.filter((c) => !c.refunded).map(({ refunded: _r, ...c }) => c);
  return { items, total: items.length };
});

/** BR-P21: hoàn số dư chưa dùng về nguồn các top-up mới nhất trước, mỗi khoản một hoá đơn điều chỉnh. */
route('POST', '/api/admin/billing/credit-accounts/:id/closure-refund', (p) => {
  const id = idParam(p);
  const c = db.closedAccounts.find((x) => x.id === id);
  if (!c) throw new HttpError(404, 'not_found', `Không có tài khoản id=${id}`);
  if (c.refunded) throw new HttpError(409, 'already_refunded', 'Tài khoản này đã được hoàn');
  const split = splitClosureRefund(
    c.unusedBalanceVnd,
    c.sources.map((s) => ({ topUpId: s.topUpId, amountPaidVnd: s.amountVnd })),
  );
  c.refunded = true;
  return { status: 'refunded', ...split };
});

// ---------------------------------------------------------------------------------------------

export async function mockRequest(req: MockRequest): Promise<MockResponse> {
  const method = (req.method ?? 'GET').toUpperCase();
  const url = new URL(req.url, 'http://mock.local');
  if (mockConfig.latencyMs > 0) {
    await new Promise((r) => setTimeout(r, mockConfig.latencyMs));
  }
  const r = routes.find((x) => x.method === method && x.pattern.test(url.pathname));
  if (!r) {
    return {
      status: 404,
      data: { error: 'not_found', detail: `Mock không có ${method} ${url.pathname}` },
    };
  }
  const m = r.pattern.exec(url.pathname);
  const params: Params = {};
  r.keys.forEach((k, i) => {
    params[k] = decodeURIComponent(m?.[i + 1] ?? '');
  });
  try {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
      string,
      unknown
    >;
    // structuredClone: UI không được giữ tham chiếu vào trạng thái của mock.
    return { status: 200, data: structuredClone(r.handler(params, url.searchParams, body)) };
  } catch (err) {
    if (err instanceof HttpError) {
      return { status: err.status, data: { error: err.code, detail: err.message } };
    }
    return { status: 500, data: { error: 'internal_error', detail: String(err) } };
  }
}
