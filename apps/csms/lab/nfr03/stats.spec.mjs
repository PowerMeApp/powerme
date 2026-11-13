/**
 * Unit test cho phân vị, tổng hợp, ghép cặp CALL–CALLRESULT và kết luận của phép đo NFR-03.
 * Chạy cùng `npm test -w @powerme/csms` (jest.config.js: roots có `lab/nfr03`).
 */
import { createStationProfile, loadIdentity } from './profile.mjs';
import { analyze, renderCsv, renderMarkdown } from './report.mjs';
import {
  aggregateStations,
  ALL,
  describe as describeSamples,
  joinClientServer,
  pairFrames,
  percentile,
  summarize,
  verdict,
} from './stats.mjs';
import { checkLoadPassword } from './load-data.mjs';

const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

describe('percentile (nearest-rank)', () => {
  it('trả giá trị đã đo, không nội suy', () => {
    expect(percentile(range(100), 95)).toBe(95);
    expect(percentile(range(100), 50)).toBe(50);
    expect(percentile(range(100), 99)).toBe(99);
    expect(percentile(range(100), 100)).toBe(100);
    // 20 mẫu: hạng ceil(0,95 × 20) = 19
    expect(percentile(range(20), 95)).toBe(19);
    // 10 mẫu: hạng ceil(9,5) = 10 → giá trị lớn nhất
    expect(percentile(range(10), 95)).toBe(10);
  });
  it('không phụ thuộc thứ tự đầu vào và không sửa mảng gốc', () => {
    const values = [30, 10, 20];
    expect(percentile(values, 50)).toBe(20);
    expect(values).toEqual([30, 10, 20]);
  });
  it('một mẫu: mọi phân vị là mẫu đó; không mẫu: null', () => {
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBeNull();
  });
  it('sắp xếp theo số, không theo chuỗi', () => {
    expect(percentile([9, 10, 100, 1000], 50)).toBe(10);
  });
  it('mẫu thiếu được tính là +∞ ở cuối', () => {
    // 95 mẫu có số + 5 không trả lời: hạng 95 vẫn là mẫu có số
    expect(percentile(range(95), 95, 5)).toBe(95);
    // 94 + 6: hạng 95 rơi vào mẫu không trả lời
    expect(percentile(range(94), 95, 6)).toBe(Infinity);
    expect(percentile([], 95, 3)).toBe(Infinity);
  });
  it('từ chối phân vị ngoài (0, 100]', () => {
    expect(() => percentile([1], 0)).toThrow();
    expect(() => percentile([1], 101)).toThrow();
  });
});

describe('describe / summarize', () => {
  it('đếm riêng bản tin có và không có trả lời', () => {
    const d = describeSamples([10, 20, 30], 1);
    expect(d).toMatchObject({ n: 4, answered: 3, unanswered: 1, p50Ms: 20, maxMs: 30 });
    expect(d.meanMs).toBe(20);
    // p95 trên mẫu có trả lời = 30; tính cả bản tin không trả lời thì hạng 4/4 là +∞
    expect(d.p95Ms).toBe(30);
    expect(d.penalizedP95Ms).toBe(Infinity);
  });
  it('nhóm theo loại bản tin, dòng gộp đứng đầu', () => {
    const s = summarize([
      { action: 'MeterValues', ms: 5 },
      { action: 'MeterValues', ms: 15 },
      { action: 'Heartbeat', ms: 2 },
      { action: 'Heartbeat', ms: null },
      { action: 'Authorize', ms: 9, error: true },
    ]);
    expect(s.map((x) => x.action)).toEqual([ALL, 'Authorize', 'Heartbeat', 'MeterValues']);
    expect(s[0]).toMatchObject({ n: 5, answered: 4, unanswered: 1, callErrors: 1, maxMs: 15 });
    expect(s[2]).toMatchObject({ n: 2, answered: 1, unanswered: 1, p95Ms: 2 });
    expect(s[3]).toMatchObject({ n: 2, p50Ms: 5, p95Ms: 15 });
  });
  it('không có dòng nào → không có nhóm nào', () => {
    expect(summarize([])).toEqual([]);
  });
});

/** Tạo frame log gọn cho test: id tăng dần theo thứ tự khai báo. */
function frames(list) {
  return list.map(
    ([station, epoch, direction, messageType, uniqueId, action, receivedAtMs], i) => ({
      id: String(i + 1),
      station,
      epoch,
      direction,
      messageType,
      uniqueId,
      action,
      receivedAtMs,
    }),
  );
}

describe('pairFrames (ocpp_message_log → thời gian xử lý của CSMS)', () => {
  it('ghép CALL chiều vào với CALLRESULT chiều ra cùng unique_id', () => {
    const rows = pairFrames(
      frames([
        ['LOAD-0001', 1, 'in', 2, 'a', 'Heartbeat', 1000],
        ['LOAD-0001', 1, 'out', 3, 'a', null, 1004],
      ]),
    );
    expect(rows).toEqual([
      {
        station: 'LOAD-0001',
        epoch: 1,
        id: 'a',
        action: 'Heartbeat',
        receivedAtMs: 1000,
        ms: 4,
        result: 'callresult',
      },
    ]);
  });
  it('CALLERROR chiều ra vẫn là một trả lời có thời gian', () => {
    const [row] = pairFrames(
      frames([
        ['LOAD-0001', 1, 'in', 2, 'a', 'DataTransfer', 1000],
        ['LOAD-0001', 1, 'out', 4, 'a', null, 1030],
      ]),
    );
    expect(row).toMatchObject({ ms: 30, result: 'callerror' });
  });
  it('CALL không có trả lời trong log → ms null, result none', () => {
    const [row] = pairFrames(frames([['LOAD-0001', 1, 'in', 2, 'a', 'MeterValues', 1000]]));
    expect(row).toMatchObject({ ms: null, result: 'none' });
  });
  it('bỏ qua CALL do CSMS gửi và trả lời của trụ (TriggerMessage)', () => {
    const rows = pairFrames(
      frames([
        ['LOAD-0001', 1, 'out', 2, 't1', 'TriggerMessage', 1000],
        ['LOAD-0001', 1, 'in', 3, 't1', null, 1010],
        ['LOAD-0001', 1, 'in', 2, 's1', 'StatusNotification', 1011],
        ['LOAD-0001', 1, 'out', 3, 's1', null, 1017],
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'StatusNotification', ms: 6 });
  });
  it('các bản tin đan xen của nhiều trụ không ghép nhầm, kể cả khi trùng unique_id', () => {
    const rows = pairFrames(
      frames([
        ['LOAD-0001', 1, 'in', 2, 'x', 'MeterValues', 1000],
        ['LOAD-0002', 1, 'in', 2, 'x', 'MeterValues', 1001],
        ['LOAD-0002', 1, 'out', 3, 'x', null, 1003],
        ['LOAD-0001', 1, 'out', 3, 'x', null, 1020],
      ]),
    );
    expect(rows.map((r) => [r.station, r.ms])).toEqual([
      ['LOAD-0001', 20],
      ['LOAD-0002', 2],
    ]);
  });
  it('trả lời không ghép sang epoch khác của cùng trụ', () => {
    const rows = pairFrames(
      frames([
        ['LOAD-0001', 1, 'in', 2, 'a', 'StopTransaction', 1000],
        ['LOAD-0001', 2, 'in', 2, 'a', 'StopTransaction', 5000],
        ['LOAD-0001', 2, 'out', 3, 'a', null, 5009],
      ]),
    );
    expect(rows.map((r) => [r.epoch, r.ms, r.result])).toEqual([
      [1, null, 'none'],
      [2, 9, 'callresult'],
    ]);
  });
  it('gửi lại y nguyên trên cùng socket: mỗi CALL ghép với trả lời sớm nhất sau nó', () => {
    const rows = pairFrames(
      frames([
        ['LOAD-0001', 1, 'in', 2, 'a', 'StartTransaction', 1000],
        ['LOAD-0001', 1, 'in', 2, 'a', 'StartTransaction', 1100],
        ['LOAD-0001', 1, 'out', 3, 'a', null, 1150],
        ['LOAD-0001', 1, 'out', 3, 'a', null, 1160],
      ]),
    );
    expect(rows.map((r) => r.ms)).toEqual([150, 60]);
  });
  it('xếp theo id của bảng (số lớn, dạng chuỗi), không theo thứ tự mảng', () => {
    const rows = pairFrames([
      {
        id: '10000000000000000002',
        station: 'LOAD-0001',
        epoch: 1,
        direction: 'out',
        messageType: 3,
        uniqueId: 'a',
        action: null,
        receivedAtMs: 1007,
      },
      {
        id: '10000000000000000001',
        station: 'LOAD-0001',
        epoch: 1,
        direction: 'in',
        messageType: 2,
        uniqueId: 'a',
        action: 'Authorize',
        receivedAtMs: 1000,
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].ms).toBe(7);
  });
  it('trả lời mồ côi (CALL nằm ngoài cửa sổ đọc) bị bỏ', () => {
    expect(pairFrames(frames([['LOAD-0001', 1, 'out', 3, 'a', null, 1000]]))).toEqual([]);
  });
});

describe('joinClientServer', () => {
  it('chênh lệch = client − server của cùng (trụ, id); đếm bản tin log không có', () => {
    const client = [
      { station: 'LOAD-0001', id: 'a', action: 'Heartbeat', ms: 12.5 },
      { station: 'LOAD-0001', id: 'b', action: 'Heartbeat', ms: null },
      { station: 'LOAD-0002', id: 'a', action: 'MeterValues', ms: 40 },
      { station: 'LOAD-0003', id: 'z', action: 'MeterValues', ms: 40 },
    ];
    const server = [
      { station: 'LOAD-0001', id: 'a', action: 'Heartbeat', ms: 2 },
      { station: 'LOAD-0001', id: 'b', action: 'Heartbeat', ms: 3 },
      { station: 'LOAD-0002', id: 'a', action: 'MeterValues', ms: 31 },
    ];
    const { joined, clientOnly } = joinClientServer(client, server);
    expect(joined).toEqual([
      { action: 'Heartbeat', ms: 10.5 },
      { action: 'MeterValues', ms: 9 },
    ]);
    expect(clientOnly).toBe(1);
  });
});

const fast = (n, ms = 10) => summarize(range(n).map(() => ({ action: 'MeterValues', ms })));

describe('verdict (ngưỡng p95 ≤ 1 s)', () => {
  const full = { stationsRequested: 50, stationsConnected: 50, durationS: 600 };
  it('ĐẠT khi cả hai phía dưới ngưỡng; đủ điều kiện cam kết → official', () => {
    const v = verdict({ client: fast(100, 40), server: fast(100, 8), ...full });
    expect(v.overall).toBe('ĐẠT');
    expect(v.official).toBe(true);
    expect(v.caveats).toEqual([]);
    expect(v.server).toMatchObject({ p95Ms: 8, pass: true, failingActions: [] });
  });
  it('đúng 1000 ms vẫn đạt, 1001 ms thì không', () => {
    expect(verdict({ client: fast(10), server: fast(10, 1000), ...full }).overall).toBe('ĐẠT');
    expect(verdict({ client: fast(10), server: fast(10, 1001), ...full }).overall).toBe(
      'KHÔNG ĐẠT',
    );
  });
  it('KHÔNG ĐẠT khi client vượt ngưỡng dù server đạt', () => {
    const v = verdict({ client: fast(100, 1500), server: fast(100, 8), ...full });
    expect(v.overall).toBe('KHÔNG ĐẠT');
    expect(v.client.pass).toBe(false);
  });
  it('quá 5% bản tin không được trả lời → p95 = ∞ → KHÔNG ĐẠT', () => {
    const rows = [
      ...range(94).map(() => ({ action: 'MeterValues', ms: 5 })),
      ...range(6).map(() => ({ action: 'MeterValues', ms: null })),
    ];
    const v = verdict({ client: summarize(rows), server: fast(94, 5), ...full });
    expect(v.client.p95Ms).toBe(Infinity);
    expect(v.overall).toBe('KHÔNG ĐẠT');
  });
  it('chưa có số server → CHƯA ĐỦ SỐ, không official', () => {
    const v = verdict({ client: fast(100), server: null, ...full });
    expect(v.overall).toBe('CHƯA ĐỦ SỐ');
    expect(v.official).toBe(false);
    expect(v.caveats.join(' ')).toMatch(/server/);
  });
  it('trụ không nối đủ → KHÔNG ĐẠT; ít trụ / chạy ngắn → không official', () => {
    const missing = verdict({
      client: fast(100),
      server: fast(100),
      stationsRequested: 50,
      stationsConnected: 48,
      durationS: 600,
    });
    expect(missing.overall).toBe('KHÔNG ĐẠT');
    const short = verdict({
      client: fast(100),
      server: fast(100),
      stationsRequested: 5,
      stationsConnected: 5,
      durationS: 40,
    });
    expect(short.overall).toBe('ĐẠT');
    expect(short.official).toBe(false);
    expect(short.caveats).toHaveLength(2);
  });
  it('liệt kê loại bản tin tự nó vượt ngưỡng dù gộp vẫn đạt', () => {
    const rows = [
      ...range(99).map(() => ({ action: 'MeterValues', ms: 5 })),
      { action: 'BootNotification', ms: 2500 },
    ];
    const v = verdict({ client: summarize(rows), server: summarize(rows), ...full });
    expect(v.overall).toBe('ĐẠT');
    expect(v.server.failingActions).toEqual(['BootNotification']);
  });
});

describe('hồ sơ tải có seed', () => {
  it('cùng seed + số thứ tự → cùng chuỗi phiên; trụ khác → chuỗi khác', () => {
    const take = (seed, index) => {
      const p = createStationProfile({ seed, index, meterIntervalS: 10 });
      return [p.initialMeterWh, p.nextSession(), p.nextSession()];
    };
    expect(take(20261112, 1)).toEqual(take(20261112, 1));
    expect(take(20261112, 1)).not.toEqual(take(20261112, 2));
    expect(take(20261112, 1)).not.toEqual(take(1, 1));
  });
  it('phiên nằm trong giới hạn của hồ sơ', () => {
    const p = createStationProfile({ seed: 7, index: 3, meterIntervalS: 10 });
    const first = p.nextSession();
    expect(first.idleS).toBeGreaterThanOrEqual(0);
    expect(first.idleS).toBeLessThan(15);
    for (let i = 0; i < 50; i++) {
      const s = p.nextSession();
      expect(s.idleS).toBeGreaterThanOrEqual(5);
      expect(s.idleS).toBeLessThan(20);
      expect([1, 2]).toContain(s.connector);
      expect(s.whs.length).toBeGreaterThanOrEqual(6);
      expect(s.whs.length).toBeLessThanOrEqual(18);
      // 30–120 kW trong 10 s, dao động ±10%: 75–367 Wh mỗi nhịp
      for (const wh of s.whs) {
        expect(wh).toBeGreaterThanOrEqual(75);
        expect(wh).toBeLessThanOrEqual(367);
      }
    }
  });
  it('định danh trụ tải: serial, thẻ (≤ 20 ký tự theo OCPP), email', () => {
    expect(loadIdentity(7)).toEqual({
      index: 7,
      serial: 'LOAD-0007',
      displayCode: 'PM-LOAD-0007',
      idTag: 'LOADCARD0007',
      email: 'load-0007@load.powerme.test',
    });
    expect(loadIdentity(500).idTag.length).toBeLessThanOrEqual(20);
  });
});

describe('checkLoadPassword', () => {
  it('bắt buộc, 16..40 ký tự, không khoảng trắng / dấu hai chấm', () => {
    expect(checkLoadPassword(undefined)).toMatch(/Thiếu/);
    expect(checkLoadPassword('x'.repeat(15))).toMatch(/16\.\.40/);
    expect(checkLoadPassword('x'.repeat(41))).toMatch(/16\.\.40/);
    expect(checkLoadPassword(`${'x'.repeat(16)}\r`)).toMatch(/khoảng trắng/);
    expect(checkLoadPassword(`${'x'.repeat(16)}:y`)).toMatch(/":"/);
    expect(checkLoadPassword('x'.repeat(16))).toBeNull();
  });
});

describe('báo cáo', () => {
  const stationStats = (over = {}) => ({
    connected: true,
    connects: 1,
    connectFailures: [],
    disconnects: 0,
    authorizeNotAccepted: 0,
    sessionsStarted: 2,
    sessionsStopped: 2,
    stepErrors: 0,
    firstError: null,
    heartbeatS: 300,
    ...over,
  });
  it('aggregateStations cộng số liệu từng trụ', () => {
    const a = aggregateStations(
      [
        stationStats(),
        stationStats({ connectFailures: ['429 Too Many Requests'], connects: 2, disconnects: 1 }),
        stationStats({ connected: false, connects: 0, firstError: 'không nối được' }),
      ],
      3,
    );
    expect(a).toMatchObject({
      requested: 3,
      connected: 2,
      connects: 3,
      connectFailures: 1,
      connectFailureSamples: ['429 Too Many Requests'],
      disconnects: 1,
      sessionsStopped: 6,
      errorSamples: ['không nối được'],
      heartbeatS: 300,
    });
  });
  it('summary.md nói rõ lần chạy local chưa phải số chính thức; CSV có cả hai phía', () => {
    const meta = {
      label: 'thử',
      target: { kind: 'local', endpoint: 'ws://127.0.0.1:9200/ocpp', env: { OCPP_PORT: '9200' } },
      params: {
        stations: 50,
        durationS: 600,
        rampS: 25,
        meterIntervalS: 10,
        seed: 1,
        profile: { ticksMin: 6, ticksMax: 18, idleMinS: 5, idleMaxS: 20 },
      },
      startedAt: '2026-11-12T00:00:00.000Z',
      finishedAt: '2026-11-12T00:10:30.000Z',
      wallClockS: 630,
      stations: aggregateStations([stationStats()], 50),
      git: { commit: 'abc', branch: 'x', dirty: false },
      machine: { cpuModel: 'cpu', logicalCpus: 4, totalMemGb: 8, os: 'os', node: 'v24' },
    };
    meta.stations.connected = 50;
    const clientRows = [
      { station: 'LOAD-0001', id: 'a', action: 'Heartbeat', ms: 12, outcome: 'ok' },
      { station: 'LOAD-0001', id: 'b', action: 'MeterValues', ms: null, outcome: 'timeout' },
    ];
    const serverRows = [
      { station: 'LOAD-0001', id: 'a', action: 'Heartbeat', ms: 3, result: 'callresult' },
      { station: 'LOAD-0001', id: 'b', action: 'MeterValues', ms: null, result: 'none' },
    ];
    const analysis = analyze({ meta, clientRows, serverRows });
    expect(analysis.outcomes).toEqual({ ok: 1, timeout: 1 });
    expect(analysis.verdict.overall).toBe('KHÔNG ĐẠT'); // 1/2 bản tin không được trả lời
    const md = renderMarkdown({ meta, analysis });
    expect(md).toMatch(/Số đo LOCAL, chưa phải staging/);
    expect(md).toMatch(/Lần chạy này: KHÔNG ĐẠT/);
    expect(md).toMatch(/đo local, không phải staging/);
    const csv = renderCsv(analysis).trim().split('\n');
    expect(csv[0].split(',')).toHaveLength(14);
    expect(csv.filter((l) => l.startsWith('server,'))).toHaveLength(3);
    expect(csv.filter((l) => l.startsWith('client,'))).toHaveLength(3);
    expect(csv[1]).toBe('server,ALL,2,1,1,0,3.00,3.00,3.00,3.00,3.00,inf,1000,false');
  });
  it('chưa có server-rows → CHƯA ĐỦ SỐ và hướng dẫn chạy server-timings', () => {
    const meta = {
      label: 'thử',
      target: { kind: 'staging', endpoint: 'wss://example.test/ocpp' },
      params: {
        stations: 50,
        durationS: 600,
        rampS: 25,
        meterIntervalS: 10,
        seed: 1,
        profile: { ticksMin: 6, ticksMax: 18, idleMinS: 5, idleMaxS: 20 },
      },
      startedAt: '2026-11-12T00:00:00.000Z',
      finishedAt: '2026-11-12T00:10:30.000Z',
      wallClockS: 630,
      stations: { ...aggregateStations([], 50), connected: 50 },
      git: { commit: null, branch: null, dirty: null },
      machine: { cpuModel: 'cpu', logicalCpus: 4, totalMemGb: 8, os: 'os', node: 'v24' },
    };
    const clientRows = [
      { station: 'LOAD-0001', id: 'a', action: 'Heartbeat', ms: 120, outcome: 'ok' },
    ];
    const analysis = analyze({ meta, clientRows, serverRows: null });
    expect(analysis.verdict.overall).toBe('CHƯA ĐỦ SỐ');
    const md = renderMarkdown({ meta, analysis });
    expect(md).toMatch(/server-timings\.mjs/);
    expect(md).not.toMatch(/Số đo LOCAL/);
  });
});
