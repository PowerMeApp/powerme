// Overlay.jsx — lớp chữ HTML quanh canvas: nhãn súng A/B, mạng + hàng đợi, gợi ý thao tác.
//
// QA-06: viên nhãn là capsule nổi (trắng mờ + blur ở cảnh sáng, Charcoal mờ ở cảnh tối — tru3d.css);
// màu trạng thái chỉ ở chấm và thanh SoC, chữ luôn Ink/Gray để đọc rõ.
// Chỉ animate transform/opacity (CSS trong tru3d.css). Số liệu dùng tabular-nums.
import { useSyncExternalStore } from 'react';
import { VI, knownStatus } from './motion.js';

const SOURCE = { remote: 'Từ app', rfid: 'Thẻ RFID', password: 'Mật khẩu HMI' };
const READER_MASK = '[reader identifier]';

function note(c) {
  if (c.remoteWaitSec != null) return `Lệnh từ app đã tới trụ · chờ cắm súng ${c.remoteWaitSec} s`;
  if (c.readerPending) return 'Đầu đọc RFID · đang chờ CSMS';
  if (c.status === 'Faulted') return `Mã lỗi ${c.errorCode}`;
  if (c.status === 'Finishing') return `Phiên xong · ${c.kwh.toFixed(2)} kWh · rút súng`;
  if (c.status === 'Preparing') return c.plugged ? 'Đã cắm súng · chờ lệnh / thẻ' : 'Chờ cắm súng';
  if (c.status === 'Available') return c.plugged ? 'Đã cắm súng' : 'Quẹt thẻ hoặc quét QR';
  return null;
}

function Metric({ v, u }) {
  return (
    <span className="t3-m">
      <span className="t3-v">{v}</span>
      <span className="t3-u">{u}</span>
    </span>
  );
}

function GunPill({ c, side }) {
  const st = knownStatus(c.status);
  const src =
    c.txActive && c.source
      ? c.source === 'rfid' && c.idTag === READER_MASK
        ? 'Đầu đọc RFID'
        : SOURCE[c.source]
      : null;
  const metrics = c.txActive || st === 'Charging';
  const n = note(c);
  return (
    <div className={`t3-pill t3-${side}`} style={{ '--c': `var(--lt-${st})` }}>
      <div className="t3-core" key={st}>
        <div className="t3-row">
          <span className={`t3-dot t3-dot-${st}`} aria-hidden="true" />
          <b>Súng {c.label}</b>
          <span className="t3-st">{VI[st]}</span>
          {src && <span className="t3-tag">{src}</span>}
        </div>
        {metrics && (
          <div className="t3-metrics">
            <Metric v={c.kw.toFixed(1)} u="kW" />
            <Metric v={c.kwh.toFixed(2)} u="kWh" />
            <Metric v={c.soc == null ? '—' : c.soc.toFixed(1)} u="% SoC" />
          </div>
        )}
        {metrics && c.soc != null && (
          <div className="t3-bar" aria-hidden="true">
            <i style={{ transform: `scaleX(${Math.max(0, Math.min(1, c.soc / 100))})` }} />
          </div>
        )}
        {n && !metrics && <div className="t3-note">{n}</div>}
      </div>
    </div>
  );
}

function NetPill({ s }) {
  const n = s.net;
  const mode = n.halfOpen ? 'half' : n.state;
  const text = {
    online: 'Trực tuyến',
    connecting: 'Đang nối lại…',
    offline: n.nextRetrySec != null ? `Mất kết nối · thử lại ${n.nextRetrySec} s` : 'Mất kết nối',
    half: 'Half-open · chờ ping timeout',
  }[mode];
  const st = mode === 'online' ? 'Available' : mode === 'offline' ? 'Faulted' : 'SuspendedEV';
  return (
    <div className="t3-pill t3-net" style={{ '--c': `var(--lt-${st})` }}>
      <div className="t3-core" key={mode}>
        <div className="t3-row">
          <span className={`t3-dot t3-net-${mode}`} aria-hidden="true" />
          <b>Mạng</b>
          <span className="t3-st">{text}</span>
          {s.queue.total > 0 && <span className="t3-tag">{s.queue.total} bản tin chờ phát bù</span>}
          {s.speed > 1 && <span className="t3-tag t3-speed">×{s.speed}</span>}
        </div>
      </div>
    </div>
  );
}

export default function Overlay({ store, lite }) {
  const s = useSyncExternalStore(store.subscribe, store.get);
  if (!s) return null;
  const [a, b] = s.connectors;
  return (
    <div className="t3-ov" aria-live="off">
      {a && <GunPill c={a} side="a" />}
      {b && <GunPill c={b} side="b" />}
      <NetPill s={s} />
      <div className="t3-hint">
        Kéo để xoay · nhấp đúp để về góc ban đầu{lite ? ' · chế độ nhẹ' : ''}
      </div>
    </div>
  );
}
