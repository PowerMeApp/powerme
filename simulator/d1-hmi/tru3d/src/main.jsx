// main.jsx — điểm vào bundle hình trụ 3D (QA-04). tru-3d.js (loader) import file build và gọi mount().
//
//   const ctl = mount(box, { onFail, quality })   // quality: 'auto' | 'lite' | 'hq' (xem Effects.jsx)
//   ctl.update(snapshot)   // mỗi snapshot SSE "state" — cùng dữ liệu với hình SVG 2D
//   ctl.setActive(bool)    // false → frameloop "never": không vẽ khung nào (ẩn tab, thu gọn, tắt 3D)
//
// Không có nguồn dữ liệu nào khác ngoài snapshot được đưa vào; không gọi API điều khiển trụ.
import { Canvas } from '@react-three/fiber';
import { Component, StrictMode, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import Effects from './Effects.jsx';
import Overlay from './Overlay.jsx';
import Scene from './Scene.jsx';
import { readPalette } from './motion.js';
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

function App({ store, quality, active, onFail }) {
  const level = useSyncExternalStore(quality.subscribe, quality.get);
  const high = level === 'high';
  return (
    <div className="t3-stage">
      <Guard onFail={onFail}>
        <Canvas
          className="t3-canvas"
          frameloop={active ? 'always' : 'never'}
          dpr={high ? [1, 2] : 1}
          gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
          camera={{ fov: 30, near: 0.1, far: 80, position: [0, 3.4, 17] }}
          onCreated={({ gl }) => {
            gl.toneMapping = THREE.ACESFilmicToneMapping;
            gl.toneMappingExposure = 1.0;
            gl.outputColorSpace = THREE.SRGBColorSpace;
          }}
        >
          <Scene store={store} high={high} />
          <Effects quality={quality} high={high} />
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
  const host = document.createElement('div');
  host.className = 't3-host';
  box.appendChild(host);
  const root = createRoot(host);
  let active = false;
  const render = () =>
    root.render(
      <StrictMode>
        <App store={store} quality={quality} active={active} onFail={onFail} />
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
