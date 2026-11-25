// tru-3d.js — hình trụ sạc 3D (three.js) trên trang từng trụ (QA-03).
//
// LÀM GÌ
//   Dựng một cảnh 3D tự vẽ bằng khối cơ bản: thân trụ, màn hình (chữ vẽ lên canvas), hai khay súng A/B
//   có đèn viền theo trạng thái OCPP (đúng bảng màu --lt-* và kiểu nháy trong README, mục "Hình trụ
//   sạc minh hoạ"), cáp có chấm chạy khi Charging, xe trượt đến khi cắm súng (thanh pin theo SoC),
//   ăng-ten theo trạng thái mạng. Kéo chuột để xoay, nhấp đúp để về góc nhìn ban đầu.
// VÌ SAO
//   Cùng snapshot SSE với hình SVG 2D (tru.html gọi window.renderTru3d(state)); không có nguồn dữ
//   liệu thứ hai, không điều khiển gì. Hình MINH HOẠ: không logo, không kiểu dáng của hãng nào.
// FALLBACK
//   Về hình SVG 2D (tru-sac.js) khi: không có WebGL, `prefers-reduced-motion: reduce`, nút "Tắt hoạt
//   ảnh", nút "Hình 2D", `?3d=off`, hoặc không nạp được three.js (/vendor/three/ trả 404 — ví dụ
//   image Docker cài --omit=dev). three.js do server.mjs phục vụ từ node_modules, không dùng CDN.

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

let THREE = null;
if (root && box && btn && !reduced && qs.get('3d') !== 'off' && webglOk()) {
  try {
    THREE = await import('/vendor/three/three.module.js');
  } catch (e) {
    console.warn('Không nạp được three.js — dùng hình 2D', e);
  }
}
if (THREE) start(THREE);

function start(T) {
  let raf = 0; // id requestAnimationFrame đang chờ
  let active = false; // 3D đang vẽ (bật, không tắt hoạt ảnh, không thu gọn, tab đang hiện)
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
  const css = getComputedStyle(document.documentElement);
  const cssColor = (name, fb) => new T.Color((css.getPropertyValue(name) || fb).trim() || fb);
  const LT = {};
  for (const st of [
    'Available',
    'Preparing',
    'Charging',
    'SuspendedEV',
    'SuspendedEVSE',
    'Finishing',
    'Faulted',
    'Unavailable',
    'Reserved',
  ])
    LT[st] = cssColor(`--lt-${st}`, '#8b97a6');
  const VI = {
    Available: 'Sẵn sàng',
    Preparing: 'Chuẩn bị',
    Charging: 'Đang sạc',
    SuspendedEV: 'Tạm dừng · xe tạm dừng',
    SuspendedEVSE: 'Tạm dừng · trụ tạm dừng',
    Finishing: 'Kết thúc',
    Faulted: 'Lỗi',
    Unavailable: 'Ngừng',
    Reserved: 'Đặt trước',
  };
  // Cường độ đèn 0..1 theo thời gian (giây) — bám bảng "Hình trụ sạc minh hoạ" trong README.
  function lightLevel(st, t) {
    switch (st) {
      case 'Preparing':
        return 0.55 + 0.45 * Math.cos((t * Math.PI * 2) / 2); // nhấp nháy chậm 2 s
      case 'Charging':
        return 0.5 + 0.5 * Math.sin((t * Math.PI * 2) / 3); // "thở" 3 s
      case 'SuspendedEV':
        return t % 1.6 < 0.8 ? 1 : 0.15; // nháy đều 1,6 s
      case 'SuspendedEVSE': {
        const u = t % 2; // xung đôi rồi nghỉ, chu kỳ 2 s
        return u < 0.2 || (u > 0.4 && u < 0.6) ? 1 : 0.15;
      }
      case 'Faulted':
        return t % 0.5 < 0.25 ? 1 : 0.1; // nháy nhanh 0,5 s
      default:
        return 1; // Available, Finishing, Unavailable, Reserved: tĩnh
    }
  }

  // ── Cảnh ────────────────────────────────────────────────────────────────
  const renderer = new T.WebGLRenderer({
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  box.appendChild(renderer.domElement);
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(32, 2, 0.1, 100);
  camera.position.set(0, 2.6, 11);
  camera.lookAt(0, 1.1, 0);
  scene.add(new T.HemisphereLight(0xffffff, 0x445566, 1.6));
  const sun = new T.DirectionalLight(0xffffff, 1.6);
  sun.position.set(4, 8, 6);
  scene.add(sun);
  const world = new T.Group();
  scene.add(world);
  const mat = (color, extra = {}) =>
    new T.MeshStandardMaterial({ color, roughness: 0.6, ...extra });
  const bodyC = cssColor('--tru-body', '#dde4ee');
  const edgeC = cssColor('--tru-edge', '#7f8ea3');
  const carC = cssColor('--tru-car', '#5d7a99');
  const glassC = cssColor('--tru-glass', '#cfe3f5');
  const cableC = cssColor('--tru-cable', '#3a4656');
  const add = (geo, m, x, y, z, parent = world) => {
    const o = new T.Mesh(geo, m);
    o.position.set(x, y, z);
    parent.add(o);
    return o;
  };

  // Nền
  const ground = add(new T.CircleGeometry(6.5, 48), mat(edgeC, { roughness: 1 }), 0, 0, 0);
  ground.rotation.x = -Math.PI / 2;
  ground.material.transparent = true;
  ground.material.opacity = 0.25;
  // Thân trụ + nắp + đế
  add(new T.BoxGeometry(1.7, 2.7, 0.75), mat(bodyC), 0, 1.4, 0);
  add(new T.BoxGeometry(1.85, 0.12, 0.85), mat(edgeC), 0, 2.8, 0);
  add(new T.BoxGeometry(1.9, 0.08, 0.9), mat(edgeC), 0, 0.04, 0);
  for (const y of [0.45, 0.58, 0.71])
    add(new T.BoxGeometry(1.1, 0.035, 0.02), mat(edgeC), 0, y, 0.38);
  // Màn hình: chữ vẽ lên canvas
  const scr = document.createElement('canvas');
  scr.width = 640;
  scr.height = 400;
  const sctx = scr.getContext('2d');
  const scrTex = new T.CanvasTexture(scr);
  scrTex.colorSpace = T.SRGBColorSpace;
  add(new T.BoxGeometry(1.4, 0.92, 0.04), mat(edgeC), 0, 1.85, 0.38);
  add(new T.PlaneGeometry(1.3, 0.82), new T.MeshBasicMaterial({ map: scrTex }), 0, 1.85, 0.405);
  // Ăng-ten
  add(new T.CylinderGeometry(0.025, 0.025, 0.45, 8), mat(edgeC), 0, 3.08, 0);
  const antTip = add(new T.SphereGeometry(0.08, 16, 12), new T.MeshBasicMaterial(), 0, 3.33, 0);

  // ── Hai súng + hai xe ───────────────────────────────────────────────────
  const guns = {};
  for (const id of [1, 2]) {
    const sg = id === 1 ? -1 : 1; // A bên trái, B bên phải
    const g = { id, sg, carP: 0, st: 'Unavailable', plugged: false, charging: false, kw: 0 };
    // Khay súng ở mặt bên thân trụ + vòng đèn
    const holsterX = sg * 0.88;
    add(new T.BoxGeometry(0.12, 0.62, 0.36), mat(edgeC), holsterX, 1.15, 0.05);
    g.ring = add(
      new T.TorusGeometry(0.24, 0.045, 12, 40),
      new T.MeshBasicMaterial({ color: LT.Unavailable }),
      holsterX + sg * 0.07,
      1.15,
      0.05,
    );
    g.ring.rotation.y = Math.PI / 2;
    g.ring.scale.set(1, 1.5, 1);
    g.holster = new T.Vector3(holsterX + sg * 0.1, 1.05, 0.05);
    // Đầu súng (di chuyển giữa khay và cổng sạc xe)
    g.head = add(new T.BoxGeometry(0.16, 0.16, 0.26), mat(cableC), 0, 0, 0);
    // Xe: thân dài theo trục z, cổng sạc ở mặt hướng về trụ
    const car = new T.Group();
    world.add(car);
    add(new T.BoxGeometry(1.1, 0.5, 2.3), mat(carC, { roughness: 0.35 }), 0, 0.5, 0, car);
    add(new T.BoxGeometry(0.95, 0.38, 1.2), mat(glassC, { roughness: 0.2 }), 0, 0.93, -0.1, car);
    for (const [wx, wz] of [
      [-0.55, -0.75],
      [0.55, -0.75],
      [-0.55, 0.75],
      [0.55, 0.75],
    ]) {
      const w = add(new T.CylinderGeometry(0.22, 0.22, 0.14, 20), mat(0x1b2430), wx, 0.22, wz, car);
      w.rotation.z = Math.PI / 2;
    }
    // Thanh pin trên nóc xe (đổ theo SoC)
    add(new T.BoxGeometry(0.1, 0.06, 1.0), mat(edgeC), 0, 1.16, -0.1, car);
    g.bat = add(
      new T.BoxGeometry(0.11, 0.07, 1.0),
      new T.MeshBasicMaterial({ color: LT.Charging }),
      0,
      1.17,
      -0.1,
      car,
    );
    g.car = car;
    car.visible = false;
    // Cáp + chấm chạy
    g.cableMat = mat(cableC, { roughness: 0.8 });
    g.cable = add(new T.BufferGeometry(), g.cableMat, 0, 0, 0);
    g.dots = [];
    for (let i = 0; i < 5; i++) {
      const d = add(
        new T.SphereGeometry(0.05, 10, 8),
        new T.MeshBasicMaterial({ color: LT.Charging }),
        0,
        0,
        0,
      );
      d.visible = false;
      g.dots.push(d);
    }
    guns[id] = g;
  }

  // ── Lớp chữ HTML phủ trên hình (nhãn súng, mạng, hàng đợi) ───────────────
  const ov = document.createElement('div');
  ov.className = 'tru-3d-ov';
  ov.innerHTML =
    '<div class="ov-a"></div><div class="ov-net"></div><div class="ov-b"></div>' +
    '<div class="ov-hint">Kéo chuột để xoay · nhấp đúp để về góc ban đầu</div>';
  box.appendChild(ov);
  const ovA = ov.querySelector('.ov-a');
  const ovB = ov.querySelector('.ov-b');
  const ovNet = ov.querySelector('.ov-net');

  // ── Dữ liệu ─────────────────────────────────────────────────────────────
  let snap = window.__truLast ?? null;
  let speed = 1;
  let net = 'offline';
  let screenKey = '';
  const pad = (n) => String(n).padStart(2, '0');
  const dur = (s) =>
    s >= 3600
      ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
      : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  function lcdRows(c) {
    const soc = c.soc == null ? '—' : c.soc.toFixed(1);
    switch (c.status) {
      case 'Available':
        return [
          ['Sẵn sàng', 44, '#35d07f'],
          ['quẹt thẻ hoặc', 28, '#9fb0c4'],
          ['quét QR', 28, '#9fb0c4'],
        ];
      case 'Preparing':
        return c.plugged
          ? [
              ['Đã cắm súng', 36, '#4aa3ff'],
              ['chờ lệnh / thẻ', 28, '#9fb0c4'],
            ]
          : [
              ['Cắm súng', 40, '#4aa3ff'],
              ['vào xe', 40, '#4aa3ff'],
            ];
      case 'Charging':
        return [
          [`${c.kw.toFixed(1)} kW`, 48, '#35d07f'],
          [`${c.kwh.toFixed(2)} kWh`, 32, '#e8eef5'],
          [`SoC ${soc} %`, 30, '#e8eef5'],
          [dur(c.elapsed), 28, '#9fb0c4'],
        ];
      case 'SuspendedEV':
      case 'SuspendedEVSE':
        return [
          [c.status === 'SuspendedEV' ? 'Xe tạm dừng' : 'Trụ tạm dừng', 34, '#f0b04a'],
          [`SoC ${soc} %`, 30, '#e8eef5'],
        ];
      case 'Finishing':
        return [
          ['Rút súng', 42, '#a78bfa'],
          [`${c.kwh.toFixed(2)} kWh`, 30, '#e8eef5'],
        ];
      case 'Faulted':
        return [
          ['LỖI', 48, '#ff4d57'],
          [String(c.errorCode).slice(0, 18), 24, '#f0b04a'],
        ];
      case 'Reserved':
        return [['Đã đặt trước', 34, '#2cc3b8']];
      default:
        return [
          ['Ngừng', 40, '#8b97a6'],
          ['phục vụ', 40, '#8b97a6'],
        ];
    }
  }
  function drawScreen(s) {
    const n = s.net;
    const strip =
      n.state === 'online'
        ? [`PowerMe · ${s.simTime.slice(11, 16)} UTC`, '#9fb0c4']
        : n.state === 'offline'
          ? [
              n.nextRetrySec != null
                ? `Mất kết nối — thử lại sau ${n.nextRetrySec} s`
                : 'Mất kết nối',
              '#ff4d57',
            ]
          : ['Đang nối lại máy chủ...', '#f0b04a'];
    const halves = s.connectors.map(lcdRows);
    const key = JSON.stringify([strip, halves]);
    if (key === screenKey) return;
    screenKey = key;
    const W = scr.width;
    const H = scr.height;
    sctx.fillStyle = '#0b1622';
    sctx.fillRect(0, 0, W, H);
    sctx.fillStyle = '#132538';
    sctx.fillRect(0, 0, W, 64);
    sctx.textAlign = 'center';
    sctx.textBaseline = 'middle';
    sctx.font = '600 30px "Segoe UI", system-ui, sans-serif';
    sctx.fillStyle = strip[1];
    sctx.fillText(strip[0], W / 2, 34);
    sctx.strokeStyle = '#2c3b4d';
    sctx.lineWidth = 3;
    sctx.beginPath();
    sctx.moveTo(W / 2, 80);
    sctx.lineTo(W / 2, H - 16);
    sctx.stroke();
    halves.forEach((rows, i) => {
      const cx = i === 0 ? W / 4 : (3 * W) / 4;
      sctx.font = '700 26px "Segoe UI", system-ui, sans-serif';
      sctx.fillStyle = '#9fb0c4';
      sctx.fillText(i === 0 ? 'SÚNG A' : 'SÚNG B', cx, 104);
      let y = 160;
      for (const [t, size, color] of rows) {
        sctx.font = `700 ${size}px "Segoe UI", system-ui, sans-serif`;
        sctx.fillStyle = color;
        sctx.fillText(t, cx, y);
        y += size + 18;
      }
    });
    scrTex.needsUpdate = true;
  }
  function apply(s) {
    snap = s;
    if (!s) return;
    speed = s.speed;
    net = s.net.state;
    for (const c of s.connectors) {
      const g = guns[c.id];
      if (!g) continue;
      g.st = LT[c.status] ? c.status : 'Unavailable';
      g.plugged = !!c.plugged;
      // Lần đầu có dữ liệu: đặt xe đúng chỗ ngay, không cho trượt vào khi vừa mở trang
      if (!g.seen) g.carP = g.plugged ? 1 : 0;
      g.seen = true;
      g.charging = g.st === 'Charging';
      g.kw = c.kw;
      g.soc = c.soc ?? 0;
    }
    const lab = (c) =>
      `Súng ${c.label} · ${VI[c.status] ?? c.status} (${c.status})${c.txActive ? ` · ${c.kw.toFixed(1)} kW · ${c.kwh.toFixed(2)} kWh` : ''}`;
    ovA.textContent = lab(s.connectors[0]);
    ovB.textContent = lab(s.connectors[1]);
    ovA.style.borderColor = `var(--lt-${guns[1].st})`;
    ovB.style.borderColor = `var(--lt-${guns[2].st})`;
    ovNet.textContent =
      { online: 'Mạng: online', offline: 'Mạng: MẤT KẾT NỐI', connecting: 'Mạng: đang nối...' }[
        net
      ] +
      (s.net.halfOpen ? ' (half-open)' : '') +
      (s.queue.total ? ` · ${s.queue.total} bản tin chờ phát bù` : '');
    drawScreen(s);
  }
  window.renderTru3d = (s) => {
    if (active) apply(s);
    else snap = s;
  };

  // ── Hình học cập nhật mỗi khung ─────────────────────────────────────────
  const tmp = new T.Vector3();
  function cableCurve(g) {
    const portX = g.sg * (2.75 - 0.55 + (1 - g.carP) * 6);
    if (g.plugged && g.carP > 0.02) {
      const port = new T.Vector3(portX - g.sg * 0.05, 0.62, 0.55);
      return {
        curve: new T.CatmullRomCurve3([
          g.holster.clone(),
          new T.Vector3(g.sg * 1.1, 0.5, 0.35),
          new T.Vector3(g.sg * 1.6, 0.12, 0.55),
          port,
        ]),
        head: port,
      };
    }
    const h = g.holster;
    return {
      curve: new T.CatmullRomCurve3([
        h.clone(),
        new T.Vector3(h.x + g.sg * 0.2, 0.45, 0.3),
        new T.Vector3(h.x + g.sg * 0.08, 0.2, 0.15),
        new T.Vector3(h.x + g.sg * 0.12, 0.85, 0.12),
      ]),
      head: new T.Vector3(h.x + g.sg * 0.12, 1.2, 0.12),
    };
  }
  let clock = performance.now();
  let tSec = 0;
  function frame(now) {
    raf = 0;
    if (!active) return;
    // mốc rAF có thể sớm hơn performance.now() lúc bật → kẹp về 0, không để thời gian chạy lùi
    const dt = Math.max(0, Math.min(0.1, (now - clock) / 1000));
    clock = now;
    tSec += dt;
    antTip.material.color.set(
      net === 'online' ? LT.Available : net === 'connecting' ? LT.SuspendedEV : LT.Faulted,
    );
    for (const g of Object.values(guns)) {
      const lvl = lightLevel(g.st, tSec);
      g.ring.material.color.copy(LT[g.st]).multiplyScalar(0.25 + 0.75 * lvl);
      // Xe trượt đến khi cắm súng, đi khi rút
      const target = g.plugged ? 1 : 0;
      g.carP += (target - g.carP) * Math.min(1, dt * 2.5);
      if (Math.abs(target - g.carP) < 0.002) g.carP = target;
      g.car.visible = g.carP > 0.01;
      g.car.position.set(g.sg * (2.75 + (1 - g.carP) * 6), 0, 0.3);
      g.bat.scale.z = Math.max(0.02, Math.min(1, g.soc / 100));
      g.bat.position.z = -0.1 - 0.5 * (1 - g.bat.scale.z);
      const { curve, head } = cableCurve(g);
      g.cable.geometry.dispose();
      g.cable.geometry = new T.TubeGeometry(curve, 48, 0.04, 8, false);
      g.head.position.copy(head);
      // Chấm chạy dọc cáp khi Charging: tốc độ theo kW, ×10/×20 nhanh gấp đôi (như hình 2D)
      const v = (0.12 + g.kw / 500) * (speed > 1 ? 2 : 1);
      g.dots.forEach((d, i) => {
        d.visible = g.charging && g.plugged && g.carP > 0.9;
        if (!d.visible) return;
        const u = (tSec * v + i / g.dots.length) % 1;
        curve.getPointAt(u, tmp);
        d.position.copy(tmp);
      });
    }
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }

  // ── Kéo để xoay ─────────────────────────────────────────────────────────
  let drag = null;
  const cv = renderer.domElement;
  cv.style.touchAction = 'none';
  cv.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, ry: world.rotation.y, rx: world.rotation.x };
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    world.rotation.y = drag.ry + (e.clientX - drag.x) * 0.008;
    world.rotation.x = Math.max(-0.25, Math.min(0.45, drag.rx + (e.clientY - drag.y) * 0.004));
  });
  const endDrag = () => (drag = null);
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', endDrag);
  cv.addEventListener('dblclick', () => world.rotation.set(0, 0, 0));

  function resize() {
    const w = box.clientWidth || 800;
    const h = Math.round(Math.min(w * 0.42, window.innerHeight * 0.6, 520));
    renderer.setSize(w, h, false);
    cv.style.width = '100%';
    cv.style.height = h + 'px';
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(box);

  // ── Bật/tắt 3D ──────────────────────────────────────────────────────────
  let want = store.get('tru.3d') !== '0';
  function update() {
    const noanim = root.classList.contains('noanim');
    const collapsed = root.classList.contains('collapsed');
    const next = want && !noanim && !collapsed && document.visibilityState !== 'hidden';
    btn.hidden = false;
    btn.disabled = noanim;
    btn.title = noanim ? 'Đang tắt hoạt ảnh: hình 3D tắt, dùng hình 2D' : '';
    btn.textContent = want && !noanim ? 'Hình 2D' : 'Hình 3D';
    btn.setAttribute('aria-pressed', String(want && !noanim));
    box.hidden = !(want && !noanim);
    root.classList.toggle('has3d', want && !noanim);
    if (next === active) return;
    active = next;
    if (active) {
      resize();
      apply(snap ?? window.__truLast ?? null);
      clock = performance.now();
      if (!raf) raf = requestAnimationFrame(frame);
    } else if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
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
