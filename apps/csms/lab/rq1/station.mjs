/**
 * Trụ thí nghiệm RQ1 — trụ giả OCPP 1.6J có SỰ THẬT NỀN (bộ đếm năng lượng nội bộ = `E_true`).
 *
 * Vì sao tồn tại: NFR-02 đo `E_bill` của hệ thống so với năng lượng trụ THẬT SỰ đã cấp, thứ mà
 * CSMS không thấy. `demo/scripted-station.mjs` chạy đúng các ca này (ds-03a/b/d) nhưng là một
 * script CLI với trạng thái toàn cục, số Wh cố định và không ghi sự thật nền; ở đây cùng cách nói
 * giao thức được đóng thành lớp để chạy song song nhiều trụ, mỗi trụ một kế hoạch có seed
 * (plan.mjs). File demo được GIỮ NGUYÊN để không đụng các kịch bản đã kiểm trước Review.
 *
 * Trụ này KHÔNG phải firmware Ruihua và không thay SAP simulator: nó gây lỗi CÓ CHỦ Ý (đứt kết
 * nối, phát lại `meterStop` cũ, gửi lại bản tin y nguyên) theo các hiện tượng đã quan sát ở EXP-01.
 *
 * Dùng được với mọi CSMS OCPP 1.6J (PowerMe, SteVe): chỉ khác `endpoint`.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RPCClient, createRPCError } = require('ocpp-rpc');

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class LabStation {
  /**
   * @param opts.endpoint  URL gốc WebSocket, KHÔNG kèm identity (vd ws://127.0.0.1:9190/ocpp)
   * @param opts.identity  chargeBoxId / serial của trụ
   * @param opts.password  mật khẩu Basic Auth (tuỳ chọn)
   * @param opts.meterStartWh  số chỉ bộ đếm luỹ kế lúc bắt đầu
   * @param opts.onFrame   callback nhận mỗi bản tin trụ gửi (để ghi trace)
   */
  constructor({
    endpoint,
    identity,
    password,
    meterStartWh = 0,
    connector = 1,
    sleep = realSleep,
    onFrame = () => {},
    callTimeoutMs = 20_000,
  }) {
    this.endpoint = endpoint;
    this.identity = identity;
    this.password = password;
    this.connector = connector;
    this.sleep = sleep;
    this.onFrame = onFrame;
    this.callTimeoutMs = callTimeoutMs;
    this.client = null;
    this.connectorStatus = new Map([
      [1, 'Available'],
      [2, 'Available'],
    ]);
    /** Bộ đếm năng lượng luỹ kế (Wh, số nguyên) — sự thật nền, chỉ trụ biết. */
    this.registerWh = meterStartWh;
    this.meterStartWh = meterStartWh;
    /** Mẫu đã đo nhưng chưa gửi được (đang offline). */
    this.queue = [];
    /** Mốc thời gian (ms) của các mẫu năng lượng CSMS thật sự đã được gửi — để tính khe hở thật. */
    this.deliveredSampleMs = [];
    this.connects = 0;
    this.drops = 0;
    /** Mốc (ms) của nhịp đo gần nhất: đồng hồ đo chạy đều, không phụ thuộc việc nối lại. */
    this.lastTickMs = Date.now();
  }

  /** Đặt lại mốc nhịp đo (gọi lúc phiên bắt đầu). */
  startMetering(ms = Date.now()) {
    this.lastTickMs = ms;
  }

  /** Chờ tới nhịp đo kế tiếp (mốc nhịp trước + interval); đã quá hạn thì không chờ. */
  async waitNextTick(intervalMs) {
    await this.sleep(Math.max(0, this.lastTickMs + intervalMs - Date.now()));
  }

  get online() {
    return this.client !== null;
  }

  async connect({ boot }) {
    const client = new RPCClient({
      endpoint: this.endpoint,
      identity: this.identity,
      protocols: ['ocpp1.6'],
      strictMode: true,
      reconnect: false,
      callTimeoutMs: this.callTimeoutMs,
      ...(this.password ? { password: this.password } : {}),
    });
    // PowerMe gửi TriggerMessage(StatusNotification) c0/c1/c2 sau mỗi lần nối (T13 #18): trả lời
    // bằng trạng thái hiện tại của súng. SteVe không gửi; handler này khi đó không được gọi.
    client.handle('TriggerMessage', ({ params }) => {
      const { requestedMessage, connectorId } = params;
      if (requestedMessage !== 'StatusNotification') return { status: 'NotImplemented' };
      setImmediate(() => {
        const status = connectorId === 0 ? 'Available' : this.connectorStatus.get(connectorId);
        if (!status || this.client !== client) return;
        this.#call('StatusNotification', {
          connectorId,
          status,
          errorCode: 'NoError',
          timestamp: iso(),
        }).catch(() => {});
      });
      return { status: 'Accepted' };
    });
    client.handle(({ method }) => {
      throw createRPCError('NotImplemented', `${method} không được hỗ trợ`);
    });
    await client.connect();
    this.client = client;
    this.connects++;
    if (boot) {
      await this.#call('BootNotification', {
        chargePointVendor: 'Ruihua',
        chargePointModel: 'D1-120',
        chargePointSerialNumber: this.identity.slice(0, 25),
        firmwareVersion: 'rq1-lab',
      });
      for (const [id, status] of this.connectorStatus) await this.notify(id, status);
    }
  }

  /** Ngắt đột ngột (không close frame) — CSMS thấy mã 1006, giống rút cáp mạng. */
  async drop() {
    const client = this.client;
    this.client = null;
    this.drops++;
    if (client) await client.close({ force: true }).catch(() => {});
  }

  /** Đóng tử tế khi lần chạy xong. */
  async close() {
    const client = this.client;
    this.client = null;
    if (client) await client.close({ code: 1000, reason: 'rq1 run done' }).catch(() => {});
  }

  async #call(action, params) {
    if (!this.client) throw new Error(`${action}: trụ đang offline`);
    this.onFrame({ at: iso(), action, params });
    return this.client.call(action, params);
  }

  async notify(connectorId, status) {
    this.connectorStatus.set(connectorId, status);
    if (!this.client) return; // offline: chỉ đổi trạng thái nội bộ
    await this.#call('StatusNotification', {
      connectorId,
      status,
      errorCode: 'NoError',
      timestamp: iso(),
    });
  }

  async authorize(idTag) {
    const res = await this.#call('Authorize', { idTag });
    return res.idTagInfo.status;
  }

  /** Gửi StartTransaction với tham số cho sẵn (gửi lại y nguyên = gọi lại với cùng đối tượng). */
  async sendStart(params) {
    const res = await this.#call('StartTransaction', params);
    return { transactionId: res.transactionId, idTagStatus: res.idTagInfo?.status ?? null };
  }

  async sendStop(params) {
    await this.#call('StopTransaction', params);
  }

  /** Xe nhận thêm `wh` trong một nhịp: bộ đếm tăng, trả mẫu {wh, ms} vừa đo. */
  tick(wh) {
    this.registerWh += wh;
    this.lastTickMs = Date.now();
    return { wh: this.registerWh, ms: this.lastTickMs };
  }

  async sendSample(transactionId, sample) {
    await this.#call('MeterValues', {
      connectorId: this.connector,
      transactionId,
      meterValue: [
        {
          timestamp: iso(sample.ms),
          sampledValue: [
            {
              value: String(sample.wh),
              measurand: 'Energy.Active.Import.Register',
              unit: 'Wh',
            },
          ],
        },
      ],
    });
    this.deliveredSampleMs.push(sample.ms);
  }

  /** Phát bù hàng đợi theo thứ tự đo, giữ nguyên cp_timestamp gốc. */
  async flushQueue(transactionId) {
    const queued = this.queue;
    this.queue = [];
    for (const sample of queued) await this.sendSample(transactionId, sample);
    return queued.length;
  }
}

/**
 * Khe hở lớn nhất (giây) trong chuỗi mẫu trụ ĐÃ GIAO, tính cả mốc bắt đầu và mốc dừng — cùng các
 * điểm mà `evaluateSeries` của CSMS xét. Đây là sự thật nền cho precision/recall của `meter_gap`.
 */
export function maxDeliveredGapS(startMs, sampleMs, stopMs) {
  const points = [startMs, ...[...sampleMs].sort((a, b) => a - b)];
  const last = points[points.length - 1];
  if (stopMs !== null && stopMs !== undefined && stopMs > last) points.push(stopMs);
  let max = 0;
  for (let i = 1; i < points.length; i++) max = Math.max(max, points[i] - points[i - 1]);
  return max / 1000;
}
