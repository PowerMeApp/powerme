// hmi-actions.mjs — hành động người dùng bấm trên HMI: cắm/rút súng, quẹt thẻ, mật khẩu,
//   chế độ sạc, dừng, gây/xoá lỗi, tốc độ mô phỏng. Mỗi hàm trả { ok, message }.
// VÌ SAO TÁCH: station.mjs giữ mạng + phiên + điện; file này chỉ là "bàn phím" của trụ.
// GIẢ ĐỊNH: free vend (mật khẩu HMI) gửi thẳng StartTransaction idTag "HMI-FREEVEND", không
//   Authorize; offline chấp nhận thẻ hợp lệ + thẻ ví theo danh sách cục bộ; pin đầy/lỗi → "Other".

import { CARDS, ERROR_CODES, FREE_VEND_TAG } from './model.mjs';

export const fail = (message) => ({ ok: false, message });
export const done = (message = 'ok') => ({ ok: true, message });

export function makeHmiActions(s) {
  const { conns, opt, net, emit, setStatus, idleStatus, startTx, stopTx, tl, changed } = s;
  const conn = (a) => conns.get(Number(a?.connector));
  return {
    async plug(a) {
      const c = conn(a);
      if (!c) return fail('Súng không tồn tại');
      if (c.plugged) return fail('Súng đã cắm');
      if (c.fault) return fail('Súng đang lỗi — xoá lỗi trước');
      if (c.inoperative) return fail('Súng đang ngừng hoạt động (Unavailable)');
      c.plugged = true;
      c.vehicleSoc = 20 + Math.random() * 40;
      await setStatus(c, 'Preparing');
      if (c.remoteWait) await startTx(c, c.remoteWait.idTag, 'remote');
      return done('Đã cắm súng');
    },
    async unplug(a) {
      const c = conn(a);
      if (!c?.plugged) return fail('Súng chưa cắm');
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
        const r = await emit('Authorize', { idTag }, { buffer: false }).catch(() => null);
        accepted = r?.idTagInfo?.status === 'Accepted';
        if (!accepted)
          return fail(`CSMS từ chối thẻ: ${r?.idTagInfo?.status ?? 'lỗi gửi Authorize'}`);
      } else {
        accepted = a.card !== 'unknown'; // offline: danh sách cục bộ (giả định)
        if (!accepted) return fail('Offline: thẻ không có trong danh sách cục bộ');
        tl('info', `Offline — chấp nhận thẻ ${idTag} theo danh sách cục bộ`);
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
    async speed(a) {
      const s = Number(a.value);
      if (![1, 10].includes(s)) return fail('Chỉ hỗ trợ ×1 hoặc ×10');
      opt.speed = s;
      changed();
      return done(`Tốc độ ×${s}`);
    },
  };
}
