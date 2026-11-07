/**
 * Spec bộ xử lý HTTP với backend giả, trên server `node:http` thật ở cổng ngẫu nhiên (không DB):
 * Content-Type, `/` trả HTML có tiêu đề, mã lỗi 404/400/405/403/500 và dạng `{error, detail}`,
 * CORS chỉ cho localhost, POST từ Origin lạ bị chặn, lỗi lạ không rò stack trace.
 */
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
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
};

let server: Server;
let base: string;

beforeAll(async () => {
  Logger.overrideLogger(false);
  server = createServer(createConsoleListener(backend));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
