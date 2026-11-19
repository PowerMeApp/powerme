/** Dashboard configuration (PKG-2: core/config). */
export const env = {
  /** Same origin: Vite proxies /api to the CSMS in dev; Caddy does it on staging (FE-01d). */
  apiBase: '/api',
  appName: 'PowerMe',
} as const;

/**
 * Vietmap Tile key for the map on screen 18 (FE-03c), read at build time from
 * VITE_VIETMAP_TILE_KEY (`apps/dashboard/.env.local`, never committed). It ends up in the browser
 * (style URL), so it must be a Tile-only key, never the CSMS Search / Route key in `infra/.env`.
 * A function, not a constant, so tests can switch it with `vi.stubEnv`.
 */
export const vietmapTileKey = (): string =>
  String(import.meta.env['VITE_VIETMAP_TILE_KEY'] ?? '').trim();
