// tru-3d.js — bộ nạp hình trụ sạc 3D trên trang từng trụ (QA-03 → QA-04).
//
// LÀM GÌ
//   Kiểm điều kiện, rồi nạp bundle React + react-three-fiber (GET /tru3d/tru3d.js, build từ
//   simulator/d1-hmi/tru3d/) và gắn vào khung #tru3d. Bật/tắt theo nút "Hình 2D"/"Hình 3D", "Tắt hoạt
//   ảnh", "Thu gọn" và tab ẩn/hiện; khi không vẽ thì bundle dừng hẳn vòng render (frameloop "never").
// VÌ SAO
//   Cùng snapshot SSE với hình SVG 2D (tru.html gọi window.renderTru3d(state)); không có nguồn dữ
//   liệu thứ hai, không điều khiển gì. Hình MINH HOẠ: không logo, không kiểu dáng của hãng nào.
// FALLBACK (về SVG 2D, không báo lỗi lên trang)
//   không có WebGL, `prefers-reduced-motion: reduce`, nút "Tắt hoạt ảnh", nút "Hình 2D" (nhớ trong
//   localStorage), `?3d=off`, chưa build bundle (/tru3d/tru3d.js → 404), không nạp được three.js
//   (/vendor/three/ → 404, ví dụ image Docker cài --omit=dev), hoặc cảnh 3D lỗi khi chạy.

const root = document.getElementById('tru');
const box = document.getElementById('tru3d');
const btn = document.getElementById('tru3dBtn');
const qs = new URLSearchParams(location.search);
const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function webglOk() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

let mod = null;
if (root && box && btn && !reduced && qs.get('3d') !== 'off' && webglOk()) {
  try {
    mod = await import('/tru3d/tru3d.js');
  } catch {
    // Chưa build (`npm run sim:tru3d:build`) hoặc thiếu three → hình 2D, không coi là lỗi.
    console.info('Hình 3D chưa có (chưa build bundle hoặc thiếu three) — dùng hình 2D');
  }
}
if (mod?.mount) start(mod);

function start(m) {
  const store = {
    get: (k) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        localStorage.setItem(k, v);
      } catch {
        /* chỉ mất việc nhớ lựa chọn */
      }
    },
  };
  let active = false;
  let broken = false;
  let want = store.get('tru.3d') !== '0';
  const ctl = m.mount(box, {
    initial: window.__truLast ?? null,
    // Cảnh 3D lỗi khi chạy (vd. mất context WebGL lúc tạo) → về 2D, ẩn nút 3D
    onFail() {
      broken = true;
      update();
    },
  });
  window.renderTru3d = (s) => ctl.update(s);

  function update() {
    const noanim = root.classList.contains('noanim');
    const collapsed = root.classList.contains('collapsed');
    const on = want && !noanim && !broken;
    btn.hidden = broken;
    btn.disabled = noanim;
    btn.title = noanim ? 'Đang tắt hoạt ảnh: hình 3D tắt, dùng hình 2D' : '';
    btn.textContent = on ? 'Hình 2D' : 'Hình 3D';
    btn.setAttribute('aria-pressed', String(on));
    box.hidden = !on;
    root.classList.toggle('has3d', on);
    const next = on && !collapsed && document.visibilityState !== 'hidden';
    if (next === active) return;
    active = next;
    if (active && window.__truLast) ctl.update(window.__truLast);
    ctl.setActive(active);
  }
  btn.onclick = () => {
    want = !want;
    store.set('tru.3d', want ? '1' : '0');
    update();
  };
  new MutationObserver(update).observe(root, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('visibilitychange', update);
  update();
}
