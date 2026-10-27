/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dashboard WP4: chạy hoàn toàn trên dữ liệu mô phỏng (src/mocks) — chưa proxy tới CSMS.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: '127.0.0.1' },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    css: false,
  },
});
