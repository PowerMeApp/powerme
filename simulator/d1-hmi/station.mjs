// station.mjs — logic trụ sạc giả lập D1 (DC 120 kW, hai súng) + client OCPP 1.6J.
//
// LÀM GÌ
//   Một "trụ" trong bộ nhớ: hai súng (connectorId 1 = A, 2 = B; 0 = cả trụ), mô hình điện DC,
//   client OCPP (ocpp-rpc) tự quản lý kết nối lại và hàng đợi bản tin khi rớt mạng. server.mjs
//   gọi các hàm hành động ở đây (cắm súng, quẹt thẻ, rớt mạng...) và đẩy trạng thái ra HMI.
//
// VÌ SAO TỰ QUẢN LÝ RECONNECT
//   Phải kiểm soát chính xác lúc nào trụ biết mất mạng, buffer gì, thử lại khi nào, phát bù thế
//   nào — nên RPCClient chạy với reconnect:false và vòng thử lại nằm ở đây.
//
// MÔ HÌNH RỚT MẠNG — bám EXP-01 (apps/csms/lab/EXP-01-ngat-ket-noi-81s.md)
//   Đây là mô hình rút ra từ MỘT lần quan sát trên simulator SAP, KHÔNG phải firmware Ruihua.
//   - Thử nối lại cố định 30 s (tuyến tính), không backoff.
//   - Trong lúc offline: MeterValues, StartTransaction, StopTransaction, StatusNotification vào hàng
//     đợi, GIỮ NGUYÊN timestamp lúc phát sinh (đồng hồ trụ).
//   - Sau khi nối lại KHÔNG gửi BootNotification. Gửi trước các bản tin giao dịch/trạng thái theo
//     thứ tự, rồi phát lại MeterValues cũ SAU (nên đến sau StopTransaction — sai thứ tự như EXP-01).
//   - Phát lại mất mẫu im lặng: EXP-01 mất 2/8 → mặc định bỏ 25 % mẫu (replayLoss, chỉnh được).
//
// GIẢ ĐỊNH CHƯA XÁC NHẬN HÃNG (bảng đầy đủ trong README.md)
//   Wh là số nguyên; idTag free vend = "HMI-FREEVEND" và gửi thẳng StartTransaction không Authorize;
//   offline trụ chấp nhận thẻ hợp lệ + thẻ ví theo danh sách cục bộ; pin đầy → reason "Other";
//   hai súng chia đều 120 kW; config key hỗ trợ là tập con tự chọn.
//
// Đồng hồ mô phỏng: mọi timestamp OCPP dùng đồng hồ mô phỏng (tăng nhanh ×speed khi demo tăng tốc).
// Thời gian MẠNG (rớt mạng, thử lại 30 s) luôn là giây thật.

import { EventEmitter } from 'node:events';
import ocpp from 'ocpp-rpc';
import {
  OCPP_STATUSES,
  ERROR_CODES,
  CARDS,
  BATTERY_KWH,
  STATION_KW,
  sleep,
  taper,
  summarize,
} from './model.mjs';
import { registerHandlers } from './ocpp-commands.mjs';
import { makeHmiActions, fail, done } from './hmi-actions.mjs';

export { OCPP_STATUSES, ERROR_CODES, CARDS };

const { RPCClient } = ocpp;

export function createStation(options = {}) {
  const opt = {
    csmsUrl: 'ws://localhost:9000/ocpp',
    cpId: 'RH24D1-00001',
    unitPrice: 3500, // đ/kWh — chỉ để hiển thị, CSMS mới là nguồn sự thật
    password: '123456', // mật khẩu HMI mẫu (giả)
    retryMs: 30_000, // EXP-01: thử lại cố định 30 s
    replayLoss: 0.25, // EXP-01: phát lại 6/8
    rebootMs: 3000,
    speed: 1,
    ...options,
  };
  const events = new EventEmitter();
  const log = [];
  const timeline = [];
  let seq = 0;

  // ── Đồng hồ mô phỏng ──────────────────────────────────────────────────────
  const sim = { ms: Date.now() };
  const simIso = (ms = sim.ms) => new Date(ms).toISOString();

  // ── Cấu hình trụ (GetConfiguration / ChangeConfiguration) ─────────────────
  const CONFIG = new Map([
    ['HeartbeatInterval', { value: '60', readonly: false, numeric: true }],
    [
      'MeterValueSampleInterval',
      { value: String(options.meterInterval ?? 10), readonly: false, numeric: true },
    ],
    ['AuthorizeRemoteTxRequests', { value: 'false', readonly: false }],
    [
      'WebSocketPingInterval',
      { value: String(options.pingSec ?? 30), readonly: false, numeric: true },
    ],
    ['ConnectionTimeOut', { value: '120', readonly: false, numeric: true }],
    ['NumberOfConnectors', { value: '2', readonly: true }],
    ['SupportedFeatureProfiles', { value: 'Core,RemoteTrigger', readonly: true }],
    ['ConnectorPhaseRotation', { value: '0.RST,1.RST,2.RST', readonly: true }],
  ]);
  const cfgNum = (k) => Number(CONFIG.get(k).value);

  // ── Trạng thái súng ───────────────────────────────────────────────────────
  const mkConn = (id) => ({
    id,
    status: 'Available',
    errorCode: 'NoError',
    plugged: false,
    fault: null,
    inoperative: false,
    pendingAvail: null, // 'Inoperative' | 'Operative' chờ hết phiên
    vehicleSoc: null,
    register: 120_000 + id * 3_000, // chỉ số công tơ tích luỹ, Wh nguyên
    mode: { type: 'full', value: null },
    remoteWait: null, // { idTag, until } — RemoteStart đang chờ cắm súng
    tx: null,
    last: { kw: 0, v: 0, a: 0 },
  });
  const conns = new Map([
    [1, mkConn(1)],
    [2, mkConn(2)],
  ]);

  // ── Mạng ──────────────────────────────────────────────────────────────────
  const net = {
    cause: null, // lý do ngắt do người dùng chủ động (nút Rớt mạng)
    state: 'offline', // offline | connecting | online
    epoch: 0, // tăng mỗi lần mở socket thành công
    downUntil: 0, // mốc thật: trước đó mọi lần nối đều thất bại
    halfOpen: false,
    nextRetryAt: 0,
    offlineSince: 0,
    booted: false,
  };
  let client = null;
  let retryTimer = null;
  let hbTimer = null;
  let flushing = false;
  let rebooting = false;
  let stopped = false;
  const queue = []; // { action, payload, tx }
  const callNames = new Map();

  // ── Nhật ký OCPP + dòng thời gian ─────────────────────────────────────────
  function pushLog(entry) {
    entry.n = ++seq;
    entry.t = Date.now();
    log.push(entry);
    if (log.length > 300) log.shift();
    events.emit('log', entry);
  }
  function tl(kind, text) {
    timeline.push({ t: Date.now(), kind, text });
    if (timeline.length > 40) timeline.shift();
    changed();
  }
  const changed = () => events.emit('change');

  function attachLogging(c) {
    c.on('message', ({ message, outbound }) => {
      let m;
      try {
        m = JSON.parse(message);
      } catch {
        return;
      }
      const [type, id, a, b] = m;
      if (type === 2) {
        callNames.set(id, a);
        pushLog({ dir: outbound ? 'out' : 'in', kind: 'CALL', action: a, text: summarize(a, b) });
      } else {
        const action = callNames.get(id) ?? '?';
        const body = type === 3 ? a : { code: a, desc: b };
        pushLog({
          dir: outbound ? 'out' : 'in',
          kind: type === 3 ? 'RESULT' : 'ERROR',
          action,
          text: JSON.stringify(body).slice(0, 150),
        });
        if (callNames.size > 200) callNames.delete(callNames.keys().next().value);
      }
    });
  }

  // ── Gửi bản tin: trực tiếp nếu online, vào hàng đợi nếu offline ──────────
  // buffer=false (Authorize, Boot, Heartbeat): offline thì ném lỗi.
  async function emit(action, payload, { tx = null, buffer = true } = {}) {
    const blocked =
      net.state !== 'online' || (tx && tx.id == null && action !== 'StartTransaction');
    if (blocked) {
      if (!buffer) throw new Error('offline');
      queue.push({ action, payload, tx });
      changed();
      return null;
    }
    if (tx && action !== 'StartTransaction') payload.transactionId = tx.id;
    try {
      return await client.call(action, payload);
    } catch (e) {
      if (e.rpcErrorCode) {
        tl('warn', `CSMS từ chối ${action}: ${e.message}`);
        throw e;
      }
      if (!buffer) throw e;
      queue.push({ action, payload, tx }); // lỗi đường truyền (timeout, socket chết) → giữ lại
      changed();
      return null;
    }
  }

  const setStatus = (c, status, errorCode = 'NoError') => {
    c.status = status;
    c.errorCode = errorCode;
    changed();
    return emit('StatusNotification', {
      connectorId: c.id,
      status,
      errorCode,
      timestamp: simIso(),
    }).catch(() => {});
  };
  const idleStatus = (c) =>
    c.fault ? 'Faulted' : c.inoperative ? 'Unavailable' : c.plugged ? 'Preparing' : 'Available';

  // Phát bù hàng đợi sau khi nối lại (hoặc khi tx vừa có transactionId).
  async function flushQueue() {
    if (flushing || net.state !== 'online') return;
    flushing = true;
    try {
      const ordered = queue.filter((q) => q.action !== 'MeterValues');
      const meters = queue.filter((q) => q.action === 'MeterValues');
      const total = queue.length;
      queue.length = 0;
      if (total) tl('net', `phát bù ${total} bản tin buffer (giữ timestamp gốc)`);
      let dropped = 0;
      const send = async (q) => {
        if (q.tx && q.tx.id == null && q.action !== 'StartTransaction') return queue.push(q);
        try {
          const res = await emit(q.action, q.payload, { tx: q.tx });
          if (q.action === 'StartTransaction') onStartResult(q.tx, res);
        } catch {}
      };
      for (const q of ordered) await send(q);
      meters.forEach((q, i) => {
        // bỏ mẫu theo tỉ lệ replayLoss, rải đều (EXP-01: 8 buffer, 6 phát lại)
        if (Math.floor((i + 1) * opt.replayLoss) > Math.floor(i * opt.replayLoss)) {
          dropped++;
          meters[i] = null;
        }
      });
      for (const q of meters) if (q) await send(q);
      if (dropped)
        tl(
          'warn',
          `mất ${dropped}/${meters.length} MeterValues khi phát lại (im lặng, như EXP-01)`,
        );
    } finally {
      flushing = false;
    }
    if (queue.length && !queue.every((q) => q.tx && q.tx.id == null)) setImmediate(flushQueue);
    changed();
  }

  // ── Kết nối / ngắt / thử lại ──────────────────────────────────────────────
  function buildClient() {
    const c = new RPCClient({
      endpoint: opt.csmsUrl,
      identity: opt.cpId,
      protocols: ['ocpp1.6'],
      strictMode: true,
      reconnect: false,
      pingIntervalMs: cfgNum('WebSocketPingInterval') * 1000,
      callTimeoutMs: 15_000,
    });
    attachLogging(c);
    registerHandlers(c, ctx);
    c.on('close', () => {
      if (c !== client || stopped) return;
      if (rebooting) return;
      goOffline('CSMS/ping đóng socket');
    });
    return c;
  }

  async function connectOnce({ boot }) {
    if (Date.now() < net.downUntil) throw new Error('mạng còn đứt');
    net.state = 'connecting';
    changed();
    const c = buildClient();
    client = c;
    try {
      await c.connect();
    } catch (e) {
      client = null;
      net.state = 'offline';
      throw e;
    }
    net.epoch++;
    net.state = 'online';
    net.halfOpen = false;
    tl(
      'net',
      `đã nối lại — epoch ${net.epoch}${boot ? ' (sẽ gửi BootNotification)' : ' (KHÔNG gửi Boot, như EXP-01)'}`,
    );
    if (boot) await bootSequence();
    else {
      scheduleHeartbeat();
      await flushQueue();
    }
    changed();
  }

  async function bootSequence() {
    const res = await emit(
      'BootNotification',
      {
        chargePointVendor: 'Ruihua',
        chargePointModel: 'D1-120',
        chargePointSerialNumber: opt.cpId,
        firmwareVersion: 'sim-hmi-0.1',
      },
      { buffer: false },
    );
    if (res.status !== 'Accepted') {
      tl('warn', `Boot ${res.status} — thử lại sau ${res.interval}s`);
      setTimeout(
        () => !stopped && bootSequence().catch(() => {}),
        Math.max(1, res.interval) * 1000,
      );
      return;
    }
    net.booted = true;
    CONFIG.get('HeartbeatInterval').value = String(res.interval || 60);
    await emit('StatusNotification', {
      connectorId: 0,
      status: 'Available',
      errorCode: 'NoError',
      timestamp: simIso(),
    });
    for (const c of conns.values())
      await setStatus(c, c.tx ? 'Charging' : idleStatus(c), c.fault ?? 'NoError');
    scheduleHeartbeat();
    await flushQueue();
  }

  function scheduleHeartbeat() {
    clearInterval(hbTimer);
    hbTimer = setInterval(
      () => {
        if (net.state === 'online') emit('Heartbeat', {}, { buffer: false }).catch(() => {});
      },
      cfgNum('HeartbeatInterval') * 1000,
    );
  }

  function goOffline(why) {
    if (net.state === 'offline' && retryTimer) return;
    net.state = 'offline';
    net.offlineSince = Date.now();
    const reason = net.cause ?? why;
    net.cause = null;
    if (client) client = null;
    clearInterval(hbTimer);
    tl('net', `mất kết nối (${reason}) — thử lại mỗi ${opt.retryMs / 1000}s`);
    scheduleRetry();
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    net.nextRetryAt = Date.now() + opt.retryMs;
    retryTimer = setTimeout(async () => {
      if (stopped) return;
      try {
        await connectOnce({ boot: false });
        retryTimer = null;
        net.nextRetryAt = 0;
      } catch (e) {
        tl('net', `thử nối lại thất bại (${e.message})`);
        scheduleRetry();
      }
      changed();
    }, opt.retryMs);
    changed();
  }

  // ── Điện: tick mô phỏng ───────────────────────────────────────────────────
  let lastTick = Date.now();
  const ticker = setInterval(() => {
    const nowReal = Date.now();
    const dtSim = ((nowReal - lastTick) / 1000) * opt.speed;
    lastTick = nowReal;
    sim.ms += dtSim * 1000;
    const active = [...conns.values()].filter((c) => c.tx);
    for (const c of conns.values()) {
      if (c.remoteWait && nowReal > c.remoteWait.until) {
        c.remoteWait = null;
        tl('info', `RemoteStart súng ${c.id} hết hạn 120 s — chưa cắm súng`);
      }
      if (!c.tx) {
        c.last = { kw: 0, v: 0, a: 0 };
        continue;
      }
      const tx = c.tx;
      const kw = (STATION_KW / active.length) * taper(c.vehicleSoc);
      const v = 350 + c.vehicleSoc * 0.7;
      const dWh = (kw * 1000 * dtSim) / 3600;
      tx.whF += dWh;
      c.vehicleSoc = Math.min(100, c.vehicleSoc + (dWh / (BATTERY_KWH * 1000)) * 100);
      c.last = { kw, v, a: (kw * 1000) / v };
      tx.wh = Math.floor(tx.whF);
      if (sim.ms - tx.lastSample >= cfgNum('MeterValueSampleInterval') * 1000) {
        tx.lastSample = sim.ms;
        sendMeter(c).catch(() => {});
      }
      if (c.vehicleSoc >= 100 && !tx.stopping) {
        c.vehicleSoc = 100;
        stopTx(c, 'Other').catch(() => {}); // pin đầy: reason "Other" (EVDisconnected dành cho rút súng)
      }
    }
    changed();
  }, 250);

  function sendMeter(c) {
    const tx = c.tx;
    const reg = tx.meterStart + tx.wh;
    return emit(
      'MeterValues',
      {
        connectorId: c.id,
        meterValue: [
          {
            timestamp: simIso(),
            sampledValue: [
              { value: String(reg), measurand: 'Energy.Active.Import.Register', unit: 'Wh' },
              { value: String(Math.round(c.vehicleSoc)), measurand: 'SoC', unit: 'Percent' },
              {
                value: String(Math.round(c.last.kw * 1000)),
                measurand: 'Power.Active.Import',
                unit: 'W',
              },
              { value: c.last.v.toFixed(1), measurand: 'Voltage', unit: 'V' },
              { value: c.last.a.toFixed(1), measurand: 'Current.Import', unit: 'A' },
            ],
          },
        ],
      },
      { tx },
    ).catch(() => {});
  }

  // ── Phiên sạc ─────────────────────────────────────────────────────────────
  function onStartResult(tx, res) {
    if (!res) return;
    tx.id = res.transactionId;
    if (res.idTagInfo?.status !== 'Accepted') {
      tl(
        'warn',
        `CSMS trả StartTransaction ${res.idTagInfo?.status} — trụ dừng phiên (DeAuthorized)`,
      );
      const c = [...conns.values()].find((x) => x.tx === tx);
      if (c) stopTx(c, 'DeAuthorized').catch(() => {});
    }
  }

  async function startTx(c, idTag, source) {
    const tx = {
      id: null,
      idTag,
      source,
      meterStart: c.register,
      whF: 0,
      wh: 0,
      startSim: sim.ms,
      lastSample: sim.ms,
      stopping: false,
      limitHit: false,
    };
    c.tx = tx;
    c.remoteWait = null;
    changed();
    const res = await emit(
      'StartTransaction',
      { connectorId: c.id, idTag, meterStart: tx.meterStart, timestamp: simIso() },
      { tx },
    );
    onStartResult(tx, res);
    await setStatus(c, 'Charging');
    if (res) flushQueue();
  }

  async function stopTx(c, reason) {
    const tx = c.tx;
    if (!tx || tx.stopping) return;
    tx.stopping = true;
    const meterStop = tx.meterStart + tx.wh;
    const ts = simIso();
    c.register = meterStop;
    c.tx = null;
    c.last = { kw: 0, v: 0, a: 0 };
    tx.final = { wh: tx.wh, cost: (tx.wh / 1000) * opt.unitPrice };
    c.lastSession = { ...tx.final, reason, idTag: tx.idTag };
    changed();
    await setStatus(c, 'Finishing');
    await emit(
      'StopTransaction',
      { idTag: tx.idTag, meterStop, timestamp: ts, reason },
      { tx },
    ).catch(() => {});
    if (c.pendingAvail) applyAvailability(c, c.pendingAvail);
  }

  function applyAvailability(c, type) {
    c.pendingAvail = null;
    c.inoperative = type === 'Inoperative';
    if (!c.tx && c.status !== 'Finishing') setStatus(c, idleStatus(c), c.fault ?? 'NoError');
    else if (c.status === 'Finishing' && c.inoperative) setStatus(c, 'Unavailable');
  }

  const netActions = {
    async drop(a) {
      const sec = Number(a.seconds);
      if (!(sec >= 1 && sec <= 180)) return fail('Số giây phải trong 1–180');
      if (net.state !== 'online') return fail('Trụ đang offline');
      net.downUntil = Date.now() + sec * 1000;
      net.cause = `đã cắt mạng ${sec} s`;
      client.close({ force: true }).catch(() => {}); // 'close' → goOffline
      return done(`Rớt mạng ${sec} s`);
    },
    // Half-open: ngừng đọc/ghi socket nhưng KHÔNG đóng. Trụ chỉ phát hiện nhờ ping timeout.
    async halfopen(a) {
      const sec = Number(a.seconds);
      if (!(sec >= 1 && sec <= 180)) return fail('Số giây phải trong 1–180');
      if (net.state !== 'online') return fail('Trụ đang offline');
      const sock = client._ws._socket;
      sock.pause();
      sock.write = () => true;
      net.halfOpen = true;
      net.downUntil = Date.now() + sec * 1000;
      tl('net', 'half-open: socket im lặng, trụ CHƯA biết — chờ ping timeout');
      return done('Half-open');
    },
    async reboot(a = {}) {
      if (rebooting) return fail('Đang khởi động lại');
      rebooting = true;
      tl('info', 'Khởi động lại trụ');
      for (const c of conns.values()) if (c.tx) await stopTx(c, a.reason ?? 'Reboot');
      net.booted = false;
      clearInterval(hbTimer);
      clearTimeout(retryTimer);
      retryTimer = null;
      const old = client;
      client = null;
      net.state = 'offline';
      changed();
      if (old) await old.close({ force: true }).catch(() => {});
      await sleep(opt.rebootMs);
      rebooting = false;
      net.downUntil = 0;
      await connectOnce({ boot: true }).catch((e) => {
        tl('net', `nối lại sau reboot thất bại (${e.message})`);
        goOffline('reboot');
      });
      return done('Đã khởi động lại');
    },
  };

  const ctx = {
    conns,
    opt,
    net,
    CONFIG,
    cfgNum,
    emit,
    setStatus,
    idleStatus,
    startTx,
    stopTx,
    tl,
    changed,
    sendMeter,
    bootSequence,
    applyAvailability,
    scheduleHeartbeat,
    reboot: (a) => netActions.reboot(a),
  };
  const actions = { ...makeHmiActions(ctx), ...netActions };

  // ── Snapshot cho HMI ──────────────────────────────────────────────────────
  function connSnap(c) {
    const tx = c.tx;
    const wh = tx ? tx.wh : (c.lastSession?.wh ?? 0);
    const cost = tx ? (tx.wh / 1000) * opt.unitPrice : (c.lastSession?.cost ?? 0);
    const elapsed = tx ? Math.floor((sim.ms - tx.startSim) / 1000) : 0;
    let limitHit = false;
    if (tx) {
      const { type, value } = c.mode;
      limitHit =
        (type === 'time' && elapsed >= value * 60) ||
        (type === 'kwh' && tx.wh >= value * 1000) ||
        (type === 'money' && cost >= value);
    }
    return {
      id: c.id,
      label: c.id === 1 ? 'A' : 'B',
      status: c.status,
      errorCode: c.errorCode,
      plugged: c.plugged,
      soc: c.vehicleSoc == null ? null : Math.round(c.vehicleSoc * 10) / 10,
      voltage: Math.round(c.last.v),
      current: Math.round(c.last.a * 10) / 10,
      kw: Math.round(c.last.kw * 10) / 10,
      wh,
      kwh: Math.round(wh / 10) / 100,
      cost: Math.round(cost),
      elapsed,
      mode: c.mode,
      limitHit,
      txId: tx?.id ?? null,
      txActive: !!tx,
      idTag: tx?.idTag ?? null,
      source: tx?.source ?? null,
      remoteWaitSec: c.remoteWait
        ? Math.max(0, Math.round((c.remoteWait.until - Date.now()) / 1000))
        : null,
      pendingAvail: c.pendingAvail,
      inoperative: c.inoperative,
      lastReason: c.lastSession?.reason ?? null,
    };
  }
  function snapshot() {
    const counts = {};
    for (const q of queue) counts[q.action] = (counts[q.action] ?? 0) + 1;
    return {
      cpId: opt.cpId,
      csmsUrl: opt.csmsUrl,
      unitPrice: opt.unitPrice,
      speed: opt.speed,
      simTime: simIso(),
      net: {
        state: net.state,
        epoch: net.epoch,
        halfOpen: net.halfOpen,
        booted: net.booted,
        downRemainingSec: Math.max(0, Math.ceil((net.downUntil - Date.now()) / 1000)),
        nextRetrySec: net.nextRetryAt
          ? Math.max(0, Math.ceil((net.nextRetryAt - Date.now()) / 1000))
          : null,
        retrySec: opt.retryMs / 1000,
        offlineSec:
          net.state === 'offline' ? Math.floor((Date.now() - net.offlineSince) / 1000) : 0,
      },
      queue: { total: queue.length, byAction: counts },
      connectors: [...conns.values()].map(connSnap),
      timeline: timeline.slice(-14),
      statuses: OCPP_STATUSES,
      errorCodes: ERROR_CODES,
      cards: CARDS,
    };
  }

  return {
    events,
    snapshot,
    logHistory: () => log.slice(),
    async act(name, args) {
      const fn = actions[name];
      if (!fn) return fail(`Hành động không có: ${name}`);
      try {
        return await fn(args ?? {});
      } catch (e) {
        return fail(e.message);
      }
    },
    async start() {
      net.offlineSince = Date.now();
      try {
        await connectOnce({ boot: true });
      } catch (e) {
        tl('net', `chưa nối được CSMS (${e.message})`);
        goOffline('khởi động');
      }
    },
    async close() {
      stopped = true;
      clearInterval(ticker);
      clearInterval(hbTimer);
      clearTimeout(retryTimer);
      if (client) await client.close({ force: true }).catch(() => {});
    },
  };
}
