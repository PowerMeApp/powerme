// Scene.jsx — cảnh 3D trụ sạc DC hai súng (react-three-fiber).
//
// Mọi thứ chỉ PHẢN ÁNH snapshot SSE trong `store` (cùng snapshot với hình 2D); không có nút điều
// khiển trụ. Hình minh hoạ tự dựng: không logo, không kiểu dáng của hãng nào.
//
// Toạ độ: đơn vị ~ mét. Trụ ở gốc, cao ~2,4. Súng A bên trái (sg = -1), súng B bên phải (sg = +1).
// Mọi chuyển động đi qua spring/damp (motion.js), không nội suy tuyến tính.
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import {
  MOOD_GAIN,
  clamp01,
  damp,
  knownStatus,
  lightLevel,
  moodColor,
  moodOf,
  smooth,
  speedFactor,
  spring,
} from './motion.js';
import { SCREEN_H, SCREEN_W, drawScreen } from './screen.js';

const TARGET = new THREE.Vector3(0, 1.12, 0);
const HOME = { radius: 10.4, phi: 1.36, theta: 0.12 };
const CAR_X = 2.95; // tâm xe khi đỗ (|x|)
const CAR_AWAY = 9; // xe đi xa thêm bao nhiêu khi chưa cắm
const CAR_Z = 0.22;
const N_DOTS = 12;

// ── Tiện ích hình học / texture ────────────────────────────────────────────
function RBox({ args, r = 0.05, seg = 4, material, ...props }) {
  const [w, h, d] = args;
  const geo = useMemo(() => new RoundedBoxGeometry(w, h, d, seg, r), [w, h, d, seg, r]);
  useEffect(() => () => geo.dispose(), [geo]);
  return <mesh geometry={geo} material={material} {...props} />;
}

function radialTexture(stops) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  for (const [o, col] of stops) g.addColorStop(o, col);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Quầng sáng: shader radial cộng màu (additive), không ghi depth.
const glowVert = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const glowFrag = /* glsl */ `
  uniform vec3 uColor;
  uniform float uGain;
  uniform float uPow;
  varying vec2 vUv;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float a = pow(clamp(1.0 - d, 0.0, 1.0), uPow) * uGain;
    gl_FragColor = vec4(uColor * a, a);
    #include <colorspace_fragment>
  }
`;
function glowMaterial(pow) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color('#7d8da3') },
      uGain: { value: 0.3 },
      uPow: { value: pow },
    },
    vertexShader: glowVert,
    fragmentShader: glowFrag,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
}

// ── Vật liệu dùng chung ────────────────────────────────────────────────────
function useMaterials() {
  return useMemo(() => {
    const phys = (o) => new THREE.MeshPhysicalMaterial(o);
    const glow = (color) => new THREE.MeshBasicMaterial({ color, toneMapped: false });
    return {
      graphite: phys({
        color: '#262b33',
        metalness: 0.72,
        roughness: 0.34,
        clearcoat: 1,
        clearcoatRoughness: 0.18,
      }),
      alu: phys({
        color: '#b4bcc6',
        metalness: 1,
        roughness: 0.36,
        clearcoat: 0.5,
        clearcoatRoughness: 0.25,
      }),
      darkMetal: phys({ color: '#0e1013', metalness: 0.6, roughness: 0.45 }),
      bezel: phys({
        color: '#040506',
        metalness: 0.2,
        roughness: 0.15,
        clearcoat: 1,
        clearcoatRoughness: 0.05,
      }),
      glass: phys({
        color: '#ffffff',
        metalness: 0,
        roughness: 0.06,
        transmission: 0.92,
        thickness: 0.02,
        ior: 1.45,
        clearcoat: 1,
        clearcoatRoughness: 0.04,
        transparent: true,
        opacity: 1,
      }),
      frost: phys({
        color: '#9fb4c8',
        metalness: 0,
        roughness: 0.42,
        transmission: 0.6,
        thickness: 0.05,
        transparent: true,
        opacity: 0.55,
      }),
      rubber: phys({ color: '#14171c', metalness: 0.1, roughness: 0.55, clearcoat: 0.35 }),
      tire: new THREE.MeshStandardMaterial({ color: '#0b0c0e', roughness: 0.9 }),
      paintA: phys({
        color: '#d7dce3',
        metalness: 0.55,
        roughness: 0.32,
        clearcoat: 1,
        clearcoatRoughness: 0.08,
      }),
      paintB: phys({
        color: '#344d6b',
        metalness: 0.6,
        roughness: 0.3,
        clearcoat: 1,
        clearcoatRoughness: 0.08,
      }),
      cabin: phys({
        color: '#05080c',
        metalness: 0.3,
        roughness: 0.08,
        clearcoat: 1,
        clearcoatRoughness: 0.03,
      }),
      blob: new THREE.MeshBasicMaterial({
        map: radialTexture([
          [0, 'rgba(0,0,0,0.85)'],
          [0.45, 'rgba(0,0,0,0.45)'],
          [1, 'rgba(0,0,0,0)'],
        ]),
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      }),
      head: glow('#e6f0ff'),
      tail: glow('#7a1820'),
      glow,
    };
  }, []);
}

// ── Ánh sáng studio ────────────────────────────────────────────────────────
function Studio({ store }) {
  const { gl, scene } = useThree();
  const rim = useRef();
  useEffect(() => {
    const pm = new THREE.PMREMGenerator(gl);
    const env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    scene.environmentIntensity = 0.62;
    return () => {
      scene.environment = null;
      env.dispose();
      pm.dispose();
    };
  }, [gl, scene]);
  const target = useMemo(() => new THREE.Color(), []);
  useFrame((_, dt) => {
    const s = store.get();
    const mood = moodOf(s?.connectors);
    target.set(moodColor(mood, store.lt));
    rim.current.color.lerp(target, 1 - Math.exp(-3 * dt));
    rim.current.intensity = damp(rim.current.intensity, 5 + 9 * MOOD_GAIN[mood], 3, dt);
  });
  return (
    <>
      <ambientLight intensity={0.08} />
      <directionalLight position={[3.5, 7, 6]} intensity={1.15} color="#fff6ec" />
      <directionalLight position={[-6, 4, 3]} intensity={0.35} color="#cfe0ff" />
      {/* đèn viền phía sau, màu theo trạng thái → mép thân trụ ánh màu */}
      <pointLight ref={rim} position={[0, 2.1, -1.6]} distance={7} decay={1.6} intensity={6} />
    </>
  );
}

// ── Nền, bóng mềm, quầng sáng ──────────────────────────────────────────────
function Stage({ store, M }) {
  const halo = useRef();
  const { camera } = useThree();
  const tex = useMemo(
    () => ({
      floorAlpha: radialTexture([
        [0, '#ffffff'],
        [0.45, '#9a9a9a'],
        [1, '#000000'],
      ]),
    }),
    [],
  );
  const mats = useMemo(
    () => ({
      floor: new THREE.MeshStandardMaterial({
        color: '#0b0d10',
        roughness: 0.5,
        metalness: 0.25,
        alphaMap: tex.floorAlpha,
        transparent: true,
        depthWrite: false,
      }),
      halo: glowMaterial(2.1),
      pool: glowMaterial(1.6),
      ring: new THREE.MeshBasicMaterial({
        color: '#7d8da3',
        transparent: true,
        opacity: 0.4,
        toneMapped: false,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    }),
    [tex],
  );
  const c = useMemo(() => new THREE.Color(), []);
  const gain = useRef(0.3);
  useFrame((st, dt) => {
    const s = store.get();
    const mood = moodOf(s?.connectors);
    c.set(moodColor(mood, store.lt));
    const t = st.clock.elapsedTime;
    const breathe = mood === 'charge' ? 0.88 + 0.12 * Math.sin((t * Math.PI * 2) / 3) : 1;
    gain.current = damp(gain.current, MOOD_GAIN[mood], 2.2, dt);
    for (const m of [mats.halo, mats.pool])
      m.uniforms.uColor.value.lerp(c, 1 - Math.exp(-2.5 * dt));
    mats.halo.uniforms.uGain.value = 0.62 * gain.current * breathe;
    mats.pool.uniforms.uGain.value = 0.42 * gain.current * breathe;
    mats.ring.color.copy(mats.halo.uniforms.uColor.value);
    mats.ring.opacity = 0.18 + 0.5 * gain.current * breathe;
    // quầng luôn quay mặt về camera (billboard) để kéo xoay vẫn tròn
    halo.current.quaternion.copy(camera.quaternion);
  });
  return (
    <>
      <mesh rotation-x={-Math.PI / 2} material={mats.floor} renderOrder={-2}>
        <circleGeometry args={[15, 96]} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.004} material={mats.pool} renderOrder={-1}>
        <planeGeometry args={[7.5, 7.5]} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.006} material={mats.ring}>
        <ringGeometry args={[1.46, 1.485, 128]} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.008} material={M.blob}>
        <planeGeometry args={[2.6, 1.7]} />
      </mesh>
      <mesh ref={halo} position={[0, 1.45, -1.4]} material={mats.halo} renderOrder={-1}>
        <planeGeometry args={[9, 9]} />
      </mesh>
    </>
  );
}

// ── Thân trụ: màn hình, đầu đọc RFID, dải đèn đỉnh, ăng-ten ───────────────
function Station({ store, M }) {
  const scr = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = SCREEN_W;
    canvas.height = SCREEN_H;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return { ctx: canvas.getContext('2d'), tex, key: '' };
  }, []);
  const screenMat = useMemo(
    () => new THREE.MeshBasicMaterial({ map: scr.tex, toneMapped: false }),
    [scr],
  );
  const topMat = useMemo(() => M.glow('#7d8da3'), [M]);
  const padMat = useMemo(() => M.glow('#4aa3ff'), [M]);
  const c = useMemo(() => new THREE.Color(), []);
  const padLvl = useRef(0.3);
  useFrame((st, dt) => {
    const s = store.get();
    if (!s) return;
    const key = drawScreen(scr.ctx, s, store.lt, scr.key);
    if (key !== scr.key) {
      scr.key = key;
      scr.tex.needsUpdate = true;
    }
    const mood = moodOf(s.connectors);
    c.set(moodColor(mood, store.lt));
    topMat.color.lerp(c.multiplyScalar(0.35 + 1.1 * MOOD_GAIN[mood]), 1 - Math.exp(-3 * dt));
    // Đầu đọc RFID: sáng nhịp khi đang chờ CSMS trả lời một lần quẹt (readerPending)
    const t = st.clock.elapsedTime;
    const waiting = s.connectors.some((x) => x.readerPending);
    const goal = waiting ? 0.6 + 0.6 * Math.abs(Math.sin(t * 4)) : 0.28;
    padLvl.current = damp(padLvl.current, goal, waiting ? 14 : 3, dt);
    padMat.color.set(store.lt.Preparing).multiplyScalar(padLvl.current);
  });
  return (
    <group>
      {/* đế + thân + mặt nhôm */}
      <RBox args={[1.72, 0.1, 0.92]} r={0.03} material={M.darkMetal} position-y={0.05} />
      <RBox args={[1.5, 2.3, 0.72]} r={0.13} seg={6} material={M.graphite} position-y={1.25} />
      <RBox args={[1.32, 2.06, 0.04]} r={0.06} material={M.alu} position={[0, 1.24, 0.355]} />
      {/* nắp + dải đèn đỉnh (màu theo trạng thái chung) */}
      <RBox args={[1.56, 0.05, 0.78]} r={0.022} material={M.darkMetal} position-y={2.42} />
      <mesh position={[0, 2.385, 0.405]} material={topMat}>
        <boxGeometry args={[1.18, 0.016, 0.01]} />
      </mesh>
      {/* màn hình phát sáng sau lớp kính */}
      <RBox args={[1.18, 0.78, 0.03]} r={0.03} material={M.bezel} position={[0, 1.78, 0.38]} />
      <mesh position={[0, 1.78, 0.397]} material={screenMat}>
        <planeGeometry args={[1.08, 0.675]} />
      </mesh>
      <RBox args={[1.14, 0.74, 0.012]} r={0.006} material={M.glass} position={[0, 1.78, 0.405]} />
      {/* đầu đọc RFID: tấm kính mờ + ký hiệu không tiếp xúc */}
      <RBox args={[0.46, 0.28, 0.03]} r={0.04} material={M.bezel} position={[0, 1.17, 0.385]} />
      <group position={[0, 1.17, 0.402]}>
        {[0.045, 0.075, 0.105].map((rad) => (
          <mesh key={rad} material={padMat} rotation-z={-Math.PI / 4} position-x={-0.05}>
            <torusGeometry args={[rad, 0.006, 6, 24, Math.PI / 2]} />
          </mesh>
        ))}
      </group>
      <RBox args={[0.44, 0.26, 0.008]} r={0.03} material={M.frost} position={[0, 1.17, 0.405]} />
      {/* khe tản nhiệt */}
      {[0.44, 0.53, 0.62].map((y) => (
        <RBox
          key={y}
          args={[0.86, 0.022, 0.01]}
          r={0.008}
          material={M.darkMetal}
          position={[0, y, 0.38]}
        />
      ))}
      <Antenna store={store} M={M} />
    </group>
  );
}

function Antenna({ store, M }) {
  const tipMat = useMemo(() => M.glow('#35d07f'), [M]);
  const arcMats = useMemo(() => [0, 1, 2].map(() => M.glow('#35d07f')), [M]);
  const base = useMemo(() => new THREE.Color(), []);
  const cur = useMemo(() => new THREE.Color('#8b97a6'), []);
  useFrame((st, dt) => {
    const s = store.get();
    if (!s) return;
    const lt = store.lt;
    const n = s.net;
    const mode = n.halfOpen ? 'half' : n.state; // online | connecting | offline | half
    base.set(mode === 'online' ? lt.Available : mode === 'offline' ? lt.Faulted : lt.SuspendedEV);
    cur.lerp(base, 1 - Math.exp(-4 * dt));
    const t = st.clock.elapsedTime;
    const tip =
      mode === 'online'
        ? 1
        : mode === 'connecting'
          ? 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2))
          : mode === 'half'
            ? Math.sin(t * 13) > 0.6
              ? 0.3
              : 1
            : 0.55 + 0.45 * (t % 1 < 0.5 ? 1 : 0);
    tipMat.color.copy(cur).multiplyScalar(0.4 + 0.9 * tip);
    arcMats.forEach((m, i) => {
      let lvl;
      if (mode === 'online') {
        // sóng toả ra đều, chu kỳ 1,8 s
        const ph = (((t / 1.8 - i * 0.22) % 1) + 1) % 1;
        lvl = 0.25 + 0.75 * Math.exp(-ph * 4);
      } else if (mode === 'connecting') {
        lvl = Math.floor(t * 3) % 3 === i ? 1 : 0.12; // quét từng vạch
      } else if (mode === 'half') {
        lvl = i === 2 ? 0.05 : i === 1 ? (Math.sin(t * 9) > 0 ? 0.7 : 0.1) : 0.8; // chập chờn
      } else {
        lvl = 0.05; // offline: tắt
      }
      m.color.copy(cur).multiplyScalar(lvl * 1.2);
    });
  });
  return (
    <group position={[0.5, 2.45, -0.16]}>
      <mesh material={M.darkMetal} position-y={0.17}>
        <cylinderGeometry args={[0.014, 0.02, 0.34, 10]} />
      </mesh>
      <mesh material={tipMat} position-y={0.36}>
        <sphereGeometry args={[0.035, 16, 12]} />
      </mesh>
      {[0.09, 0.15, 0.21].map((rad, i) => (
        <mesh key={rad} material={arcMats[i]} position-y={0.36} rotation-z={Math.PI / 4}>
          <torusGeometry args={[rad, 0.008, 6, 28, Math.PI / 2]} />
        </mesh>
      ))}
    </group>
  );
}

// ── Xe minh hoạ low-poly (đuôi xe hướng về trụ, cổng sạc ở hông sau) ──────
function useCabinGeometry() {
  return useMemo(() => {
    const sh = new THREE.Shape();
    sh.moveTo(-0.98, 0);
    sh.lineTo(1.22, 0);
    sh.lineTo(0.86, 0.43);
    sh.lineTo(-0.2, 0.46);
    sh.lineTo(-0.72, 0.06);
    sh.closePath();
    const g = new THREE.ExtrudeGeometry(sh, {
      depth: 1.04,
      bevelEnabled: true,
      bevelThickness: 0.04,
      bevelSize: 0.04,
      bevelSegments: 2,
    });
    g.translate(0, 0, -0.52);
    return g;
  }, []);
}

const PORT_LOCAL = new THREE.Vector3(1.24, 0.82, 0.7);

function Car({ M, paint, mirror, carRef, batFill, batMat, portMat }) {
  const cabin = useCabinGeometry();
  const track = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        color: '#ffffff',
        transmission: 0.7,
        roughness: 0.3,
        thickness: 0.05,
        transparent: true,
        opacity: 0.35,
      }),
    [],
  );
  return (
    <group ref={carRef} scale-x={mirror ? -1 : 1} visible={false}>
      <RBox args={[3.1, 0.5, 1.38]} r={0.17} seg={5} material={paint} position-y={0.5} />
      <mesh geometry={cabin} material={M.cabin} position-y={0.73} />
      {[
        [-1.0, 0.62],
        [1.0, 0.62],
        [-1.0, -0.62],
        [1.0, -0.62],
      ].map(([x, z]) => (
        <group key={`${x}${z}`} position={[x, 0.31, z]} rotation-x={Math.PI / 2}>
          <mesh material={M.tire}>
            <cylinderGeometry args={[0.31, 0.31, 0.22, 28]} />
          </mesh>
          <mesh material={M.graphite}>
            <cylinderGeometry args={[0.2, 0.2, 0.226, 20]} />
          </mesh>
        </group>
      ))}
      {/* đèn pha (mũi, -x) và đèn hậu (đuôi, +x) */}
      <mesh position={[-1.56, 0.6, 0]} material={M.head}>
        <boxGeometry args={[0.02, 0.05, 1.04]} />
      </mesh>
      <mesh position={[1.56, 0.62, 0]} material={M.tail}>
        <boxGeometry args={[0.012, 0.03, 1.1]} />
      </mesh>
      {/* cổng sạc ở hông sau, phía camera */}
      <mesh position={PORT_LOCAL} rotation-x={Math.PI / 2} material={M.bezel}>
        <cylinderGeometry args={[0.07, 0.07, 0.02, 24]} />
      </mesh>
      <mesh position={[PORT_LOCAL.x, PORT_LOCAL.y, PORT_LOCAL.z + 0.012]} material={portMat}>
        <torusGeometry args={[0.075, 0.01, 8, 28]} />
      </mesh>
      {/* thanh pin nổi trên nóc, đổ theo SoC */}
      <group position={[0.1, 1.62, 0]}>
        <RBox args={[1.5, 0.1, 0.1]} r={0.045} material={track} />
        <RBox args={[0.05, 0.05, 0.05]} r={0.015} material={track} position-x={0.79} />
        <RBox ref={batFill} args={[1.44, 0.064, 0.064]} r={0.03} material={batMat} />
      </group>
    </group>
  );
}

// ── Một khoang súng: khay + vòng đèn + dải đèn mép + cáp + hạt năng lượng + xe ──
function Bay({ id, store, M }) {
  const sg = id === 1 ? -1 : 1;
  const carRef = useRef();
  const blobRef = useRef();
  const headRef = useRef();
  const batFill = useRef();
  const dots = useRef();
  const halos = useRef();
  const mats = useMemo(
    () => ({
      ring: M.glow('#8b97a6'),
      strip: M.glow('#8b97a6'),
      port: M.glow('#8b97a6'),
      tip: M.glow('#8b97a6'),
      bat: M.glow('#35d07f'),
      dot: new THREE.MeshBasicMaterial({ color: '#35d07f', toneMapped: false }),
      dotHalo: new THREE.MeshBasicMaterial({
        color: '#35d07f',
        toneMapped: false,
        transparent: true,
        opacity: 0.22,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    }),
    [M],
  );
  const cable = useRef();
  const st8 = useRef({
    seen: false,
    car: { x: 0, v: 0 },
    gun: { x: 0, v: 0 },
    soc: 0,
    base: new THREE.Color('#8b97a6'),
    goal: new THREE.Color(),
    bat: new THREE.Color('#35d07f'),
    last: '',
    curve: null,
    phase: 0,
  });
  const tmp = useMemo(
    () => ({
      v: new THREE.Vector3(),
      port: new THREE.Vector3(),
      head: new THREE.Vector3(),
      qDock: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, (sg * Math.PI) / 2)),
      qPlug: new THREE.Quaternion().setFromEuler(new THREE.Euler(-1.0, 0, 0)),
      q: new THREE.Quaternion(),
      m: new THREE.Matrix4(),
      s: new THREE.Vector3(),
      pts: Array.from({ length: 6 }, () => new THREE.Vector3()),
    }),
    [sg],
  );
  // Cáp: CatmullRom qua 6 điểm; nội suy điểm giữa vị trí "trên khay" và "đang cắm".
  const dockPts = useMemo(
    () => [
      [sg * 0.74, 0.42, 0.06],
      [sg * 0.96, 0.15, 0.24],
      [sg * 1.18, 0.14, 0.3],
      [sg * 1.34, 0.55, 0.24],
    ],
    [sg],
  );

  useFrame((frame, dt) => {
    const s = store.get();
    const c = s?.connectors?.find((x) => x.id === id);
    if (!c) return;
    const S = st8.current;
    const lt = store.lt;
    const st = knownStatus(c.status);
    const t = frame.clock.elapsedTime;
    // Lần đầu có dữ liệu: đặt xe/súng đúng chỗ ngay, không cho trượt vào khi vừa mở trang.
    if (!S.seen) {
      S.seen = true;
      S.car.x = S.gun.x = c.plugged ? 1 : 0;
      S.soc = (c.soc ?? 0) / 100;
      S.base.set(lt[st]);
    }
    // Xe vào trước rồi súng mới cắm; rút súng xong xe mới đi.
    const carGoal = c.plugged || S.gun.x > 0.08 ? 1 : 0;
    spring(S.car, carGoal, dt, 26, 0.82);
    const gunGoal = c.plugged && S.car.x > 0.93 ? 1 : 0;
    spring(S.gun, gunGoal, dt, 34, 0.86);
    const carP = S.car.x;
    const gunP = smooth(S.gun.x);

    // Đèn: màu đổi mượt, cường độ theo kiểu nháy của trạng thái
    S.goal.set(lt[st]);
    S.base.lerp(S.goal, 1 - Math.exp(-6 * dt));
    const lvl = lightLevel(st, t);
    mats.ring.color.copy(S.base).multiplyScalar(0.2 + 1.25 * lvl);
    mats.strip.color.copy(S.base).multiplyScalar(0.12 + 0.95 * lvl);
    mats.port.color.copy(S.base).multiplyScalar(gunP > 0.5 ? 0.2 + 1.1 * lvl : 0.15);
    mats.tip.color.copy(S.base).multiplyScalar(0.3 + 0.9 * lvl);

    // Xe
    const car = carRef.current;
    car.visible = carP > 0.005;
    car.position.set(sg * (CAR_X + (1 - carP) * CAR_AWAY), 0, CAR_Z);
    car.updateMatrixWorld();
    blobRef.current.visible = car.visible;
    blobRef.current.position.set(car.position.x, 0.009, CAR_Z);
    // Pin theo SoC (lò xo mềm), màu đỏ → hổ phách → xanh
    S.soc = damp(S.soc, clamp01((c.soc ?? 0) / 100), 4, dt);
    const f = Math.max(0.02, S.soc);
    batFill.current.scale.x = f;
    batFill.current.position.x = -0.72 * (1 - f) * (sg === 1 ? -1 : 1);
    S.goal.set(S.soc < 0.2 ? lt.Faulted : S.soc < 0.5 ? lt.SuspendedEV : lt.Charging);
    S.bat.lerp(S.goal, 1 - Math.exp(-3 * dt));
    const charging = st === 'Charging' && gunP > 0.97;
    mats.bat.color.copy(S.bat).multiplyScalar(charging ? 0.85 + 0.35 * lightLevel(st, t) : 0.8);

    // Đầu súng: vị trí + hướng nội suy giữa khay và cổng sạc, nhấc lên giữa đường
    tmp.port.copy(PORT_LOCAL);
    car.localToWorld(tmp.port);
    const dockHead = tmp.v.set(sg * 0.8, 1.2, 0.12);
    const plugHead = tmp.port.setZ(tmp.port.z + 0.02);
    tmp.head.lerpVectors(dockHead, plugHead, gunP);
    tmp.head.y += Math.sin(Math.PI * gunP) * 0.45;
    tmp.head.z += Math.sin(Math.PI * gunP) * 0.35;
    tmp.q.slerpQuaternions(tmp.qDock, tmp.qPlug, gunP);
    headRef.current.position.copy(tmp.head);
    headRef.current.quaternion.copy(tmp.q);

    // Cáp: chỉ dựng lại khi đầu súng/xe còn di chuyển
    const sig = `${gunP.toFixed(4)}|${carP.toFixed(4)}`;
    if (sig !== S.last || !S.curve) {
      S.last = sig;
      const P = tmp.pts;
      const end = P[5].set(0, -0.34, 0).applyQuaternion(tmp.q).add(tmp.head);
      P[4].set(0, -0.22, 0).applyQuaternion(tmp.q).add(end);
      // đang cắm: từ gốc cáp chạy sát sàn tới dưới tay cầm rồi vòng lên
      const plugged = [
        [sg * 0.74, 0.42, 0.06],
        [sg * 0.96, 0.07, 0.42],
        [(sg * 0.96 + end.x) / 2, 0.05, (0.42 + end.z) / 2 + 0.2],
        [end.x - sg * 0.12, 0.12, end.z + 0.22],
      ];
      for (let i = 0; i < 4; i++) {
        const a = dockPts[i];
        const b = plugged[i];
        P[i].set(
          a[0] + (b[0] - a[0]) * gunP,
          a[1] + (b[1] - a[1]) * gunP + Math.sin(Math.PI * gunP) * 0.3 * (i / 3),
          a[2] + (b[2] - a[2]) * gunP,
        );
      }
      S.curve = new THREE.CatmullRomCurve3(
        P.map((p) => p.clone()),
        false,
        'centripetal',
      );
      const geo = new THREE.TubeGeometry(S.curve, 72, 0.034, 10, false);
      cable.current.geometry.dispose();
      cable.current.geometry = geo;
    }

    // Hạt năng lượng chạy dọc cáp (trạm → xe) khi Charging: tốc độ theo kW và ×10/×20
    const show = charging && carP > 0.97;
    dots.current.visible = halos.current.visible = show;
    if (show) {
      const v = (0.1 + c.kw / 420) * speedFactor(s.speed);
      S.phase = (S.phase + dt * v) % 1;
      mats.dot.color.set(lt.Charging).multiplyScalar(1.6);
      mats.dotHalo.color.copy(mats.dot.color);
      for (let i = 0; i < N_DOTS; i++) {
        const u = (S.phase + i / N_DOTS) % 1;
        S.curve.getPointAt(u, tmp.v);
        const k = Math.sin(Math.PI * u); // nhỏ dần ở hai đầu
        tmp.s.setScalar(0.35 + 0.65 * k);
        tmp.m.compose(tmp.v, tmp.q.identity(), tmp.s);
        dots.current.setMatrixAt(i, tmp.m);
        tmp.s.setScalar(0.4 + 0.8 * k);
        tmp.m.compose(tmp.v, tmp.q, tmp.s);
        halos.current.setMatrixAt(i, tmp.m);
      }
      dots.current.instanceMatrix.needsUpdate = true;
      halos.current.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <group>
      {/* khay súng ở hông trụ + vòng đèn */}
      <RBox
        args={[0.16, 0.3, 0.28]}
        r={0.04}
        material={M.darkMetal}
        position={[sg * 0.8, 1.2, 0.12]}
      />
      <mesh position={[sg * 0.885, 1.2, 0.12]} rotation-y={Math.PI / 2} material={mats.ring}>
        <torusGeometry args={[0.12, 0.014, 10, 40]} />
      </mesh>
      {/* dải đèn dọc mép trước, cùng màu/kiểu nháy với khay */}
      <mesh position={[sg * 0.705, 1.24, 0.37]} material={mats.strip}>
        <boxGeometry args={[0.014, 1.7, 0.012]} />
      </mesh>
      {/* đầu súng (gốc = đầu cắm; tay cầm kéo dài về -y) */}
      <group ref={headRef}>
        <RBox args={[0.13, 0.3, 0.14]} r={0.045} material={M.rubber} position-y={-0.17} />
        <mesh material={M.alu} position-y={-0.01}>
          <cylinderGeometry args={[0.055, 0.06, 0.05, 20]} />
        </mesh>
        <mesh material={mats.tip} position={[0, -0.12, 0.072]}>
          <boxGeometry args={[0.06, 0.012, 0.004]} />
        </mesh>
      </group>
      <mesh ref={cable} material={M.rubber}>
        <bufferGeometry />
      </mesh>
      <instancedMesh
        ref={dots}
        args={[null, null, N_DOTS]}
        material={mats.dot}
        frustumCulled={false}
      >
        <sphereGeometry args={[0.024, 10, 8]} />
      </instancedMesh>
      <instancedMesh
        ref={halos}
        args={[null, null, N_DOTS]}
        material={mats.dotHalo}
        frustumCulled={false}
      >
        <sphereGeometry args={[0.048, 10, 8]} />
      </instancedMesh>
      <Car
        M={M}
        paint={id === 1 ? M.paintA : M.paintB}
        mirror={sg === 1}
        carRef={carRef}
        batFill={batFill}
        batMat={mats.bat}
        portMat={mats.port}
      />
      <mesh ref={blobRef} rotation-x={-Math.PI / 2} visible={false} material={M.blob}>
        <planeGeometry args={[3.9, 2.0]} />
      </mesh>
    </group>
  );
}

// ── Camera: kéo để xoay (giới hạn góc), tự xoay rất chậm khi rảnh, nhấp đúp về góc đầu ──
function Rig() {
  const { camera, gl } = useThree();
  const ctl = useMemo(() => new OrbitControls(camera, gl.domElement), [camera, gl]);
  const S = useRef({ busy: false, last: -10, homing: false, base: HOME.theta, phase: 0 });
  const sph = useMemo(() => new THREE.Spherical(), []);
  const off = useMemo(() => new THREE.Vector3(), []);
  useEffect(() => {
    ctl.target.copy(TARGET);
    ctl.enableDamping = true;
    ctl.dampingFactor = 0.07;
    ctl.enablePan = false;
    ctl.enableZoom = false; // không chiếm cuộn trang
    ctl.rotateSpeed = 0.55;
    ctl.minPolarAngle = 1.02;
    ctl.maxPolarAngle = 1.52;
    ctl.minAzimuthAngle = -1.05;
    ctl.maxAzimuthAngle = 1.05;
    camera.position.setFromSpherical(new THREE.Spherical(HOME.radius, HOME.phi, HOME.theta));
    camera.position.add(TARGET);
    ctl.update();
    const now = () => performance.now() / 1000;
    const onStart = () => {
      S.current.busy = true;
      S.current.homing = false;
    };
    const onEnd = () => {
      S.current.busy = false;
      S.current.last = now();
      off.copy(camera.position).sub(ctl.target);
      sph.setFromVector3(off);
      S.current.base = sph.theta; // tự xoay quanh góc người xem vừa chọn
      S.current.phase = 0;
    };
    const onDbl = () => {
      S.current.homing = true;
      S.current.base = HOME.theta;
      S.current.phase = 0;
    };
    ctl.addEventListener('start', onStart);
    ctl.addEventListener('end', onEnd);
    gl.domElement.addEventListener('dblclick', onDbl);
    return () => {
      ctl.removeEventListener('start', onStart);
      ctl.removeEventListener('end', onEnd);
      gl.domElement.removeEventListener('dblclick', onDbl);
      ctl.dispose();
    };
  }, [ctl, camera, gl, sph, off]);
  useFrame((_, dt) => {
    const R = S.current;
    // Khung hẹp/dọc (điện thoại) → lùi camera cho trụ và phần lớn hai xe vẫn lọt khung
    const half = Math.tan((camera.fov * Math.PI) / 360) * camera.aspect;
    const fitR = Math.min(18, Math.max(HOME.radius, 3.6 / half));
    if (!R.busy) {
      off.copy(camera.position).sub(ctl.target);
      sph.setFromVector3(off);
      sph.radius = R.fitted ? damp(sph.radius, fitR, 3, dt) : fitR;
      R.fitted = true;
      if (R.homing) {
        sph.theta = damp(sph.theta, HOME.theta, 4, dt);
        sph.phi = damp(sph.phi, HOME.phi, 4, dt);
        if (Math.abs(sph.theta - HOME.theta) + Math.abs(sph.phi - HOME.phi) < 0.002) {
          R.homing = false;
          R.last = performance.now() / 1000;
        }
      } else if (performance.now() / 1000 - R.last > 2.5) {
        // tự xoay rất chậm: dao động ±0,3 rad quanh góc gốc, chu kỳ 70 s
        R.phase += dt;
        const goal = R.base + 0.3 * Math.sin((R.phase * Math.PI * 2) / 70);
        sph.theta = damp(sph.theta, goal, 0.9, dt);
      }
      camera.position.setFromSpherical(sph).add(ctl.target);
    }
    ctl.update();
  });
  return null;
}

export default function Scene({ store }) {
  const M = useMaterials();
  return (
    <>
      <Studio store={store} />
      <Rig />
      <Stage store={store} M={M} />
      <Station store={store} M={M} />
      <Bay id={1} store={store} M={M} />
      <Bay id={2} store={store} M={M} />
    </>
  );
}
