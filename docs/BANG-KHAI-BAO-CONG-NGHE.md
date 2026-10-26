# Bảng khai báo công nghệ — Report 4 (T18)

| | |
|---|---|
| Ngày soạn | 23/10/2026 |
| Soạn cho | T18 — Report 4 (khung năm nhóm theo hướng dẫn Review 2) |
| Người chịu trách nhiệm | Ngô Văn Minh Trí (WP2) |
| Mốc đối chiếu | `origin/main` tại commit `d4f771a48b8fab784365087eb9b925e616b8df24` (23/10/2026, PR #26) |
| Cách đối chiếu | Đọc trực tiếp `package.json`, `apps/csms/package.json`, `package-lock.json` (đọc bằng `node`), `.nvmrc`, `infra/docker-compose.yml`, `.github/workflows/*.yml`, `.github/dependabot.yml`, `simulator/README.md` trên `main`; lịch sử commit bằng `git log` |

Bản này thay bản viết khi hầu hết code chưa merge. Mâu thuẫn nội bộ M1–M14 đã dọn ở PR #22 (xem `docs/NHAT-KY-DON-MAU-THUAN.md`).

**Cách đọc cột Trạng thái**

| Trạng thái | Nghĩa |
|---|---|
| **Đã ghim** | Có số phiên bản cụ thể trong lock, compose, workflow hoặc README ghim của repo trên `main`. |
| **Đề xuất, chưa ghim** | Chỉ có trong tài liệu hoặc mới ở mức khoảng (`^`); số trong tài liệu không phải số máy đang chạy. |
| **Chưa quyết** | Repo không ghi hoặc ghi rõ là đang treo. |
| **Chưa có trong repo** | Có nhắc trong kế hoạch/tài liệu nhưng không có file cấu hình, lock hay mã nào trên `main`. |

Đường dẫn ở cột Nguồn tính từ gốc repo, trên `main`.

---

## 1. Dịch vụ bên thứ ba

"Dữ liệu gửi đi" là dữ liệu thực tế đang rời máy hôm nay, không phải dự định. Toàn bộ dữ liệu demo (trụ, thẻ, phiên sạc) là giả lập; repo không chứa dữ liệu cá nhân thật.

| Dịch vụ | Mục đích | Dữ liệu gửi đi hiện tại | Nguồn | Trạng thái |
|---|---|---|---|---|
| GitHub (org `PowerMeApp`, gói Free, repo private) | Lưu mã nguồn, PR/review, Issues, Actions (CI), Dependabot | Mã nguồn và tài liệu của dự án. Không có dữ liệu cá nhân thật, không có khoá/mật khẩu thật (gitleaks quét mọi PR). `infra/.env.example` chỉ chứa giá trị giả | `README.md`, `CONTRIBUTING.md` §10, `.github/` | **Đã ghim** (đang dùng) |
| GitHub Actions (runner `ubuntu-latest`) | Chạy CI và quét bí mật | Bản checkout của repo trong runner; log của job. Container Postgres/Redis chỉ sống trong job | `.github/workflows/ci.yml`, `security.yml` | **Đã ghim** (đang dùng) |
| Dependabot (bot của GitHub, không phải AI) | Đề xuất nâng phiên bản npm (hằng tuần) và GitHub Actions (hằng tháng) | Đọc manifest/lock của repo; không nhận dữ liệu ngoài | `.github/dependabot.yml` | **Đã ghim** (đang dùng) |
| Google Drive (tài liệu nhóm; "PowerMe Doc" của WP1, thư mục Context) | Lưu tài liệu của WP1 và tài liệu hãng (manual D1 / YJ-EU) | Tài liệu dự án và manual phần cứng. Không có dữ liệu cá nhân của người dùng cuối. Link/quyền truy cập không nằm trong repo | `docs/PHAN-TICH-TAI-LIEU-WP1.md` (chú thích cuối) | **Đã ghim** là nơi chứa tài liệu; quyền truy cập không kiểm được từ repo |
| VNPay sandbox | Thanh toán thử (QA-04) | Chưa gửi gì. `VNPAY_TMN_CODE` và `VNPAY_HASH_SECRET` để trống | `infra/.env.example`, `docs/KE-HOACH-POWERME.md` §9 | **Chưa có trong repo** (chưa đăng ký; dự phòng: mock service) |
| Hoá đơn điện tử (Viettel / VNPT / MISA) | Xuất hoá đơn | Chưa gửi gì; nhà cung cấp đòi pháp nhân và mã số thuế | `docs/AGENDA-GAP-GVHD.md` §1.4, `docs/NGHIEN-CUU-NEN-TANG.md` §6 | **Chưa có trong repo** (dự phòng: tự sinh XML theo NĐ 123/2020) |
| Firebase Cloud Messaging | Thông báo đẩy tới app | Chưa gửi gì. Thông báo đẩy nằm trong danh sách cắt (thay bằng thông báo trong app) | `docs/KE-HOACH-POWERME.md` §8, `docs/PHAN-TICH-TAI-LIEU-WP1.md` §6.3 | **Chưa quyết** |
| Dịch vụ hosting (staging/production) | Chạy CSMS cho hội đồng/doanh nghiệp truy cập | Chưa gửi gì vì chưa có hosting. Khi có, dữ liệu trụ/phiên sạc nằm ở vùng đã chọn, kéo theo vấn đề PDPL (mục 4) | `docs/PHAN-TICH-TAI-LIEU-WP1.md` §6.2 | **Chưa quyết** |
| Dịch vụ của công cụ AI (Anthropic, qua Claude Code) | Hỗ trợ viết tài liệu/code/test (mục 5) | Đoạn mã và tài liệu của repo nằm trong ngữ cảnh phiên làm việc. Quy tắc: không đưa dữ liệu thật, khoá, mật khẩu vào | Mục 5 | **Đã ghim** (đang dùng; khai báo của nhóm) |

---

## 2. Công nghệ phát triển

Số phiên bản lấy từ `package-lock.json` (`packages["node_modules/<tên>"].version`) khi ghi "lock", và từ `apps/csms/package.json` khi ghi "khai báo". Các gói của `apps/csms` được khai báo ghim cứng (không `^`/`~`).

### 2.1 Back-end (CSMS, `apps/csms`) và runtime

| Thành phần | Phiên bản | Nguồn | Trạng thái |
|---|---|---|---|
| Node.js | **24.18.1** (CI dùng `24`, tức 24.x mới nhất) | `.nvmrc` · `.github/workflows/ci.yml` (`NODE_VERSION: '24'`) · `package.json` `engines.node` `>=24.0.0` | **Đã ghim** (số chính xác ở `.nvmrc`; CI chỉ ghim major) |
| npm | `>=10.0.0`; `lockfileVersion` 3 | `package.json` `engines.npm` · `package-lock.json` | **Đã ghim** mức tối thiểu |
| TypeScript | **5.9.3** (devDependency) | `apps/csms/package.json` · lock `typescript` 5.9.3 · `apps/csms/tsconfig*.json` · ADR-0003 | **Đã ghim** |
| NestJS (`@nestjs/common`, `@nestjs/core`) | **12.2.0** | `apps/csms/package.json` · lock `@nestjs/core` 12.2.0 | **Đã ghim** |
| `rxjs` · `reflect-metadata` | **7.8.2** · **0.2.2** (phụ thuộc trực tiếp) | `apps/csms/package.json` · lock | **Đã ghim** |
| `ocpp-rpc` (tầng OCPP-J, MIT) | **2.2.1** | `apps/csms/package.json` · lock · ADR-0004 | **Đã ghim** |
| ↳ `ws` (bắc cầu của ocpp-rpc) | **8.21.3** | lock `ws` | **Đã ghim** (bắc cầu) |
| ↳ `ajv` (bắc cầu của ocpp-rpc) | **8.14.0** | lock `ajv` | **Đã ghim** (bắc cầu) |
| `@types/node` · `@types/jest` · `@types/pg` | **24.19.2** · **30.0.0** · **8.23.1** | `apps/csms/package.json` · lock | **Đã ghim** |
| Socket.IO + Redis adapter (realtime) | — (tài liệu ghi "4.x") | ADR-0006; `apps/csms/README.md` ghi BE-08 là "chưa". Không có `socket.io` trong lock; console hiện poll mỗi 1 giây | **Đề xuất, chưa ghim** |
| BullMQ · pino · prom-client | — | Chỉ nằm trong `docs/WP2-KIEN-TRUC-TECHSTACK.md`; không có trong lock | **Đề xuất, chưa ghim** |
| Caddy 2 (reverse proxy, TLS, Security Profile 2) | — | ADR-0011; không có `Caddyfile` và không có service `caddy` trong `infra/docker-compose.yml` | **Chưa có trong repo** |
| `@powerme/shared` (kiểu dữ liệu dùng chung) | `0.1.0`, private; chưa có mã | `packages/shared/package.json` | **Đã ghim** (workspace rỗng) |

### 2.2 Cơ sở dữ liệu

| Thành phần | Phiên bản | Nguồn | Trạng thái |
|---|---|---|---|
| PostgreSQL (compose và CI) | **16.4-alpine** (compose và CI cùng số) | `infra/docker-compose.yml` · `.github/workflows/ci.yml` `services.postgres.image` · ADR-0007 | **Đã ghim** |
| PostgreSQL nhúng cho `npm run demo` | **17.10.0-beta.17** (gói `embedded-postgres`, chỉ `devDependency`, kèm binary `@embedded-postgres/windows-x64`, `linux-x64`...). Bản beta, khác bản CI (16.4); kết quả demo **không thay** kiểm thử trên Postgres 16 | `apps/csms/package.json` · lock `embedded-postgres` 17.10.0-beta.17 · `apps/csms/demo/db-embedded.mjs` (chú thích đầu file) · `docs/DEMO-REVIEW-2.md` | **Đã ghim** (chỉ cho demo) |
| `pg` (driver) | **8.23.1** | `apps/csms/package.json` · lock | **Đã ghim** |
| Drizzle ORM | **0.45.4** (Apache-2.0) | `apps/csms/package.json` · lock · ADR-0008 | **Đã ghim** |
| `drizzle-kit` (devDependency) | **0.31.11** | `apps/csms/package.json` · lock · `apps/csms/drizzle.config.ts` | **Đã ghim** |
| Migration | SQL viết tay: `apps/csms/drizzle/0000_init.sql` (có partition) | `apps/csms/drizzle/` · `docs/THIET-KE-CSDL-VAT-LY.md` | **Đã ghim** |
| Redis | **7.4-alpine** (compose và CI). Chưa có thư viện client Redis nào trong lock; `apps/csms/README.md` ghi "chưa dùng ở Iteration 1" | `infra/docker-compose.yml` · `ci.yml` | **Đã ghim** ảnh; **chưa dùng** trong mã |
| PGlite | **Không có trong repo.** Lock chỉ nhắc `@electric-sql/pglite` như peer tuỳ chọn của `drizzle-orm`, không được cài. Từng dùng tạm ngoài repo bởi agent kiểm chứng; không đủ vì migration dùng partition | `package-lock.json` (peerOptional) · chú thích `apps/csms/demo/db-embedded.mjs` | **Chưa có trong repo** |
| MySQL (CSDL của SteVe) | **8.0** (không ghim patch), profile `reference` | `infra/docker-compose.yml` service `steve-db` | **Đã ghim** mức minor |

### 2.3 Front-end

| Thành phần | Phiên bản | Nguồn | Trạng thái |
|---|---|---|---|
| Console vận hành (`apps/csms/src/console`) | Phục vụ từ chính CSMS, trang poll mỗi 1 giây; không có thư viện front-end riêng | `apps/csms/README.md` · PR #24 | **Đã ghim** (không dependency UI) |
| Mini HMI trụ D1 `simulator/d1-hmi` | Node thuần (ESM `.mjs`), **không dependency riêng**, chỉ dùng `ocpp-rpc` đã có trong `node_modules` | `simulator/d1-hmi/README.md` · `server.mjs`, `smoke.mjs` | **Đã ghim** |
| React + Vite + TypeScript (dashboard `apps/dashboard`) | — | `README.md` bảng "Bộ công cụ". `apps/dashboard/` chỉ có `README.md` và `package.json` (không `dependencies`, không `src`) | **Chưa có trong repo** (đề xuất trong kế hoạch) |

### 2.4 Mobile

| Thành phần | Phiên bản | Nguồn | Trạng thái |
|---|---|---|---|
| Flutter (Dart), app tài xế `apps/mobile` | — | `README.md` và `apps/mobile/README.md` ghi Flutter, ngoài npm workspaces. `apps/mobile/` chỉ có `README.md` và `package.json` rỗng (`scripts: {}`); không có `pubspec.yaml`, không có file Dart | **Chưa có trong repo** (WP3 chưa nộp mã) |
| React Native / Expo | — | Đã bỏ khỏi tài liệu ở PR #22 | Không dùng |

### 2.5 Kiểm thử, định dạng, công cụ dev

| Thành phần | Phiên bản | Nguồn | Trạng thái |
|---|---|---|---|
| Jest | **30.5.2** | `apps/csms/package.json` · lock · `apps/csms/jest.config.js` (`preset: ts-jest`, `maxWorkers: 1`; test tích hợp tự bỏ qua khi thiếu `DATABASE_URL`) | **Đã ghim** |
| ts-jest | **29.4.15** | `apps/csms/package.json` · lock | **Đã ghim** |
| Prettier | khai báo `^3.4.2` · lock **3.9.6** | `package.json` · `package-lock.json` · `.prettierrc.json` | **Đã ghim** qua lock (khai báo dạng khoảng) |
| Lint | Không có công cụ lint: không có ESLint trong lock; bước `npm run lint` của CI dùng `--if-present` nên không làm gì | `package.json` · `.github/workflows/ci.yml` | **Chưa có trong repo** |
| SAP e-mobility-charging-stations-simulator | **v4.12.0**, tag `web@v4.12.0` = commit `227ec233edbc115a879fb18fb0094b99694954fe`, pnpm 11.22.0 (`packageManager` của upstream); Apache-2.0; clone ngoài repo, chạy từ source | `simulator/README.md` (bảng đầu) · `apps/csms/lab/simulator/README.md` | **Đã ghim** |
| SteVe (CSMS đối chứng) | **3.14.1**, build cục bộ từ tag `steve-3.14.1` = commit `3fd8cda4722822214f744329bc48dba349456514`, profile `reference`, chạy riêng, không fork | `infra/docker-compose.yml` · `infra/README.md` | **Đã ghim** tag/commit; chưa dựng được trên máy Trí (không có Docker) |
| k6 (load test, QA-07) | — | `infra/k6/` không có file nào được theo dõi | **Chưa có trong repo** |
| Docker / Docker Compose | Phiên bản công cụ chưa ghim; file dùng cú pháp Compose v2 | `infra/docker-compose.yml` · `infra/README.md` | **Đề xuất, chưa ghim** |

---

## 3. Mã nguồn và DevOps

| Thành phần | Chi tiết | Nguồn | Trạng thái |
|---|---|---|---|
| Nền tảng mã nguồn | GitHub, org `PowerMeApp`, repo private, gói Free. Monorepo npm workspaces `apps/*`, `packages/*` (`@powerme/csms`, `dashboard`, `mobile`, `shared`, đều `0.1.0`) | `package.json` · ADR-0001 | **Đã ghim** |
| Quy tắc nhánh | `main` là nhánh dài hạn duy nhất; nhánh `wp<số>/<mã-task>-<mô-tả-không-dấu>`, một nhánh một task, sống quá 5 ngày là chia chưa nhỏ; đồng bộ bằng rebase | `CONTRIBUTING.md` §2 | **Đã ghim** (quy ước) |
| Commit/PR | Conventional Commits `<loại>(<phạm vi>): <mô tả>  [MÃ-TASK]`; kiểm tiêu đề PR bằng `amannn/action-semantic-pull-request@v5` (bỏ qua actor `dependabot[bot]`); squash merge | `CONTRIBUTING.md` §3–4 · `.github/workflows/pr-title.yml` | **Đã ghim** |
| Điều kiện gộp theo quy ước | CI xanh, ít nhất một approve từ người khác, comment đã xử lý, PR điền đủ mẫu | `CONTRIBUTING.md` §4 · `.github/pull_request_template.md` | **Đã ghim** là quy ước; **không được thực thi tự động** (xem dưới) |
| Branch protection | **Không có hiệu lực** trên gói Free. Ba rào chắn thay thế: hook `pre-push` trên máy (`.githooks/pre-push`, bật bởi `npm install` qua script `prepare`), gitleaks trong CI, workflow "Cảnh gác main" tự tạo issue khi có commit vào `main` không qua PR. CODEOWNERS có file nhưng chỉ hiệu lực khi bật "Require review from Code Owners" | `CONTRIBUTING.md` §10 · `.github/workflows/security.yml`, `main-push-guard.yml` · `.github/CODEOWNERS` | **Đã ghim** (rào thay thế); sửa tận gốc (GitHub Education/Team) **chưa làm** |
| CI | `ci.yml`: chạy khi push `main` và **mọi** PR; `ubuntu-latest`; Node 24; `npm ci` → `format:check` → `lint` → `typecheck` → `test` → `build`; service Postgres 16.4-alpine và Redis 7.4-alpine; `timeout-minutes: 20`; huỷ lượt cũ khi có commit mới | `.github/workflows/ci.yml` | **Đã ghim** |
| Quét bí mật | `security.yml`: gitleaks **8.18.4** tải binary từ GitHub Release (không dùng `gitleaks-action` vì đòi giấy phép trả phí trong org), quét toàn bộ lịch sử; cấu hình `.gitleaks.toml` | `.github/workflows/security.yml` | **Đã ghim** |
| Actions đang dùng | `actions/checkout@v4`, `actions/setup-node@v4`, `amannn/action-semantic-pull-request@v5` (tag major, không ghim SHA) | `.github/workflows/*.yml` | **Đã ghim** mức major |
| Dependabot | npm hằng tuần (thứ Hai), tối đa 5 PR, gom nhóm `dev-dependencies` và `production-patch-minor`; GitHub Actions hằng tháng | `.github/dependabot.yml` | **Đã ghim** |
| CD (tự triển khai) | Không có: không có workflow deploy, không có Dockerfile cho CSMS, không có service `csms` trong compose | `.github/workflows/` · `infra/docker-compose.yml` | **Chưa có trong repo** |
| Phát hành | Repo chưa có tag nào tính đến mốc đối chiếu; tag `review-2` dự kiến gắn sau khi dọn mâu thuẫn | `docs/NHAT-KY-DON-MAU-THUAN.md` | **Chưa có trong repo** |

---

## 4. Môi trường triển khai

Nói thẳng: hiện chỉ có môi trường dev trên máy cá nhân. Staging đã có bộ cấu hình nhưng chưa có server; production chưa tồn tại.

| Môi trường | Hiện trạng | Nơi chạy | Cách triển khai | Rollback | Nguồn | Trạng thái |
|---|---|---|---|---|---|---|
| Dev | Máy cá nhân của từng thành viên. Máy của Trí không có Docker nên chạy `npm run demo` (trong `apps/csms`): Postgres nhúng 17 beta, áp `0000_init.sql`, seed, CSMS ở cổng OCPP 9000 và console. Trụ giả lập: `node simulator/d1-hmi/server.mjs` (HMI cổng 8100). Máy có Docker chạy `npm run infra:up` (Postgres 16.4 + Redis 7.4) | Máy cá nhân | `npm ci`, rồi `npm run demo` | Không cần; `npm run demo:reset` xoá dữ liệu demo | `apps/csms/package.json` · `docs/DEMO-REVIEW-2.md` · `infra/README.md` | **Đã ghim** |
| CI | Runner GitHub, Postgres 16.4 + Redis 7.4 theo job; không phải môi trường chạy thật | GitHub Actions | Tự chạy mỗi PR | Không áp dụng | `.github/workflows/ci.yml` | **Đã ghim** |
| Staging | **Đã có bộ cấu hình, chưa triển khai — chưa có server.** Repo có sẵn Dockerfile CSMS và simulator, Docker Compose (Caddy + CSMS + Postgres 16.4, simulator theo profile), script deploy/rollback/seed và workflow `deploy-staging.yml` (T04/T84). **Chưa chạy thử trên Docker hay VPS thật** (máy Trí không có Docker; chỉ kiểm bằng mô phỏng, xem PR). Còn việc làm tay: thuê VPS, DNS, cài Docker, secrets GitHub, biến `STAGING_ENABLED`. Giới hạn đã biết: console vận hành chưa có xác thực (chỉ xem qua SSH tunnel), chưa có dashboard, một máy không HA, sao lưu cùng máy, chưa giám sát. Quyết định ngân sách VPS vẫn của nhóm (`DESIGN-BRIEF-WP2-INPUT.md` G3) | VPS Singapore (đề xuất ~2 vCPU/4 GB), **chưa thuê** | Docker Compose trên một VPS; CI build ảnh lên GHCR rồi SSH chạy `deploy.sh <tag>` | `rollback.sh`: lùi ảnh chỉ an toàn khi lần deploy không áp migration; còn lại khôi phục DB từ bản sao lưu (mất dữ liệu sau đó). Chưa kiểm chứng trên môi trường thật | `infra/staging/README.md` · `apps/csms/Dockerfile` · `.github/workflows/deploy-staging.yml` · `docs/DESIGN-BRIEF-WP2-INPUT.md` G3 | **Cấu hình sẵn sàng, chưa triển khai** |
| Production | **Chưa có.** Vùng hosting chưa quyết: AWS Singapore (rẻ hơn, nhưng là chuyển dữ liệu xuyên biên giới theo PDPL/NĐ 13/2023) so với AWS Hanoi Local Zone (GA 19/06/2026, đắt hơn, dữ liệu trong nước) | — | — | — | `docs/PHAN-TICH-TAI-LIEU-WP1.md` §6.2 | **Chưa quyết** |
| Rollback (chung) | Chưa có quy trình. Đề xuất: migration SQL viết tay kèm file đảo ngược cho mỗi file tiến (hiện chỉ có `0000_init.sql`, chưa có file đảo ngược) và tag phát hành để quay về bản đã tag. Chưa kiểm chứng | — | — | Đề xuất như trên | ADR-0008 | **Đề xuất, chưa ghim** |

---

## 5. Công cụ AI

| Công cụ | Mô hình | Chặng sử dụng | Phạm vi và kiểm soát |
|---|---|---|---|
| Claude Code (Anthropic), chạy trong VS Code | Model ID xuất hiện trong lịch sử commit (dòng `Co-Authored-By`, đọc bằng `git log --format=%B`): **`Claude Fable 5.1`** (19 dòng), **`Claude Sonnet 5.5`** (11 dòng), **`Claude Opus 5`** (4 dòng) — đếm trên toàn bộ nhánh, kể cả nhánh đã squash. *Lưu ý trung thực:* commit squash vào `main` thay phần thân commit nên mất dòng `Co-Authored-By`; chỉ lịch sử nhánh còn đủ. Phiên nào không để lại dòng đồng tác giả thì không xác định được model từ repo | **Đặc tả/nghiên cứu**: đọc tài liệu và spec, soạn `docs/NGHIEN-CUU-*`, phân tích tài liệu WP1 · **Thiết kế**: tài liệu kiến trúc, 12 ADR, thiết kế CSDL vật lý, package/sequence/class diagram · **Code**: gateway OCPP, state machine, engine đối soát (Iteration 1), bàn thí nghiệm, HMI trụ D1, console vận hành, bộ chạy demo · **Kiểm thử**: test Jest và smoke test · **Review**: review PR, dọn mâu thuẫn nội bộ (M1–M14) | Người chủ task phải giải thích được mọi nội dung AI tạo ra (rủi ro R-A02, `docs/PHAN-TICH-TAI-LIEU-WP1.md`; sổ rủi ro gốc nằm ở PowerMe Doc của WP1, không trong repo). Không đưa dữ liệu thật, khoá hay mật khẩu vào công cụ AI; gitleaks chạy trên mọi PR. Đầu ra AI phải qua test và review trước khi hợp nhất |
| Dependabot | Không phải AI: bot tự động của GitHub | Cập nhật phụ thuộc | `.github/dependabot.yml` |

**Điều cần khai báo thẳng.** Quy ước ở `CONTRIBUTING.md` §4 yêu cầu ít nhất một approve từ người khác. Thực tế, trong tuần 23/10/2026 nhiều PR được merge mà không có approval, theo chỉ đạo của Trí. Nguyên nhân: bốn trong năm thành viên chỉ có quyền đọc repo và không thuộc team nào cho tới 23/10, nên review có hiệu lực không khả thi (`docs/BAO-CAO-HIEN-TRANG-REPO.md` §2). Quyền đã được sửa trong ngày 23/10. Hệ quả: các PR đó (kể cả phần do AI sinh) chỉ qua CI (gồm gitleaks) và kiểm của tác giả; chưa có review chéo của người thứ hai. Cần review bù sau, trước Defense.

---

## Chỗ chưa ghim cần quyết trước Hội đồng

Chỉ gồm những mục còn mở. Hạn: cần chốt trong họp nhóm (không ấn định ngày).

| # | Việc còn mở | Trạng thái | Người quyết (đề xuất) | Hạn |
|---|---|---|---|---|
| 1 | Vùng hosting: AWS Singapore hay Hanoi Local Zone; nếu chọn Singapore thì ghi rõ chấp nhận đơn giản hoá PDPL cho phạm vi capstone | Chưa quyết | Ân (WP1) + Trí | Cần chốt trong họp nhóm |
| 2 | Staging: bộ cấu hình đã có (Dockerfile, Compose, Caddy, deploy/rollback, workflow). Còn lại việc của nhóm: chọn nguồn tiền cho VPS Singapore (ngân sách chung hay credit của trường, agenda 2.5 với GVHD), thuê VPS, DNS, secrets GitHub — xem `infra/staging/README.md` | Cấu hình sẵn sàng; **chưa có server** | Ân (WP1) + Trí | Cần chốt trong họp nhóm |
| 3 | Quy trình rollback: file migration đảo ngược + tag phát hành | Đề xuất, chưa ghim | Trí (WP2) + Khang (WP5) | Cần chốt trong họp nhóm |
| 4 | Postgres: demo chạy 17 beta, CI 16.4; đồng bộ hoặc chấp nhận và ghi vào Report | Đề xuất, chưa ghim | Trí (WP2) | Cần chốt trong họp nhóm |
| 5 | Flutter: khi WP3 nộp mã thì ghim Flutter SDK và thêm `pubspec.yaml` | Chưa có trong repo | Sơn (WP3) | Cần chốt trong họp nhóm |
| 6 | React + Vite cho dashboard: scaffold và ghim | Chưa có trong repo | Nghĩa (WP4) | Cần chốt trong họp nhóm |
| 7 | Socket.IO + Redis adapter (BE-08): chấp nhận ADR-0006 và thêm vào lock, hoặc giữ poll 1 giây | Đề xuất, chưa ghim | Trí + Sơn (WP3) + Nghĩa (WP4) | Cần chốt trong họp nhóm |
| 8 | Caddy 2 / TLS Security Profile 2 (ADR-0011) | Chưa có trong repo | Trí (WP2) | Cần chốt trong họp nhóm |
| 9 | VNPay sandbox: xin credential hay chốt mock service | Chưa có trong repo | Khang (WP5) | Cần chốt trong họp nhóm |
| 10 | Hoá đơn điện tử: chốt phương án XML tự sinh theo NĐ 123/2020 | Chưa có trong repo | Khang (WP5) + Ân (WP1) | Cần chốt trong họp nhóm |
| 11 | FCM: giữ "cắt" (`KE-HOACH` §8) hay khôi phục (`PHAN-TICH` §6.3) | Chưa quyết | Ân (WP1) + Trí + Sơn | Cần chốt trong họp nhóm |
| 12 | Lint: chọn và ghim ESLint, hoặc bỏ bước lint khỏi quy ước | Chưa có trong repo | Trí (WP2) | Cần chốt trong họp nhóm |
| 13 | k6 (QA-07): kịch bản và phiên bản | Chưa có trong repo | Khang (WP5) | Cần chốt trong họp nhóm |
| 14 | Review bù cho các PR đã merge không có approval (tuần 23/10) | Chưa làm | Cả nhóm | Cần chốt trong họp nhóm |
| 15 | GitHub Education → Team để bật branch protection thật; chạy `scripts/setup-github.sh` | Chưa làm | Ân (WP1) | Cần chốt trong họp nhóm |
| 16 | 4 PR Dependabot đang treo (checkout v7, setup-node v7, semantic-pull-request v6, prettier 3.9.8): rebase lên `main` rồi gộp hoặc đóng | Đang treo | Ân (WP1) + Trí | Cần chốt trong họp nhóm |
| 17 | Squash merge đã bật trên Settings GitHub chưa (không kiểm được từ repo) | Chưa xác minh | Ân (WP1) | Cần chốt trong họp nhóm |

---

*Nguồn đối chiếu: các file ở cột Nguồn trên `origin/main` `d4f771a`, đọc ngày 23/10/2026. Không xác minh được từ repo: cài đặt thực trên GitHub (squash merge, quyền, team), nội dung PowerMe Doc/Drive, sổ rủi ro gốc của WP1, tình trạng 4 PR Dependabot.*
