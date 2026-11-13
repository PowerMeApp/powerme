/**
 * Trụ tải của phép đo NFR-03: một trụ giả OCPP 1.6J chạy hồ sơ tải thường ngày (Boot, Status,
 * Heartbeat, chu kỳ Authorize → StartTransaction → MeterValues → StopTransaction) và ĐO thời gian
 * phản hồi của CSMS cho từng bản tin nó gửi.
 *
 * Vì sao không dùng lại `rq1/station.mjs`: trụ RQ1 tồn tại để GÂY LỖI có chủ ý (đứt kết nối, phát lại
 * `meterStop` cũ) và giữ sự thật nền năng lượng; nó không đo thời gian và hàm gửi của nó là private.
 * Trụ ở đây làm việc ngược lại: không gây lỗi nào, chỉ đo. Cách nói giao thức (ocpp-rpc strictMode,
 * trả lời TriggerMessage bằng StatusNotification) giữ giống hệt.
 *
 * Đo ở đâu: từ sự kiện `message` của ocpp-rpc, tức ngay sau `ws.send()` của CALL cho tới lúc frame
 * CALLRESULT / CALLERROR có cùng MessageId về tới tiến trình này. Không đo quanh `client.call()` vì
 * ocpp-rpc xếp hàng CALL chiều ra (callConcurrency = 1): thời gian một Heartbeat nằm chờ sau một
 * MeterValues là độ trễ của bộ sinh tải, không phải của CSMS.
 */
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const { RPCClient, createRPCError } = require('ocpp-rpc');

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sleepUntil = (ms) => sleep(Math.max(0, ms - Date.now()));
const round2 = (x) => Math.round(x * 100) / 100;

export class LoadStation {
  /**
   * @param opts.endpoint        URL gốc WebSocket, không kèm serial (vd wss://host/ocpp)
   * @param opts.identity        `{ serial, idTag }` (profile.mjs `loadIdentity`)
   * @param opts.password        mật khẩu Basic Auth của trụ; không bao giờ được ghi ra
   * @param opts.plan            bộ sinh phiên của trụ (profile.mjs `createStationProfile`)
   * @param opts.meterIntervalS  nhịp MeterValues
   * @param opts.heartbeatS      nhịp Heartbeat; null = dùng `interval` CSMS trả trong BootNotification
   * @param opts.onRow           nhận một dòng cho mỗi CALL trụ đã gửi
   */
  constructor({
    endpoint,
    identity,
    password,
    plan,
    meterIntervalS,
    heartbeatS = null,
    callTimeoutMs = 30_000,
    connectRetries = 5,
    onRow = () => {},
  }) {
    this.endpoint = endpoint;
    this.serial = identity.serial;
    this.idTag = identity.idTag;
    this.password = password;
    this.plan = plan;
    this.meterIntervalMs = meterIntervalS * 1000;
    this.heartbeatS = heartbeatS;
    this.callTimeoutMs = callTimeoutMs;
    this.connectRetries = connectRetries;
    this.onRow = onRow;

    this.client = null;
    this.closing = false;
    this.registerWh = plan.initialMeterWh;
    this.connectorStatus = new Map([
      [1, 'Available'],
      [2, 'Available'],
    ]);
    /** CALL đã gửi, chưa có trả lời: MessageId → { action, t0, sentAtMs }. */
    this.pending = new Map();
    this.heartbeatTimer = null;
    this.stats = {
      connected: false,
      connects: 0,
      connectFailures: [],
      disconnects: 0,
      authorizeNotAccepted: 0,
      sessionsStarted: 0,
      sessionsStopped: 0,
      stepErrors: 0,
      firstError: null,
    };
  }

  // ---- đo thời gian ---------------------------------------------------------------------------

  #onMessage(client, { message, outbound }) {
    let frame;
    try {
      frame = JSON.parse(typeof message === 'string' ? message : String(message));
    } catch {
      return;
    }
    if (!Array.isArray(frame)) return;
    const [type, id, action] = frame;
    if (outbound) {
      if (type === 2) {
        this.pending.set(id, { action, t0: performance.now(), sentAtMs: Date.now(), client });
      }
      return;
    }
    if (type !== 3 && type !== 4) return;
    const sent = this.pending.get(id);
    if (!sent) return; // trả lời đến sau khi ta đã tính là timeout
    this.pending.delete(id);
    this.#emit(id, sent, round2(performance.now() - sent.t0), type === 3 ? 'ok' : 'callerror');
  }

  #emit(id, sent, ms, outcome) {
    this.onRow({
      station: this.serial,
      id,
      action: sent.action,
      sentAt: iso(sent.sentAtMs),
      ms,
      outcome,
    });
  }

  /** CALL cũ nhất của `action` còn chờ trả lời bị bỏ: ghi một dòng không có thời gian. */
  #abandon(action, outcome) {
    for (const [id, sent] of this.pending) {
      if (sent.action !== action) continue;
      this.pending.delete(id);
      this.#emit(id, sent, null, outcome);
      return;
    }
  }

  #abandonAll(client, outcome) {
    for (const [id, sent] of this.pending) {
      if (sent.client !== client) continue;
      this.pending.delete(id);
      this.#emit(id, sent, null, outcome);
    }
  }

  // ---- kết nối --------------------------------------------------------------------------------

  async #connectOnce() {
    const client = new RPCClient({
      endpoint: this.endpoint,
      identity: this.serial,
      protocols: ['ocpp1.6'],
      strictMode: true,
      reconnect: false,
      callTimeoutMs: this.callTimeoutMs,
      ...(this.password ? { password: this.password } : {}),
    });
    client.on('message', (e) => this.#onMessage(client, e));
    // PowerMe gửi TriggerMessage(StatusNotification) c0/c1/c2 sau mỗi lần nối (T13 #18).
    client.handle('TriggerMessage', ({ params }) => {
      const { requestedMessage, connectorId } = params;
      if (requestedMessage !== 'StatusNotification') return { status: 'NotImplemented' };
      setImmediate(() => {
        const status = connectorId === 0 ? 'Available' : this.connectorStatus.get(connectorId);
        if (!status || this.client !== client) return;
        void this.#step('StatusNotification', {
          connectorId,
          status,
          errorCode: 'NoError',
          timestamp: iso(),
        });
      });
      return { status: 'Accepted' };
    });
    client.handle(({ method }) => {
      throw createRPCError('NotImplemented', `${method} không được hỗ trợ`);
    });
    client.on('close', () => {
      this.#abandonAll(client, 'disconnected');
      if (this.client !== client) return;
      this.client = null;
      if (!this.closing) this.stats.disconnects++;
    });
    await client.connect();
    this.client = client;
    this.stats.connects++;
    this.stats.connected = true;
  }

  /**
   * Nối, thử lại khi bị 429 (bộ giới hạn đăng nhập: quá nhiều trụ cùng bắt tay) hoặc lỗi mạng.
   * KHÔNG thử lại khi bị 401 / 403 / 404: mỗi lần 401 là một lần "sai mật khẩu" trong bộ đếm của
   * CSMS (5 lần mỗi trụ, 20 lần mỗi IP trong 60 s → khoá 15 phút), thử lại chỉ làm khoá cả IP.
   * Mỗi lần thất bại được ghi lại; hết số lần thử thì ném lỗi.
   */
  async connect() {
    let lastError = null;
    for (let attempt = 1; attempt <= this.connectRetries; attempt++) {
      try {
        await this.#connectOnce();
        return;
      } catch (err) {
        lastError = err;
        this.stats.connectFailures.push(
          `${err?.code ?? ''} ${String(err?.message ?? err)}`.trim().slice(0, 200),
        );
        if ([401, 403, 404].includes(err?.code)) break;
        await sleep(1000 * attempt);
      }
    }
    throw new Error(
      `${this.serial}: không nối được (${lastError?.code ?? ''} ${lastError?.message ?? lastError})`,
    );
  }

  async close() {
    this.closing = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const client = this.client;
    this.client = null;
    if (client) await client.close({ code: 1000, reason: 'nfr03 done' }).catch(() => {});
  }

  // ---- gửi bản tin ----------------------------------------------------------------------------

  /** Gửi một CALL; lỗi được đếm và trả `undefined` (trụ tải không dừng vì một bản tin hỏng). */
  async #step(action, params) {
    try {
      if (!this.client) {
        if (this.closing) return undefined;
        await this.connect(); // nối lại KHÔNG Boot, như trụ thật sau khi rớt mạng
      }
      return await this.client.call(action, params);
    } catch (err) {
      this.stats.stepErrors++;
      this.stats.firstError ??= `${action}: ${String(err?.message ?? err).slice(0, 200)}`;
      // CALLERROR đã được ghi từ frame về; CALL đứt giữa chừng được ghi khi socket đóng. Chỉ còn
      // timeout của ocpp-rpc là chưa có dòng nào.
      if (err?.constructor?.name === 'TimeoutError') this.#abandon(action, 'timeout');
      return undefined;
    }
  }

  #notify(connectorId, status) {
    this.connectorStatus.set(connectorId, status);
    return this.#step('StatusNotification', {
      connectorId,
      status,
      errorCode: 'NoError',
      timestamp: iso(),
    });
  }

  async #boot() {
    const res = await this.#step('BootNotification', {
      chargePointVendor: 'Ruihua',
      chargePointModel: 'D1-120',
      chargePointSerialNumber: this.serial,
      firmwareVersion: 'nfr03-load',
    });
    for (const [id, status] of this.connectorStatus) await this.#notify(id, status);
    const everyS = this.heartbeatS ?? res?.interval ?? 300;
    this.heartbeatTimer = setInterval(() => void this.#step('Heartbeat', {}), everyS * 1000);
    this.heartbeatTimer.unref();
    return everyS;
  }

  async #session(session, endMs) {
    const c = session.connector;
    const auth = await this.#step('Authorize', { idTag: this.idTag });
    if (auth?.idTagInfo?.status !== 'Accepted') {
      this.stats.authorizeNotAccepted++;
      return;
    }
    await this.#notify(c, 'Preparing');
    const startMs = Date.now();
    const start = await this.#step('StartTransaction', {
      connectorId: c,
      idTag: this.idTag,
      meterStart: this.registerWh,
      timestamp: iso(startMs),
    });
    if (typeof start?.transactionId !== 'number') {
      await this.#notify(c, 'Available');
      return;
    }
    this.stats.sessionsStarted++;
    const tx = start.transactionId;
    await this.#notify(c, 'Charging');
    for (const [i, wh] of session.whs.entries()) {
      const due = startMs + (i + 1) * this.meterIntervalMs;
      if (due > endMs) break; // hết thời gian đo: dừng phiên tử tế thay vì bỏ dở
      await sleepUntil(due);
      this.registerWh += wh;
      await this.#step('MeterValues', {
        connectorId: c,
        transactionId: tx,
        meterValue: [
          {
            timestamp: iso(),
            sampledValue: [
              {
                value: String(this.registerWh),
                measurand: 'Energy.Active.Import.Register',
                unit: 'Wh',
              },
              {
                value: String(Math.round((wh * 3_600_000) / this.meterIntervalMs)),
                measurand: 'Power.Active.Import',
                unit: 'W',
              },
            ],
          },
        ],
      });
    }
    await this.#notify(c, 'Finishing');
    const stop = await this.#step('StopTransaction', {
      transactionId: tx,
      idTag: this.idTag,
      meterStop: this.registerWh,
      timestamp: iso(),
      reason: 'Local',
    });
    if (stop) this.stats.sessionsStopped++;
    await this.#notify(c, 'Available');
  }

  /**
   * Chạy hồ sơ tải tới `endMs` (đồng hồ máy này) rồi đóng. Phiên đang chạy lúc hết giờ được dừng
   * bằng StopTransaction, nên không để lại phiên mở trên CSMS.
   * @returns `this.stats`, thêm `heartbeatS` trụ đã dùng
   */
  async run(endMs) {
    try {
      await this.connect();
      this.stats.heartbeatS = await this.#boot();
      while (Date.now() < endMs) {
        const session = this.plan.nextSession();
        const wakeMs = Date.now() + session.idleS * 1000;
        if (wakeMs >= endMs) {
          await sleepUntil(endMs);
          break;
        }
        await sleepUntil(wakeMs);
        await this.#session(session, endMs);
      }
    } catch (err) {
      this.stats.firstError ??= String(err?.message ?? err).slice(0, 200);
    } finally {
      await this.close();
    }
    return this.stats;
  }
}
