/**
 * Trang web của bảng điều khiển: MỘT chuỗi HTML (CSS + JS inline, không CDN, không thư viện)
 * do `GET /` trả về.
 *
 * Vì sao tồn tại: demo Review 2 cần nhìn thấy hệ thống đang chạy trên máy chiếu mà không cần
 * dựng frontend riêng. Trang poll các endpoint `/api/admin/*` mỗi 1 s (đủ cho demo; realtime
 * Socket.IO là việc sau) và vẽ biểu đồ năng lượng bằng SVG thuần.
 *
 * CHƯA CÓ XÁC THỰC — footer cố định nói rõ điều đó. JS cố ý không dùng template literal để
 * chuỗi này nằm gọn trong String.raw (không cần escape dấu backtick / `${`). Mọi dữ liệu từ API
 * đi qua `esc()` trước khi chèn vào HTML.
 */
export const CONSOLE_PAGE_HTML: string = String.raw`<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PowerMe CSMS — Bảng điều khiển vận hành</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #eef1f5; --panel: #ffffff; --panel2: #f6f8fb; --ink: #14202e; --muted: #5b6b7e;
  --line: #d5dce6; --accent: #0b6fd6;
  --ok: #17803d; --okbg: #dcf3e3; --warn: #a15c00; --warnbg: #fff0cf;
  --bad: #b3261e; --badbg: #fde1de; --info: #1b5fb0; --infobg: #deebfb;
  --off: #5b6b7e; --offbg: #e6eaf0; --viol: #6b3fb0; --violbg: #ece3fa;
  --replay: #fff3cd;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d141c; --panel: #16212d; --panel2: #1b2836; --ink: #e8eef5; --muted: #94a5b8;
    --line: #2b3a4b; --accent: #5aa8ff;
    --ok: #5fd68a; --okbg: #12361f; --warn: #ffc65c; --warnbg: #402c05;
    --bad: #ff8a80; --badbg: #4a1612; --info: #7db8ff; --infobg: #14304f;
    --off: #94a5b8; --offbg: #243243; --viol: #c6a6ff; --violbg: #2d1f4a;
    --replay: #4a3a08;
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 18px/1.35 "Segoe UI", system-ui, -apple-system, Roboto, sans-serif;
  display: flex; flex-direction: column;
}
header {
  display: flex; align-items: center; gap: 16px; padding: 10px 20px;
  background: var(--panel); border-bottom: 1px solid var(--line);
}
header h1 { font-size: 22px; margin: 0; flex: 1; }
#live { font-size: 15px; color: var(--muted); }
#live b { display: inline-block; width: 11px; height: 11px; border-radius: 50%; background: var(--off); margin-right: 6px; }
#live.ok b { background: var(--ok); }
#live.err b { background: var(--bad); }
main {
  flex: 1; min-height: 0; padding: 12px 16px 46px; display: grid; gap: 12px;
  grid-template-rows: auto 1fr;
}
#tiles { display: grid; grid-template-columns: 1.1fr 3fr 1fr; gap: 12px; }
.tile { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 16px; }
.tile h3 { margin: 0 0 4px; font-size: 14px; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
.big { font-size: 46px; font-weight: 700; line-height: 1.05; }
.big small { font-size: 20px; font-weight: 500; color: var(--muted); }
.statusrow { display: flex; flex-wrap: wrap; gap: 6px 10px; }
.statchip { display: flex; align-items: baseline; gap: 6px; padding: 2px 10px; border-radius: 8px; }
.statchip b { font-size: 28px; }
.statchip span { font-size: 15px; }
.statchip.zero { opacity: .45; }
#grid { min-height: 0; display: grid; gap: 12px; grid-template-columns: minmax(420px, 1fr) 1.7fr; grid-template-rows: 1fr 1fr; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.panel > h2 { margin: 0; padding: 8px 14px; font-size: 18px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: baseline; }
.panel > h2 small { font-weight: 400; font-size: 14px; color: var(--muted); }
.body { overflow: auto; flex: 1; min-height: 0; }
#p-stations { grid-column: 1; grid-row: 1; }
#p-sessions { grid-column: 2; grid-row: 1; }
#p-recon { grid-column: 1; grid-row: 2; }
#p-log { grid-column: 2; grid-row: 2; }
table { border-collapse: collapse; width: 100%; font-size: 16px; }
th { position: sticky; top: 0; background: var(--panel2); text-align: left; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); padding: 5px 10px; z-index: 1; }
td { padding: 5px 10px; border-top: 1px solid var(--line); white-space: nowrap; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.click { cursor: pointer; }
tr.click:hover td { background: var(--panel2); }
tr.s-review td { background: var(--badbg); font-weight: 600; }
tr.s-orphaned td { background: var(--warnbg); font-weight: 600; }
tr.s-review td:first-child { box-shadow: inset 6px 0 0 var(--bad); }
tr.s-orphaned td:first-child { box-shadow: inset 6px 0 0 var(--warn); }
.badge { display: inline-block; padding: 1px 10px; border-radius: 999px; font-size: 14px; font-weight: 700; }
.b-pending, .b-closed { background: var(--offbg); color: var(--off); }
.b-active, .b-reconciled { background: var(--okbg); color: var(--ok); }
.b-paused, .b-stopping, .b-orphaned { background: var(--warnbg); color: var(--warn); }
.b-review, .b-failed { background: var(--badbg); color: var(--bad); }
.b-info { background: var(--infobg); color: var(--info); }
.b-viol { background: var(--violbg); color: var(--viol); }
.st { padding: 10px 14px; border-bottom: 1px solid var(--line); }
.st .head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.st .name { font-weight: 700; font-size: 19px; }
.dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
.dot.on { background: var(--ok); } .dot.off { background: var(--bad); }
.st .meta { color: var(--muted); font-size: 15px; margin: 2px 0 6px; }
.chips { display: flex; gap: 8px; flex-wrap: wrap; }
.chip { padding: 3px 12px; border-radius: 8px; font-size: 16px; }
.chip small { opacity: .75; }
.c-Available { background: var(--okbg); color: var(--ok); }
.c-Preparing, .c-Finishing { background: var(--infobg); color: var(--info); }
.c-Charging { background: var(--ok); color: var(--panel); font-weight: 700; }
.c-SuspendedEV, .c-SuspendedEVSE { background: var(--warnbg); color: var(--warn); }
.c-Reserved { background: var(--violbg); color: var(--viol); }
.c-Unavailable { background: var(--offbg); color: var(--off); }
.c-Faulted { background: var(--bad); color: var(--panel); font-weight: 700; }
button { font: inherit; font-size: 15px; padding: 3px 12px; border-radius: 8px; cursor: pointer; border: 1px solid var(--bad); background: transparent; color: var(--bad); }
button:hover:not(:disabled) { background: var(--bad); color: var(--panel); }
button:disabled { opacity: .4; cursor: not-allowed; }
button.plain { border-color: var(--line); color: var(--ink); }
.rec { padding: 8px 14px; border-bottom: 1px solid var(--line); }
.rec .t { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 15px; color: var(--muted); }
.rec .s { font-size: 18px; margin-top: 2px; }
.rec.k-conflict { background: var(--badbg); }
#log td { font-family: ui-monospace, Consolas, monospace; font-size: 15px; padding: 2px 10px; }
#log tr.replayed td { background: var(--replay); }
.arrow-in { color: var(--info); font-weight: 700; } .arrow-out { color: var(--viol); font-weight: 700; }
.tag { font-size: 12px; font-weight: 700; padding: 0 6px; border-radius: 4px; background: var(--warn); color: var(--panel); }
.empty { color: var(--muted); padding: 16px; }
footer {
  position: fixed; left: 0; right: 0; bottom: 0; text-align: center; font-size: 15px;
  padding: 7px 10px; background: var(--warnbg); color: var(--warn); border-top: 1px solid var(--line); font-weight: 600;
}
#drawer {
  position: fixed; top: 0; right: 0; bottom: 34px; width: min(860px, 96vw); background: var(--panel);
  border-left: 2px solid var(--line); box-shadow: -8px 0 24px rgba(0,0,0,.25); display: none; flex-direction: column; z-index: 5;
}
#drawer.open { display: flex; }
#drawer .dh { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--line); }
#drawer .dh h2 { margin: 0; flex: 1; font-size: 22px; }
#drawer .db { overflow: auto; padding: 12px 16px; flex: 1; }
.kv { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px 16px; margin-bottom: 10px; }
.kv div { font-size: 16px; } .kv span { display: block; font-size: 13px; color: var(--muted); text-transform: uppercase; }
svg text { fill: var(--muted); font-size: 13px; }
.legend { font-size: 14px; color: var(--muted); display: flex; gap: 16px; flex-wrap: wrap; margin: 4px 0 10px; }
#toast { position: fixed; left: 50%; bottom: 52px; transform: translateX(-50%); background: var(--ink); color: var(--bg); padding: 8px 18px; border-radius: 8px; display: none; z-index: 9; font-size: 17px; }
</style>
</head>
<body>
<header>
  <h1>PowerMe CSMS — Bảng điều khiển vận hành</h1>
  <div id="live"><b></b><span>đang kết nối…</span></div>
</header>
<main>
  <section id="tiles">
    <div class="tile"><h3>Trụ</h3><div class="big" id="t-st">—</div></div>
    <div class="tile"><h3>Phiên sạc theo trạng thái</h3><div class="statusrow" id="t-sess"></div></div>
    <div class="tile"><h3>Đối soát: conflict</h3><div class="big" id="t-conf">—</div></div>
  </section>
  <section id="grid">
    <div class="panel" id="p-stations"><h2>Trụ &amp; súng <small id="n-st"></small></h2><div class="body" id="stations"></div></div>
    <div class="panel" id="p-sessions"><h2>Phiên sạc <small>bấm một hàng để xem chi tiết</small></h2><div class="body" id="sessions"></div></div>
    <div class="panel" id="p-recon"><h2>Đối soát <small id="n-rec"></small></h2><div class="body" id="recon"></div></div>
    <div class="panel" id="p-log"><h2>Nhật ký OCPP trực tiếp <small><span class="arrow-in">←</span> trụ gửi vào CSMS · <span class="arrow-out">→</span> CSMS gửi ra · <span class="tag">PHÁT LẠI</span> suy từ cp_timestamp</small></h2><div class="body"><table id="log"><tbody></tbody></table></div></div>
  </section>
</main>
<aside id="drawer"></aside>
<div id="toast"></div>
<footer>Bảng điều khiển demo — chưa có xác thực; dữ liệu mô phỏng</footer>
<script>
(function () {
  'use strict';
  var STATUSES = ['pending', 'active', 'paused', 'stopping', 'closed', 'review', 'reconciled', 'orphaned', 'failed'];
  var STATUS_VI = { pending: 'chờ', active: 'đang sạc', paused: 'tạm dừng', stopping: 'đang dừng', closed: 'đã đóng', review: 'cần xem xét', reconciled: 'đã đối soát', orphaned: 'mồ côi', failed: 'thất bại' };
  var STOPPABLE = { pending: 1, active: 1, paused: 1, stopping: 1 };
  var logRows = [];
  var lastMsgId = null;
  var openSessionId = null;
  var stationsState = [];
  var busy = false;

  function $(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function dash(v) { return v === null || v === undefined ? '—' : v; }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function hms(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function ago(iso) {
    if (!iso) return '—';
    var s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (s < 60) return s + ' s trước';
    if (s < 3600) return Math.floor(s / 60) + ' phút trước';
    return Math.floor(s / 3600) + ' giờ trước';
  }
  function wh(v) { return v === null || v === undefined ? '—' : String(Math.round(v * 10) / 10) + ' Wh'; }
  function badge(status) { return '<span class="badge b-' + esc(status) + '">' + esc(status) + '</span>'; }

  function getJson(path) {
    return fetch(path, { cache: 'no-store' }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error((j && j.detail) || r.statusText);
        return j;
      });
    });
  }
  function post(path) {
    return fetch(path, { method: 'POST' }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, body: j }; });
    });
  }
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(toast.h);
    toast.h = setTimeout(function () { t.style.display = 'none'; }, 5000);
  }

  // ---- tóm tắt ----
  function renderSummary(s) {
    $('t-st').innerHTML = s.stations.online + ' <small>online</small> · ' + s.stations.offline + ' <small>offline</small>';
    var h = '';
    STATUSES.forEach(function (k) {
      var n = s.sessions_by_status[k];
      h += '<div class="statchip b-' + k + (n ? '' : ' zero') + '"><b>' + n + '</b><span>' + STATUS_VI[k] + '</span></div>';
    });
    $('t-sess').innerHTML = h;
    var c = s.reconciliation_conflicts;
    $('t-conf').innerHTML = '<span style="color:' + (c ? 'var(--bad)' : 'inherit') + '">' + c + '</span> <small>/ ' + Object.keys(s.reconciliation_by_type).reduce(function (a, k) { return a + s.reconciliation_by_type[k]; }, 0) + ' bản ghi</small>';
  }

  // ---- trụ & súng ----
  function renderStations(list) {
    stationsState = list;
    $('n-st').textContent = list.length + ' trụ';
    if (!list.length) { $('stations').innerHTML = '<div class="empty">Chưa có trụ nào trong charge_points.</div>'; return; }
    var h = '';
    list.forEach(function (st) {
      h += '<div class="st"><div class="head"><span class="dot ' + (st.connected ? 'on' : 'off') + '"></span><span class="name">' + esc(st.serial) + '</span>' +
        '<span class="badge ' + (st.connected ? 'b-active' : 'b-failed') + '">' + (st.connected ? 'đang nối' : 'mất kết nối') + '</span>' +
        '<span style="flex:1"></span><button data-disc="' + esc(st.serial) + '"' + (st.connected ? '' : ' disabled') + '>Ngắt kết nối trụ</button></div>' +
        '<div class="meta">vòng đời: ' + esc(st.lifecycle) + ' · epoch ' + st.current_epoch + ' · lần cuối nhận tin: ' + ago(st.last_message_at) + '</div><div class="chips">';
      st.connectors.forEach(function (c) {
        h += '<span class="chip c-' + esc(c.status) + '">súng ' + c.connector_no + ': <b>' + esc(c.status) + '</b></span>';
      });
      if (!st.connectors.length) h += '<span class="empty" style="padding:0">chưa có súng</span>';
      h += '</div></div>';
    });
    $('stations').innerHTML = h;
  }

  // ---- phiên sạc ----
  function energyCell(s) {
    if (s.energy_wh !== null) return wh(s.energy_wh);
    if (s.latest_meter_wh !== null) return '<i title="số đọc đồng hồ mới nhất trừ meterStart">' + wh(s.latest_meter_wh - s.meter_start_wh) + '*</i>';
    return '—';
  }
  function renderSessions(list) {
    if (!list.length) { $('sessions').innerHTML = '<div class="empty">Chưa có phiên sạc.</div>'; return; }
    var h = '<table><thead><tr><th>TX</th><th>Trụ / súng</th><th>idTag</th><th>Nguồn · thanh toán</th><th>Trạng thái</th><th>Bắt đầu</th><th>Kết thúc</th><th class="num">meter start→stop</th><th class="num">Điện năng</th><th class="num">Mẫu</th><th></th></tr></thead><tbody>';
    list.forEach(function (s) {
      h += '<tr class="click s-' + esc(s.status) + '" data-sid="' + s.id + '"><td><b>#' + s.transaction_no + '</b></td><td>' + esc(s.station) + ' / ' + s.connector_no + '</td><td>' + esc(s.id_tag) + '</td><td>' + esc(s.origin) + ' · ' + esc(s.payment_mode) + '</td><td>' + badge(s.status) + (s.delivered_offline ? ' <span class="badge b-viol" title="trụ gửi bù sau khi nối lại">bù</span>' : '') + '</td><td>' + hms(s.started_at) + '</td><td>' + hms(s.ended_at) + '</td><td class="num">' + s.meter_start_wh + ' → ' + dash(s.meter_stop_wh) + '</td><td class="num">' + energyCell(s) + '</td><td class="num">' + s.meter_value_count + '</td><td>' + (s.has_conflict ? '<span class="badge b-failed">conflict</span>' : '') + '</td></tr>';
    });
    $('sessions').innerHTML = h + '</tbody></table>';
  }

  // ---- đối soát: diễn giải một câu ----
  function sentence(r) {
    var act = /action=(\w+)/.exec(r.resolution || '');
    var tag = /id_tag=(\S+)/.exec(r.resolution || '');
    var late = r.late_sample ? ' (phát hiện khi mẫu muộn tới)' : '';
    switch (r.kind) {
      case 'conflict':
        return 'meterStop ' + wh(r.meter_stop_minus_start_wh) + ' mâu thuẫn chuỗi đo ' + wh(r.series_last_wh) + ' — lệch ' + wh(r.energy_difference_wh) + late;
      case 'gap_detected':
        return 'Chuỗi đo bị đứt ' + hms(r.gap_start) + ' → ' + hms(r.gap_end) + ', chênh ' + wh(r.energy_difference_wh) + late;
      case 'replay':
        return 'Bản tin ' + (act ? act[1] : '?') + ' bị phát hiện là PHÁT LẠI từ hàng đợi offline của trụ';
      case 'duplicate':
        return 'Bản tin ' + (act ? act[1] : '?') + ' trùng — CSMS đã có, không tạo phiên mới';
      case 'orphan_stop':
        return 'StopTransaction tới cho phiên đã dừng — giữ nguyên trạng thái phiên';
      case 'unknown_id_tag':
        return 'idTag lạ (' + (tag ? tag[1] : '?') + ') — không có trong sổ thẻ';
      default:
        return 'Chênh lệch ' + wh(r.energy_difference_wh) + ' trong chuỗi đo' + late;
    }
  }
  function renderRecon(list) {
    $('n-rec').textContent = list.length + ' bản ghi mới nhất';
    if (!list.length) { $('recon').innerHTML = '<div class="empty">Chưa có bản ghi đối soát.</div>'; return; }
    var h = '';
    list.forEach(function (r) {
      var cls = r.kind === 'conflict' ? 'b-failed' : (r.kind === 'gap_detected' ? 'b-paused' : 'b-info');
      h += '<div class="rec k-' + esc(r.kind) + '"><div class="t"><span class="badge ' + cls + '">' + esc(r.kind) + '</span><span>phiên #' + dash(r.transaction_no) + ' · bản ghi ' + r.record_no + '</span><span>' + hms(r.created_at) + '</span>' + (r.reviewed ? '<span class="badge b-active">đã xử lý</span>' : '') + '</div><div class="s">' + esc(sentence(r)) + '</div></div>';
    });
    $('recon').innerHTML = h;
  }

  // ---- nhật ký ----
  function renderLog() {
    var h = '';
    for (var i = logRows.length - 1; i >= 0; i--) {
      var m = logRows[i];
      var arrow = m.direction === 'in' ? '<span class="arrow-in">←</span>' : '<span class="arrow-out">→</span>';
      var what = m.message_type === 2 ? m.action : (m.message_type === 3 ? 'CALLRESULT' : 'CALLERROR');
      h += '<tr' + (m.replayed === true ? ' class="replayed"' : '') + '><td>' + hms(m.received_at) + '</td><td>' + arrow + '</td><td>' + esc(m.station) + ' e' + m.epoch + '</td><td>' + esc(what) + '</td><td>' + esc(m.unique_id.slice(0, 8)) + '</td><td>' + (m.replayed === true ? '<span class="tag">PHÁT LẠI</span>' : '') + '</td></tr>';
    }
    $('log').querySelector('tbody').innerHTML = h || '<tr><td class="empty">Chưa có frame nào.</td></tr>';
  }
  function takeMessages(list) {
    if (!list.length) return;
    list.forEach(function (m) { logRows.push(m); });
    if (logRows.length > 300) logRows = logRows.slice(logRows.length - 300);
    lastMsgId = list[list.length - 1].id;
    renderLog();
  }

  // ---- chi tiết phiên + biểu đồ SVG ----
  function chart(d) {
    var s = d.session;
    var pts = d.meter_values.filter(function (m) { return m.measurand === 'Energy.Active.Import.Register'; });
    if (!pts.length) return '<div class="empty">Phiên chưa có mẫu Energy.Active.Import.Register.</div>';
    var W = 800, H = 300, L = 70, R = 20, T = 14, B = 34;
    var xs = pts.map(function (p) { return Date.parse(p.cp_timestamp); });
    var ys = pts.map(function (p) { return p.value; });
    var marks = [];
    if (s.meter_stop_wh !== null) marks.push(s.meter_stop_wh);
    marks.push(s.meter_start_wh);
    var ymin = Math.min.apply(null, ys.concat(marks)), ymax = Math.max.apply(null, ys.concat(marks));
    var xmin = Math.min.apply(null, xs), xmax = Math.max.apply(null, xs);
    d.reconciliation_records.forEach(function (r) {
      if (r.gap_start && r.gap_end && (r.kind === 'conflict' || r.kind === 'gap_detected')) {
        xmin = Math.min(xmin, Date.parse(r.gap_start)); xmax = Math.max(xmax, Date.parse(r.gap_end));
      }
    });
    if (ymax === ymin) { ymax += 1; ymin -= 1; }
    if (xmax === xmin) { xmax += 1000; }
    function X(t) { return L + (t - xmin) / (xmax - xmin) * (W - L - R); }
    function Y(v) { return T + (1 - (v - ymin) / (ymax - ymin)) * (H - T - B); }
    var g = '';
    for (var i = 0; i <= 4; i++) {
      var v = ymin + (ymax - ymin) * i / 4;
      g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(v) + '" y2="' + Y(v) + '" stroke="var(--line)"/><text x="' + (L - 6) + '" y="' + (Y(v) + 4) + '" text-anchor="end">' + Math.round(v) + '</text>';
    }
    for (var j = 0; j <= 4; j++) {
      var t = xmin + (xmax - xmin) * j / 4;
      g += '<text x="' + X(t) + '" y="' + (H - 10) + '" text-anchor="' + (j === 0 ? 'start' : j === 4 ? 'end' : 'middle') + '">' + hms(new Date(t).toISOString()) + '</text>';
    }
    // vùng đối soát: chỉ vẽ khoảng RỘNG NHẤT (bản ghi late_sample thu hẹp dần, chồng lên sẽ tối)
    var bands = '';
    var widest = null;
    d.reconciliation_records.forEach(function (r) {
      if (r.gap_start && r.gap_end && (r.kind === 'conflict' || r.kind === 'gap_detected')) {
        var w = Date.parse(r.gap_end) - Date.parse(r.gap_start);
        if (widest === null || w > widest.w) widest = { w: w, a: r.gap_start, b: r.gap_end };
      }
    });
    if (widest !== null) {
      var x1 = X(Date.parse(widest.a)), x2 = X(Date.parse(widest.b));
      bands = '<rect x="' + x1 + '" y="' + T + '" width="' + Math.max(2, x2 - x1) + '" height="' + (H - T - B) + '" fill="var(--warn)" opacity=".16"/>';
    }
    var line = pts.map(function (p, k) { return (k ? 'L' : 'M') + X(Date.parse(p.cp_timestamp)).toFixed(1) + ' ' + Y(p.value).toFixed(1); }).join(' ');
    var dots = pts.map(function (p) {
      var x = X(Date.parse(p.cp_timestamp)).toFixed(1), y = Y(p.value).toFixed(1);
      return p.replayed === true
        ? '<path d="M' + x + ' ' + (y - 7) + ' l7 7 l-7 7 l-7 -7 z" fill="var(--panel)" stroke="var(--warn)" stroke-width="2.5"><title>mẫu PHÁT LẠI ' + hms(p.cp_timestamp) + ' = ' + p.value + ' Wh</title></path>'
        : '<circle cx="' + x + '" cy="' + y + '" r="4" fill="var(--accent)"><title>' + hms(p.cp_timestamp) + ' = ' + p.value + ' Wh</title></circle>';
    }).join('');
    var stop = '';
    if (s.meter_stop_wh !== null) {
      stop = '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(s.meter_stop_wh) + '" y2="' + Y(s.meter_stop_wh) + '" stroke="var(--bad)" stroke-width="2" stroke-dasharray="7 5"/><text x="' + (W - R) + '" y="' + (Y(s.meter_stop_wh) - 5) + '" text-anchor="end" style="fill:var(--bad)">meterStop ' + s.meter_stop_wh + ' Wh</text>';
    }
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Năng lượng theo thời gian">' + g + bands + stop +
      '<path d="' + line + '" fill="none" stroke="var(--accent)" stroke-width="2.5"/>' + dots + '<text x="' + L + '" y="' + (T + 2) + '" dy="-2">Wh</text></svg>' +
      '<div class="legend"><span>● mẫu live</span><span style="color:var(--warn)">◇ mẫu phát lại (' + pts.filter(function (p) { return p.replayed === true; }).length + ')</span><span style="color:var(--bad)">– – meterStop trên StopTransaction</span><span>vùng vàng: khoảng đối soát. Trục thời gian = đồng hồ trụ (cp_timestamp).</span></div>';
  }
  function renderDrawer(d) {
    var s = d.session;
    var st = stationsState.filter(function (x) { return x.serial === s.station; })[0];
    var canStop = !!STOPPABLE[s.status] && st && st.connected;
    var replayN = d.meter_values.filter(function (m) { return m.replayed === true; }).length;
    var h = '<div class="dh"><h2>Phiên #' + s.transaction_no + ' · ' + esc(s.station) + ' / súng ' + s.connector_no + ' ' + badge(s.status) + '</h2>' +
      '<button id="d-stop"' + (canStop ? '' : ' disabled title="Phiên không ở trạng thái dừng được hoặc trụ offline"') + ' data-sid="' + s.id + '">Dừng phiên (RemoteStop)</button><button class="plain" id="d-close">Đóng ✕</button></div><div class="db">';
    h += '<div class="kv"><div><span>idTag</span>' + esc(s.id_tag) + '</div><div><span>Nguồn · thanh toán</span>' + esc(s.origin) + ' · ' + esc(s.payment_mode) + '</div><div><span>Lý do dừng</span>' + (s.stop_reason ? esc(s.stop_reason) : '—') + '</div>' +
      '<div><span>Bắt đầu (CSMS)</span>' + hms(s.started_at) + '</div><div><span>Kết thúc (CSMS)</span>' + hms(s.ended_at) + '</div><div><span>Gửi bù offline</span>' + (s.delivered_offline ? 'có' : 'không') + '</div>' +
      '<div><span>meterStart / meterStop</span>' + s.meter_start_wh + ' / ' + dash(s.meter_stop_wh) + ' Wh</div><div><span>Điện năng</span>' + energyCell(s) + '</div><div><span>Mẫu đo (phát lại)</span>' + s.meter_value_count + ' (' + replayN + ')</div></div>';
    h += chart(d);
    h += '<h3 style="margin:12px 0 4px">Bản ghi đối soát (' + d.reconciliation_records.length + ')</h3>';
    if (!d.reconciliation_records.length) h += '<div class="empty" style="padding:4px 0">Không có.</div>';
    d.reconciliation_records.forEach(function (r) {
      h += '<div class="rec k-' + esc(r.kind) + '"><div class="t"><span class="badge ' + (r.kind === 'conflict' ? 'b-failed' : 'b-info') + '">' + esc(r.kind) + '</span><span>#' + r.record_no + ' · ' + hms(r.created_at) + '</span></div><div class="s">' + esc(sentence(r)) + '</div></div>';
    });
    if (d.pauses.length) h += '<h3 style="margin:12px 0 4px">Tạm dừng (' + d.pauses.length + ')</h3>' + d.pauses.map(function (p) { return '<div>' + hms(p.paused_at) + ' → ' + hms(p.resumed_at) + ' (' + esc(p.pause_cause) + ')</div>'; }).join('');
    $('drawer').innerHTML = h + '</div>';
    $('drawer').className = 'open';
  }
  function refreshDrawer() {
    if (openSessionId === null) return Promise.resolve();
    return getJson('/api/admin/sessions/' + openSessionId).then(renderDrawer, function () {});
  }

  // ---- vòng poll ----
  function tick() {
    if (busy) return;
    busy = true;
    var msgPath = '/api/admin/messages?limit=100' + (lastMsgId === null ? '' : '&after=' + lastMsgId);
    Promise.all([getJson('/api/admin/summary'), getJson('/api/admin/stations'), getJson('/api/admin/sessions?limit=50'), getJson('/api/admin/reconciliation?limit=50'), getJson(msgPath)])
      .then(function (r) {
        renderSummary(r[0]); renderStations(r[1]); renderSessions(r[2]); renderRecon(r[3]); takeMessages(r[4]);
        $('live').className = 'ok'; $('live').lastChild.textContent = 'trực tiếp · cập nhật ' + hms(new Date().toISOString());
        return refreshDrawer();
      })
      .catch(function (e) { $('live').className = 'err'; $('live').lastChild.textContent = 'mất kết nối tới CSMS: ' + e.message; })
      .then(function () { busy = false; });
  }

  // ---- hành động ----
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!(t instanceof Element)) return;
    var disc = t.closest('[data-disc]');
    if (disc) {
      var serial = disc.getAttribute('data-disc');
      if (!window.confirm('Ngắt kết nối trụ ' + serial + ' phía CSMS?\nPhiên đang sạc sẽ chuyển sang "orphaned" cho tới khi trụ nối lại.')) return;
      post('/api/admin/stations/' + encodeURIComponent(serial) + '/disconnect').then(function (r) {
        toast(r.ok ? 'Đã đóng socket của ' + serial : 'Lỗi: ' + r.body.detail); tick();
      });
      return;
    }
    if (t.id === 'd-close') { openSessionId = null; $('drawer').className = ''; return; }
    if (t.id === 'd-stop') {
      var sid = t.getAttribute('data-sid');
      if (!window.confirm('Gửi RemoteStopTransaction cho phiên này?')) return;
      post('/api/admin/sessions/' + sid + '/remote-stop').then(function (r) {
        toast(r.ok ? 'Trụ trả lời: ' + r.body.status : 'Lỗi: ' + r.body.detail); tick();
      });
      return;
    }
    var row = t.closest('[data-sid]');
    if (row && row.tagName === 'TR') {
      openSessionId = Number(row.getAttribute('data-sid'));
      refreshDrawer();
    }
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { openSessionId = null; $('drawer').className = ''; }
  });

  // Liên kết sâu: /#s=<id phiên> mở thẳng khung chi tiết (tiện khi demo / chụp ảnh).
  var deep = /^#s=(\d+)$/.exec(location.hash);
  if (deep) openSessionId = Number(deep[1]);
  tick();
  setInterval(tick, 1000);
})();
</script>
</body>
</html>
`;
