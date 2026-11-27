// hmi-actions.mjs — hành động người dùng bấm trên HMI: cắm/rút súng, quẹt thẻ, mật khẩu,
//   chế độ sạc, dừng, gây/xoá lỗi, tốc độ mô phỏng (×1/×10/×20), đưa đồng hồ về giờ thật.
//   Mỗi hàm trả { ok, message }.
// VÌ SAO TÁCH: station.mjs giữ mạng + phiên + điện; file này chỉ là "bàn phím" của trụ.
// GIẢ ĐỊNH: free vend (mật khẩu HMI) gửi thẳng StartTransaction idTag "HMI-FREEVEND", không
//   Authorize; offline chấp nhận hai thẻ hợp lệ theo danh sách cục bộ; pin đầy/lỗi → "Other".

import { CARDS, ERROR_CODES, FREE_VEND_TAG } from './model.mjs';
import { isReaderFrame, READER_MASK } from './rfid-reader.mjs';

export const fail = (message) => ({ ok: false, message });
export const done = (message = 'ok') => ({ ok: true, message });

export function makeHmiActions(s) {
  const {
    conns,
    opt,
    net,
    emit,
    setStatus,
    idleStatus,
    startTx,
    stopTx,
    tl,
    changed,
    jStep,
    offlineAccepts,
  } = s;
  const conn = (a) => conns.get(Number(a?.connector));
  const authorize = (idTag) => emit('Authorize', { idTag }, { buffer: false });
  const readerFail = (code, message) => ({ ok: false, code, message });
  const readerOnline = () =>
    net.state === 'online' && net.booted && !net.halfOpen && !(net.downUntil > Date.now());
  const readerReady = (c) =>
    c.plugged &&
    !c.tx &&
    !c.fault &&
    !c.inoperative &&
    c.errorCode === 'NoError' &&
    c.status === 'Preparing' &&
    !c.remoteWait;
  // Hành trình phiên (QA-03): bước Authorize của đầu đọc; idTag bị che trong station (jAdd).
  const readerStep = (c, status, close) =>
    jStep(c, 'authorize', { idTag: READER_MASK, status, reader: true }, { close });
  return {
    async swipeReader(a) {
      if (
        !a ||
        typeof a !== 'object' ||
        Array.isArray(a) ||
        Object.keys(a).length !== 2 ||
        !Object.hasOwn(a, 'connector') ||
        !Object.hasOwn(a, 'idTag') ||
        !Number.isInteger(a.connector) ||
        !isReaderFrame(a.idTag)
      )
        return readerFail(
          'invalid',
          'Đầu đọc cần đúng 10 chữ số và súng được chọn. Quẹt lại trong ô đầu đọc.',
        );
      const c = conns.get(a.connector);
      if (!c) return readerFail('invalid', 'Súng không tồn tại');
      if (c.readerPending) return readerFail('busy', 'Đang chờ CSMS cho súng này. Không quẹt lại.');
      if (!readerOnline())
        return readerFail('network', 'Đầu đọc USB cần kết nối CSMS online. Chưa gửi Authorize.');
      if (!readerReady(c))
        return readerFail('state', 'Cắm súng, xoá lỗi và chờ Preparing trước khi quẹt.');
      const generation = c.readerGeneration,
        epoch = net.epoch;
      c.readerPending = true;
      changed();
      try {
        let response;
        try {
          response = await authorize(a.idTag);
        } catch {
          readerStep(c, null, true);
          return readerFail(
            'network',
            'Chưa nhận được kết quả Authorize từ CSMS. Chưa gửi StartTransaction; kiểm tra mạng rồi quẹt lại.',
          );
        }
        const status = response?.idTagInfo?.status;
        readerStep(c, status ?? null, status !== 'Accepted');
        if (['Invalid', 'Blocked', 'Expired', 'ConcurrentTx'].includes(status))
          return readerFail(
            'rejected',
            'CSMS từ chối thẻ: ' + status + '. Liên hệ Admin kiểm tra đăng ký thẻ.',
          );
        if (status !== 'Accepted')
          return readerFail(
            'network',
            'Chưa xác nhận được Authorize. Chưa gửi StartTransaction; kiểm tra kết nối CSMS.',
          );
        if (
          !readerOnline() ||
          net.epoch !== epoch ||
          !readerReady(c) ||
          c.readerGeneration !== generation
        ) {
          jStep(c, 'readerStale', {}, { close: true });
          return readerFail(
            'stale',
            'Súng hoặc kết nối đã thay đổi trong lúc chờ. Chưa gửi StartTransaction; kiểm tra súng rồi quẹt lại.',
          );
        }
        let confirmed;
        try {
          confirmed = await startTx(c, a.idTag, 'rfid');
        } catch {
          return readerFail(
            'awaiting',
            'Đã yêu cầu bắt đầu; kết quả chưa xác định. Xem trạng thái súng/CSMS, không quẹt lại.',
          );
        }
        if (!confirmed || !c.tx || c.tx.id == null || !readerOnline())
          return readerFail(
            'awaiting',
            'Đã yêu cầu bắt đầu; chờ xác nhận CSMS. Xem trạng thái súng, không quẹt lại.',
          );
        return { ok: true, code: 'started', message: 'CSMS đã chấp nhận và xác nhận phiên sạc.' };
      } finally {
        c.readerPending = false;
        changed();
      }
    },
    async plug(a) {
      const c = conn(a);
      if (!c) return fail('Súng không tồn tại');
      if (c.plugged) return fail('Súng đã cắm');
      if (c.fault) return fail('Súng đang lỗi — xoá lỗi trước');
      if (c.inoperative) return fail('Súng đang ngừng hoạt động (Unavailable)');
      c.readerGeneration++;
      c.plugged = true;
      c.vehicleSoc = 20 + Math.random() * 40;
      await setStatus(c, 'Preparing');
      if (c.remoteWait) await startTx(c, c.remoteWait.idTag, 'remote');
      return done('Đã cắm súng');
    },
    async unplug(a) {
      const c = conn(a);
      if (!c?.plugged) return fail('Súng chưa cắm');
      c.readerGeneration++;
      if (c.tx) await stopTx(c, 'EVDisconnected');
      c.plugged = false;
      c.vehicleSoc = null;
      c.remoteWait = null;
      await setStatus(c, idleStatus(c), c.fault ?? 'NoError');
      return done('Đã rút súng');
    },
    async swipe(a) {
      const c = conn(a);
      const idTag = CARDS[a.card] ?? null;
      if (!c || !idTag) return fail('Thẻ/súng không hợp lệ');
      if (!c.plugged) return fail('Hãy cắm súng trước khi quẹt thẻ');
      if (c.tx || c.status !== 'Preparing') return fail(`Súng đang ${c.status}`);
      let accepted;
      if (net.state === 'online') {
        const r = await authorize(idTag).catch(() => null);
        accepted = r?.idTagInfo?.status === 'Accepted';
        const status = r?.idTagInfo?.status ?? null;
        jStep(c, 'authorize', { idTag, status }, { close: !accepted });
        if (!accepted) return fail(`CSMS từ chối thẻ: ${status ?? 'lỗi gửi Authorize'}`);
      } else {
        // Offline: danh sách cục bộ (giả định) + cấu hình authorize offline mà CSMS có thể đã tắt (T150).
        const listed = a.card !== 'unknown';
        accepted = offlineAccepts(listed);
        jStep(c, 'authorize', { idTag, offline: true, local: accepted }, { close: !accepted });
        if (!accepted)
          return fail(
            listed
              ? 'Offline: CSMS đã tắt authorize offline (LocalAuthorizeOffline=false), không sạc khi mất mạng'
              : 'Offline: thẻ không có trong danh sách cục bộ',
          );
        tl(
          'info',
          listed
            ? `Offline — chấp nhận thẻ ${idTag} theo danh sách cục bộ`
            : `Offline — trụ nhận thẻ lạ ${idTag} (AllowOfflineTxForUnknownId), rủi ro BR-P52`,
        );
      }
      await startTx(c, idTag, 'rfid');
      return done('Thẻ được chấp nhận — bắt đầu sạc');
    },
    async password(a) {
      const c = conn(a);
      if (!c) return fail('Súng không tồn tại');
      if (a.password !== opt.password) return fail('Sai mật khẩu');
      if (!c.plugged || c.tx || c.status !== 'Preparing')
        return fail('Cắm súng và để ở trạng thái Preparing');
      await startTx(c, FREE_VEND_TAG, 'password');
      return done('Mật khẩu đúng — bắt đầu sạc');
    },
    async mode(a) {
      const c = conn(a);
      if (!c) return fail('Súng không tồn tại');
      if (c.tx) return fail('Không đổi chế độ khi đang sạc');
      const type = a.type;
      const value = Number(a.value);
      if (!['full', 'time', 'kwh', 'money'].includes(type)) return fail('Chế độ không hợp lệ');
      if (type !== 'full' && !(value > 0)) return fail('Giá trị phải > 0');
      c.readerGeneration++;
      c.mode = { type, value: type === 'full' ? null : value };
      changed();
      return done('Đã chọn chế độ');
    },
    async stop(a) {
      const c = conn(a);
      if (!c?.tx) return fail('Súng không có phiên');
      await stopTx(c, 'Local');
      return done('Đã dừng sạc');
    },
    async fault(a) {
      const c = conn(a);
      if (!c) return fail('Súng không tồn tại');
      if (!ERROR_CODES.includes(a.errorCode)) return fail('errorCode không hợp lệ');
      c.readerGeneration++;
      c.fault = a.errorCode;
      if (c.tx) await stopTx(c, 'Other');
      await setStatus(c, 'Faulted', a.errorCode);
      return done('Đã gây lỗi');
    },
    async clearfault(a) {
      const c = conn(a);
      if (!c?.fault) return fail('Súng không lỗi');
      c.fault = null;
      await setStatus(c, idleStatus(c));
      return done('Đã xoá lỗi');
    },
    // Tốc độ đồng hồ mô phỏng của RIÊNG trụ này (QA-03): ×1, ×10, ×20.
    async speed(a) {
      const v = Number(a.value);
      if (![1, 10, 20].includes(v)) return fail('Chỉ hỗ trợ ×1, ×10 hoặc ×20');
      opt.speed = v;
      tl('info', `Tốc độ mô phỏng ×${v}`);
      return done(`Tốc độ ×${v}`);
    },
    // Đưa đồng hồ mô phỏng về giờ thật (sau khi chạy ×10/×20 đồng hồ trụ đi trước giờ thật).
    // Chỉ khi không súng nào đang sạc, để timestamp trong một phiên không nhảy lùi.
    async syncclock() {
      if ([...conns.values()].some((c) => c.tx))
        return fail('Đang có phiên — dừng phiên rồi mới chỉnh đồng hồ');
      s.syncClock();
      tl('info', 'Đồng hồ trụ đã đưa về giờ thật');
      return done('Đã đưa đồng hồ trụ về giờ thật');
    },
  };
}
