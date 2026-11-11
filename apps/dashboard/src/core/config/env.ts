/** Dashboard configuration (PKG-2: core/config). */
export const env = {
  /** Same origin: Vite proxies /api to the CSMS in dev; Caddy does it on staging (FE-01d). */
  apiBase: '/api',
  appName: 'PowerMe',
} as const;
