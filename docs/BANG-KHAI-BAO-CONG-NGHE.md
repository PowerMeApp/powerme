# Bảng khai báo công nghệ — Report 4 (T18)

| | |
|---|---|
| Ngày soạn | 23/10/2026 |
| Soạn cho | T18 — Report 4 |
| Người chịu trách nhiệm | Ngô Văn Minh Trí (WP2) |
| Mốc đối chiếu | `origin/main` tại commit `59abc4a31b421cd0c43a1d1c0cbbb80033315f1e` (12/09/2026) |
| Nhánh WP2 chưa merge đã đối chiếu | `wp2/be-01-tai-lieu-kien-truc-va-tong-quan` (e6e1e08, 16/09) · `wp2/be-01-nhan-flutter-va-mo-ta-task` (d3ffdde) · `wp2/be-02-ban-thi-nghiem-ocpp` · `wp2/be-02-csms-ctl-tuong-tac` (5cd8c46, 08/10) |
| Nhánh bot đã đối chiếu | 4 nhánh `dependabot/*` (3 bump GitHub Actions ngày 11/09, 1 bump Prettier ngày 21/09) |

> ⚠️ **Bảng này chỉ ghi những gì có trong repo tại commit `59abc4a31b421cd0c43a1d1c0cbbb80033315f1e` và các nhánh WP2 chưa merge; cột Nguồn để Ân kiểm lại trước khi đưa vào Report.**

**Cách đọc cột Trạng thái**

| Trạng thái | Nghĩa |
|---|---|
| **Đã ghim** | Có số phiên bản cụ thể trong file cấu hình hoặc lockfile của repo (`package.json`, `package-lock.json`, `.nvmrc`, `docker-compose.yml`, workflow). Là thứ máy đang chạy thật. |
| **Đề xuất, chưa ghim** | Chỉ xuất hiện trong tài liệu (README, kế hoạch, `WP2-KIEN-TRUC-TECHSTACK.md`), chưa có trong lockfile hay compose. Số phiên bản nếu có là số tài liệu ghi, không phải số máy đang chạy. |
| **Chưa quyết** | Repo không ghi, hoặc ghi rõ là đang treo chờ quyết định. |

Quy ước ghi nguồn: đường dẫn tương đối từ gốc repo, trên `main` nếu không nói gì khác; `[be-01-docs]` = nhánh `wp2/be-01-tai-lieu-kien-truc-va-tong-quan`; `[be-01-flutter]` = `wp2/be-01-nhan-flutter-va-mo-ta-task`; `[be-02]` = `wp2/be-02-csms-ctl-tuong-tac`.

---

## 1. Ngôn ngữ & runtime

| Thành phần | Phiên bản | Nguồn trong repo | Trạng thái |
|---|---|---|---|
| Node.js | **24.18.1** | `.nvmrc` (= `24.18.1`) · `.github/workflows/ci.yml` (`NODE_VERSION: '24'` — chỉ major, `setup-node` tự lấy 24.x mới nhất) · `package.json` `engines.node` = `>=22.0.0` · README mục "Bắt đầu": "Node.js ≥ 22 (xem .nvmrc)" | **Đã ghim** (ở `.nvmrc`) — ba chỗ ghi ba mức khác nhau, xem mục mâu thuẫn M1 |
| npm | `>=10.0.0` · lockfile v3 | `package.json` `engines.npm` · `package-lock.json` `lockfileVersion: 3` | **Đã ghim** mức tối thiểu; không ghim số chính xác |
| TypeScript | (chưa ghim — cần quyết) | `README.md` bảng "Bộ công cụ" ghi "NestJS + TypeScript", "React + Vite + TypeScript" · `docs/adr/0001-monorepo-npm-workspaces.md` ("Cả ba đầu ra viết bằng TypeScript") · `[be-01-docs] docs/WP2-KIEN-TRUC-TECHSTACK.md` bảng ngăn xếp ghi "5.x, bật `strict`" | **Đề xuất, chưa ghim** — không có `tsconfig*.json`, không có `typescript` trong `package-lock.json` ở bất kỳ nhánh nào |
| JavaScript ESM (`.mjs`) — script bàn thí nghiệm | chạy trực tiếp trên Node (không build) | `[be-02] apps/csms/lab/*.mjs` (`mini-csms.mjs`, `csms-ctl.mjs`, `fake-station.mjs`, `trace.mjs`, `trace-to-mermaid.mjs`, `exp-02-dat-cho.mjs`) · `[be-02] apps/csms/lab/README.md`: "Dụng cụ đo, không phải sản phẩm. BE-02 thật dựng trên NestJS sau" | **Đã ghim** (là mã đang chạy; không phải stack sản phẩm) |
| Dart / Flutter (app tài xế) | (chưa ghim — cần quyết) | `main`: `README.md` + `docs/KE-HOACH-POWERME.md` + `apps/mobile/README.md` ghi **React Native / Expo**. `[be-01-flutter]`: `README.md` và `docs/KE-HOACH-POWERME.md` đổi thành **Flutter** ("hợp đồng API qua `openapi.json` sinh từ NestJS"). `[be-01-docs] WP2-KIEN-TRUC-TECHSTACK.md` sơ đồ mục 1 vẽ `apps/mobile` = Flutter. `apps/mobile/package.json` vẫn là workspace npm rỗng | **Chưa quyết** — repo chưa có một dòng code Flutter/Dart nào; `main` và nhánh chưa merge đang nói hai điều khác nhau (M3) |
| Python (chỉ dùng phân tích số liệu nghiên cứu) | (chưa ghim) | `.gitignore` mục "Python (nghiên cứu / phân tích số liệu)" (`__pycache__/`, `.venv/`, `.ipynb_checkpoints/`) · `.editorconfig` `[*.{py,ps1}] indent_size = 4` · `ocppdl/README.md`: gói `ocpp-2.1.0-py3-none-any.whl` **chỉ để tra schema, không phải phụ thuộc** · `docs/NGHIEN-CUU-NEN-TANG.md` §4: "mobilityhouse/ocpp (MIT) — tham chiếu tầng message *nếu dùng Python*" | **Đề xuất, chưa ghim** — không có `requirements.txt`/`pyproject.toml`, không có file `.py` nào trong repo |

---

## 2. Framework & thư viện lõi

| Thành phần | Phiên bản | Nguồn trong repo | Trạng thái |
|---|---|---|---|
| NestJS (CSMS) | (chưa ghim — tài liệu ghi "11") | `README.md` bảng "Bộ công cụ" và cây thư mục · `apps/csms/README.md` dòng Stack · `docs/KE-HOACH-POWERME.md` §2 · `ocppdl/README.md` ("Backend của nhóm viết bằng NestJS + TypeScript") · `[be-01-docs] WP2-KIEN-TRUC-TECHSTACK.md` bảng ngăn xếp: "NestJS 11 — *đã chọn* — README.md" và ADR-0002 (modular monolith) | **Đề xuất, chưa ghim** — `apps/csms/package.json` (kể cả `[be-02]`) không có `@nestjs/*`; số "11" chỉ nằm trong tài liệu |
| **ocpp-rpc** (tầng vận chuyển OCPP-J) | **2.2.1** — ghim cứng, không `^`/`~` · giấy phép **MIT** · `engines.node >=17.3.0` | `[be-02] apps/csms/package.json` `"ocpp-rpc": "2.2.1"` · `[be-02] package-lock.json` `node_modules/ocpp-rpc` (`version 2.2.1`, `license MIT`, deps `ajv 8.14.0`, `ajv-formats ^2.1.1`, `backoff ^2.5.0`, `ws ^8.5.0`) · `[be-01-docs] WP2-KIEN-TRUC-TECHSTACK.md` ADR-0004 · `[be-02] apps/csms/lab/EXP-01-ngat-ket-noi-81s.md` ("`ocpp-rpc@2.2.1`, `strictMode`") · `docs/NGHIEN-CUU-BO-SUNG-WP2.md` §2.2 | **Đã ghim** (trên nhánh `[be-02]`; `main` chưa có — `origin/main:apps/csms/package.json` không có `dependencies`) |
| ↳ Schema JSON của OCA đi kèm `ocpp-rpc` | theo gói 2.2.1 · giấy phép **CC BY-ND 4.0** (không phái sinh — dùng nguyên văn, không sửa) | `[be-01-docs] WP2-KIEN-TRUC-TECHSTACK.md` ADR-0004 mục "Bẫy giấy phép" — đây là **khẳng định trong tài liệu**, repo không chứa file LICENSE của schema để đối chiếu | **Đề xuất, chưa ghim** về mặt chứng cứ — Ân kiểm lại trong `node_modules/ocpp-rpc` trước khi đưa vào Report |
| ↳ `ws` (WebSocket, phụ thuộc bắc cầu của ocpp-rpc) | **8.21.3** (khoảng `^8.5.0`) · MIT | `[be-02] package-lock.json` `node_modules/ws` · `docs/WP2-LO-TRINH-KY-THUAT.md` dòng 179 ("Thư viện `ws`") | **Đã ghim** qua lockfile (bắc cầu, không khai báo trực tiếp) |
| ↳ `ajv` + `ajv-formats` (validate schema, phụ thuộc bắc cầu của ocpp-rpc) | **8.14.0** (ghim cứng bởi ocpp-rpc) · **2.1.1** · MIT | `[be-02] package-lock.json` `node_modules/ajv`, `node_modules/ajv-formats` | **Đã ghim** qua lockfile (bắc cầu) |
| ↳ `backoff` (bắc cầu) | **2.5.0** · MIT | `[be-02] package-lock.json` `node_modules/backoff` | **Đã ghim** qua lockfile (bắc cầu) |
| `ws` / `ajv` **của SAP simulator** | (chưa ghim) | Repo không chứa mã nguồn hay lockfile của SAP simulator — chỉ có cấu hình ở `[be-02] apps/csms/lab/simulator/` (`config.json`, `idtags.json`, `powerme-d1.station-template.json`). Phiên bản `ws`/`ajv` của SAP nằm trong lockfile upstream tại tag `web@v4.12.0`, ngoài repo | **Chưa quyết** cách khai báo — nếu Report cần, lấy từ `pnpm-lock.yaml` của bản clone SAP đã ghim tag |
| Drizzle ORM + migration SQL thuần | (chưa ghim) | `[be-01-docs] WP2-KIEN-TRUC-TECHSTACK.md` bảng ngăn xếp + ADR-0008 ("*chốt cùng WP5* — WP5 có quyền phủ quyết vì dùng chung DB") · §6 "Việc cần chốt trong S2" | **Chưa quyết** — không có trong lockfile; tài liệu tự ghi là đề xuất |
| Socket.IO + Redis adapter (realtime tới app/dashboard) | (chưa ghim — tài liệu ghi "4.x") | `[be-01-docs] WP2-KIEN-TRUC-TECHSTACK.md` bảng ngăn xếp + ADR-0006 + §4.3 · `[be-01-flutter] docs/KE-HOACH-POWERME.md` dòng BE-08 ("qua Socket.IO — Redis pub/sub chỉ cho giao diện") | **Đề xuất, chưa ghim** — `main` (`apps/csms/README.md`, `KE-HOACH` BE-08) vẫn ghi "Redis pub/sub" không kèm Socket.IO (M6) |
| BullMQ (hàng đợi job nền) · pino (log) · prom-client (metrics) · Jest (test) | (chưa ghim) | `[be-01-docs] WP2-KIEN-TRUC-TECHSTACK.md` bảng ngăn xếp (dòng "Cache, hàng đợi job", "Log", "Metrics", "Test") | **Đề xuất, chưa ghim** — chỉ có trong tài liệu kiến trúc |
| Prettier | khai báo `^3.4.2` · lock **3.9.6** · MIT | `package.json` `devDependencies.prettier` · `package-lock.json` `node_modules/prettier` (`3.9.6`) · cấu hình `.prettierrc.json` (`singleQuote`, `printWidth 100`, `endOfLine lf`) · `.prettierignore` · CI chạy `npm run format:check` (`ci.yml`) · **Dependabot đang đề xuất** nâng lên `^3.9.8` / lock `3.9.8` — nhánh `dependabot/npm_and_yarn/dev-dependencies-e9a20cb14c`, commit `62c760e` (21/09/2026), chưa merge | **Đã ghim** (3.9.6 là bản đang chạy) |
| React + Vite (dashboard) | (chưa ghim) | `README.md` bảng "Bộ công cụ" ("React + Vite + TypeScript") · `apps/dashboard/README.md` dòng Stack · `docs/KE-HOACH-POWERME.md` §2 · `apps/dashboard/package.json` là workspace rỗng (không `dependencies`) | **Đề xuất, chưa ghim** |

---

## 3. Dịch vụ & hạ tầng

| Thành phần | Phiên bản | Nguồn trong repo | Trạng thái |
|---|---|---|---|
| PostgreSQL | **16.4-alpine** (dev, compose) · `16-alpine` (CI) | `infra/docker-compose.yml` service `postgres` `image: postgres:16.4-alpine` · `infra/README.md` bảng "Ghim phiên bản" · `.github/workflows/ci.yml` `services.postgres.image: postgres:16-alpine` · `infra/.env.example` (`DATABASE_URL`) · `[be-01-docs] WP2-KIEN-TRUC-TECHSTACK.md` ADR-0007 (partition gốc theo tháng, không TimescaleDB) | **Đã ghim** — CI và compose lệch patch (M2) |
| Redis | **7.4-alpine** (dev, compose) · `7-alpine` (CI) | `infra/docker-compose.yml` service `redis` (`redis-server --appendonly yes`) · `infra/README.md` · `.github/workflows/ci.yml` `services.redis.image: redis:7-alpine` · `infra/.env.example` (`REDIS_URL`) | **Đã ghim** — CI và compose lệch patch (M2) |
| Caddy 2 (reverse proxy, kết thúc TLS, Security Profile 2) | (chưa ghim — tài liệu ghi "Caddy 2") | `[be-01-docs] WP2-KIEN-TRUC-TECHSTACK.md` bảng ngăn xếp + ADR-0011 + sơ đồ mục 1 + NFR-OCPP-06 | **Đề xuất, chưa ghim** — không có `Caddyfile`, không có service `caddy` trong `infra/docker-compose.yml` |
| Docker Compose | (chưa ghim phiên bản công cụ) — file dùng cú pháp Compose v2 (`name:`, `profiles:`) | `infra/docker-compose.yml` · `package.json` scripts `infra:up/down/logs/reset` (`docker compose -f infra/docker-compose.yml …`) · `README.md` yêu cầu "Docker Desktop" · `infra/README.md` | **Đã ghim** cách dùng; **chưa ghim** phiên bản Docker/Compose |
| SteVe (CSMS đối chứng) | **3.14.1** — release 12/08/2026 · image **build tại chỗ** `steve:3.14.1` · chạy tiến trình riêng, **không fork, không copy code** · profile `reference` | `infra/docker-compose.yml` service `steve` (`image: steve:3.14.1`, chú thích: "Nếu image công khai không có tag này, build cục bộ từ commit đã ghim và ghi lại số commit ở `docs/adr/`") · `infra/README.md` bảng ghim ("Release ngày 12/08/2026") · `README.md` bảng "Bộ công cụ" · `docs/KE-HOACH-POWERME.md` §2 (giấy phép "⚠️ phải tự kiểm") và §9 rủi ro "Giấy phép SteVe chưa chốt" | **Đã ghim** tag; **chưa ghim** commit build cục bộ (không có Dockerfile SteVe trong repo, `docs/adr/` chỉ có ADR-0001) (M5) |
| MySQL (CSDL cho SteVe) | **8.0** (không ghim patch) | `infra/docker-compose.yml` service `steve-db` `image: mysql:8.0`, profile `reference`, DB `stevedb` · `infra/.env.example` `STEVE_DB_PASSWORD` | **Đã ghim** ở mức minor |
| SAP e-mobility-charging-stations-simulator | **v4.12.0** (tag `web@v4.12.0`) · Apache-2.0 · chạy từ source, không dùng Docker | `[be-02] apps/csms/lab/simulator/README.md` ("**v4.12.0** (tag `web@v4.12.0`)"; build: `corepack pnpm install --frozen-lockfile` rồi `node scripts/bundle.js`) · `[be-02] apps/csms/lab/EXP-01-ngat-ket-noi-81s.md` bảng bàn thí nghiệm · `simulator/README.md` (`main`): "Phiên bản ghim: `<điền commit SHA khi clone>`" — **chưa điền** · `README.md`, `docs/KE-HOACH-POWERME.md` §2 (Apache-2.0) · `infra/README.md`: "ghim theo commit — xem simulator/README.md" | **Đã ghim** tag trên `[be-02]`; **chưa ghim** ở `simulator/README.md` trên `main` (M4) |
| ↳ pnpm / corepack (chỉ để build SAP simulator, không phải tool của repo) | (chưa ghim — README chỉ ghi `corepack pnpm`, **không ghi số phiên bản**) | `[be-02] apps/csms/lab/simulator/README.md` dòng "Build không qua `pnpm` lồng (lỗi PATH trên Windows)" · `docs/adr/0001-monorepo-npm-workspaces.md` (pnpm workspaces bị loại cho monorepo) | **Chưa quyết** — nếu Report cần số, phải lấy từ `packageManager` trong `package.json` của bản clone SAP, ngoài repo |
| k6 (load test, QA-07) | (chưa ghim) | `infra/k6/` chỉ có `.gitkeep` · `infra/README.md` mục "Load test (QA-07)" (mẫu MaEVe, 1 VU = 1 trạm) · `README.md` bảng "Bộ công cụ" · `docs/KE-HOACH-POWERME.md` §2 và QA-07 · `.github/CODEOWNERS` (`/infra/k6/` → wp5) · `.gitignore` `k6-results/` | **Đề xuất, chưa ghim** — chưa có kịch bản, chưa có phiên bản |
| gitleaks (quét bí mật) | **8.18.4** — tải binary từ GitHub Release, **không dùng `gitleaks-action`** (đòi giấy phép trả phí trong org) | `.github/workflows/security.yml` (`GITLEAKS_VERSION: 8.18.4`) · `.gitleaks.toml` (`useDefault = true`, `[allowlist]`) · `CONTRIBUTING.md` §7, §10.2 | **Đã ghim** |

---

## 4. Repo, CI, môi trường

| Thành phần | Phiên bản | Nguồn trong repo | Trạng thái |
|---|---|---|---|
| GitHub — org `PowerMeApp`, repo `PowerMeApp/powerme`, **gói Free**, repo private | — | `README.md` (URL clone, cảnh báo "GitHub không thực thi bảo vệ nhánh trên repo này") · `CONTRIBUTING.md` §2, §10 · `.github/CODEOWNERS` · `.githooks/pre-push` · `.github/workflows/main-push-guard.yml` · `scripts/setup-github.sh` | **Đã ghim** (thực trạng) |
| ↳ Branch protection | **không có hiệu lực** trên gói Free → **3 rào chắn thay thế** (CONTRIBUTING §10): (1) hook `pre-push` trên máy, (2) `gitleaks` trong CI thay Secret scanning (API trả 422), (3) workflow "Cảnh gác main" tự tạo issue khi có commit vào `main` không qua PR | `CONTRIBUTING.md` §10.1–10.3 và "Giới hạn cần hiểu đúng" · `README.md` bảng "Ba rào chắn" · `.githooks/pre-push` · `.github/workflows/security.yml` · `.github/workflows/main-push-guard.yml` (có `permissions: pull-requests: read`, commit `59abc4a`) | **Đã ghim** — cách sửa tận gốc (nâng lên GitHub Team qua GitHub Education rồi chạy `scripts/setup-github.sh`) **chưa làm** |
| ↳ CODEOWNERS | — | `.github/CODEOWNERS` (team `@PowerMeApp/wp1…wp5`; ghi rõ "chỉ có hiệu lực khi bật Require review from Code Owners — gói Free chưa bật được") | **Đã ghim** nhưng không hiệu lực |
| GitHub Actions — runner | `ubuntu-latest` | `ci.yml`, `security.yml`, `pr-title.yml`, `main-push-guard.yml` | **Đã ghim** (floating tag của GitHub) |
| ↳ `actions/checkout` | **v4** — Dependabot đề xuất **v7** | `.github/workflows/ci.yml`, `.github/workflows/security.yml` (`fetch-depth: 0`) · nhánh `dependabot/github_actions/actions/checkout-7`, commit `68641ef` (11/09/2026), chưa merge | **Đã ghim** v4; PR nâng cấp đang treo |
| ↳ `actions/setup-node` | **v4** (`node-version: 24`, `cache: npm`) — Dependabot đề xuất **v7** | `.github/workflows/ci.yml` · nhánh `dependabot/github_actions/actions/setup-node-7`, commit `d584cfd` (11/09/2026), chưa merge | **Đã ghim** v4; PR nâng cấp đang treo |
| ↳ `amannn/action-semantic-pull-request` | **v5** — Dependabot đề xuất **v6** | `.github/workflows/pr-title.yml` (types: feat/fix/refactor/test/docs/chore/perf; scopes: csms/dashboard/mobile/shared/simulator/infra/docs/repo; `subjectPattern: ^(?![A-Z]).+$`) · nhánh `dependabot/github_actions/amannn/action-semantic-pull-request-6`, commit `1550a3f` (11/09/2026), chưa merge | **Đã ghim** v5; PR nâng cấp đang treo |
| ↳ gitleaks trong CI | 8.18.4 (xem bảng 3) | `.github/workflows/security.yml` | **Đã ghim** |
| ↳ CI pipeline | Lint · Typecheck · Test · Build + `format:check`, service container Postgres/Redis, `concurrency.cancel-in-progress`, chạy trên **mọi** PR (kể cả PR xếp tầng) | `.github/workflows/ci.yml` (`on.pull_request` không lọc nhánh — commit `5cd8c46` trên `[be-02]`; `main` tại `59abc4a` vẫn lọc `branches: [main]`) | **Đã ghim** — bản trên `main` và `[be-02]` khác nhau ở phần `on:` |
| npm workspaces (monorepo) | `apps/*`, `packages/*` → `@powerme/csms`, `@powerme/dashboard`, `@powerme/mobile`, `@powerme/shared` (đều `0.1.0`, private) | `package.json` `workspaces` · `apps/*/package.json`, `packages/shared/package.json` · `docs/adr/0001-monorepo-npm-workspaces.md` (Chấp nhận, 03/09/2026) · `.gitattributes` (`package-lock.json linguist-generated -diff`) | **Đã ghim** |
| Conventional Commits | `<loại>(<phạm vi>): <mô tả>  [MÃ-TASK]` | `CONTRIBUTING.md` §3 · `.github/workflows/pr-title.yml` (kiểm tiêu đề PR) · `.github/dependabot.yml` (`commit-message.prefix` `chore(deps)` / `chore(ci)`) | **Đã ghim** |
| Squash merge | chỉ cho phép squash; tiêu đề commit = tiêu đề PR; tự xoá nhánh sau gộp | `CONTRIBUTING.md` §4 · `scripts/setup-github.sh` dòng 155–163 (`allow_squash_merge=true`, `allow_merge_commit=false`, `allow_rebase_merge=false`, `delete_branch_on_merge=true`) | **Đã ghim** quy ước; việc script đã chạy trên GitHub hay chưa **không kiểm được từ repo** |
| Hook `pre-push` | chặn push vào `main` trên máy; vượt rào có chủ đích bằng `POWERME_ALLOW_MAIN_PUSH=1` | `.githooks/pre-push` · `scripts/setup-hooks.sh` (`git config core.hooksPath .githooks`) · `package.json` script `prepare` (tự chạy khi `npm install`) và `setup:hooks` | **Đã ghim** |
| Dependabot (bot tự động) | npm: hằng tuần thứ Hai, tối đa 5 PR, gom nhóm `dev-dependencies` và `production-patch-minor` · GitHub Actions: hằng tháng | `.github/dependabot.yml` · 4 nhánh `dependabot/*` đang mở (xem các dòng Actions và Prettier) | **Đã ghim** |
| Định dạng mã nguồn | Prettier 3.9.6 (bảng 2) · `.editorconfig` (utf-8, lf, 2 space; `.py`/`.ps1` 4 space) · `.gitattributes` (`eol=lf`, `.ps1`/`.bat` crlf) | `.prettierrc.json`, `.prettierignore`, `.editorconfig`, `.gitattributes` | **Đã ghim** |
| Mẫu Issue / PR | `bug.yml`, `research.yml`, `task.yml`, `config.yml` · `pull_request_template.md` | `.github/ISSUE_TEMPLATE/`, `.github/pull_request_template.md` | **Đã ghim** |
| Biến môi trường | `infra/.env.example` (Postgres, Redis, `CSMS_HTTP_PORT=3000`, `CSMS_OCPP_WS_PORT=3001`, `CSMS_OCPP_PATH_PREFIX=/ocpp`, `OCPP_HEARTBEAT_INTERVAL_SECONDS=300`, `OCPP_OFFLINE_THRESHOLD_SECONDS=900`, JWT, SteVe, VNPay) | `infra/.env.example` · `CONTRIBUTING.md` §7 | **Đã ghim** (giá trị giả) |
| Môi trường staging / deploy | "Docker Compose trên một VPS · GitHub Actions" | `[be-01-docs] WP2-KIEN-TRUC-TECHSTACK.md` bảng ngăn xếp dòng "Triển khai" (ghi *đã có*) và §6 "Nơi chạy staging — WP1 hỏi GVHD (agenda 2.5); nếu không: tự thuê VPS" · `docs/AGENDA-GAP-GVHD.md` §2.5 · `CONTRIBUTING.md` §5 DoD ("Chạy được trên môi trường staging") | **Chưa quyết** — không có workflow deploy, không có cấu hình staging trong repo (xem bảng 5, hosting) |

---

## 5. Dịch vụ ngoài & công cụ AI

| Thành phần | Phiên bản / trạng thái | Nguồn trong repo | Trạng thái |
|---|---|---|---|
| VNPay sandbox (thanh toán, QA-04) | **chưa đăng ký** — `VNPAY_TMN_CODE=` và `VNPAY_HASH_SECRET=` để trống; URL sandbox `https://sandbox.vnpayment.vn/paymentv2/vpcpay.html` | `infra/.env.example` mục "VNPay sandbox (QA-04)" ("Xin trước, đừng đợi tới S5. Nếu không xin được thì chuyển sang mock service") · `docs/KE-HOACH-POWERME.md` §9 rủi ro "Không xin được sandbox thanh toán và hoá đơn điện tử" · `docs/NGHIEN-CUU-NEN-TANG.md` ("KHÔNG CÓ DỮ LIỆU" về điều kiện sandbox cho nhóm sinh viên) · `[be-01-docs] PHAN-TICH-TAI-LIEU-WP1.md` (IPN VNPay thuộc WP2, module `payments` trong `apps/csms`) | **Chưa quyết** — dự phòng: mock service |
| Hoá đơn điện tử (Viettel / VNPT / MISA) | **chưa** — nhà cung cấp yêu cầu pháp nhân và mã số thuế | `docs/AGENDA-GAP-GVHD.md` §1.4 (dự phòng: tự sinh XML theo NĐ 123/2020 và TT 78/2021, ký số bằng chứng thư thử nghiệm) · `docs/KE-HOACH-POWERME.md` §9 · `docs/NGHIEN-CUU-NEN-TANG.md` §6 (việc gọi Viettel Invoice / VNPT / MISA giao WP5, tuần 1) | **Chưa quyết** |
| Firebase Cloud Messaging (thông báo đẩy) | **chưa quyết** | `docs/KE-HOACH-POWERME.md` §8 "Danh sách cắt": "Thông báo đẩy → thay bằng thông báo trong app" · `[be-01-docs] PHAN-TICH-TAI-LIEU-WP1.md` §6.3: WP1 chỉ ra WebSocket không đánh thức app chạy nền, "nếu giữ mục tiêu 8–9 thì phải khôi phục, việc của WP2 (gửi) + WP3 (nhận)" | **Chưa quyết** — hai tài liệu kéo hai hướng |
| Hosting / vùng dữ liệu | **chưa quyết**: AWS Singapore (rẻ; là chuyển dữ liệu xuyên biên giới theo PDPL và NĐ 13/2023) **vs** AWS Hanoi Local Zone (GA 19/06/2026; đắt hơn; dữ liệu trong nước) | `[be-01-docs] PHAN-TICH-TAI-LIEU-WP1.md` §6.2 "Quyết định vùng hosting" · `[be-01-docs] WP2-KIEN-TRUC-TECHSTACK.md` chỉ ghi "Docker Compose trên một VPS", không ghi vùng · `docs/AGENDA-GAP-GVHD.md` §2.5 (hỏi trường có hỗ trợ máy chủ/credit cloud) | **Chưa quyết** |
| Google Drive dự án (tài liệu WP1: "PowerMe Doc" Google Docs 169 trang; thư mục Context chứa manual D1 / YJ-EU) | — | `[be-01-docs] WP2-KIEN-TRUC-TECHSTACK.md` chú thích cuối ("thư mục Context của Drive dự án ngày 11/09/2026") · `[be-01-docs] PHAN-TICH-TAI-LIEU-WP1.md` chú thích cuối ("PowerMe Doc (Google Docs, 169 trang) đọc ngày 12/09/2026") · repo **không có link Drive** | **Đã ghim** là nơi chứa tài liệu; link/quyền truy cập không nằm trong repo |
| **Công cụ AI: Claude Code (Anthropic)** — hỗ trợ viết tài liệu, script thí nghiệm và review | (chưa ghim — tên model/phiên bản không ghi ở đâu trong repo) | Repo **không nêu tên** "Claude" hay "Anthropic" ở file tracked nào. Dấu vết gián tiếp: `[be-01-docs] PHAN-TICH-TAI-LIEU-WP1.md` §9 ("Tài liệu của WP1 … phần lớn do AI hỗ trợ tạo ra — chính WP1 ghi nhận điều đó trong Charter §4 và rủi ro R-A02. Tài liệu kiến trúc WP2 của bạn cũng vậy") · `[be-01-flutter] .gitignore` ("Ngữ cảnh cá nhân cho phiên AI — không đưa lên repo chung: `HANDOFF.md`"). Tên công cụ cụ thể là **khai báo của WP2 (người soạn bảng này)**, không phải trích từ repo | **Đề xuất, chưa ghim** — Report cần ghi tên công cụ và phạm vi dùng theo khai báo của nhóm |
| ↳ Ràng buộc **R-A02** (sổ rủi ro của WP1) | Nguyên văn theo `PHAN-TICH-TAI-LIEU-WP1.md` dòng 234: *"nhóm dựa vào code và tài liệu do AI sinh mà không thực sự hiểu, rồi hỏng ở phần hỏi đáp khi hội đồng truy vì sao nó hoạt động."* → **Mọi code/tài liệu AI sinh ra phải được thành viên hiểu và giải thích được.** Cách kiểm tra tài liệu đề xuất: bàn thí nghiệm OCPP, tự vẽ lại sequence diagram từ log thật | `[be-01-docs] PHAN-TICH-TAI-LIEU-WP1.md` dòng 88 và 230–236 · bằng chứng đã làm: `[be-02] apps/csms/lab/EXP-01-ngat-ket-noi-81s.md`, `EXP-02-dat-cho.md`, `ocpp-traces/exp1-disconnect-81s.jsonl` (150 frame), `trace-to-mermaid.mjs` · **Sổ rủi ro gốc (của WP1) không nằm trong repo** — nằm trong PowerMe Doc trên Drive | **Đã ghim** nguyên tắc (trích dẫn gián tiếp); bản gốc R-A02 cần Ân đối chiếu với sổ rủi ro của WP1 |
| Dependabot (bot tự động của GitHub) | cấu hình tại bảng 4 | `.github/dependabot.yml` | **Đã ghim** |
| GitHub Education (nâng org lên Team để bật branch protection) | **chưa làm** | `CONTRIBUTING.md` §10 "Giới hạn cần hiểu đúng" · `README.md` · `scripts/setup-github.sh` | **Chưa quyết** |

---

## Chỗ chưa ghim cần quyết trước Hội đồng

Mọi dòng ở trên có trạng thái **Chưa quyết** hoặc **Đề xuất, chưa ghim**, gom theo người chịu trách nhiệm gợi ý (theo `CODEOWNERS` và `WP2-KIEN-TRUC-TECHSTACK.md` §6):

| # | Thành phần | Bảng | Trạng thái | Cần gì để ghim | Ai quyết (gợi ý) |
|---|---|---|---|---|---|
| 1 | TypeScript | 1 | Đề xuất, chưa ghim | Thêm `typescript` + `tsconfig.base.json` vào workspace, lock phiên bản | WP2 |
| 2 | Dart / Flutter (app) | 1 | Chưa quyết | Merge `wp2/be-01-nhan-flutter-va-mo-ta-task` hoặc bác; cập nhật ADR-0001 (lý do "cả ba đầu ra TypeScript" không còn đúng nếu Flutter); ghim Flutter SDK khi có code | WP1 + WP3 |
| 3 | Python (phân tích số liệu) | 1 | Đề xuất, chưa ghim | Nếu dùng: thêm `requirements.txt`/`pyproject.toml` và ghi phiên bản Python; nếu không: ghi rõ trong Report là không dùng | WP5 |
| 4 | NestJS | 2 | Đề xuất, chưa ghim | Scaffold `apps/csms` thật, lock `@nestjs/*` (tài liệu ghi 11 — phải khớp lock) | WP2 |
| 5 | Giấy phép CC BY-ND 4.0 của schema OCA trong `ocpp-rpc` | 2 | Đề xuất (chứng cứ) | Kiểm file LICENSE/README trong gói `ocpp-rpc@2.2.1` và ghi vào SDD | WP2, Ân kiểm |
| 6 | `ws`/`ajv` của SAP simulator | 2 | Chưa quyết | Quyết có khai báo trong Report không; nếu có, lấy từ lockfile upstream tại `web@v4.12.0` | WP5 |
| 7 | Drizzle ORM | 2 | Chưa quyết | WP5 đồng ý (dùng chung DB) → tách ADR-0008 thành file trong `docs/adr/` | WP2 + WP5 |
| 8 | Socket.IO + Redis adapter | 2 | Đề xuất, chưa ghim | Chấp nhận ADR-0006; sửa `apps/csms/README.md` dòng BE-08 và `packages/shared/README.md` | WP2, WP3, WP4 |
| 9 | BullMQ · pino · prom-client · Jest | 2 | Đề xuất, chưa ghim | Lock khi scaffold NestJS | WP2 |
| 10 | React + Vite (dashboard) | 2 | Đề xuất, chưa ghim | Scaffold `apps/dashboard`, lock phiên bản | WP4 |
| 11 | Caddy 2 | 3 | Đề xuất, chưa ghim | Thêm service `caddy` + `Caddyfile` vào compose (hoặc compose riêng cho staging); chấp nhận ADR-0011 | WP2 |
| 12 | Phiên bản Docker / Docker Compose | 3 | Chưa ghim | Ghi phiên bản Docker Desktop/Compose tối thiểu vào `infra/README.md` | WP2 |
| 13 | SteVe — commit build cục bộ | 3 | Chưa ghim một nửa | Thêm Dockerfile/bước build `steve:3.14.1` và ADR ghi commit SHA (compose đã yêu cầu) | WP2 + WP1 |
| 14 | SAP simulator — `simulator/README.md` trên `main` | 3 | Chưa ghim trên `main` | Điền tag `web@v4.12.0` (hoặc SHA) vào bảng đầu `simulator/README.md`; merge `[be-02]` | WP5 |
| 15 | pnpm / corepack (build SAP) | 3 | Chưa quyết | Ghi số phiên bản thực tế đã dùng vào `apps/csms/lab/simulator/README.md` nếu Report cần | WP2 / WP5 |
| 16 | k6 | 3 | Đề xuất, chưa ghim | Thêm kịch bản vào `infra/k6/` và ghim phiên bản k6 | WP5 |
| 17 | Squash merge — đã bật trên GitHub chưa | 4 | Không kiểm được từ repo | Ân xác nhận trên Settings của repo | WP1 |
| 18 | Môi trường staging / nơi deploy | 4 | Chưa quyết | Trả lời agenda 2.5 với GVHD; nếu không: thuê VPS | WP1 |
| 19 | VNPay sandbox | 5 | Chưa đăng ký | Xin credential hoặc chốt mock service | WP5 |
| 20 | Hoá đơn điện tử | 5 | Chưa | Chốt phương án XML tự sinh theo NĐ 123/2020 | WP5 + WP1 |
| 21 | FCM | 5 | Chưa quyết | Giữ "cắt" (KE-HOACH §8) hay khôi phục (PHAN-TICH §6.3) | WP1 + WP2 + WP3 |
| 22 | Vùng hosting (Singapore vs Hanoi Local Zone) | 5 | Chưa quyết | Một dòng quyết định có ý thức, kể cả "chấp nhận đơn giản hoá cho phạm vi capstone" | WP1 |
| 23 | Tên và phạm vi dùng công cụ AI (Claude Code) | 5 | Đề xuất, chưa ghim | Ghi vào Report theo khai báo nhóm; đối chiếu Charter §4 của WP1 | WP1 + WP2 |
| 24 | R-A02 — bản gốc | 5 | Trích gián tiếp | Ân đối chiếu nguyên văn với sổ rủi ro WP1 (hai chỗ trong `PHAN-TICH-TAI-LIEU-WP1.md` trích khác nhau) | WP1 |
| 25 | GitHub Education → GitHub Team | 5 | Chưa làm | Nộp đơn; chạy `scripts/setup-github.sh` | WP1 |
| 26 | 4 PR Dependabot (checkout v7, setup-node v7, semantic-pull-request v6, prettier 3.9.8) | 4 | Đang treo | Review, rebase lên `main` hiện tại (nhánh tạo 11/09 trước commit `ca2f77c` 12/09) rồi gộp hoặc đóng | WP1 + WP2 |

---

*Nguồn đối chiếu: toàn bộ file liệt kê ở cột "Nguồn trong repo", đọc bằng `git show origin/<nhánh>:<path>` sau `git fetch origin` ngày 23/10/2026. Bảng không chứa thông tin nào ngoài repo trừ dòng "Claude Code" (khai báo của người soạn, đã ghi rõ).*
