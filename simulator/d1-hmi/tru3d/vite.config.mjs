// vite.config.mjs — build hình trụ 3D (React + react-three-fiber) cho trang từng trụ (QA-04).
//
// LÀM GÌ
//   Gói src/main.jsx thành MỘT file ES module cố định: tru3d/dist/tru3d.js. server.mjs phục vụ đúng
//   file đó ở GET /tru3d/tru3d.js (danh sách cố định, không phục vụ đường dẫn tuỳ ý).
// VÌ SAO
//   - Một file, tên cố định: server không cần đọc manifest, không có chunk động để chống traversal.
//   - `three` để NGOÀI bundle và trỏ tới /vendor/three/three.module.js (route sẵn có từ QA-03), nên
//     chỉ có một bản three trên trang và bundle nhỏ hơn. Các addon three/examples/jsm (OrbitControls,
//     RoundedBoxGeometry, RoomEnvironment) được gói vào, chúng import 'three' → cũng ra ngoài.
//   - JSX dịch bằng esbuild (jsx automatic) của Vite, không cần @vitejs/plugin-react.
// CHẠY
//   npm run sim:tru3d:build   (ở gốc repo; = vite build --config simulator/d1-hmi/tru3d/vite.config.mjs)
//   Không build → /tru3d/tru3d.js trả 404 → trang tự dùng hình SVG 2D.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: here,
  publicDir: false,
  logLevel: 'warn',
  esbuild: { jsx: 'automatic', legalComments: 'none' },
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    modulePreload: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: fileURLToPath(new URL('./src/main.jsx', import.meta.url)),
      preserveEntrySignatures: 'exports-only',
      external: ['three'],
      output: {
        format: 'es',
        entryFileNames: 'tru3d.js',
        inlineDynamicImports: true,
        paths: { three: '/vendor/three/three.module.js' },
      },
    },
  },
});
