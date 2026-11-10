/**
 * Spec bộ định tuyến thuần: đường dẫn → route, và các mã lỗi 404 / 400 / 405.
 */
import { matchRoute, parseOnboardBody, parseRegisterBody } from './console.router.js';

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

describe('matchRoute — WF-04 sự cố (FE-04)', () => {
  it('GET /api/admin/faults: mặc định open + 100; all và limit ghi đè được', () => {
    expect(matchRoute('GET', '/api/admin/faults')).toEqual({
      ok: true,
      route: { kind: 'faults', filter: 'open', limit: 100 },
    });
    expect(matchRoute('GET', '/api/admin/faults?status=all&limit=3')).toEqual({
      ok: true,
      route: { kind: 'faults', filter: 'all', limit: 3 },
    });
  });

  it('status lạ hoặc limit sai → 400; POST danh sách → 405', () => {
    expect(matchRoute('GET', '/api/admin/faults?status=closed')).toMatchObject({ status: 400 });
    expect(matchRoute('GET', '/api/admin/faults?limit=0')).toMatchObject({ status: 400 });
    expect(matchRoute('POST', '/api/admin/faults')).toMatchObject({ status: 405 });
  });

  it.each([
    ['acknowledge', { kind: 'faultAcknowledge', id: 7 }],
    ['close', { kind: 'faultClose', id: 7 }],
    ['reset', { kind: 'faultReset', id: 7, type: 'Soft', force: false }],
    ['reset?type=Hard', { kind: 'faultReset', id: 7, type: 'Hard', force: false }],
    ['reset?force=true', { kind: 'faultReset', id: 7, type: 'Soft', force: true }],
    ['reset?type=Hard&force=false', { kind: 'faultReset', id: 7, type: 'Hard', force: false }],
  ])('POST /api/admin/faults/7/%s', (suffix, route) => {
    expect(matchRoute('POST', `/api/admin/faults/7/${suffix}`)).toEqual({ ok: true, route });
  });

  it('hành động: GET → 405, id không phải số dương → 400, type / force lạ → 400, hành động lạ → 404', () => {
    expect(matchRoute('GET', '/api/admin/faults/7/acknowledge')).toMatchObject({
      status: 405,
      allow: ['POST'],
    });
    expect(matchRoute('POST', '/api/admin/faults/abc/close')).toMatchObject({ status: 400 });
    expect(matchRoute('POST', '/api/admin/faults/0/close')).toMatchObject({ status: 400 });
    expect(matchRoute('POST', '/api/admin/faults/7/reset?type=Medium')).toMatchObject({
      status: 400,
    });
    expect(matchRoute('POST', '/api/admin/faults/7/reset?force=yes')).toMatchObject({
      status: 400,
    });
    expect(matchRoute('POST', '/api/admin/faults/7/delete')).toMatchObject({ status: 404 });
  });
});

describe('matchRoute — BE-24 unattributed / review', () => {
  it('GET hai hàng đợi, limit mặc định 50; POST → 405; limit sai → 400', () => {
    expect(matchRoute('GET', '/api/admin/unattributed')).toEqual({
      ok: true,
      route: { kind: 'unattributedQueue', limit: 50 },
    });
    expect(matchRoute('GET', '/api/admin/review?limit=3')).toEqual({
      ok: true,
      route: { kind: 'reviewQueue', limit: 3 },
    });
    expect(matchRoute('POST', '/api/admin/unattributed')).toMatchObject({ status: 405 });
    expect(matchRoute('GET', '/api/admin/review?limit=0')).toMatchObject({ status: 400 });
  });

  it.each([
    ['assign-driver', 'assignUnattributed'],
    ['close-unattributed', 'closeUnattributed'],
    ['resolve-review', 'resolveReview'],
  ])('POST /api/admin/sessions/8/%s → %s; GET → 405; id sai → 400', (suffix, kind) => {
    expect(matchRoute('POST', `/api/admin/sessions/8/${suffix}`)).toEqual({
      ok: true,
      route: { kind, id: 8 },
    });
    expect(matchRoute('GET', `/api/admin/sessions/8/${suffix}`)).toMatchObject({
      status: 405,
      allow: ['POST'],
    });
    expect(matchRoute('POST', `/api/admin/sessions/0/${suffix}`)).toMatchObject({ status: 400 });
  });

  it('hành động phiên lạ → 404', () => {
    expect(matchRoute('POST', '/api/admin/sessions/8/delete')).toMatchObject({ status: 404 });
  });
});

describe('matchRoute — WF-05 onboarding (T119)', () => {
  it('POST the two paths; trailing slash allowed', () => {
    expect(matchRoute('POST', '/api/admin/charge-points')).toEqual({
      ok: true,
      route: { kind: 'registerChargePoint' },
    });
    expect(matchRoute('POST', '/api/operator/charge-points/onboard/')).toEqual({
      ok: true,
      route: { kind: 'onboardChargePoint' },
    });
  });

  it('GET → 405 Allow POST; unknown operator path → 404', () => {
    expect(matchRoute('GET', '/api/admin/charge-points')).toMatchObject({
      status: 405,
      allow: ['POST'],
    });
    expect(matchRoute('GET', '/api/operator/charge-points/onboard')).toMatchObject({
      status: 405,
      allow: ['POST'],
    });
    expect(matchRoute('POST', '/api/operator/charge-points')).toMatchObject({ status: 404 });
  });
});

describe('parseRegisterBody / parseOnboardBody — snake_case bodies of the T98 contract (T119)', () => {
  it('register: snake_case in, the service input out; wrong shapes → 400 invalid_input', () => {
    expect(parseRegisterBody({ serial_number: ' SIM-0005 ' })).toEqual({
      ok: true,
      value: { serialNumber: 'SIM-0005' },
    });
    expect(parseRegisterBody({ serial_number: 'SIM-1', model: null, rated_power_kw: 120 })).toEqual(
      { ok: true, value: { serialNumber: 'SIM-1', model: null, ratedPowerKw: 120 } },
    );
    for (const bad of [
      [],
      'SIM',
      {},
      { serial_number: 5 },
      { serial_number: 'ab' },
      { serial_number: 'a:b:c' },
      { serialNumber: 'SIM-1' },
      { serial_number: 'SIM-1', rated_power_kw: -1 },
      { serial_number: 'SIM-1', rated_power_kw: '120' },
      { serial_number: 'SIM-1', model: 'x'.repeat(21) },
      { serial_number: 'SIM-1', admin_user_id: 1 },
    ]) {
      expect(parseRegisterBody(bad)).toMatchObject({
        ok: false,
        status: 400,
        error: 'invalid_input',
      });
    }
  });

  it('onboard: a valid body becomes the service input; the connector count is left to the service', () => {
    expect(
      parseOnboardBody({
        serial_number: 'SIM-0005',
        site_id: 3,
        connectors: [
          { connector_no: 1, connector_type: 'gbt', max_power_kw: 60 },
          { connector_no: 2 },
        ],
      }),
    ).toEqual({
      ok: true,
      value: {
        serialNumber: 'SIM-0005',
        siteId: 3,
        connectors: [{ connectorNo: 1, connectorType: 'gbt', maxPowerKw: 60 }, { connectorNo: 2 }],
      },
    });
    expect(parseOnboardBody({ serial_number: 'SIM-0005', site_id: 3, connectors: [] })).toEqual({
      ok: true,
      value: { serialNumber: 'SIM-0005', siteId: 3, connectors: [] },
    });
  });

  it('onboard: wrong shapes → 400 invalid_input', () => {
    const ok = { serial_number: 'SIM-1', site_id: 1, connectors: [{ connector_no: 1 }] };
    for (const bad of [
      null,
      { ...ok, serial_number: 'no spaces allowed' },
      { ...ok, site_id: '1' },
      { ...ok, site_id: 0 },
      { ...ok, site_id: 1.5 },
      { ...ok, connectors: 'two' },
      { ...ok, connectors: [1] },
      { ...ok, connectors: [{ connector_no: '1' }] },
      { ...ok, connectors: [{ connector_no: 1, connector_type: 'tesla' }] },
      { ...ok, connectors: [{ connector_no: 1, max_power_kw: 0 }] },
      { ...ok, connectors: [{ connector_no: 1, status: 'Available' }] },
      { ...ok, staff_user_id: 9 },
    ]) {
      expect(parseOnboardBody(bad)).toMatchObject({
        ok: false,
        status: 400,
        error: 'invalid_input',
      });
    }
  });
});
