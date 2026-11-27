# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

PowerMe là nền tảng quản lý trạm sạc xe điện (CSMS) theo **OCPP 1.6J** cho nhà vận hành trạm độc lập ở Việt Nam — đồ án capstone, không có trụ thật (phần cứng được mô phỏng). Nhóm viết tài liệu, commit, PR bằng **tiếng Việt**. Repo **public**: không commit `.env`, khoá, mật khẩu (CI chạy `gitleaks`).

Hướng dẫn riêng theo phần (đọc khi chạm vào phần đó): `apps/csms/src/billing/CLAUDE.md` (WF-02 thanh toán), `apps/mobile/AGENTS.md` (app Flutter, chỉ ghi trong `apps/mobile`). Quy ước nhóm: `CONTRIBUTING.md`.

## Lệnh thường dùng

Node **24** (`.nvmrc`), npm workspaces (`apps/*`, `packages/*`). Chạy ở gốc repo trừ khi ghi khác.

```bash
npm ci                       # cũng bật hook pre-push (chặn push thẳng main)
npm run format:check         # prettier toàn repo — CI chạy đúng lệnh này
npm run lint
npm run typecheck
npm test                     # test mọi workspace
npm run build
npm run sim:tru3d:build      # bundle 3D của simulator (CI cũng build)
```

**CSMS (`apps/csms`)** — Jest phải chạy qua `scripts/run-jest.cjs` (bật `--experimental-vm-modules` vì NestJS 12 / drizzle là ESM-only); gọi `npx jest` trực tiếp sẽ lỗi `require(esm)`.

```bash
cd apps/csms
node scripts/run-jest.cjs src/sessions/session-state-machine.spec.ts        # một file
node scripts/run-jest.cjs test/fe03-operator-monitoring -t "tên ca"         # một ca
DATABASE_URL=postgresql://powerme:powerme@127.0.0.1:54330/powerme_test \
  node scripts/run-jest.cjs --runInBand test/<file>.integration.test.ts      # test tích hợp
```

- `src/**/*.spec.ts` = unit (không DB). `test/*.integration.test.ts` cần Postgres thật; **thiếu `DATABASE_URL` thì `describe` bị skip** (không báo lỗi — kiểm số ca thực chạy). Test tích hợp `DROP SCHEMA` → luôn trỏ vào DB test riêng, chạy `--runInBand`.
- Không có Docker: `node demo/db-embedded.mjs [--port-offset N]` bật Postgres nhúng (cổng `54330+N`, in sẵn URL `…/powerme_test` cho test). CI dùng Postgres 16 (`infra/docker-compose.yml`); bản nhúng là 17 beta.
- Bộ Driver API "MB03" (`driver-*`, `rfid-settlement`, …) dùng `MB03_TEST_DATABASE_URL` trỏ vào DB **rỗng** tên dạng `powerme_mb03_driver_test_<số>_<8 hex>` + `MB03_TEST_ALLOW_EMPTY_DATABASE=true`, hoặc chạy cả bộ: `MB03_ALLOW_CREATE_TEST_DATABASE=true MB03_TEST_ADMIN_DATABASE_URL=<…/postgres> npm run test:driver-discovery -w @powerme/csms`.
- Migration: `DATABASE_URL=… node apps/csms/scripts/migrate.mjs` (áp tuần tự, ghi bảng `_migrations`; không `psql -f` từng file).
- Demo cục bộ đầy đủ (DB + CSMS + simulator HMI + seed): `node apps/csms/demo/run-demo.mjs [--reset] [--no-hmi] [--port-offset N]` — cổng `pg 54330 / ocpp 9000 / hmi 8100 / console+API 3000`, cộng `N`. Cần ba biến `DRIVER_API_JWT_*` (và `DASHBOARD_JWT_*` nếu dùng dashboard); seed app: `scripts/seed-demo.mjs`. Diễn tập kịch bản demo: `demo/rehearse-app.mjs ds-01|ds-02`, `demo/rehearse-topup.mjs ds-03|ds-04 --simulate-vnpay`, `demo/scripted-station.mjs <kịch bản>` — xem `docs/demo/DIEN-TAP-BM04.md`.

**Dashboard (`apps/dashboard`)**: `CSMS_URL=http://127.0.0.1:3000 npm run dev -w @powerme/dashboard` (Vite proxy `/api` → CSMS, cùng origin như staging); `npx vitest run test/<file>.test.tsx` trong `apps/dashboard`.

**Mobile (`apps/mobile`, Flutter 3.44 — không có npm script)**: trước khi test/analyze phải `cp config/api.example.json config/api.local.json && cp config/vietmap.example.json config/vietmap.local.json` (file `*.local.json` bị gitignore; thiếu là `Failed to build asset bundle`). Rồi `flutter pub get`, `dart format --output=none --set-exit-if-changed .`, `flutter analyze`, `flutter test [test/<file>_test.dart]`. Bản release chỉ nhận `https` (debug mới nhận `http` local).

**Simulator (`simulator/d1-hmi`)**: `node simulator/d1-hmi/smoke.mjs` (tự dựng CSMS giả, ~1,5 phút, không nằm trong CI); `node --test simulator/d1-hmi/rfid-*.test.mjs`.

## Kiến trúc tổng thể

```
App Flutter ─HTTPS JWT─┐   Dashboard React ─cùng origin─┐        VNPay ─IPN─┐
                       ▼                                ▼                   ▼
          Caddy (staging: TLS, chỉ mở /ocpp/*, /health, /billing/vnpay/*, /api/{driver,auth,operator,admin}/v1/*, dashboard ở /)
                       │
   CSMS (NestJS, một tiến trình) ── :9000 OCPP-J WebSocket (Basic Auth từng trụ)
                                  └ :3000 node:http thuần ─► PostgreSQL (Drizzle schema + SQL migration viết tay)
Simulator d1-hmi / scripted-station ─OCPP─► :9000   (đóng vai trụ Ruihua D1; không đọc DB)
```

- **Không có Nest HTTP.** `apps/csms/src/main.ts` dùng `createApplicationContext`. Cổng 3000 là một `http.Server` trong `console/console.server.ts`, chia theo đường dẫn: `/billing/vnpay/*` → listener VNPay (chỉ dựa chữ ký) · `/api/(auth|operator|admin)/v1/*` → `operator-api/` (JWT dashboard + `rolesGuard`, ADR-0018) · `/api/driver/*` → `driver/` (JWT tài xế) · **còn lại → console `/api/admin/*` CHƯA có xác thực** (chỉ dùng qua SSH tunnel; tuyệt đối không proxy cả `/api` ra internet). Route mới cho dashboard thêm vào `operator-api/*.ts` theo mẫu `match…Route` / `run…Route` và khai trong `QUERY_PATHS` nếu nhận query.
- **Phạm vi Operator:** `rolesGuard` đọc lại role/khoá/operator **từ DB** mỗi request; route operator luôn lọc theo `principal.operatorId`, không bao giờ lấy operator/actor từ body.
- **Đường đi bản tin OCPP** (`ocpp-gateway/`): mọi frame ghi `ocpp_message_log` **trước** khi xử lý (ADR-0005); CALL chiều vào xử lý **tuần tự theo trụ** (ADR-0004, `inbound-serializer.ts`); mỗi lần nối là một **epoch** (`connection-registry.ts`); `reconciliation/replay-detector.ts` coi bản tin có `timestamp` sớm hơn lúc nối > `REPLAY_SKEW_THRESHOLD_S` (5 s) là phát lại; rồi `ocpp-handlers.ts` gọi service nghiệp vụ. Khoá nghiệp vụ là `(chargePointId, connectorId)`; `connectorId = 0` là toàn trụ.
- **Phiên sạc (STM-1, `sessions/session-state-machine.ts`)**: `active → orphaned` (trụ mất kết nối) `→ active` (nối lại) `→ closed → reconciled` hoặc `→ review` (số liệu mâu thuẫn, người vận hành chốt ở màn 23). Mọi chuyển trạng thái ghi `session_status_history`. idTag lạ vẫn tạo phiên (unattributed, ADR-0012) kèm bản ghi `reconciliation_records` (`replay`, `conflict`, `late_sample`, `orphan_stop`, `unknown_id_tag`, …). CSMS là nguồn sự thật cho phiên và tiền; giá hiển thị trên trụ không có giá trị.
- **Tiền** (ADR-0013, ví trả trước): chỉ phiên `reconciled` mới quyết toán (`sessions/charge-settlement.service.ts`, job bền `charge_settlement_jobs`, đúng một `session_debit` qua `CreditLedgerService`; sổ cái chỉ thêm). Giá theo 3 khung giờ; đồng hồ trụ lệch xử lý ở `reconciliation/tariff-clock.ts` (`cp` / `cp_offset` / `csms_fallback`, dung sai 300 s). RFID có giữ tiền/dừng theo ngân sách (ADR-0020). Thanh toán, hoàn tiền, hoá đơn (VNPay, SePay) ở `billing/`.
- **Hẹn giờ trong RAM** (`common/scheduler.ts`, mỗi service tự quét DB lúc khởi động) → chỉ chạy **một** instance CSMS; không chạy CSMS thứ hai trỏ vào cùng DB.
- **Dashboard** (React 19, Vite, RTK Query `core/api/api.ts`, Mantine) gọi `/api/...` cùng origin; kiểu dữ liệu API dùng chung ở `packages/shared` (export thẳng `src/index.ts`, không build). Hợp đồng: `docs/api/OPERATOR-ADMIN-API-HOP-DONG.md` + `operator-admin-api.openapi.yaml`, `docs/api/DRIVER-API-HOP-DONG.md` + `driver-api.openapi.yaml` — sửa route thì sửa hợp đồng cùng PR.
- **Simulator** chỉ biết danh sách trụ được đưa vào (`CP_IDS`, `CP_PASSWORDS`, `CP_NAMES`…; `app-stations.mjs` dựng 13 trụ mẫu) và nói chuyện với CSMS qua OCPP như trụ thật. HMI `/tru/<serial>`; bundle 3D (React + react-three-fiber) build riêng, thiếu thì tự về SVG 2D. App tài xế nhập/quét **mã in trên trụ** (`display_code`, QR `powerme:connector:<mã>/<súng>`), không phải serial OCPP.
- **Staging** (`infra/staging/`): một VM, Docker Compose (`caddy`, `csms`, `postgres`, `dashboard`, `demo-station`, `simulator` profile `sim`). Deploy bằng push tag `review-N` → `.github/workflows/deploy-staging.yml` → `deploy.sh` (sao lưu DB, migrate, kiểm sức khoẻ, tự lùi). Chi tiết vận hành: `infra/staging/README.md`, `DEV-ACCESS.md`.

## Quy ước dễ sai

- **Migration**: SQL viết tay `apps/csms/drizzle/NNNN_<ten>.sql` (không `drizzle-kit generate`, ADR-0008), số tăng dần; cùng PR phải sửa schema TS `src/db/schema/`, thêm nhật ký `docs/NHAT-KY-MIGRATION-NNNN.md`, cập nhật `docs/THIET-KE-CSDL-VAT-LY.md`. Sửa `scripts/migrate.mjs` thì sửa cả `test/helpers/apply-migrations.ts`.
- `UPDATE` SQL thô lên bảng có `updated_at` phải đặt `updated_at=now()` (test `erd-alignment-2` quét toàn `src/`).
- Ngày nghiệp vụ (biểu giá, khuyến mãi) theo giờ Việt Nam: `(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`, không dùng `current_date` (CI chạy UTC → test đỏ 00:00–07:00 giờ VN).
- Thay đổi kiến trúc / thư viện lõi / lệch spec OCPP → ADR mới trong `docs/adr/`. Biến môi trường mới → cập nhật `infra/.env.example` (và `infra/staging/.env.example` nếu staging dùng).
- Commit: `<loại>(<phạm vi>): <mô tả chữ thường không dấu>  [MÃ-TASK]` (Conventional Commits; phạm vi `csms|dashboard|mobile|shared|simulator|infra|docs`). Nhánh `wp<số>/<mã-task>-<mô-tả>`. PR squash-merge, thân PR tiếng Việt. Trước khi merge: cập nhật nhánh theo `main` và chờ CI chạy lại (hai PR cùng xanh khi đứng riêng từng làm `main` đỏ khi gộp).
- Chạy prettier chỉ trên file mình sửa; đừng `prettier --write` cả thư mục `docs/`.

## Môi trường Windows của nhóm

- Lệnh shell là Git Bash; Node trên Windows không hiểu đường dẫn `/tmp/...` của Git Bash (dùng `cygpath -w`).
- Làm việc song song bằng `git worktree` trong `.claude/worktrees/` (repo **không** gitignore thư mục này — thêm `.claude/` vào `.git/info/exclude` của máy mình, và đừng `git add -A` ở gốc). Mỗi worktree tự `npm ci` — **không junction/symlink `node_modules` về repo chính**, và **không bao giờ xoá đệ quy thư mục worktree** (`rm -rf`, `git worktree remove --force`, `Remove-Item -Recurse`): link trong `node_modules/@powerme/*` hoặc junction đã hai lần làm xoá luôn file của repo chính. Gỡ link trước, hoặc chỉ `git worktree prune`. `gh pr merge --delete-branch` cũng tự xoá worktree đang checkout nhánh đó.
