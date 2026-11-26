// Effects.jsx — vòng vẽ cuối: hậu kỳ bloom + tone mapping, và bộ hạ chất lượng (QA-05).
//
// Chất lượng cao: RenderPass (HDR, half float, MSAA 4) → UnrealBloomPass (chỉ vùng sáng vượt ngưỡng
// luminance: đèn viền, vòng đèn khay súng, hạt năng lượng, đèn xe) → OutputPass (ACES + sRGB).
// Chế độ nhẹ: vẽ thẳng ra canvas (renderer tự tone map ACES), không bloom, không phản chiếu, dpr 1.
//
// Hạ chất lượng tự động (chế độ "auto"): sau 4 s khởi động, nếu FPS trung bình < 30 trong một cửa sổ
// 2 s thì chuyển hẳn sang chế độ nhẹ (một chiều, không bật lại). `?3d=lite` ép chế độ nhẹ ngay;
// `?3d=hq` giữ chất lượng cao, không tự hạ (dùng khi chụp ảnh / máy chiếu demo đã thử trước).
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

export const BLOOM = { strength: 0.5, radius: 0.6, threshold: 0.62, knee: 0.45 };

export default function Effects({ quality, high }) {
  const { gl, scene, camera, size, viewport, setDpr } = useThree();
  const fx = useMemo(() => {
    const rt = new THREE.WebGLRenderTarget(4, 4, {
      type: THREE.HalfFloatType,
      samples: gl.capabilities.isWebGL2 === false ? 0 : 4,
    });
    const composer = new EffectComposer(gl, rt);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(256, 256),
      BLOOM.strength,
      BLOOM.radius,
      BLOOM.threshold,
    );
    // ngưỡng có "đầu gối" mềm thay vì cắt cứng 0,01 → quầng không lởm chởm khi đèn nháy
    bloom.highPassUniforms.smoothWidth.value = BLOOM.knee;
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    return { composer, bloom };
  }, [gl, scene, camera]);
  useEffect(() => {
    fx.composer.setPixelRatio(viewport.dpr);
    fx.composer.setSize(size.width, size.height);
  }, [fx, size, viewport.dpr]);
  useEffect(() => () => fx.composer.dispose(), [fx]);
  useEffect(() => {
    if (!high) setDpr(1);
  }, [high, setDpr]);

  const mon = useRef({ t: 0, frames: 0, warm: 0 });
  useFrame((_, dt) => {
    // Đo FPS (bỏ qua khung đầu sau khi tab ẩn/hiện: dt rất lớn)
    const M = mon.current;
    if (high && quality.mode === 'auto' && dt < 0.5) {
      M.warm += dt;
      if (M.warm > 4) {
        M.t += dt;
        M.frames++;
        if (M.t >= 2) {
          if (M.frames / M.t < 30) quality.downgrade();
          M.t = 0;
          M.frames = 0;
        }
      }
    }
    if (high) fx.composer.render(dt);
    else gl.render(scene, camera);
  }, 1);
  return null;
}
