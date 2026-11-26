// Car.jsx — xe điện minh hoạ (QA-05). Thân bo cong từ biên dạng hông (Shape + ExtrudeGeometry có
// bevel), cabin kính tối liền khối, mâm 5 chấu, đèn pha / đèn hậu dạng thanh mảnh phát sáng nhẹ,
// cổng sạc ở hông sau phát sáng theo trạng thái súng.
//
// Xe MINH HOẠ CHUNG: không mô phỏng mẫu xe của hãng nào, không logo, không chữ.
// Hệ toạ độ cục bộ: mũi xe ở -x, đuôi ở +x (đuôi hướng về trụ), +z là hông phía camera.
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';

export const WHEEL_R = 0.34;
const WHEEL_X = 1.05;
const WHEEL_Z = 0.62;
const BODY_DEPTH = 1.32; // + 2 × bevelThickness 0.1 → rộng 1,52
export const PORT_LOCAL = new THREE.Vector3(1.4, 0.8, 0.77);

// Biên dạng thân dưới (nhìn từ hông): hai hốc bánh, mũi thấp, đuôi đứng.
function bodyShape() {
  const s = new THREE.Shape();
  s.moveTo(-1.6, 0.3);
  s.lineTo(-WHEEL_X - 0.44, 0.3);
  s.absarc(-WHEEL_X, 0.3, 0.44, Math.PI, 0, true);
  s.lineTo(WHEEL_X - 0.44, 0.3);
  s.absarc(WHEEL_X, 0.3, 0.44, Math.PI, 0, true);
  s.lineTo(1.62, 0.3);
  s.quadraticCurveTo(1.7, 0.31, 1.7, 0.44);
  s.lineTo(1.7, 0.8);
  s.quadraticCurveTo(1.69, 0.9, 1.56, 0.92);
  s.lineTo(1.18, 0.93);
  s.quadraticCurveTo(0.2, 0.92, -0.95, 0.88);
  s.quadraticCurveTo(-1.48, 0.84, -1.66, 0.7);
  s.quadraticCurveTo(-1.72, 0.65, -1.72, 0.56);
  s.lineTo(-1.72, 0.4);
  s.quadraticCurveTo(-1.71, 0.3, -1.6, 0.3);
  return s;
}

// Cabin kính (greenhouse): kính sau dốc, mái vòm thấp, kính lái nghiêng.
function cabinShape() {
  const s = new THREE.Shape();
  s.moveTo(1.3, 0.84);
  s.quadraticCurveTo(1.04, 1.2, 0.52, 1.25);
  s.quadraticCurveTo(-0.02, 1.29, -0.36, 1.23);
  s.quadraticCurveTo(-0.74, 1.08, -1.0, 0.84);
  s.lineTo(1.3, 0.84);
  return s;
}

function useCarGeometry() {
  const geo = useMemo(() => {
    const body = new THREE.ExtrudeGeometry(bodyShape(), {
      depth: BODY_DEPTH,
      bevelEnabled: true,
      bevelThickness: 0.1,
      bevelSize: 0.06,
      bevelSegments: 6,
      curveSegments: 28,
    });
    body.translate(0, 0, -BODY_DEPTH / 2);
    body.computeVertexNormals();
    const cabin = new THREE.ExtrudeGeometry(cabinShape(), {
      depth: 1.0,
      bevelEnabled: true,
      bevelThickness: 0.14,
      bevelSize: 0.07,
      bevelSegments: 7,
      curveSegments: 24,
    });
    cabin.translate(0, 0, -0.5);
    // Lốp: tiện tròn (Lathe) quanh trục y rồi xoay về trục z
    const prof = [
      [0.22, -0.112],
      [0.29, -0.122],
      [0.325, -0.108],
      [0.34, -0.06],
      [0.343, 0],
      [0.34, 0.06],
      [0.325, 0.108],
      [0.29, 0.122],
      [0.22, 0.112],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const tire = new THREE.LatheGeometry(prof, 48);
    tire.rotateX(Math.PI / 2);
    const rimLip = new THREE.TorusGeometry(0.218, 0.016, 10, 48);
    const rimDisc = new THREE.CylinderGeometry(0.21, 0.21, 0.04, 40);
    rimDisc.rotateX(Math.PI / 2);
    // Chấu đôi: hộp thuôn từ moay-ơ ra vành
    const spoke = new THREE.BoxGeometry(0.03, 0.17, 0.022);
    spoke.translate(0, 0.115, 0);
    const hub = new THREE.CylinderGeometry(0.045, 0.05, 0.05, 24);
    hub.rotateX(Math.PI / 2);
    const lamp = new THREE.BoxGeometry(0.018, 0.028, 1.1);
    const tail = new THREE.BoxGeometry(0.018, 0.04, 1.28);
    const port = new THREE.CylinderGeometry(0.072, 0.072, 0.016, 32);
    port.rotateX(Math.PI / 2);
    const portRing = new THREE.TorusGeometry(0.078, 0.009, 10, 40);
    const sill = new THREE.BoxGeometry(1.46, 0.016, 0.01);
    return { body, cabin, tire, rimLip, rimDisc, spoke, hub, lamp, tail, port, portRing, sill };
  }, []);
  useEffect(() => () => Object.values(geo).forEach((g) => g.dispose()), [geo]);
  return geo;
}

function Wheel({ G, M, position, back, wheelRef }) {
  // Mặt mâm luôn quay ra ngoài: bánh phía sau (z < 0) xoay 180° quanh y
  return (
    <group position={position} rotation-y={back ? Math.PI : 0}>
      <group ref={wheelRef}>
        <mesh geometry={G.tire} material={M.tire} />
        <mesh geometry={G.rimDisc} material={M.rimDark} position-z={0.05} />
        <mesh geometry={G.rimLip} material={M.rim} position-z={0.1} />
        {[0, 1, 2, 3, 4].map((i) => (
          <group key={i} rotation-z={(i * Math.PI * 2) / 5} position-z={0.098}>
            <mesh geometry={G.spoke} material={M.rim} position-x={-0.022} rotation-z={0.05} />
            <mesh geometry={G.spoke} material={M.rim} position-x={0.022} rotation-z={-0.05} />
          </group>
        ))}
        <mesh geometry={G.hub} material={M.rim} position-z={0.1} />
      </group>
    </group>
  );
}

/**
 * carRef: group gốc (Bay đặt vị trí); wheels: mảng ref 4 bánh (Bay quay theo quãng đường);
 * portMat: vật liệu vòng cổng sạc (màu theo trạng thái súng).
 */
export default function Car({ M, paint, mirror, carRef, wheels, portMat, children }) {
  const G = useCarGeometry();
  return (
    <group ref={carRef} scale-x={mirror ? -1 : 1} visible={false}>
      <mesh geometry={G.body} material={paint} />
      <mesh geometry={G.cabin} material={M.cabin} />
      {/* đường gân nhôm tối dọc mép trên hông xe, hai bên */}
      {[1, -1].map((s) => (
        <mesh key={s} geometry={G.sill} material={M.trim} position={[0.1, 0.83, s * 0.763]} />
      ))}
      {[
        [-WHEEL_X, WHEEL_Z, false],
        [WHEEL_X, WHEEL_Z, false],
        [-WHEEL_X, -WHEEL_Z, true],
        [WHEEL_X, -WHEEL_Z, true],
      ].map(([x, z, back], i) => (
        <Wheel
          key={i}
          G={G}
          M={M}
          position={[x, WHEEL_R, z]}
          back={back}
          wheelRef={(el) => (wheels.current[i] = el)}
        />
      ))}
      {/* đèn pha (mũi, -x) và thanh đèn hậu liền (đuôi, +x) */}
      <mesh geometry={G.lamp} material={M.head} position={[-1.781, 0.6, 0]} />
      <mesh geometry={G.tail} material={M.tail} position={[1.762, 0.74, 0]} />
      {/* cổng sạc ở hông sau, phía camera */}
      <mesh geometry={G.port} material={M.bezel} position={PORT_LOCAL} />
      <mesh
        geometry={G.portRing}
        material={portMat}
        position={[PORT_LOCAL.x, PORT_LOCAL.y, PORT_LOCAL.z + 0.008]}
      />
      {children}
    </group>
  );
}
