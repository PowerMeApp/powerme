// tru-sac.js — vẽ và cập nhật hình "Trụ sạc" minh hoạ trên HMI D1 (QA-02).
//
// LÀM GÌ
//   - Dựng phần SVG lặp lại (hai súng A/B, màn hình LCD) vào khung có sẵn trong index.html.
//   - Mỗi lần HMI nhận snapshot qua SSE, index.html gọi window.renderTru(state); hàm này chỉ ĐỔI
//     class/chữ/biến CSS — mọi chuyển động nằm trong tru-sac.css.
// VÌ SAO
//   KHÔNG có nguồn dữ liệu thứ hai: hình dùng đúng snapshot mà hai panel súng đang dùng
//   (state.connectors[], state.net, state.queue, state.speed, state.cpId). Hình chỉ phản ánh,
//   không điều khiển gì.
// GIẢ ĐỊNH
//   Đây là hình MINH HOẠ tự vẽ: không có logo, ảnh hay kiểu dáng của hãng nào. Số liệu trên LCD
//   trong hình là số tạm tính của HMI, CSMS mới là nguồn sự thật.
(() => {
  'use strict';
  const root = document.getElementById('tru');
  if (!root) return;
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, '0');
  const mmss = (s) => `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;

  // Tên tiếng Việt + nhãn phụ cho 9 trạng thái OCPP (đèn dùng màu --lt-<trạng thái> trong CSS).
  const ST = {
    Available: { vi: 'Sẵn sàng' },
    Preparing: { vi: 'Chuẩn bị' },
    Charging: { vi: 'Đang sạc' },
    SuspendedEV: { vi: 'Tạm dừng', tag: 'xe tạm dừng' },
    SuspendedEVSE: { vi: 'Tạm dừng', tag: 'trụ tạm dừng' },
    Finishing: { vi: 'Kết thúc' },
    Faulted: { vi: 'Lỗi' },
    Unavailable: { vi: 'Ngừng' },
    Reserved: { vi: 'Đặt trước' },
  };

  // ── Lưu lựa chọn của người xem (thu gọn / tắt hoạt ảnh). localStorage có thể bị chặn → try/catch.
  const store = {
    get(k) {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, v);
      } catch {
        /* bỏ qua: chỉ mất việc nhớ lựa chọn */
      }
    },
  };
  const reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function setCollapsed(on) {
    root.classList.toggle('collapsed', on);
    $('truToggle').textContent = on ? 'Mở rộng' : 'Thu gọn';
    $('truToggle').setAttribute('aria-expanded', String(!on));
  }
  function setNoAnim(on) {
    root.classList.toggle('noanim', on);
    $('truAnim').textContent = on ? 'Bật hoạt ảnh' : 'Tắt hoạt ảnh';
    $('truAnim').setAttribute('aria-pressed', String(on));
  }
  setCollapsed(store.get('tru.collapsed') === '1');
  if (reduced) {
    // Hệ điều hành yêu cầu giảm chuyển động: CSS đã tắt hết; khoá nút để khỏi gây hiểu nhầm.
    setNoAnim(true);
    $('truAnim').disabled = true;
    $('truAnim').title = 'Đang tắt theo cài đặt "giảm chuyển động" của hệ điều hành';
  } else {
    // ?anim=off ép tắt hoạt ảnh cho lần mở này (tiện chụp ảnh tĩnh); không ghi vào localStorage
    const qs = new URLSearchParams(location.search).get('anim');
    setNoAnim(qs ? qs === 'off' : store.get('tru.noanim') === '1');
  }
  $('truToggle').onclick = () => {
    const on = !root.classList.contains('collapsed');
    setCollapsed(on);
    store.set('tru.collapsed', on ? '1' : '0');
  };
  $('truAnim').onclick = () => {
    const on = !root.classList.contains('noanim');
    setNoAnim(on);
    store.set('tru.noanim', on ? '1' : '0');
  };

  // ── Dựng một súng. Hình vẽ cho súng A (bên trái); súng B là bản lật ngang (nhóm .mir), còn chữ
  //    được đặt riêng (không lật) bằng hàm X() để vẫn đọc được.
  // Toạ độ trong viewBox 1000×400: thân trụ x 330–670; xe A nằm x 20–240, cổng sạc ở (242,296).
  const X = (side, x) => (side === 'B' ? 1000 - x : x);
  function gunSvg(id) {
    const side = id === 1 ? 'A' : 'B';
    const mir = id === 2 ? 'transform="translate(1000 0) scale(-1 1)"' : '';
    return `
      <g class="trg" id="trg${id}" data-side="${side}" data-st="Unavailable">
        <g class="car">
          <g ${mir}><g transform="translate(8 260)">
            <path class="car-body" d="M2 62 L2 50 Q6 38 34 34 L66 12 Q74 6 90 6 L150 6 Q166 6 178 16 L198 34 Q218 38 220 50 L220 62 Z"/>
            <path class="car-glass" d="M74 32 L90 14 L148 14 L166 32 Z"/>
            <circle class="wheel" cx="52" cy="72" r="17"/><circle class="hub" cx="52" cy="72" r="6"/>
            <circle class="wheel" cx="172" cy="72" r="17"/><circle class="hub" cx="172" cy="72" r="6"/>
          </g></g>
          <rect class="bat-frame" x="${X(side, 80) - (side === 'B' ? 80 : 0)}" y="300" width="80" height="18" rx="4"/>
          <rect class="bat-fill" data-f="bat" x="${X(side, 82) - (side === 'B' ? 76 : 0)}" y="302" width="76" height="14" rx="2" style="transform:scaleX(0)"/>
          <text class="bat-txt" data-f="soc" x="${X(side, 118)}" y="250">Pin —</text>
        </g>
        <g ${mir}>
          <g class="plug">
            <path class="cable" d="M310 282 C 296 344, 272 344, 252 298"/>
            <path class="flow" data-f="flow" d="M310 282 C 296 344, 272 344, 252 298"/>
            <rect class="gun-head" x="228" y="288" width="26" height="16" rx="4"/>
          </g>
          <rect class="bay" x="306" y="222" width="40" height="84" rx="9"/>
          <rect class="gun-head idle-head" x="314" y="236" width="24" height="44" rx="6"/>
          <rect class="ring" x="298" y="212" width="56" height="104" rx="15"/>
        </g>
        <text class="letter" x="${X(side, 326)}" y="302">${side}</text>
        <rect class="badge" x="${side === 'A' ? 55 : 715}" y="70" width="230" height="58" rx="12"/>
        <text class="badge-t1" data-f="t1" x="${side === 'A' ? 170 : 830}" y="95"></text>
        <text class="badge-t2" data-f="t2" x="${side === 'A' ? 170 : 830}" y="117"></text>
      </g>`;
  }
  $('trGuns').innerHTML = gunSvg(1) + gunSvg(2);

  // ── Màn hình LCD: hai nửa (A | B), mỗi nửa 1 dòng tiêu đề + 4 dòng nội dung.
  const ROW_Y = [186, 210, 230, 250];
  const CX = { 1: 432, 2: 568 };
  function lcdHalf(id) {
    const rows = ROW_Y.map(
      (y, i) => `<text class="lc" data-r="${i}" x="${CX[id]}" y="${y}"></text>`,
    );
    return `<g id="lcd${id}"><circle data-f="dot" cx="${CX[id] - 38}" cy="151" r="5"/>
      <text class="lc lc-h" x="${CX[id] + 6}" y="156">SÚNG ${id === 1 ? 'A' : 'B'}</text>${rows.join('')}</g>`;
  }
  $('trLcd').innerHTML = lcdHalf(1) + lcdHalf(2);

  const gun = {};
  for (const id of [1, 2]) {
    const g = $('trg' + id);
    const f = (n) => g.querySelector(`[data-f="${n}"]`);
    const l = $('lcd' + id);
    gun[id] = {
      g,
      bat: f('bat'),
      soc: f('soc'),
      flow: f('flow'),
      t1: f('t1'),
      t2: f('t2'),
      dot: l.querySelector('[data-f="dot"]'),
      rows: [...l.querySelectorAll('[data-r]')],
    };
  }

  // Nội dung LCD cho một súng theo trạng thái. Trả về tối đa 4 dòng {t: chữ, s: cỡ chữ, c: màu}.
  function lcdRows(c) {
    const soc = c.soc == null ? '—' : c.soc.toFixed(1);
    switch (c.status) {
      case 'Available':
        return [
          { t: 'Sẵn sàng', s: 20, c: 'ok' },
          { t: 'quẹt thẻ hoặc', s: 15, c: 'dim' },
          { t: 'quét QR', s: 15, c: 'dim' },
        ];
      case 'Preparing':
        return [
          { t: 'Cắm súng', s: 20, c: 'info' },
          { t: 'vào xe', s: 20, c: 'info' },
          ...(c.plugged ? [{ t: 'rồi quẹt thẻ', s: 15, c: 'dim' }] : []),
        ];
      case 'Charging':
        return [
          { t: `${c.kw.toFixed(1)} kW`, s: 24, c: 'ok' },
          { t: `SoC ${soc} %`, s: 17 },
          { t: mmss(c.elapsed), s: 16 },
          { t: `${c.cost.toLocaleString('vi-VN')} đ`, s: 16, c: 'info' },
        ];
      case 'SuspendedEV':
      case 'SuspendedEVSE':
        return [
          { t: ST[c.status].tag.replace(/^./, (m) => m.toUpperCase()), s: 17, c: 'warn' },
          { t: `SoC ${soc} %`, s: 16 },
          { t: mmss(c.elapsed), s: 15 },
        ];
      case 'Finishing':
        return [
          { t: 'Rút súng', s: 22, c: 'info' },
          { t: 'phiên đã xong', s: 15, c: 'dim' },
        ];
      case 'Faulted': {
        // "ConnectorLockFailure" → ["Connector", "Lock Failure"] cho vừa nửa màn hình
        const w = (c.errorCode === 'NoError' ? 'Faulted' : c.errorCode)
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .split(' ');
        const lines = w.length >= 3 ? [w[0], w.slice(1).join(' ')] : w;
        return [{ t: 'LỖI', s: 24, c: 'err' }, ...lines.map((t) => ({ t, s: 14, c: 'warn' }))];
      }
      case 'Reserved':
        return [
          { t: 'Đã đặt', s: 20, c: 'info' },
          { t: 'trước', s: 20, c: 'info' },
        ];
      default:
        return [
          { t: 'Ngừng', s: 20, c: 'dim' },
          { t: 'phục vụ', s: 20, c: 'dim' },
        ];
    }
  }

  // Tốc độ chấm chạy trên cáp tỉ lệ công suất: px/s = 6 + 0,5·kW; "Tăng tốc ×10" thì nhanh gấp 2
  // (không gấp 10 để mắt còn theo được). Chu kỳ nét = 16 đơn vị → dur = 16 / tốc độ.
  function flowDur(kw, speed) {
    const pxps = (6 + 0.5 * kw) * (speed > 1 ? 2 : 1);
    return Math.max(0.15, Math.round((16 / pxps) * 20) / 20) + 's';
  }

  function renderGun(c, speed) {
    const o = gun[c.id];
    const st = ST[c.status] ? c.status : 'Unavailable';
    const lt = `var(--lt-${st})`;
    o.g.dataset.st = st;
    o.g.style.setProperty('--lt', lt);
    o.g.classList.toggle('plugged', !!c.plugged);
    o.g.classList.toggle('chg', st === 'Charging');
    o.flow.style.setProperty('--dur', flowDur(c.kw, speed));
    // Thanh pin trên xe đổ theo SoC thật (CSS transition làm mượt)
    o.bat.style.transform = `scaleX(${Math.max(0, Math.min(100, c.soc ?? 0)) / 100})`;
    o.soc.textContent = c.soc == null ? 'Pin —' : `Pin ${c.soc.toFixed(1)} %`;
    // Nhãn
    const label = `Súng ${c.label} · ${ST[st].vi}`;
    o.t1.textContent = label;
    o.t2.textContent = ST[st].tag ? `${st} · ${ST[st].tag}` : st;
    // LCD
    o.dot.style.fill = lt;
    const rows = lcdRows(c);
    o.rows.forEach((el, i) => {
      const r = rows[i];
      el.textContent = r ? r.t : '';
      el.setAttribute('font-size', r ? r.s : 14);
      el.setAttribute('class', 'lc' + (r && r.c ? ' lc-' + r.c : ''));
    });
  }

  // ── Mạng + hàng đợi + nhịp "phát bù" khi nối lại
  let prevQueue = 0;
  let replayTimer = 0;
  function fireReplay(n) {
    const rp = $('trReplay');
    $('trReplayTxt').textContent = `Phát bù ${n} bản tin → CSMS`;
    rp.classList.remove('go');
    void rp.getBoundingClientRect(); // ép tính lại để hoạt ảnh chạy lại từ đầu
    rp.classList.add('go');
    clearTimeout(replayTimer);
    replayTimer = setTimeout(() => rp.classList.remove('go'), 3500);
  }

  window.renderTru = function renderTru(s) {
    const n = s.net;
    root.dataset.net = n.state;
    $('trSerial').textContent = `120 kW DC · ${s.cpId}`;
    $('trNetTxt').textContent =
      { online: 'Mạng: online', offline: 'Mạng: MẤT KẾT NỐI', connecting: 'Mạng: đang nối...' }[
        n.state
      ] + (n.halfOpen ? ' (half-open)' : '');
    // Bong bóng số bản tin đang chờ trong buffer
    $('trBubble').style.display = s.queue.total > 0 ? '' : 'none';
    $('trBubbleN').textContent = s.queue.total;
    // Dải trên cùng của LCD: mạng + đồng hồ mô phỏng
    $('trStrip').textContent =
      n.state === 'online'
        ? `PowerMe · ${s.simTime.slice(11, 16)} UTC`
        : n.state === 'offline'
          ? n.nextRetrySec != null
            ? `Mất kết nối — thử lại sau ${n.nextRetrySec} s`
            : 'Mất kết nối — đang thử lại'
          : 'Đang nối lại máy chủ...';
    $('trStrip').setAttribute(
      'class',
      'lc lc-strip ' + (n.state === 'online' ? 'lc-dim' : 'lc-err'),
    );
    for (const c of s.connectors) renderGun(c, s.speed);
    if (prevQueue > 0 && s.queue.total === 0 && n.state === 'online') fireReplay(prevQueue);
    prevQueue = s.queue.total;
  };
})();
