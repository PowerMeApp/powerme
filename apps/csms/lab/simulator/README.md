# Cấu hình SAP simulator cho bàn thí nghiệm WP2

Chép ba file này vào `dist/assets/` (và `src/assets/` nếu build lại) của
SAP e-mobility-charging-stations-simulator **v4.12.0** (tag `web@v4.12.0`):

- `config.json` → `dist/assets/config.json` — một trụ, trỏ về `ws://localhost:9000/ocpp`
- `powerme-d1.station-template.json` → `dist/assets/station-templates/` — DC 120 kW, 2 súng, MeterValues 10 s, ATG tự mở phiên
- `idtags.json` → `dist/assets/idtags.json` — bundle không tự chép file này; thiếu nó ATG chết im lặng

Build không qua `pnpm` lồng (lỗi PATH trên Windows): `corepack pnpm install --frozen-lockfile` rồi `node scripts/bundle.js`.
Chạy: `NODE_ENV=production node dist/start.js`.

Template này là bản chỉnh của `abb-atg`. Lưu ý: SAP **không có** `TransactionMessageAttempts` /
`TransactionMessageRetryInterval` / `LocalAuthorizeOffline` / `LocalPreAuthorize` — phải patch trước thí nghiệm chính thức (WP5).
