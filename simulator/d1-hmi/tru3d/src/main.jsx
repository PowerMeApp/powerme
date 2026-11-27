// main.jsx — điểm vào bundle hình trụ 3D (QA-04). tru-3d.js (loader) import file build và gọi mount().
//
//   const ctl = mount(box, { onFail, quality })   // quality: 'auto' | 'lite' | 'hq' (xem Effects.jsx)
//   ctl.update(snapshot)   // mỗi snapshot SSE "state" — cùng dữ liệu với hình SVG 2D
//   ctl.setActive(bool)    // false → frameloop "never": không vẽ khung nào (ẩn tab, thu gọn, tắt 3D)
//
// Giao diện (QA-06): giao diện sáng → cảnh SÁNG trên canvas trong suốt (nền là gradient Hero Sky của
// khung CSS, sàn trắng mờ dần, bóng tiếp xúc, quầng màu trạng thái nhẹ); giao diện tối → cảnh tối cũ
// trong thẻ Charcoal. Chọn một lần lúc mount theo --t3-scene (motion.js readSceneTheme).
//
// Không có nguồn dữ liệu nào khác ngoài snapshot được đưa vào; không gọi API điều khiển trụ.
import { Canvas } from '@react-three/fiber';
import { Component, StrictMode, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import Effects from './Effects.jsx';
import Overlay from './Overlay.jsx';
import Scene from './Scene.jsx';
import { readPalette, readSceneTheme } from './motion.js';
import css from './tru3d.css?inline';

function createStore(initial) {
  let snap = initial ?? null;
  const subs = new Set();
  return {
    lt: readPalette(),
    get: () => snap,
    set(s) {
      snap = s;
      for (const f of subs) f();
    },
    subscribe(f) {
      subs.add(f);
      return () => subs.delete(f);
    },
  };
}

// Chất lượng vẽ: 'high' (bloom + phản chiếu) hoặc 'lite'. Chỉ đi một chiều high → lite.
function createQuality(mode) {
  const m = mode === 'lite' || mode === 'hq' ? mode : 'auto';
  let level = m === 'lite' ? 'lite' : 'high';
  const subs = new Set();
  return {
    mode: m,
    get: () => level,
    downgrade() {
      if (level === 'lite' || m === 'hq') return;
      level = 'lite';
      console.info('Hình 3D: FPS thấp — chuyển chế độ nhẹ (tắt bloom và phản chiếu)');
      for (const f of subs) f();
    },
    subscribe(f) {
      subs.add(f);
      return () => subs.delete(f);
    },
  };
}

class Guard extends Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e) {
    console.warn('Hình 3D lỗi — dùng hình 2D', e);
    this.props.onFail?.();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function App({ store, quality, active, onFail, light }) {
  const level = useSyncExternalStore(quality.subscribe, quality.get);
  const high = level === 'high';
  return (
    <div className="t3-stage">
      <Guard onFail={onFail}>
        <Canvas
          className="t3-canvas"
          frameloop={active ? 'always' : 'never'}
          dpr={high ? [1, 2] : 1}
          gl={{ antialias: true, alpha: light, powerPreference: 'high-performance' }}
          camera={{ fov: 30, near: 0.1, far: 80, position: [0, 3.4, 17] }}
          onCreated={({ gl }) => {
            gl.toneMapping = THREE.ACESFilmicToneMapping;
            gl.toneMappingExposure = light ? 1.05 : 1.0;
            gl.outputColorSpace = THREE.SRGBColorSpace;
            // cảnh sáng: xoá về trong suốt để lộ gradient Hero Sky của khung CSS phía sau canvas
            if (light) gl.setClearColor(0x000000, 0);
          }}
        >
          <Scene store={store} high={high} light={light} />
          <Effects quality={quality} high={high} light={light} />
        </Canvas>
      </Guard>
      <Overlay store={store} lite={!high} />
    </div>
  );
}

export function mount(box, { initial, onFail, quality: mode } = {}) {
  if (!document.getElementById('tru3d-css')) {
    const tag = document.createElement('style');
    tag.id = 'tru3d-css';
    tag.textContent = css;
    document.head.appendChild(tag);
  }
  const store = createStore(initial);
  const quality = createQuality(mode);
  const light = readSceneTheme() === 'light';
  box.classList.toggle('t3-light', light);
  box.classList.toggle('t3-dark', !light);
  const host = document.createElement('div');
  host.className = 't3-host';
  box.appendChild(host);
  const root = createRoot(host);
  let active = false;
  const render = () =>
    root.render(
      <StrictMode>
        <App store={store} quality={quality} active={active} onFail={onFail} light={light} />
      </StrictMode>,
    );
  render();
  return {
    update: (s) => store.set(s),
    setActive(a) {
      if (a === active) return;
      active = a;
      render();
    },
    unmount() {
      root.unmount();
      host.remove();
    },
  };
}
