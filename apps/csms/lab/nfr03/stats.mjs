/**
 * Hàm thuần của phép đo NFR-03 / NFR-OCPP-01: phân vị, tổng hợp theo loại bản tin, ghép cặp
 * CALL–CALLRESULT từ `ocpp_message_log`, và kết luận ĐẠT / KHÔNG ĐẠT.
 *
 * Vì sao tồn tại: cam kết BM04 là "CSMS reply time per charge point message, p95 ≤ 1 s with 50
 * simulated charge points" (SRS NFR-OCPP-01: "CSMS response time to a CALL from a charge point,
 * ≤ 1 s at p95"). Mọi con số trong summary.md đi qua các hàm ở đây, nên chúng không đọc file, không
 * nối DB và có unit test (stats.spec.mjs).
 *
 * Hai quy ước cần biết khi đọc kết quả:
 *   1. Phân vị = NEAREST-RANK (giá trị nhỏ nhất mà ít nhất p% mẫu ≤ nó), không nội suy: p95 luôn là
 *      một thời gian phản hồi đã đo thật.
 *   2. Bản tin KHÔNG được trả lời (timeout, đứt kết nối, không có CALLRESULT trong log) không có thời
 *      gian phản hồi. Bỏ chúng khỏi mẫu sẽ làm số đẹp lên đúng lúc hệ thống tệ nhất, nên khi kết
 *      luận chúng được tính là +∞ (`penalizedP95Ms`): quá 5% bản tin không được trả lời thì p95 = ∞.
 */

/** Ngưỡng NFR-OCPP-01 / NFR-03: p95 ≤ 1 s. */
export const THRESHOLD_MS = 1000;
/** Tải cam kết: 50 trụ, 10 phút. Lần chạy ít hơn chỉ chứng minh công cụ, không phải số báo cáo. */
export const REQUIRED_STATIONS = 50;
export const REQUIRED_DURATION_S = 600;

export const ALL = 'Tất cả';

/**
 * Phân vị nearest-rank của `values` (mảng số, không cần sắp xếp). `missing` = số mẫu không có giá
 * trị, tính là +∞ (xếp cuối). Trả null khi không có mẫu nào.
 */
export function percentile(values, p, missing = 0) {
  if (!(p > 0 && p <= 100)) throw new Error(`phân vị phải trong (0, 100], nhận ${p}`);
  const n = values.length + missing;
  if (n === 0) return null;
  const rank = Math.ceil((p / 100) * n); // 1..n
  if (rank > values.length) return Infinity;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[rank - 1];
}

/** Thống kê một nhóm: `ms` là các thời gian đã đo, `unanswered` là số bản tin không có trả lời. */
export function describe(ms, unanswered = 0) {
  const n = ms.length;
  return {
    n: n + unanswered,
    answered: n,
    unanswered,
    p50Ms: percentile(ms, 50),
    p95Ms: percentile(ms, 95),
    p99Ms: percentile(ms, 99),
    maxMs: n ? ms.reduce((a, b) => Math.max(a, b), -Infinity) : null,
    meanMs: n ? ms.reduce((a, b) => a + b, 0) / n : null,
    penalizedP95Ms: percentile(ms, 95, unanswered),
  };
}

/**
 * Tổng hợp theo loại bản tin + một dòng gộp. `rows`: `{ action, ms, error? }` với `ms === null`
 * nghĩa là không được trả lời; `error` = CSMS trả CALLERROR (vẫn là một trả lời, có thời gian).
 * Dòng gộp đứng đầu, các loại bản tin xếp theo tên.
 */
export function summarize(rows) {
  const groups = new Map();
  for (const row of rows) {
    for (const key of [ALL, row.action]) {
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { ms: [], unanswered: 0, errors: 0 }));
      if (typeof row.ms === 'number' && Number.isFinite(row.ms)) g.ms.push(row.ms);
      else g.unanswered++;
      if (row.error) g.errors++;
    }
  }
  const actions = [...groups.keys()].filter((k) => k !== ALL).sort();
  return (groups.has(ALL) ? [ALL, ...actions] : []).map((action) => {
    const g = groups.get(action);
    return { action, ...describe(g.ms, g.unanswered), callErrors: g.errors };
  });
}

/**
 * Ghép CALL chiều vào với CALLRESULT / CALLERROR chiều ra của CSMS, từ các dòng `ocpp_message_log`.
 *
 * Khoá ghép = (trụ, epoch, unique_id): một CALLRESULT luôn đi trên cùng socket với CALL của nó. CALL
 * do CSMS gửi (TriggerMessage, RemoteStop: direction 'out', type 2) và trả lời của trụ ('in', type
 * 3/4) KHÔNG phải "CSMS reply time" nên bị bỏ qua. Trụ gửi lại y nguyên một bản tin (cùng unique_id)
 * thì mỗi CALL ghép với trả lời đến sớm nhất sau nó.
 *
 * @param frames  `{ id, station, epoch, direction: 'in'|'out', messageType: 2|3|4, uniqueId, action,
 *                 receivedAtMs }`; `id` là khoá của bảng (tăng theo thứ tự ghi)
 * @returns mỗi CALL chiều vào một dòng `{ station, epoch, id, action, receivedAtMs, ms, result }`;
 *          `ms === null` và `result === 'none'` khi log không có trả lời
 */
export function pairFrames(frames) {
  const ordered = [...frames].sort((a, b) => {
    const [x, y] = [BigInt(a.id), BigInt(b.id)];
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const pending = new Map();
  const out = [];
  for (const f of ordered) {
    const key = `${f.station}\u0000${f.epoch}\u0000${f.uniqueId}`;
    if (f.direction === 'in' && f.messageType === 2) {
      const row = {
        station: f.station,
        epoch: f.epoch,
        id: f.uniqueId,
        action: f.action,
        receivedAtMs: f.receivedAtMs,
        ms: null,
        result: 'none',
      };
      out.push(row);
      const queue = pending.get(key);
      if (queue) queue.push(row);
      else pending.set(key, [row]);
    } else if (f.direction === 'out' && (f.messageType === 3 || f.messageType === 4)) {
      const queue = pending.get(key);
      const row = queue?.shift();
      if (!row) continue; // trả lời không có CALL trong cửa sổ đọc (CALL nằm trước mốc `from`)
      if (queue.length === 0) pending.delete(key);
      row.ms = f.receivedAtMs - row.receivedAtMs;
      row.result = f.messageType === 3 ? 'callresult' : 'callerror';
    }
  }
  return out;
}

/**
 * Ghép số đo client với số đo server của CÙNG một bản tin (trụ + unique_id). `ms` của kết quả =
 * client − server = mạng hai chiều + TLS/proxy + thời gian nằm trong socket; là phần số đo server
 * không thấy. `clientOnly` = bản tin client đã gửi mà log của CSMS không có.
 */
export function joinClientServer(clientRows, serverRows) {
  const key = (r) => `${r.station}\u0000${r.id}`;
  const server = new Map();
  for (const r of serverRows) if (!server.has(key(r))) server.set(key(r), r);
  const joined = [];
  let clientOnly = 0;
  for (const c of clientRows) {
    const s = server.get(key(c));
    if (!s) {
      clientOnly++;
      continue;
    }
    if (typeof c.ms === 'number' && typeof s.ms === 'number') {
      joined.push({ action: c.action, ms: c.ms - s.ms });
    }
  }
  return { joined, clientOnly };
}

/** Gộp số liệu của từng trụ thành một khối cho meta.json. */
export function aggregateStations(stats, requested) {
  const sum = (f) => stats.reduce((a, s) => a + f(s), 0);
  const unique = (list) => [...new Set(list)].slice(0, 5);
  const heartbeats = unique(stats.map((s) => s.heartbeatS).filter((x) => x !== undefined));
  return {
    requested,
    connected: stats.filter((s) => s.connected).length,
    connects: sum((s) => s.connects),
    connectFailures: sum((s) => s.connectFailures.length),
    connectFailureSamples: unique(stats.flatMap((s) => s.connectFailures)),
    disconnects: sum((s) => s.disconnects),
    sessionsStarted: sum((s) => s.sessionsStarted),
    sessionsStopped: sum((s) => s.sessionsStopped),
    authorizeNotAccepted: sum((s) => s.authorizeNotAccepted),
    stepErrors: sum((s) => s.stepErrors),
    errorSamples: unique(stats.map((s) => s.firstError).filter(Boolean)),
    heartbeatS: heartbeats.length === 1 ? heartbeats[0] : heartbeats.join('/'),
  };
}

const pass = (ms) => ms !== null && ms <= THRESHOLD_MS;

/**
 * Kết luận so với ngưỡng. Số QUYẾT ĐỊNH là p95 gộp mọi bản tin (đúng câu chữ "per charge point
 * message"), có tính bản tin không được trả lời; loại bản tin nào tự nó vượt ngưỡng được liệt kê
 * kèm. `server` rỗng/null nghĩa là chưa đọc được `ocpp_message_log`.
 *
 * `official` = lần chạy đủ điều kiện của cam kết (đủ trụ, đủ thời gian, có số server); việc lần
 * chạy đó có ở staging hay không do người đọc `meta.json` xác nhận, hàm này không biết.
 *
 * @returns `{ client, server, overall: 'ĐẠT'|'KHÔNG ĐẠT'|'CHƯA ĐỦ SỐ', official, caveats[] }`
 */
export function verdict({ client, server, stationsRequested, stationsConnected, durationS }) {
  const side = (summary) => {
    const all = summary?.find((s) => s.action === ALL);
    if (!all) return null;
    const failingActions = summary
      .filter((s) => s.action !== ALL && !pass(s.penalizedP95Ms))
      .map((s) => s.action);
    return { p95Ms: all.penalizedP95Ms, pass: pass(all.penalizedP95Ms), failingActions };
  };
  const c = side(client);
  const s = side(server);
  const caveats = [];
  if (stationsConnected < stationsRequested) {
    caveats.push(`chỉ ${stationsConnected}/${stationsRequested} trụ nối được`);
  }
  if (stationsRequested < REQUIRED_STATIONS) {
    caveats.push(`${stationsRequested} trụ, cam kết là ${REQUIRED_STATIONS}`);
  }
  if (durationS < REQUIRED_DURATION_S) {
    caveats.push(`chạy ${durationS} s, cam kết là ${REQUIRED_DURATION_S} s`);
  }
  if (!s) caveats.push('chưa có số đo phía server (ocpp_message_log)');
  let overall;
  if ((c && !c.pass) || (s && !s.pass) || stationsConnected < stationsRequested) {
    overall = 'KHÔNG ĐẠT';
  } else if (!c || !s) {
    overall = 'CHƯA ĐỦ SỐ';
  } else {
    overall = 'ĐẠT';
  }
  const official =
    stationsRequested >= REQUIRED_STATIONS &&
    stationsConnected >= stationsRequested &&
    durationS >= REQUIRED_DURATION_S &&
    Boolean(s);
  return { client: c, server: s, overall, official, caveats };
}
