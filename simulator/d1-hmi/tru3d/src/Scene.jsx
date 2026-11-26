// Scene.jsx — cảnh 3D trụ sạc DC hai súng (react-three-fiber), bản QA-05.
//
// Mọi thứ chỉ PHẢN ÁNH snapshot SSE trong `store` (cùng snapshot với hình 2D); không có nút điều
// khiển trụ. Hình minh hoạ tự dựng: không logo, không kiểu dáng của hãng nào.
//
// Toạ độ: đơn vị ~ mét. Trụ ở gốc, cao ~2,45. Súng A bên trái (sg = -1), súng B bên phải (sg = +1).
// Mọi chuyển động đi qua spring/damp (motion.js), không nội suy tuyến tính.
//
// Ánh sáng: env map phòng studio (RoomEnvironment + PMREMGenerator, dựng tại chỗ, không tải HDR),
// một đèn key ấm, một đèn fill lạnh, một đèn viền phía sau màu theo "tâm trạng" của trụ. Vật phát sáng
// (đèn LED, vòng khay, hạt năng lượng, đèn xe) có màu HDR > 1 để bloom (Effects.jsx) bắt được; bề mặt
// thường giữ dưới ngưỡng.
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import Car, { PORT_LOCAL, WHEEL_R } from './Car.jsx';
import { BG, ContactShadows, Floor } from './Floor.jsx';
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
import { SCREEN_H, SCREEN_SCALE, SCREEN_W, drawScreen } from './screen.js';

const TARGET = new THREE.Vector3(0, 1.08, 0);
const HOME = { radius: 10.6, phi: 1.33, theta: 0.14 };
// Intro: camera bắt đầu xa hơn, cao hơn, lệch góc rồi "dolly" vào bằng lò xo
const INTRO = { radius: 17, phi: 1.12, theta: 0.62 };
const CAR_X = 2.98; // tâm xe khi đỗ (|x|)
const CAR_AWAY = 9; // xe đi xa thêm bao nhiêu khi chưa cắm
const CAR_Z = 0.25;
const N_DOTS = 14;
const GLOW = 3; // hệ số HDR cho vật phát sáng (vượt ngưỡng bloom)

// ── Tiện ích hình học / texture ────────────────────────────────────────────
function RBox({ args, r = 0.05, seg = 4, material, ...props }) {
  const [w, h, d] = args;
  const geo = useMemo(() => new RoundedBoxGeometry(w, h, d, seg, r), [w, h, d, seg, r]);
  useEffect(() => () => geo.dispose(), [geo]);
  return <mesh geometry={geo} material={material} {...props} />;
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
  });
}

// ── Vật liệu dùng chung ────────────────────────────────────────────────────
function useMaterials() {
  const M = useMemo(() => {
    const phys = (o) => new THREE.MeshPhysicalMaterial(o);
    const glow = (color) => new THREE.MeshBasicMaterial({ color });
    return {
      // nhôm anodized xám không gian: kim loại, nhám vừa, phủ bóng mỏng
      anodized: phys({
        color: '#2a2f36',
        metalness: 0.9,
        roughness: 0.38,
        clearcoat: 0.6,
        clearcoatRoughness: 0.22,
      }),
      alu: phys({
        color: '#aab2bc',
        metalness: 1,
        roughness: 0.3,
        clearcoat: 0.4,
        clearcoatRoughness: 0.2,
      }),
      // mặt trước kính đen bóng
      blackGlass: phys({
        color: '#06070a',
        metalness: 0.1,
        roughness: 0.12,
        clearcoat: 1,
        clearcoatRoughness: 0.04,
      }),
      darkMetal: phys({ color: '#0d0f12', metalness: 0.7, roughness: 0.42 }),
      bezel: phys({
        color: '#030405',
        metalness: 0.2,
        roughness: 0.2,
        clearcoat: 1,
        clearcoatRoughness: 0.05,
      }),
      // lớp kính phủ màn hình: chỉ phản chiếu env, gần như trong suốt (không dùng transmission → không
      // có lượt vẽ phụ)
      cover: phys({
        color: '#000000',
        metalness: 0,
        roughness: 0.04,
        clearcoat: 1,
        clearcoatRoughness: 0.02,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
      }),
      frost: phys({
        color: '#a9bccf',
        metalness: 0,
        roughness: 0.5,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
      }),
      rubber: phys({
        color: '#121418',
        metalness: 0.05,
        roughness: 0.5,
        clearcoat: 0.5,
        clearcoatRoughness: 0.35,
      }),
      tire: phys({ color: '#0b0c0e', metalness: 0, roughness: 0.82, sheen: 0.3 }),
      rim: phys({ color: '#c3c9d0', metalness: 1, roughness: 0.22, clearcoat: 0.6 }),
      rimDark: phys({ color: '#15181c', metalness: 0.8, roughness: 0.35 }),
      trim: phys({ color: '#4a5058', metalness: 1, roughness: 0.25 }),
      // sơn xe: trắng ngọc trai và xanh thép, phủ bóng
      paintA: phys({
        color: '#dfe3e8',
        metalness: 0.35,
        roughness: 0.3,
        clearcoat: 1,
        clearcoatRoughness: 0.05,
      }),
      paintB: phys({
        color: '#34465e',
        metalness: 0.65,
        roughness: 0.3,
        clearcoat: 1,
        clearcoatRoughness: 0.05,
      }),
      // kính cabin tối, phản chiếu studio
      cabin: phys({
        color: '#020305',
        metalness: 0,
        roughness: 0.12,
        clearcoat: 0.5,
        clearcoatRoughness: 0.06,
        envMapIntensity: 0.16,
      }),
      track: phys({
        color: '#d8e2ee',
        metalness: 0,
        roughness: 0.3,
        transparent: true,
        opacity: 0.14,
        depthWrite: false,
      }),
      head: glow(new THREE.Color('#eaf2ff').multiplyScalar(1.2)),
      tail: glow(new THREE.Color('#ff2a36').multiplyScalar(1.5)),
      glow,
    };
  }, []);
  useEffect(
    () => () => {
      for (const v of Object.values(M)) if (v?.isMaterial) v.dispose();
    },
    [M],
  );
  return M;
}

// ── Ánh sáng studio, nền gần OLED, fog ─────────────────────────────────────
function Studio({ store, M }) {
  const { gl, scene } = useThree();
  const rim = useRef();
  useEffect(() => {
    const pm = new THREE.PMREMGenerator(gl);
    const env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    scene.environmentIntensity = 0.55;
    // envMapIntensity riêng chỉ có hiệu lực khi vật liệu có envMap của chính nó: kính cabin cần phản
    // chiếu studio yếu hơn hẳn (kính tối), nên gán env trực tiếp cho nó.
    M.cabin.envMap = env;
    scene.background = new THREE.Color(BG);
    scene.fog = new THREE.Fog(BG, 13, 26);
    return () => {
      scene.environment = null;
      M.cabin.envMap = null;
      scene.background = null;
      scene.fog = null;
      env.dispose();
      pm.dispose();
    };
  }, [gl, scene, M]);
  const target = useMemo(() => new THREE.Color(), []);
  useFrame((_, dt) => {
    const s = store.get();
    const mood = moodOf(s?.connectors);
    target.set(moodColor(mood, store.lt));
    rim.current.color.lerp(target, 1 - Math.exp(-3 * dt));
    rim.current.intensity = damp(rim.current.intensity, 4 + 8 * MOOD_GAIN[mood], 3, dt);
  });
  return (
    <>
      <ambientLight intensity={0.05} />
      <directionalLight position={[3.5, 7, 6]} intensity={1.0} color="#fff4e8" />
      <directionalLight position={[-6, 3.5, 2.5]} intensity={0.3} color="#cfe0ff" />
      {/* đèn viền phía sau, màu theo trạng thái → mép thân trụ ánh màu */}
      <pointLight ref={rim} position={[0, 2.2, -1.7]} distance={7} decay={1.6} intensity={5} />
    </>
  );
}

// ── Sàn, quầng sáng sau trụ, vòng sàn ─────────────────────────────────────
function Stage({ store, high }) {
  const halo = useRef();
  const { camera } = useThree();
  const mats = useMemo(
    () => ({
      halo: glowMaterial(2.3),
      pool: glowMaterial(1.8),
      ring: new THREE.MeshBasicMaterial({
        color: '#7d8da3',
        transparent: true,
        opacity: 0.3,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    }),
    [],
  );
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);
  const c = useMemo(() => new THREE.Color(), []);
  const gain = useRef(0.3);
  useFrame((st, dt) => {
    const s = store.get();
    const mood = moodOf(s?.connectors);
    c.set(moodColor(mood, store.lt));
    const t = st.clock.elapsedTime;
    const breathe = mood === 'charge' ? 0.9 + 0.1 * Math.sin((t * Math.PI * 2) / 3) : 1;
    gain.current = damp(gain.current, MOOD_GAIN[mood], 2.2, dt);
    for (const m of [mats.halo, mats.pool])
      m.uniforms.uColor.value.lerp(c, 1 - Math.exp(-2.5 * dt));
    mats.halo.uniforms.uGain.value = 0.6 * gain.current * breathe;
    mats.pool.uniforms.uGain.value = 0.3 * gain.current * breathe;
    mats.ring.color.copy(mats.halo.uniforms.uColor.value);
    mats.ring.opacity = 0.1 + 0.32 * gain.current * breathe;
    // quầng luôn quay mặt về camera (billboard) để kéo xoay vẫn tròn
    halo.current.quaternion.copy(camera.quaternion);
  });
  return (
    <>
      <Floor high={high} />
      <mesh rotation-x={-Math.PI / 2} position-y={0.004} material={mats.pool} renderOrder={2}>
        <planeGeometry args={[7, 7]} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.006} material={mats.ring} renderOrder={2}>
        <ringGeometry args={[1.5, 1.512, 160]} />
      </mesh>
      <mesh ref={halo} position={[0, 1.5, -1.5]} material={mats.halo} renderOrder={-1}>
        <planeGeometry args={[9, 9]} />
      </mesh>
    </>
  );
}

// ── Thân trụ: kính đen mặt trước, màn hình, đầu đọc RFID, đèn đỉnh, ăng-ten ─
function Station({ store, M }) {
  const scr = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = SCREEN_W * SCREEN_SCALE;
    canvas.height = SCREEN_H * SCREEN_SCALE;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(SCREEN_SCALE, 0, 0, SCREEN_SCALE, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return { ctx, tex, key: '' };
  }, []);
  // Màn hình tự phát sáng nhưng giữ dưới ngưỡng bloom để chữ không nhoè
  const screenMat = useMemo(
    () => new THREE.MeshBasicMaterial({ map: scr.tex, color: new THREE.Color(0.62, 0.62, 0.62) }),
    [scr],
  );
  const topMat = useMemo(() => M.glow('#7d8da3'), [M]);
  const kissMat = useMemo(() => M.glow('#7d8da3'), [M]);
  const padMat = useMemo(() => M.glow('#4aa3ff'), [M]);
  useEffect(
    () => () => {
      for (const m of [screenMat, topMat, kissMat, padMat]) m.dispose();
      scr.tex.dispose();
    },
    [screenMat, topMat, kissMat, padMat, scr],
  );
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
    const k = 1 - Math.exp(-3 * dt);
    const g = MOOD_GAIN[mood];
    topMat.color.lerp(c.clone().multiplyScalar(GLOW * (0.25 + 0.75 * g)), k);
    kissMat.color.lerp(c.multiplyScalar(GLOW * 0.3 * g), k);
    // Đầu đọc RFID: sáng nhịp khi đang chờ CSMS trả lời một lần quẹt (readerPending)
    const t = st.clock.elapsedTime;
    const waiting = s.connectors.some((x) => x.readerPending);
    const goal = waiting ? 0.6 + 0.6 * Math.abs(Math.sin(t * 4)) : 0.22;
    padLvl.current = damp(padLvl.current, goal, waiting ? 14 : 3, dt);
    padMat.color.set(store.lt.Preparing).multiplyScalar(GLOW * padLvl.current);
  });
  return (
    <group>
      {/* đế + vệt sáng sát sàn */}
      <RBox args={[1.78, 0.08, 0.98]} r={0.03} material={M.darkMetal} position-y={0.04} />
      <mesh position={[0, 0.012, 0.495]} material={kissMat}>
        <boxGeometry args={[1.5, 0.008, 0.006]} />
      </mesh>
      {/* thân nhôm anodized + mặt kính đen */}
      <RBox args={[1.5, 2.3, 0.72]} r={0.14} seg={8} material={M.anodized} position-y={1.23} />
      <RBox
        args={[1.34, 2.1, 0.03]}
        r={0.06}
        seg={5}
        material={M.blackGlass}
        position={[0, 1.24, 0.366]}
      />
      {/* nắp nhôm + dải đèn hắt dưới nắp (màu theo trạng thái chung) */}
      <RBox args={[1.6, 0.06, 0.82]} r={0.025} seg={4} material={M.alu} position-y={2.41} />
      <mesh position={[0, 2.37, 0.392]} material={topMat}>
        <boxGeometry args={[1.26, 0.008, 0.008]} />
      </mesh>
      {/* màn hình: viền đen, mặt phát sáng, lớp kính phủ */}
      <RBox args={[1.16, 0.76, 0.016]} r={0.03} material={M.bezel} position={[0, 1.76, 0.386]} />
      <mesh position={[0, 1.76, 0.3952]} material={screenMat}>
        <planeGeometry args={[1.08, 0.675]} />
      </mesh>
      <RBox args={[1.14, 0.74, 0.004]} r={0.02} material={M.cover} position={[0, 1.76, 0.398]} />
      {/* đầu đọc RFID: ký hiệu không tiếp xúc sau tấm kính mờ */}
      <RBox args={[0.44, 0.26, 0.012]} r={0.035} material={M.bezel} position={[0, 1.1, 0.386]} />
      <group position={[0, 1.1, 0.394]}>
        {[0.04, 0.068, 0.096].map((rad) => (
          <mesh key={rad} material={padMat} rotation-z={-Math.PI / 4} position-x={-0.05}>
            <torusGeometry args={[rad, 0.005, 8, 28, Math.PI / 2]} />
          </mesh>
        ))}
      </group>
      <RBox args={[0.42, 0.24, 0.004]} r={0.03} material={M.frost} position={[0, 1.1, 0.398]} />
      {/* đường nối mảnh chia mặt kính: chi tiết tối giản */}
      <mesh position={[0, 0.72, 0.3825]} material={M.trim}>
        <boxGeometry args={[1.1, 0.004, 0.002]} />
      </mesh>
      <Antenna store={store} M={M} />
    </group>
  );
}

function Antenna({ store, M }) {
  const tipMat = useMemo(() => M.glow('#35d07f'), [M]);
  const arcMats = useMemo(() => [0, 1, 2].map(() => M.glow('#35d07f')), [M]);
  useEffect(() => () => [tipMat, ...arcMats].forEach((m) => m.dispose()), [tipMat, arcMats]);
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
    tipMat.color.copy(cur).multiplyScalar(GLOW * (0.3 + 0.7 * tip));
    arcMats.forEach((m, i) => {
      let lvl;
      if (mode === 'online') {
        // sóng toả ra đều, chu kỳ 1,8 s
        const ph = (((t / 1.8 - i * 0.22) % 1) + 1) % 1;
        lvl = 0.2 + 0.8 * Math.exp(-ph * 4);
      } else if (mode === 'connecting') {
        lvl = Math.floor(t * 3) % 3 === i ? 1 : 0.1; // quét từng vạch
      } else if (mode === 'half') {
        lvl = i === 2 ? 0.04 : i === 1 ? (Math.sin(t * 9) > 0 ? 0.7 : 0.1) : 0.8; // chập chờn
      } else {
        lvl = 0.04; // offline: tắt
      }
      m.color.copy(cur).multiplyScalar(GLOW * lvl);
    });
  });
  return (
    <group position={[0.52, 2.44, -0.18]}>
      <mesh material={M.darkMetal} position-y={0.17}>
        <cylinderGeometry args={[0.012, 0.018, 0.34, 12]} />
      </mesh>
      <mesh material={tipMat} position-y={0.36}>
        <sphereGeometry args={[0.03, 20, 14]} />
      </mesh>
      {[0.09, 0.15, 0.21].map((rad, i) => (
        <mesh key={rad} material={arcMats[i]} position-y={0.36} rotation-z={Math.PI / 4}>
          <torusGeometry args={[rad, 0.007, 8, 32, Math.PI / 2]} />
        </mesh>
      ))}
    </group>
  );
}

// ── Đầu súng: mũi cắm nhôm, thân bọc cao su, tay cầm, đèn trạng thái ───────
// Gốc group = mặt đầu cắm; tay cầm kéo dài về -y.
function GunHead({ M, tipMat, headRef }) {
  return (
    <group ref={headRef}>
      <mesh material={M.alu} position-y={-0.02}>
        <cylinderGeometry args={[0.062, 0.066, 0.04, 28]} />
      </mesh>
      <mesh material={M.bezel} position-y={0.001}>
        <cylinderGeometry args={[0.052, 0.052, 0.004, 28]} />
      </mesh>
      <RBox args={[0.15, 0.17, 0.16]} r={0.05} seg={5} material={M.rubber} position-y={-0.12} />
      <RBox
        args={[0.1, 0.26, 0.11]}
        r={0.045}
        seg={5}
        material={M.rubber}
        position={[0, -0.3, -0.025]}
        rotation-x={0.14}
      />
      {/* đèn trạng thái mảnh trên lưng đầu súng */}
      <mesh material={tipMat} position={[0, -0.12, 0.081]}>
        <boxGeometry args={[0.07, 0.008, 0.004]} />
      </mesh>
      {/* đuôi chống gập cáp */}
      <mesh material={M.darkMetal} position={[0, -0.45, -0.045]} rotation-x={0.14}>
        <cylinderGeometry args={[0.04, 0.05, 0.08, 20]} />
      </mesh>
    </group>
  );
}

// ── Một khoang súng: khay + vòng đèn + LED viền + cáp + hạt năng lượng + xe ──
function Bay({ id, store, M }) {
  const sg = id === 1 ? -1 : 1;
  const carRef = useRef();
  const wheels = useRef([]);
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
      dot: new THREE.MeshBasicMaterial({ color: '#35d07f' }),
      dotHalo: new THREE.MeshBasicMaterial({
        color: '#35d07f',
        transparent: true,
        opacity: 0.16,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    }),
    [M],
  );
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);
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
    prevX: null,
    spin: 0,
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
      pts: Array.from({ length: 7 }, () => new THREE.Vector3()),
    }),
    [sg],
  );
  // Cáp: CatmullRom qua 7 điểm; nội suy điểm giữa vị trí "trên khay" và "đang cắm". Trên khay cáp
  // buông thành vòng võng xuống gần sàn rồi vòng lên đầu súng (như cáp thật treo ở hông trụ).
  const dockPts = useMemo(
    () => [
      [sg * 0.76, 0.46, 0.06],
      [sg * 0.9, 0.2, 0.2],
      [sg * 1.06, 0.09, 0.3],
      [sg * 1.22, 0.14, 0.3],
      [sg * 1.3, 0.42, 0.24],
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
    spring(S.car, carGoal, dt, 22, 0.9);
    const gunGoal = c.plugged && S.car.x > 0.93 ? 1 : 0;
    spring(S.gun, gunGoal, dt, 30, 0.84);
    const carP = S.car.x;
    const gunP = smooth(S.gun.x);

    // Đèn: màu đổi mượt, cường độ theo kiểu nháy của trạng thái (HDR → bloom)
    S.goal.set(lt[st]);
    S.base.lerp(S.goal, 1 - Math.exp(-6 * dt));
    const lvl = lightLevel(st, t);
    mats.ring.color.copy(S.base).multiplyScalar(GLOW * (0.12 + 0.88 * lvl));
    mats.strip.color.copy(S.base).multiplyScalar(GLOW * (0.08 + 0.75 * lvl));
    mats.port.color.copy(S.base).multiplyScalar(gunP > 0.5 ? GLOW * (0.15 + 0.85 * lvl) : 0.25);
    mats.tip.color.copy(S.base).multiplyScalar(GLOW * (0.2 + 0.6 * lvl));

    // Xe + bánh lăn theo quãng đường
    const car = carRef.current;
    car.visible = carP > 0.005;
    car.position.set(sg * (CAR_X + (1 - carP) * CAR_AWAY), 0, CAR_Z);
    car.updateMatrixWorld();
    if (S.prevX != null) {
      const localDx = (car.position.x - S.prevX) * (sg === 1 ? -1 : 1);
      S.spin -= localDx / WHEEL_R;
    }
    S.prevX = car.position.x;
    wheels.current.forEach((w, i) => w && (w.rotation.z = i < 2 ? S.spin : -S.spin));

    // Pin theo SoC (lò xo mềm), màu đỏ → hổ phách → xanh
    S.soc = damp(S.soc, clamp01((c.soc ?? 0) / 100), 4, dt);
    const f = Math.max(0.02, S.soc);
    batFill.current.scale.x = f;
    batFill.current.position.x = -0.72 * (1 - f) * (sg === 1 ? -1 : 1);
    S.goal.set(S.soc < 0.2 ? lt.Faulted : S.soc < 0.5 ? lt.SuspendedEV : lt.Charging);
    S.bat.lerp(S.goal, 1 - Math.exp(-3 * dt));
    const charging = st === 'Charging' && gunP > 0.97;
    mats.bat.color
      .copy(S.bat)
      .multiplyScalar(charging ? GLOW * (0.24 + 0.1 * lightLevel(st, t)) : GLOW * 0.18);

    // Đầu súng: vị trí + hướng nội suy giữa khay và cổng sạc, nhấc lên giữa đường
    tmp.port.copy(PORT_LOCAL);
    car.localToWorld(tmp.port);
    const dockHead = tmp.v.set(sg * 0.82, 1.2, 0.12);
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
      const end = P[6].set(0, -0.49, -0.05).applyQuaternion(tmp.q).add(tmp.head);
      P[5].set(0, -0.24, -0.03).applyQuaternion(tmp.q).add(end);
      // đang cắm: từ gốc cáp võng sát sàn tới dưới đầu súng rồi vòng lên
      const plugged = [
        [sg * 0.76, 0.46, 0.06],
        [sg * 0.92, 0.12, 0.36],
        [(sg * 0.96 + end.x) / 2, 0.045, (0.42 + end.z) / 2 + 0.24],
        [end.x - sg * 0.16, 0.05, end.z + 0.26],
        [end.x - sg * 0.06, 0.16, end.z + 0.16],
      ];
      for (let i = 0; i < 5; i++) {
        const a = dockPts[i];
        const b = plugged[i];
        P[i].set(
          a[0] + (b[0] - a[0]) * gunP,
          a[1] + (b[1] - a[1]) * gunP + Math.sin(Math.PI * gunP) * 0.3 * (i / 4),
          a[2] + (b[2] - a[2]) * gunP,
        );
      }
      S.curve = new THREE.CatmullRomCurve3(
        P.map((p) => p.clone()),
        false,
        'centripetal',
      );
      const geo = new THREE.TubeGeometry(S.curve, 110, 0.04, 14, false);
      cable.current.geometry.dispose();
      cable.current.geometry = geo;
    }

    // Hạt năng lượng chạy dọc cáp (trạm → xe) khi Charging: tốc độ theo kW và ×10/×20
    const show = charging && carP > 0.97;
    dots.current.visible = halos.current.visible = show;
    if (show) {
      const v = (0.1 + c.kw / 420) * speedFactor(s.speed);
      S.phase = (S.phase + dt * v) % 1;
      mats.dot.color.set(lt.Charging).multiplyScalar(GLOW * 1.3);
      mats.dotHalo.color.set(lt.Charging);
      for (let i = 0; i < N_DOTS; i++) {
        const u = (S.phase + i / N_DOTS) % 1;
        S.curve.getPointAt(u, tmp.v);
        const k = Math.sin(Math.PI * u); // nhỏ dần ở hai đầu
        tmp.s.setScalar(0.3 + 0.7 * k);
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
      {/* khay súng ở hông trụ: vỏ, lòng khay tối, vòng đèn */}
      <RBox
        args={[0.16, 0.36, 0.3]}
        r={0.05}
        seg={5}
        material={M.darkMetal}
        position={[sg * 0.8, 1.2, 0.12]}
      />
      <mesh position={[sg * 0.885, 1.2, 0.12]} rotation-z={Math.PI / 2} material={M.bezel}>
        <cylinderGeometry args={[0.1, 0.1, 0.012, 32]} />
      </mesh>
      <mesh position={[sg * 0.888, 1.2, 0.12]} rotation-y={Math.PI / 2} material={mats.ring}>
        <torusGeometry args={[0.118, 0.009, 12, 48]} />
      </mesh>
      {/* gioăng nơi cáp ra khỏi thân */}
      <mesh position={[sg * 0.755, 0.46, 0.06]} rotation-y={Math.PI / 2} material={M.trim}>
        <torusGeometry args={[0.05, 0.014, 10, 28]} />
      </mesh>
      {/* LED viền dọc mép mặt kính, cùng màu/kiểu nháy với khay */}
      <RBox
        args={[0.012, 1.84, 0.005]}
        r={0.0024}
        seg={2}
        material={mats.strip}
        position={[sg * 0.622, 1.24, 0.3835]}
      />
      <GunHead M={M} tipMat={mats.tip} headRef={headRef} />
      <mesh ref={cable} material={M.rubber}>
        <bufferGeometry />
      </mesh>
      <instancedMesh
        ref={dots}
        args={[null, null, N_DOTS]}
        material={mats.dot}
        frustumCulled={false}
      >
        <sphereGeometry args={[0.02, 12, 10]} />
      </instancedMesh>
      <instancedMesh
        ref={halos}
        args={[null, null, N_DOTS]}
        material={mats.dotHalo}
        frustumCulled={false}
      >
        <sphereGeometry args={[0.05, 12, 10]} />
      </instancedMesh>
      <Car
        M={M}
        paint={id === 1 ? M.paintA : M.paintB}
        mirror={sg === 1}
        carRef={carRef}
        wheels={wheels}
        portMat={mats.port}
      >
        {/* thanh pin nổi trên nóc, đổ theo SoC */}
        <group position={[0.15, 1.72, 0]}>
          <RBox args={[1.5, 0.09, 0.09]} r={0.04} material={M.track} />
          <RBox args={[0.04, 0.045, 0.045]} r={0.012} material={M.track} position-x={0.785} />
          <RBox ref={batFill} args={[1.44, 0.05, 0.05]} r={0.024} material={mats.bat} />
        </group>
      </Car>
    </group>
  );
}

// ── Camera: intro dolly, kéo để xoay (giới hạn góc), tự xoay rất chậm khi rảnh, nhấp đúp về góc đầu ──
function Rig() {
  const { camera, gl, scene } = useThree();
  const ctl = useMemo(() => new OrbitControls(camera, gl.domElement), [camera, gl]);
  const S = useRef({
    busy: false,
    last: -10,
    homing: false,
    intro: true,
    base: HOME.theta,
    phase: 0,
    r: { x: INTRO.radius, v: 0 },
    th: { x: INTRO.theta, v: 0 },
    ph: { x: INTRO.phi, v: 0 },
  });
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
    ctl.maxPolarAngle = 1.5;
    ctl.minAzimuthAngle = -1.05;
    ctl.maxAzimuthAngle = 1.05;
    camera.position.setFromSpherical(new THREE.Spherical(INTRO.radius, INTRO.phi, INTRO.theta));
    camera.position.add(TARGET);
    ctl.update();
    const now = () => performance.now() / 1000;
    const R = S.current;
    const sync = () => {
      off.copy(camera.position).sub(ctl.target);
      sph.setFromVector3(off);
      R.r.x = sph.radius;
      R.th.x = sph.theta;
      R.ph.x = sph.phi;
      R.r.v = R.th.v = R.ph.v = 0;
    };
    const onStart = () => {
      R.busy = true;
      R.homing = false;
      R.intro = false;
    };
    const onEnd = () => {
      R.busy = false;
      R.last = now();
      sync();
      R.base = R.th.x; // tự xoay quanh góc người xem vừa chọn
      R.phase = 0;
    };
    const onDbl = () => {
      sync();
      R.homing = true;
      R.base = HOME.theta;
      R.phase = 0;
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
    const fitR = Math.min(18, Math.max(HOME.radius, 3.7 / half));
    if (!R.busy) {
      if (R.intro) {
        // dolly vào bằng lò xo gần tới hạn (~1,8 s), lệch góc xoay về góc nhìn chính
        spring(R.r, fitR, dt, 5.5, 0.96);
        spring(R.th, HOME.theta, dt, 5.5, 0.96);
        spring(R.ph, HOME.phi, dt, 5.5, 0.96);
        if (Math.abs(R.r.x - fitR) + Math.abs(R.th.x - HOME.theta) < 0.003) {
          R.intro = false;
          R.last = performance.now() / 1000;
        }
      } else if (R.homing) {
        spring(R.th, HOME.theta, dt, 16, 0.92);
        spring(R.ph, HOME.phi, dt, 16, 0.92);
        R.r.x = damp(R.r.x, fitR, 3, dt);
        if (Math.abs(R.th.x - HOME.theta) + Math.abs(R.ph.x - HOME.phi) < 0.002) {
          R.homing = false;
          R.last = performance.now() / 1000;
        }
      } else {
        R.r.x = damp(R.r.x, fitR, 3, dt);
        if (performance.now() / 1000 - R.last > 2.5) {
          // tự xoay rất chậm: dao động ±0,28 rad quanh góc gốc, chu kỳ 80 s
          R.phase += dt;
          const goal = R.base + 0.28 * Math.sin((R.phase * Math.PI * 2) / 80);
          R.th.x = damp(R.th.x, goal, 0.8, dt);
        }
      }
      sph.set(R.r.x, R.ph.x, R.th.x);
      camera.position.setFromSpherical(sph).add(ctl.target);
    }
    // Fog bám khoảng cách camera: trụ luôn rõ, nền và xe ở xa chìm dần vào đen
    if (scene.fog) {
      off.copy(camera.position).sub(ctl.target);
      const r = off.length();
      scene.fog.near = r + 2.5;
      scene.fog.far = r + 15;
    }
    ctl.update();
  });
  return null;
}

export default function Scene({ store, high }) {
  const M = useMaterials();
  const stage = useRef();
  return (
    <>
      <Studio store={store} M={M} />
      <Rig />
      <group ref={stage}>
        <Stage store={store} high={high} />
      </group>
      <ContactShadows hide={stage} every={high ? 1 : 3} />
      <Station store={store} M={M} />
      <Bay id={1} store={store} M={M} />
      <Bay id={2} store={store} M={M} />
    </>
  );
}
