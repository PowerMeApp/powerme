/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev: /api goes to the real CSMS (D2), same origin as on staging behind Caddy.
// CSMS_URL defaults to the console port; use http://127.0.0.1:3200 for `npm run demo -- --port-offset 200`.
const csms = process.env['CSMS_URL'] ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: '127.0.0.1', proxy: { '/api': { target: csms } } },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    css: false,
  },
});
