// ocpp-commands.mjs — các lệnh CSMS gửi XUỐNG trụ và cách trụ trả lời.
//
// LÀM GÌ: RemoteStart/Stop, TriggerMessage, Reset, ChangeAvailability, Get/ChangeConfiguration,
//   UnlockConnector, DataTransfer, SetChargingProfile / ClearChargingProfile (T150: TxDefaultProfile
//   và TxProfile). Lệnh khác → CALLERROR NotImplemented (ReserveNow... chưa làm).
// VÌ SAO TÁCH: là phần "trụ trả lời CSMS thế nào" — chỗ CSMS-side dev cần đọc; không dính tới
//   mạng hay điện. Trạng thái dùng chung đi qua đối tượng `s` do station.mjs truyền vào.
// GIẢ ĐỊNH: RemoteStart khi chưa cắm súng → Accepted rồi chờ ConnectionTimeOut (120 s) cho tới
//   khi cắm; hành vi thật của Ruihua chưa xác nhận.

import ocpp from 'ocpp-rpc';

const { createRPCError } = ocpp;

export function registerHandlers(c, s) {
  const {
    conns,
    CONFIG,
    cfgNum,
    profiles,
    tl,
    changed,
    emit,
    setStatus,
    startTx,
    stopTx,
    sendMeter,
    bootSequence,
    applyAvailability,
    scheduleHeartbeat,
    reboot,
    jStep,
  } = s;
  const connOf = (id) => conns.get(id);
  // Vì sao súng không nhận RemoteStart — chỉ để ghi vào hành trình phiên trên trang từng trụ.
  const busyWhy = (x) =>
    x.tx
      ? 'súng đang có phiên'
      : x.fault
        ? `súng đang lỗi ${x.fault}`
        : x.inoperative
          ? 'súng Unavailable'
          : x.status === 'Finishing'
            ? 'súng đang Finishing, chờ rút súng'
            : null;
  c.handle('RemoteStartTransaction', async ({ params }) => {
    const cand = params.connectorId ? [connOf(params.connectorId)] : [...conns.values()];
    const target = cand.find(
      (x) => x && !x.tx && !x.fault && !x.inoperative && x.status !== 'Finishing',
    );
    if (!target) {
      for (const x of cand)
        if (x)
          jStep(
            x,
            'remoteStart',
            { idTag: params.idTag, result: 'Rejected', why: busyWhy(x) },
            { close: !x.tx },
          );
      if (!cand.some(Boolean))
        tl('warn', `RemoteStart tới connector ${params.connectorId} không có`);
      return { status: 'Rejected' };
    }
    jStep(target, 'remoteStart', {
      idTag: params.idTag,
      result: 'Accepted',
      waitPlug: !target.plugged,
      timeoutSec: cfgNum('ConnectionTimeOut'),
    });
    if (target.plugged) setImmediate(() => startTx(target, params.idTag, 'remote').catch(() => {}));
    else {
      target.remoteWait = {
        idTag: params.idTag,
        until: Date.now() + cfgNum('ConnectionTimeOut') * 1000,
      };
      tl(
        'info',
        `RemoteStart súng ${target.id}: đang chờ cắm súng (${cfgNum('ConnectionTimeOut')} s)`,
      );
    }
    changed();
    return { status: 'Accepted' };
  });
  c.handle('RemoteStopTransaction', async ({ params }) => {
    const t = [...conns.values()].find((x) => x.tx && x.tx.id === params.transactionId);
    if (!t) {
      tl(
        'warn',
        `RemoteStop transactionId ${params.transactionId} không khớp phiên nào → Rejected`,
      );
      return { status: 'Rejected' };
    }
    jStep(t, 'remoteStop', { txId: params.transactionId, result: 'Accepted' });
    setImmediate(() => stopTx(t, 'Remote').catch(() => {}));
    return { status: 'Accepted' };
  });
  c.handle('TriggerMessage', async ({ params }) => {
    const { requestedMessage: m, connectorId } = params;
    if (!['BootNotification', 'Heartbeat', 'StatusNotification', 'MeterValues'].includes(m))
      return { status: 'NotImplemented' };
    setImmediate(async () => {
      try {
        if (m === 'Heartbeat') await emit('Heartbeat', {}, { buffer: false });
        if (m === 'BootNotification') await bootSequence();
        for (const k of conns.values()) {
          if (connectorId && connectorId !== k.id) continue;
          if (m === 'StatusNotification') await setStatus(k, k.status, k.errorCode);
          if (m === 'MeterValues' && k.tx) await sendMeter(k);
        }
      } catch {}
    });
    return { status: 'Accepted' };
  });
  c.handle('Reset', async ({ params }) => {
    setImmediate(() => reboot({ reason: params.type === 'Hard' ? 'HardReset' : 'SoftReset' }));
    return { status: 'Accepted' };
  });
  c.handle('ChangeAvailability', async ({ params }) => {
    const targets = params.connectorId === 0 ? [...conns.values()] : [connOf(params.connectorId)];
    if (targets.some((x) => !x)) return { status: 'Rejected' };
    let scheduled = false;
    for (const k of targets) {
      if (k.tx) {
        k.pendingAvail = params.type;
        scheduled = true;
      } else applyAvailability(k, params.type);
    }
    return { status: scheduled ? 'Scheduled' : 'Accepted' };
  });
  c.handle('GetConfiguration', async ({ params }) => {
    const want = params?.key?.length ? params.key : [...CONFIG.keys()];
    const configurationKey = [];
    const unknownKey = [];
    for (const k of want) {
      const v = CONFIG.get(k);
      if (v) configurationKey.push({ key: k, readonly: v.readonly, value: v.value });
      else unknownKey.push(k);
    }
    return unknownKey.length ? { configurationKey, unknownKey } : { configurationKey };
  });
  c.handle('ChangeConfiguration', async ({ params }) => {
    const v = CONFIG.get(params.key);
    if (!v) return { status: 'NotSupported' };
    if (v.readonly) return { status: 'Rejected' };
    if (v.numeric && !(Number.isInteger(Number(params.value)) && Number(params.value) > 0))
      return { status: 'Rejected' };
    if (v.bool && !['true', 'false'].includes(String(params.value).trim().toLowerCase()))
      return { status: 'Rejected' };
    v.value = params.value;
    if (params.key === 'HeartbeatInterval') scheduleHeartbeat();
    changed();
    return {
      status: v.numeric && params.key === 'WebSocketPingInterval' ? 'RebootRequired' : 'Accepted',
    };
  });
  // T150: chỉ TxDefaultProfile và TxProfile (ChargePointMaxProfile chưa mô phỏng → Rejected).
  c.handle('SetChargingProfile', async ({ params }) => {
    const p = params.csChargingProfiles;
    const id = params.connectorId;
    if (id !== 0 && !connOf(id)) return { status: 'Rejected' };
    if (p.chargingProfilePurpose === 'TxDefaultProfile') {
      profiles.txDefault.set(id, p);
      tl(
        'info',
        `TxDefaultProfile cho ${id === 0 ? 'cả trụ' : `súng ${id}`} (id ${p.chargingProfileId})`,
      );
      return { status: 'Accepted' };
    }
    if (p.chargingProfilePurpose === 'TxProfile') {
      const k = connOf(id);
      // OCPP 1.6: TxProfile chỉ hợp lệ khi súng đang có đúng phiên đó.
      if (!k?.tx || p.transactionId === undefined || k.tx.id !== p.transactionId)
        return { status: 'Rejected' };
      profiles.tx.set(id, p);
      tl('info', `TxProfile súng ${id} tx ${p.transactionId} ghi đè TxDefaultProfile`);
      changed();
      return { status: 'Accepted' };
    }
    return { status: 'Rejected' };
  });
  c.handle('ClearChargingProfile', async ({ params = {} }) => {
    let n = 0;
    for (const [purpose, map] of [
      ['TxDefaultProfile', profiles.txDefault],
      ['TxProfile', profiles.tx],
    ])
      for (const [cid, p] of map) {
        if (params.id !== undefined && p.chargingProfileId !== params.id) continue;
        if (params.connectorId !== undefined && params.connectorId !== cid) continue;
        if (params.chargingProfilePurpose && params.chargingProfilePurpose !== purpose) continue;
        if (params.stackLevel !== undefined && params.stackLevel !== p.stackLevel) continue;
        map.delete(cid);
        n++;
      }
    return { status: n ? 'Accepted' : 'Unknown' };
  });
  c.handle('UnlockConnector', async ({ params }) => {
    const k = connOf(params.connectorId);
    if (!k) return { status: 'NotSupported' };
    if (k.tx) setImmediate(() => stopTx(k, 'UnlockCommand').catch(() => {}));
    return { status: 'Unlocked' };
  });
  c.handle('DataTransfer', async () => ({ status: 'Accepted' }));
  c.handle(({ method }) => {
    throw createRPCError('NotImplemented', `${method} không được hỗ trợ`);
  });
}
