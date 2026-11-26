// Floor.jsx — sàn tối có phản chiếu mờ + bóng tiếp xúc mềm (QA-05).
//
// Sàn
//   Chất lượng cao: Reflector (three/examples) vẽ cảnh đối xứng qua mặt sàn vào texture nửa độ phân
//   giải (~1/3); shader riêng lấy mẫu 9 điểm cho phản chiếu nhoè, giảm cường độ, tắt dần theo bán kính và
//   hoà vào màu nền theo khoảng cách (fog), để nền chìm vào đen.
//   Chế độ nhẹ: cùng shader nhưng không có phản chiếu (không có lượt vẽ thêm nào).
// Bóng tiếp xúc
//   Camera trực giao đặt ở mặt sàn nhìn LÊN, vẽ cảnh bằng vật liệu độ sâu (gần sàn → đậm) vào
//   texture, rồi làm nhoè ngang/dọc hai lượt. Bóng lấy từ hình học thật (bánh xe, đế trụ, cáp), không
//   phải gradient vẽ sẵn. Chế độ nhẹ cập nhật mỗi 3 khung.
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { HorizontalBlurShader } from 'three/examples/jsm/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/examples/jsm/shaders/VerticalBlurShader.js';

export const BG = '#040506';

const floorVert = /* glsl */ `
  uniform mat4 textureMatrix;
  varying vec4 vUv;
  varying vec3 vWorld;
  void main() {
    vUv = textureMatrix * vec4(position, 1.0);
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
const floorFrag = /* glsl */ `
  uniform vec3 color;
  uniform sampler2D tDiffuse;
  uniform vec3 uBase;
  uniform vec3 uBg;
  uniform float uStrength;
  uniform vec2 uTexel;
  uniform float uFogNear;
  uniform float uFogFar;
  varying vec4 vUv;
  varying vec3 vWorld;
  void main() {
    float r = length(vWorld.xz);
    // vũng sáng studio dưới trụ, tối dần ra xa
    vec3 col = uBase * (1.0 - 0.7 * smoothstep(1.2, 8.5, r));
    #ifdef REFLECT
      vec2 uv = vUv.xy / vUv.w;
      vec2 o = uTexel * 1.5;
      // lấy mẫu ở mip cao hơn (bias 3) + 9 điểm → nhoè mềm, không răng cưa
      #define TAP(p) texture2D(tDiffuse, p, 3.0).rgb
      vec3 refl = TAP(uv) * 0.28;
      refl += (TAP(uv + vec2(o.x, 0.0)) + TAP(uv - vec2(o.x, 0.0))
             + TAP(uv + vec2(0.0, o.y)) + TAP(uv - vec2(0.0, o.y))) * 0.12;
      refl += (TAP(uv + o) + TAP(uv - o) + TAP(uv + vec2(o.x, -o.y)) + TAP(uv + vec2(-o.x, o.y))) * 0.06;
      col += refl * uStrength * (1.0 - smoothstep(3.0, 11.0, r)) * color;
    #endif
    float f = smoothstep(uFogNear, uFogFar, distance(cameraPosition, vWorld));
    #ifdef REFLECT
      gl_FragColor = vec4(mix(col, uBg, f), 1.0);
    #else
      // chế độ nhẹ vẽ thẳng ra canvas và nền không qua tone mapping: sàn xa trong suốt dần (vật liệu
      // transparent) để lộ đúng màu nền, không thành dải chân trời sáng hơn nền
      gl_FragColor = vec4(mix(col, uBg, f), 1.0 - f);
    #endif
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
const floorUniforms = () => ({
  color: { value: new THREE.Color(1, 1, 1) },
  tDiffuse: { value: null },
  textureMatrix: { value: new THREE.Matrix4() },
  uBase: { value: new THREE.Color('#1b1f25') },
  uBg: { value: new THREE.Color(BG) },
  uStrength: { value: 0.18 },
  uTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
  uFogNear: { value: 12 },
  uFogFar: { value: 26 },
});

/** Sàn: `high` = có phản chiếu (Reflector), ngược lại chỉ nền tối + fog. */
export function Floor({ high }) {
  const { scene, size, viewport } = useThree();
  const geo = useMemo(() => new THREE.PlaneGeometry(60, 60), []);
  const mirror = useMemo(() => {
    const m = new Reflector(geo, {
      textureWidth: 256,
      textureHeight: 256,
      clipBias: 0.002,
      multisample: 0,
      shader: {
        name: 'SanPhanChieu',
        uniforms: floorUniforms(),
        vertexShader: floorVert,
        fragmentShader: '#define REFLECT\n' + floorFrag,
      },
    });
    m.rotation.x = -Math.PI / 2;
    // có mipmap để shader lấy mẫu mờ rẻ (bias) thay vì răng cưa ở texture nhỏ
    const tex = m.getRenderTarget().texture;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    return m;
  }, [geo]);
  const plain = useMemo(() => {
    const m = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        uniforms: floorUniforms(),
        vertexShader: floorVert,
        fragmentShader: floorFrag,
        transparent: true,
      }),
    );
    m.rotation.x = -Math.PI / 2;
    return m;
  }, [geo]);
  // Texture phản chiếu = ~1/3 kích thước canvas (đủ nhoè, đỡ tốn)
  useEffect(() => {
    const w = Math.max(64, Math.round(size.width * viewport.dpr * 0.35));
    const h = Math.max(64, Math.round(size.height * viewport.dpr * 0.35));
    mirror.getRenderTarget().setSize(w, h);
    mirror.material.uniforms.uTexel.value.set(1 / w, 1 / h);
  }, [mirror, size, viewport.dpr]);
  useEffect(
    () => () => {
      mirror.dispose();
      plain.material.dispose();
      geo.dispose();
    },
    [mirror, plain, geo],
  );
  useFrame(() => {
    const fog = scene.fog;
    if (!fog) return;
    for (const m of [mirror.material, plain.material]) {
      m.uniforms.uFogNear.value = fog.near;
      m.uniforms.uFogFar.value = fog.far;
    }
  });
  return (
    <>
      <primitive object={mirror} visible={high} />
      <primitive object={plain} visible={!high} />
    </>
  );
}

/**
 * Bóng tiếp xúc. `hide`: ref nhóm cần ẩn khi chụp bóng (sàn, quầng sáng, chính mặt bóng).
 * Vùng phủ width × depth (mét) quanh gốc, chiều cao chụp `height`.
 */
export function ContactShadows({
  hide,
  every = 1,
  width = 15,
  depth = 6,
  height = 2.1,
  res = 1024,
  blur = 2.4,
  opacity = 0.92,
}) {
  const { gl, scene } = useThree();
  const S = useMemo(() => {
    const rw = res;
    const rh = Math.round((res * depth) / width);
    const mk = () => {
      const t = new THREE.WebGLRenderTarget(rw, rh, { type: THREE.HalfFloatType });
      t.texture.generateMipmaps = false;
      return t;
    };
    const rt = mk();
    const rtBlur = mk();
    // Đặt ở mặt sàn, xoay +90° quanh x → nhìn lên +y; ảnh: phải = +x, lên = +z
    const cam = new THREE.OrthographicCamera(
      -width / 2,
      width / 2,
      depth / 2,
      -depth / 2,
      0,
      height,
    );
    cam.rotation.x = Math.PI / 2;
    cam.position.y = -0.002;
    cam.updateMatrixWorld();
    const depthMat = new THREE.MeshDepthMaterial();
    // Có depth test: bề mặt THẤP nhất (gần sàn nhất, bóng đậm nhất) thắng ở mỗi điểm ảnh
    depthMat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace(
        'vec4( vec3( 1.0 - fragCoordZ ), opacity );',
        'vec4( vec3( 0.0 ), pow( clamp( 1.0 - fragCoordZ, 0.0, 1.0 ), 2.2 ) );',
      );
    };
    const hb = new THREE.ShaderMaterial({
      ...HorizontalBlurShader,
      uniforms: THREE.UniformsUtils.clone(HorizontalBlurShader.uniforms),
      depthTest: false,
    });
    const vb = new THREE.ShaderMaterial({
      ...VerticalBlurShader,
      uniforms: THREE.UniformsUtils.clone(VerticalBlurShader.uniforms),
      depthTest: false,
    });
    const quad = new FullScreenQuad();
    const geo = new THREE.PlaneGeometry(width, depth).rotateX(-Math.PI / 2);
    // rotateX(-90°) đưa v tăng theo -z; ảnh bóng có v tăng theo +z → lật v
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
    const mat = new THREE.MeshBasicMaterial({
      map: rt.texture,
      transparent: true,
      opacity,
      depthWrite: false,
      fog: false,
    });
    return {
      rt,
      rtBlur,
      cam,
      depthMat,
      hb,
      vb,
      quad,
      geo,
      mat,
      rw,
      rh,
      n: 0,
      clear: new THREE.Color(),
    };
  }, [width, depth, height, res, opacity]);
  useEffect(
    () => () => {
      for (const k of ['rt', 'rtBlur', 'depthMat', 'hb', 'vb', 'quad', 'geo', 'mat'])
        S[k].dispose();
    },
    [S],
  );
  const blurOnce = (amount) => {
    S.quad.material = S.hb;
    S.hb.uniforms.tDiffuse.value = S.rt.texture;
    S.hb.uniforms.h.value = amount / S.rw;
    gl.setRenderTarget(S.rtBlur);
    S.quad.render(gl);
    S.quad.material = S.vb;
    S.vb.uniforms.tDiffuse.value = S.rtBlur.texture;
    S.vb.uniforms.v.value = amount / S.rh;
    gl.setRenderTarget(S.rt);
    S.quad.render(gl);
  };
  useFrame(() => {
    if (S.n++ % every !== 0) return;
    const bg = scene.background;
    const fog = scene.fog;
    const over = scene.overrideMaterial;
    const prevTarget = gl.getRenderTarget();
    gl.getClearColor(S.clear);
    const prevAlpha = gl.getClearAlpha();
    if (hide?.current) hide.current.visible = false;
    scene.background = null;
    scene.fog = null;
    scene.overrideMaterial = S.depthMat;
    gl.setClearColor(0x000000, 0);
    gl.setRenderTarget(S.rt);
    gl.clear();
    gl.render(scene, S.cam);
    scene.overrideMaterial = over;
    blurOnce(blur);
    blurOnce(blur * 0.45);
    gl.setRenderTarget(prevTarget);
    gl.setClearColor(S.clear, prevAlpha);
    scene.background = bg;
    scene.fog = fog;
    if (hide?.current) hide.current.visible = true;
  });
  return <mesh geometry={S.geo} material={S.mat} position-y={0.003} renderOrder={1} />;
}
