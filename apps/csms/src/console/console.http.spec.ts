/**
 * Spec bộ xử lý HTTP với backend giả, trên server `node:http` thật ở cổng ngẫu nhiên (không DB):
 * Content-Type, `/` trả HTML có tiêu đề, mã lỗi 404/400/405/403/500 và dạng `{error, detail}`,
 * CORS chỉ cho localhost, POST từ Origin lạ bị chặn, lỗi lạ không rò stack trace.
 */
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import {
  ONBOARDING_ERROR_STATUS,
  OnboardingError,
  OnboardingErrorCode,
} from '../stations/charge-point-onboarding.service.js';
import { ConsoleBackend, ConsoleError, createConsoleListener } from './console.http.js';

const calls: string[] = [];
let dbDown = false;
const backend: ConsoleBackend = {
  health: async () => {
    if (dbDown) throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2');
  },
  stations: async () => (calls.push('stations'), [{ serial: 'S1' }]),
  sessions: async (limit) => (calls.push(`sessions:${limit}`), []),
  session: async (id) => {
    if (id === 404) throw new ConsoleError(404, 'not_found', 'Không có phiên');
    return { id };
  },
  reconciliation: async (limit) => (calls.push(`recon:${limit}`), []),
  messages: async (limit, after) => (calls.push(`messages:${limit}:${String(after)}`), []),
  summary: async () => {
    throw new Error('boom: mat khau=hunter2 at /srv/secret.ts:1');
  },
  disconnect: async (serial) => {
    throw new ConsoleError(404, 'not_connected', `Trụ ${serial} không đang nối`);
  },
  remoteStop: async (id) => ({ session_id: id, status: 'Accepted' }),
  faults: async (filter, limit) => (calls.push(`faults:${filter}:${limit}`), []),
  acknowledgeFault: async (id) => {
    if (id === 9) throw new ConsoleError(409, 'invalid_transition', 'đã acknowledged');
    return { id, status: 'acknowledged' };
  },
  resetFault: async (id, type, force) => (
    calls.push(`reset:${id}:${type}${force ? ':force' : ''}`),
    { fault_id: id }
  ),
  closeFault: async (id) => ({ id, status: 'resolved' }),
  unattributedQueue: async (limit) => (calls.push(`unattributed:${limit}`), []),
  reviewQueue: async (limit) => (calls.push(`review:${limit}`), []),
  assignUnattributed: async (id, input) => (
    calls.push(`assign:${id}:${JSON.stringify(input)}`),
    { session_id: id, decision: 'assigned' }
  ),
  closeUnattributed: async (id, input) => (
    calls.push(`close:${id}:${JSON.stringify(input)}`),
    { session_id: id, decision: 'closed' }
  ),
  resolveReview: async (id, input) => {
    if (id === 404) throw new ConsoleError(404, 'not_found', 'Không có phiên này');
    calls.push(`resolve:${id}:${JSON.stringify(input)}`);
    return { session_id: id, status: 'reconciled' };
  },
  // WF-05 (T119): a serial named after an OnboardingErrorCode makes the fake throw that error.
  // The fake returns what ConsoleServer returns: snake_case, like the T98 contract.
  registerChargePoint: async (adminId, input) => {
    calls.push(`register:${adminId}:${JSON.stringify(input)}`);
    throwIfCode(input.serialNumber);
    return { charge_point_id: 5, serial_number: input.serialNumber, lifecycle: 'registered' };
  },
  onboardChargePoint: async (staffId, input) => {
    calls.push(`onboard:${staffId}:${JSON.stringify(input)}`);
    throwIfCode(input.serialNumber);
    if (input.serialNumber === 'DB-ERROR') {
      throw new Error('Failed query: update charge_points params: $scrypt$hash-secret');
    }
    return {
      charge_point_id: 5,
      display_code: 'PM-D1-HCM-0002',
      lifecycle: 'awaiting_connection',
      ocpp_url: 'ws://localhost:9000/ocpp/SIM-0005',
      identity: 'SIM-0005',
      password: 'pw-shown-once',
    };
  },
};

function throwIfCode(serial: string): void {
  if (serial in ONBOARDING_ERROR_STATUS) {
    throw new OnboardingError(serial as OnboardingErrorCode, `fake ${serial}`);
  }
}

let server: Server;
let base: string;
/** Same backend, with CONSOLE_ACTOR_* configured (admin 11, staff 22). */
let actorServer: Server;
let actorBase: string;

async function listen(s: Server): Promise<string> {
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  Logger.overrideLogger(false);
  server = createServer(createConsoleListener(backend));
  base = await listen(server);
  actorServer = createServer(createConsoleListener(backend, { adminUserId: 11, staffUserId: 22 }));
  actorBase = await listen(actorServer);
});
afterAll(async () => {
  for (const s of [server, actorServer]) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});
beforeEach(() => {
  calls.length = 0;
});

describe('GET /', () => {
  it('trả HTML UTF-8 có tiêu đề, footer cảnh báo chưa xác thực và không CDN', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await res.text();
    expect(html).toContain('<title>PowerMe CSMS — Bảng điều khiển vận hành</title>');
    expect(html).toContain('chưa có xác thực');
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/https?:\/\/(?!console\.local)[a-z]/i);
  });
});

describe('GET /health', () => {
  afterEach(() => {
    dbDown = false;
  });

  it('DB trả lời → 200 {ok:true, db:true}, không thêm trường nào', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await res.json()).toEqual({ ok: true, db: true });
  });

  it('DB lỗi → 503 {ok:false, db:false}, không rò chi tiết lỗi', async () => {
    dbDown = true;
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: false, db: false });
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('ECONNREFUSED');
  });

  it('POST /health → 405', async () => {
    const res = await fetch(`${base}/health`, { method: 'POST' });
    expect(res.status).toBe(405);
  });
});

describe('API JSON', () => {
  it('Content-Type JSON UTF-8 và gọi backend với tham số đã parse', async () => {
    const res = await fetch(`${base}/api/admin/stations`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await res.json()).toEqual([{ serial: 'S1' }]);
    await fetch(`${base}/api/admin/sessions?limit=5`);
    await fetch(`${base}/api/admin/messages?limit=3&after=9`);
    await fetch(`${base}/api/admin/reconciliation`);
    expect(calls).toEqual(['stations', 'sessions:5', 'messages:3:9', 'recon:50']);
  });

  it('404 đường dẫn lạ, 400 tham số sai, 405 sai method (có Allow) — đều {error, detail}', async () => {
    const nf = await fetch(`${base}/api/admin/khong-co`);
    expect(nf.status).toBe(404);
    expect(Object.keys((await nf.json()) as object).sort()).toEqual(['detail', 'error']);

    const bad = await fetch(`${base}/api/admin/sessions?limit=abc`);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('bad_request');

    const ma = await fetch(`${base}/api/admin/stations`, { method: 'POST' });
    expect(ma.status).toBe(405);
    expect(ma.headers.get('allow')).toBe('GET');
  });

  it('ConsoleError của backend giữ nguyên mã HTTP; POST disconnect trụ không nối → 404', async () => {
    const r1 = await fetch(`${base}/api/admin/sessions/404`);
    expect(r1.status).toBe(404);
    const r2 = await fetch(`${base}/api/admin/stations/NOPE/disconnect`, { method: 'POST' });
    expect(r2.status).toBe(404);
    expect(await r2.json()).toEqual({ error: 'not_connected', detail: 'Trụ NOPE không đang nối' });
  });

  it('lỗi lạ → 500 với detail chung, không rò message/stack', async () => {
    const res = await fetch(`${base}/api/admin/summary`);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: 'internal_error',
      detail: 'Lỗi nội bộ của CSMS',
    });
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('secret.ts');
  });

  it('remote-stop trả kết quả backend', async () => {
    const res = await fetch(`${base}/api/admin/sessions/7/remote-stop`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ session_id: 7, status: 'Accepted' });
  });
});

describe('CORS và chống POST chéo trang', () => {
  it('Origin localhost được phản chiếu; Origin lạ không có header CORS', async () => {
    const ok = await fetch(`${base}/api/admin/stations`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    const other = await fetch(`${base}/api/admin/stations`, {
      headers: { Origin: 'https://evil.example' },
    });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('OPTIONS → 204 kèm Allow-Methods', async () => {
    const res = await fetch(`${base}/api/admin/stations/S1/disconnect`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://127.0.0.1:5173' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('POST từ Origin lạ bị 403 và backend không được gọi', async () => {
    const res = await fetch(`${base}/api/admin/sessions/7/remote-stop`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('forbidden_origin');
  });
});

describe('WF-04 — API sự cố (FE-04)', () => {
  it('GET /api/admin/faults chuyển filter và limit cho backend', async () => {
    const res = await fetch(`${base}/api/admin/faults?status=all&limit=5`);
    expect(res.status).toBe(200);
    expect(calls).toEqual(['faults:all:5']);
  });

  it('POST reset mang type và force xuống backend; mặc định Soft, không force', async () => {
    expect(
      (await fetch(`${base}/api/admin/faults/3/reset?type=Hard`, { method: 'POST' })).status,
    ).toBe(200);
    expect((await fetch(`${base}/api/admin/faults/4/reset`, { method: 'POST' })).status).toBe(200);
    expect(
      (await fetch(`${base}/api/admin/faults/5/reset?force=true`, { method: 'POST' })).status,
    ).toBe(200);
    expect(calls).toEqual(['reset:3:Hard', 'reset:4:Soft', 'reset:5:Soft:force']);
  });

  it('ConsoleError 409 của backend → {error, detail}', async () => {
    const res = await fetch(`${base}/api/admin/faults/9/acknowledge`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'invalid_transition', detail: 'đã acknowledged' });
  });
});

describe('BE-24 — hàng đợi và quyết định unattributed / review (F-12, FR-13)', () => {
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('GET hai hàng đợi chuyển limit cho backend (mặc định 50)', async () => {
    expect((await fetch(`${base}/api/admin/unattributed`)).status).toBe(200);
    expect((await fetch(`${base}/api/admin/review?limit=7`)).status).toBe(200);
    expect(calls).toEqual(['unattributed:50', 'review:7']);
  });

  it('POST assign / close / resolve-review đọc thân JSON và gọi đúng backend', async () => {
    const a = await post('/api/admin/sessions/11/assign-driver', {
      operator_user_id: 3,
      driver_id: 9,
      note: 'Tài xế gọi tổng đài',
    });
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ session_id: 11, decision: 'assigned' });
    expect(
      (
        await post('/api/admin/sessions/12/close-unattributed', {
          operator_user_id: 3,
          reason: 'test_session',
          note: 'Phiên thử của kỹ thuật',
        })
      ).status,
    ).toBe(200);
    const r = await post('/api/admin/sessions/13/resolve-review', {
      operator_user_id: 3,
      resolution: 'meter_confirmed',
      note: 'Đã xem ảnh công tơ',
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ session_id: 13, status: 'reconciled' });
    expect(calls).toEqual([
      'assign:11:{"operatorUserId":3,"driverId":9,"note":"Tài xế gọi tổng đài"}',
      'close:12:{"operatorUserId":3,"reason":"test_session","note":"Phiên thử của kỹ thuật"}',
      'resolve:13:{"operatorUserId":3,"resolution":"meter_confirmed","note":"Đã xem ảnh công tơ"}',
    ]);
  });

  it('ConsoleError của service giữ mã HTTP (resolve-review phiên không có → 404)', async () => {
    const res = await post('/api/admin/sessions/404/resolve-review', {
      operator_user_id: 3,
      resolution: 'x',
      note: 'n',
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found', detail: 'Không có phiên này' });
  });

  it.each([
    ['thiếu Content-Type JSON', { 'Content-Type': 'text/plain' }, '{}', 415],
    ['JSON hỏng', {}, '{oops', 400],
    ['thân là mảng', {}, '[1]', 400],
    ['operator_user_id dạng chuỗi', {}, { operator_user_id: '3', driver_id: 9, note: 'n' }, 400],
    ['driver_id = 0', {}, { operator_user_id: 3, driver_id: 0, note: 'n' }, 400],
    ['thiếu note', {}, { operator_user_id: 3, driver_id: 9 }, 400],
    ['thân quá 8 KB', {}, { operator_user_id: 3, driver_id: 9, note: 'x'.repeat(9000) }, 413],
  ])('assign: %s → %i, backend không được gọi', async (_n, headers, body, status) => {
    const res = await post('/api/admin/sessions/11/assign-driver', body, headers);
    expect(res.status).toBe(status);
    expect(Object.keys((await res.json()) as object).sort()).toEqual(['detail', 'error']);
    expect(calls).toEqual([]);
  });

  it('POST quyết định từ Origin lạ → 403, backend không được gọi', async () => {
    const res = await post(
      '/api/admin/sessions/11/close-unattributed',
      { operator_user_id: 3, reason: 'x', note: 'n' },
      { Origin: 'https://evil.example' },
    );
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe('WF-05 — onboarding routes (T119)', () => {
  const onboardBody = {
    serial_number: 'SIM-0005',
    site_id: 1,
    connectors: [
      { connector_no: 1 },
      { connector_no: 2, connector_type: 'ccs2', max_power_kw: 60 },
    ],
  };
  const postJson = (b: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${b}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const ONBOARD = '/api/operator/charge-points/onboard';

  it('TC-F14-04 POST /api/admin/charge-points → 201 snake_case registry row, acting as the configured Admin', async () => {
    const res = await postJson(actorBase, '/api/admin/charge-points', {
      serial_number: 'SIM-0005',
      model: 'D1-120',
      rated_power_kw: 120,
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      charge_point_id: 5,
      serial_number: 'SIM-0005',
      lifecycle: 'registered',
    });
    expect(calls).toEqual([
      'register:11:{"serialNumber":"SIM-0005","model":"D1-120","ratedPowerKw":120}',
    ]);
  });

  it('TC-F09-04 POST onboard → 201 with the whole result and Cache-Control: no-store', async () => {
    const res = await postJson(actorBase, ONBOARD, onboardBody, {
      Origin: 'http://localhost:3000',
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      charge_point_id: 5,
      display_code: 'PM-D1-HCM-0002',
      lifecycle: 'awaiting_connection',
      ocpp_url: 'ws://localhost:9000/ocpp/SIM-0005',
      identity: 'SIM-0005',
      password: 'pw-shown-once',
    });
    expect(calls).toEqual([
      'onboard:22:{"serialNumber":"SIM-0005","siteId":1,"connectors":[{"connectorNo":1},{"connectorNo":2,"connectorType":"ccs2","maxPowerKw":60}]}',
    ]);
  });

  it('TC-F09-05 the acting user id never comes from the request: an extra field is rejected (400)', async () => {
    const res = await postJson(actorBase, ONBOARD, { ...onboardBody, staff_user_id: 1 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_input');
    expect(calls).toEqual([]);
  });

  it('TC-F09-06 actor not configured → 503 actor_not_configured, backend not called', async () => {
    for (const path of ['/api/admin/charge-points', ONBOARD]) {
      const res = await postJson(base, path, onboardBody);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe('actor_not_configured');
    }
    expect(calls).toEqual([]);
  });

  it.each([
    ['not application/json', { 'Content-Type': 'text/plain' }, '{}', 415],
    ['bad JSON', {}, '{not json', 400],
    ['an array', {}, '[1]', 400],
    ['malformed serial', {}, { ...onboardBody, serial_number: 'a:b' }, 400],
    ['body > 8 KB', {}, { ...onboardBody, pad: 'x'.repeat(9000) }, 413],
  ])('TC-F09-05 onboard: %s → %i, backend not called', async (_n, headers, body, status) => {
    const res = await postJson(actorBase, ONBOARD, body, headers);
    expect(res.status).toBe(status);
    expect(Object.keys((await res.json()) as object).sort()).toEqual(['detail', 'error']);
    expect(calls).toEqual([]);
  });

  it('GET → 405 Allow: POST', async () => {
    const get = await fetch(`${actorBase}${ONBOARD}`);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
  });

  it('POST from a foreign Origin → 403, backend not called', async () => {
    const res = await postJson(actorBase, ONBOARD, onboardBody, {
      Origin: 'https://evil.example',
    });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it.each(Object.entries(ONBOARDING_ERROR_STATUS))(
    'OnboardingError %s → HTTP %i {error, detail}',
    async (code, status) => {
      const res = await postJson(actorBase, ONBOARD, { ...onboardBody, serial_number: code });
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: code, detail: `fake ${code}` });
    },
  );

  it('TC-F09-07 an unexpected error → 500 and the log line carries no message (no hash, no body)', async () => {
    const lines: string[] = [];
    Logger.overrideLogger({
      log: () => undefined,
      warn: () => undefined,
      error: (m: unknown) => void lines.push(String(m)),
    });
    try {
      const res = await postJson(actorBase, ONBOARD, { ...onboardBody, serial_number: 'DB-ERROR' });
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain('hash-secret');
    } finally {
      Logger.overrideLogger(false);
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('hash-secret');
    expect(lines[0]).not.toContain('DB-ERROR');
  });
});
