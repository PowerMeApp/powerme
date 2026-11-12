/**
 * Ba kịch bản đứt kết nối của RQ1, chạy trên một `LabStation` theo kế hoạch có seed (plan.mjs).
 *
 * Tiêu đề ba kịch bản là của phiếu đăng ký v1.3 §RQ1; phần chi tiết (lỗi nào được gây ra, thứ tự
 * bản tin sau khi nối lại) bám các ca đã kiểm ở docs/DEMO-REVIEW-2.md (DS-03a/b/d) và EXP-01, và
 * là ĐỀ XUẤT chờ Ân duyệt:
 *
 *   S1  đứt giữa chuỗi MeterValues, dài hơn ân hạn → nối lại KHÔNG Boot → (phát bù hàng đợi hoặc
 *       làm mất hàng đợi) → sạc tiếp → dừng bình thường. Dữ liệu trụ ĐÚNG.
 *   S2  đứt ngay trước StopTransaction: xe sạc thêm vài nhịp rồi dừng khi trụ còn offline → nối
 *       lại → StopTransaction phát lại mang `meterStop` CŨ (số lúc đứt) → MeterValues phát bù đến
 *       sau (thứ tự của EXP-01). Dữ liệu trụ SAI.
 *   S3  phiên bắt đầu khi trụ offline → nối lại, gửi StartTransaction (mốc thời gian cũ) → mất phản
 *       hồi → gửi lại Y NGUYÊN → phát bù MeterValues → sạc tiếp → dừng bình thường → (nửa số lần)
 *       gửi lại StopTransaction y nguyên. Dữ liệu trụ ĐÚNG; rủi ro là ghi trùng.
 *
 * Mỗi hàm trả về SỰ THẬT NỀN của lần chạy; không đọc gì từ CSMS ngoài `transactionId`.
 */
import { maxDeliveredGapS } from './station.mjs';

const iso = (ms) => new Date(ms).toISOString();

/** Sạc `whs.length` nhịp khi đang online: mỗi nhịp chờ, cộng bộ đếm, gửi mẫu live. */
async function chargeOnline(station, tx, whs, intervalMs) {
  for (const wh of whs) {
    await station.waitNextTick(intervalMs);
    await station.sendSample(tx, station.tick(wh));
  }
}

/** Sạc khi offline: mẫu vào hàng đợi với mốc thời gian lúc đo. */
async function chargeOffline(station, whs, intervalMs) {
  for (const wh of whs) {
    await station.waitNextTick(intervalMs);
    station.queue.push(station.tick(wh));
  }
}

async function runS1(station, plan, idTag) {
  const intervalMs = plan.intervalS * 1000;
  await station.connect({ boot: true });
  await station.authorize(idTag);
  await station.notify(station.connector, 'Preparing');
  const startMs = Date.now();
  const start = {
    connectorId: station.connector,
    idTag,
    meterStart: plan.meterStartWh,
    timestamp: iso(startMs),
  };
  station.startMetering(startMs);
  const { transactionId: tx } = await station.sendStart(start);
  await station.notify(station.connector, 'Charging');
  await chargeOnline(station, tx, plan.preWh, intervalMs);

  const dropMs = Date.now();
  await station.drop();
  await chargeOffline(station, plan.offlineWh, intervalMs);
  await station.sleep(Math.max(0, dropMs + plan.offlineS * 1000 - Date.now()));
  await station.connect({ boot: false });
  const offlineActualS = (Date.now() - dropMs) / 1000;

  const queued = station.queue.length;
  if (plan.queueDelivered) await station.flushQueue(tx);
  else station.queue = []; // mất mẫu im lặng (EXP-01 hiện tượng 4)

  await chargeOnline(station, tx, plan.postWh, intervalMs);
  await station.notify(station.connector, 'Finishing');
  station.tick(plan.tailWh);
  const stopMs = Date.now();
  const meterStop = station.registerWh;
  await station.sendStop({
    transactionId: tx,
    idTag,
    meterStop,
    timestamp: iso(stopMs),
    reason: 'Local',
  });
  await station.notify(station.connector, 'Available');
  return {
    transactionIds: [tx],
    startMs,
    stopMs,
    meterStopSentWh: meterStop,
    injectedFault: {
      kind: 'disconnect_mid_meter_values',
      offline_s: Number(offlineActualS.toFixed(1)),
      queued_samples: queued,
      queue_delivered: plan.queueDelivered,
      boot_on_reconnect: false,
    },
  };
}

async function runS2(station, plan, idTag) {
  const intervalMs = plan.intervalS * 1000;
  await station.connect({ boot: true });
  await station.authorize(idTag);
  await station.notify(station.connector, 'Preparing');
  const startMs = Date.now();
  station.startMetering(startMs);
  const { transactionId: tx } = await station.sendStart({
    connectorId: station.connector,
    idTag,
    meterStart: plan.meterStartWh,
    timestamp: iso(startMs),
  });
  await station.notify(station.connector, 'Charging');
  await chargeOnline(station, tx, plan.preWh, intervalMs);

  const registerAtDropWh = station.registerWh; // số sẽ "đóng băng" vào meterStop
  const dropMs = Date.now();
  await station.drop();
  await chargeOffline(station, plan.offlineWh, intervalMs);
  station.tick(plan.tailWh);
  const stopMs = Date.now(); // tài xế dừng sạc khi trụ còn offline
  await station.notify(station.connector, 'Finishing');
  await station.sleep(Math.max(0, dropMs + plan.offlineS * 1000 - Date.now()));
  await station.connect({ boot: false });
  const offlineActualS = (Date.now() - dropMs) / 1000;

  // Thứ tự của EXP-01: StopTransaction phát lại đến TRƯỚC các MeterValues phát bù.
  const meterStop = plan.staleMeterStop ? registerAtDropWh : station.registerWh;
  await station.sendStop({
    transactionId: tx,
    idTag,
    meterStop,
    timestamp: iso(stopMs),
    reason: 'Local',
  });
  const queued = station.queue.length;
  if (plan.queueDelivered) await station.flushQueue(tx);
  else station.queue = []; // biến thể thăm dò --s2-queue-lost-p: hàng đợi mất hẳn
  await station.notify(station.connector, 'Available');
  return {
    transactionIds: [tx],
    startMs,
    stopMs,
    meterStopSentWh: meterStop,
    injectedFault: {
      kind: 'disconnect_before_stop_transaction',
      offline_s: Number(offlineActualS.toFixed(1)),
      stale_meter_stop: plan.staleMeterStop,
      stale_by_wh: station.registerWh - meterStop,
      queued_samples: queued,
      queue_delivered: plan.queueDelivered,
      stop_before_queue: true,
      boot_on_reconnect: false,
    },
  };
}

async function runS3(station, plan, idTag) {
  const intervalMs = plan.intervalS * 1000;
  await station.connect({ boot: true });
  const dropMs = Date.now();
  await station.drop();

  // Phiên bắt đầu khi offline: trụ chấp nhận thẻ cục bộ, StartTransaction nằm trong hàng đợi.
  await station.notify(station.connector, 'Preparing');
  const startMs = Date.now();
  station.startMetering(startMs);
  const start = {
    connectorId: station.connector,
    idTag,
    meterStart: plan.meterStartWh,
    timestamp: iso(startMs),
  };
  await station.notify(station.connector, 'Charging');
  await chargeOffline(station, plan.offlineWh, intervalMs);
  await station.sleep(Math.max(0, dropMs + plan.offlineS * 1000 - Date.now()));
  await station.connect({ boot: false });
  const offlineActualS = (Date.now() - dropMs) / 1000;

  const first = await station.sendStart(start);
  const transactionIds = [first.transactionId];
  let tx = first.transactionId;
  if (plan.resendStart) {
    // CSMS đã ghi phiên nhưng trụ "không nhận được" CALLRESULT: đứt, nối lại, gửi lại y nguyên.
    await station.drop();
    await station.sleep(plan.retransmitGapS * 1000);
    await station.connect({ boot: false });
    const second = await station.sendStart(start);
    transactionIds.push(second.transactionId);
    tx = second.transactionId; // trụ thật dùng id của phản hồi nó nhận được
  }
  const queued = await station.flushQueue(tx);
  await station.notify(station.connector, 'Charging');
  await chargeOnline(station, tx, plan.postWh, intervalMs);
  await station.notify(station.connector, 'Finishing');
  station.tick(plan.tailWh);
  const stopMs = Date.now();
  const meterStop = station.registerWh;
  const stop = { transactionId: tx, idTag, meterStop, timestamp: iso(stopMs), reason: 'Local' };
  await station.sendStop(stop);
  if (plan.resendStop) {
    await station.drop();
    await station.sleep(plan.retransmitGapS * 1000);
    await station.connect({ boot: false });
    await station.sendStop(stop);
  }
  await station.notify(station.connector, 'Available');
  return {
    transactionIds,
    startMs,
    stopMs,
    meterStopSentWh: meterStop,
    injectedFault: {
      kind: 'offline_started_session_with_retransmission',
      offline_s: Number(offlineActualS.toFixed(1)),
      queued_samples: queued,
      queue_delivered: true,
      resend_start: plan.resendStart,
      resend_stop: plan.resendStop,
      start_ids_equal: transactionIds.every((id) => id === transactionIds[0]),
      boot_on_reconnect: false,
    },
  };
}

const RUNNERS = { s1: runS1, s2: runS2, s3: runS3 };

/**
 * Chạy một kịch bản và trả sự thật nền. Không ném lỗi: lỗi của trụ nằm ở trường `error`, kèm
 * những gì đã biết tới lúc đó (để dòng dữ liệu vẫn được ghi và lần chạy không biến mất).
 */
export async function runScenario(station, plan, idTag) {
  const startedAt = Date.now();
  let out = null;
  let error = null;
  try {
    out = await RUNNERS[plan.scenario](station, plan, idTag);
  } catch (err) {
    error = String(err?.message ?? err);
  } finally {
    await station.close();
  }
  const eTrueWh = station.registerWh - station.meterStartWh;
  const truth = {
    scenario: plan.scenario,
    runIndex: plan.runIndex,
    eTrueWh,
    eStopWh: out ? out.meterStopSentWh - station.meterStartWh : null,
    meterStartWh: station.meterStartWh,
    meterStopTrueWh: station.registerWh,
    meterStopSentWh: out?.meterStopSentWh ?? null,
    transactionIds: out?.transactionIds ?? [],
    injectedFault: out?.injectedFault ?? { kind: 'incomplete' },
    maxDeliveredGapS: out
      ? Number(maxDeliveredGapS(out.startMs, station.deliveredSampleMs, out.stopMs).toFixed(3))
      : null,
    deliveredSamples: station.deliveredSampleMs.length,
    connects: station.connects,
    drops: station.drops,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationS: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    error,
  };
  return truth;
}
