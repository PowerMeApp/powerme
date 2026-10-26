/**
 * Spec bộ định tuyến thuần: đường dẫn → route, và các mã lỗi 404 / 400 / 405.
 */
import { matchRoute } from './console.router.js';

describe('matchRoute — đường dẫn hợp lệ', () => {
  it('GET / → trang', () => {
    expect(matchRoute('GET', '/')).toEqual({ ok: true, route: { kind: 'page' } });
  });

  it('GET /health → health; POST → 405', () => {
    expect(matchRoute('GET', '/health')).toEqual({ ok: true, route: { kind: 'health' } });
    expect(matchRoute('POST', '/health')).toMatchObject({ ok: false, status: 405 });
  });

  it('các GET chỉ đọc', () => {
    expect(matchRoute('GET', '/api/admin/stations')).toEqual({
      ok: true,
      route: { kind: 'stations' },
    });
    expect(matchRoute('GET', '/api/admin/summary')).toEqual({
      ok: true,
      route: { kind: 'summary' },
    });
    expect(matchRoute('GET', '/api/admin/sessions/12')).toEqual({
      ok: true,
      route: { kind: 'session', id: 12 },
    });
  });

  it('limit mặc định: sessions 50, reconciliation 50, messages 100; có thể ghi đè', () => {
    expect(matchRoute('GET', '/api/admin/sessions')).toEqual({
      ok: true,
      route: { kind: 'sessions', limit: 50 },
    });
    expect(matchRoute('GET', '/api/admin/reconciliation?limit=7')).toEqual({
      ok: true,
      route: { kind: 'reconciliation', limit: 7 },
    });
    expect(matchRoute('GET', '/api/admin/messages')).toEqual({
      ok: true,
      route: { kind: 'messages', limit: 100, after: null },
    });
    expect(matchRoute('GET', '/api/admin/messages?limit=20&after=345')).toEqual({
      ok: true,
      route: { kind: 'messages', limit: 20, after: 345 },
    });
  });

  it('dấu / ở cuối được bỏ; POST disconnect giải mã serial', () => {
    expect(matchRoute('GET', '/api/admin/summary/')).toEqual({
      ok: true,
      route: { kind: 'summary' },
    });
    expect(matchRoute('POST', '/api/admin/stations/RH24D1-00001/disconnect')).toEqual({
      ok: true,
      route: { kind: 'disconnect', serial: 'RH24D1-00001' },
    });
    expect(matchRoute('POST', '/api/admin/stations/a%20b/disconnect')).toEqual({
      ok: true,
      route: { kind: 'disconnect', serial: 'a b' },
    });
    expect(matchRoute('POST', '/api/admin/sessions/5/remote-stop')).toEqual({
      ok: true,
      route: { kind: 'remoteStop', id: 5 },
    });
  });
});

describe('matchRoute — lỗi', () => {
  it('404 cho đường dẫn lạ', () => {
    const r = matchRoute('GET', '/api/admin/nope');
    expect(r).toMatchObject({ ok: false, status: 404, error: 'not_found' });
    expect(matchRoute('GET', '/favicon.ico')).toMatchObject({ ok: false, status: 404 });
    expect(matchRoute('POST', '/api/admin/stations/x/connect')).toMatchObject({ status: 404 });
  });

  it('405 kèm Allow khi sai method', () => {
    expect(matchRoute('POST', '/api/admin/summary')).toMatchObject({
      ok: false,
      status: 405,
      allow: ['GET'],
    });
    expect(matchRoute('GET', '/api/admin/stations/x/disconnect')).toMatchObject({
      status: 405,
      allow: ['POST'],
    });
    expect(matchRoute('GET', '/api/admin/sessions/5/remote-stop')).toMatchObject({
      status: 405,
      allow: ['POST'],
    });
    expect(matchRoute('DELETE', '/')).toMatchObject({ status: 405 });
  });

  it('400 khi limit / after / id sai', () => {
    expect(matchRoute('GET', '/api/admin/sessions?limit=abc')).toMatchObject({ status: 400 });
    expect(matchRoute('GET', '/api/admin/sessions?limit=0')).toMatchObject({ status: 400 });
    expect(matchRoute('GET', '/api/admin/sessions?limit=501')).toMatchObject({ status: 400 });
    expect(matchRoute('GET', '/api/admin/sessions?limit=-1')).toMatchObject({ status: 400 });
    expect(matchRoute('GET', '/api/admin/messages?after=x')).toMatchObject({ status: 400 });
    expect(matchRoute('GET', '/api/admin/sessions/abc')).toMatchObject({ status: 400 });
    expect(matchRoute('GET', '/api/admin/sessions/0')).toMatchObject({ status: 400 });
    expect(matchRoute('POST', '/api/admin/sessions/1.5/remote-stop')).toMatchObject({
      status: 400,
    });
    expect(matchRoute('POST', '/api/admin/stations/%E0%A4%A/disconnect')).toMatchObject({
      status: 400,
    });
  });

  it('mọi lỗi đều có error và detail không rỗng', () => {
    for (const [m, u] of [
      ['GET', '/x'],
      ['PUT', '/'],
      ['GET', '/api/admin/sessions?limit=z'],
    ] as const) {
      const r = matchRoute(m, u);
      if (r.ok) throw new Error('lẽ ra phải lỗi');
      expect(r.error).not.toBe('');
      expect(r.detail).not.toBe('');
    }
  });
});
