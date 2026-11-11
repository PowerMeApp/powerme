# PowerMe staging (T04 / T84)

Hạ tầng staging theo kiến trúc ARCH-2 (Report 4, Figure 2): **một VPS Ubuntu 24.04 ở Singapore, Docker Compose**, TLS tự cấp bởi Caddy, ảnh Docker build trên GitHub Actions và kéo từ GHCR.

> **Trạng thái (10/11/2026): đang chạy thật** tại `https://powerme-staging.japaneast.cloudapp.azure.com` (VM Azure Japan East, xem [`AZURE.md`](AZURE.md)). `deploy.sh` đã chạy thật từ `review-4`; từ `review-7` workflow `deploy-staging.yml` tự deploy khi đẩy tag. Kiến trúc ghi Singapore nhưng thực tế là Japan East (policy subscription chặn Singapore). Mục [Đã kiểm và chưa kiểm](#đã-kiểm-và-chưa-kiểm) bên dưới ghi trạng thái lúc viết cấu hình (trước khi có VM); phần đã chạy thật xem `AZURE.md` mục 11.
>
> **Deploy tay trên VM:** workflow để repo ở trạng thái `git checkout --detach <tag>`, nên đừng `git pull`; làm `git fetch --tags --force origin && git checkout --detach <tag>` rồi `./deploy.sh <tag>`.

> **Đường nhanh để dựng staging trên Azure (Azure for Students, tên miền miễn phí): xem [`AZURE.md`](AZURE.md).** Có `cloud-init.yaml` (dán vào "Custom data" khi tạo VM: tự cài Docker, tạo user `deploy`, clone repo) và `init-env.sh` (sinh `.env` với mật khẩu ngẫu nhiên). Cả hai đã chạy trên Azure thật (04/11).

## Những gì có trong thư mục này

| File | Việc |
|---|---|
| `docker-compose.yml` | Caddy 2.11.7 + CSMS + Postgres 16.4 (+ simulator ở profile `sim`). Mỗi dịch vụ chỉ nhận biến nó cần qua `environment:` |
| `Caddyfile` | TLS (Let's Encrypt). **Chỉ** proxy `/ocpp/*` (WebSocket) và `/health`. Không proxy console vận hành |
| `.env.example` | Mẫu cấu hình; sao thành `.env` trên VPS. Toàn giá trị giả |
| `deploy.sh` | Sao lưu DB → pull ảnh → migrate → (seed) → khởi động → kiểm sức khoẻ → tự lùi ảnh khi an toàn |
| `rollback.sh` | Lùi về tag trước, hoặc khôi phục DB từ bản sao lưu |
| `seed.sh` | Nạp lại dữ liệu mẫu / xoá sạch DB rồi nạp lại (`--reset`) |
| `lib.sh` | Hàm dùng chung (đọc/ghi `.env` an toàn, kiểm sức khoẻ) |
| `init-env.sh` | Sinh `.env` với secret ngẫu nhiên; `--add-missing` bổ sung biến mới cho `.env` cũ (BE-27) |
| `DEV-ACCESS.md` | Dev (Sơn) dùng DB + Driver API staging qua SSH tunnel; cảnh báo; phương án B |
| `add-dev-tunnel-key.sh` | Thêm khoá SSH của dev vào user tunnel `devtunnel` (azureuser + sudo) |
| `create-dev-db-role.sh` | Tạo role Postgres `app_dev` (đọc/ghi bảng, không DDL/superuser) cho dev |
| `../../apps/csms/Dockerfile` | Ảnh `powerme-csms` (nhiều tầng, base `node:24.18.1-alpine3.24`, user `node`, có `HEALTHCHECK`) |
| `../../simulator/d1-hmi/Dockerfile` | Ảnh `powerme-simulator` (trụ giả lập D1 + HMI) |
| `../../.github/workflows/deploy-staging.yml` | Build ảnh khi đẩy tag, deploy qua SSH khi bật `STAGING_ENABLED` |
| `../../apps/csms/scripts/migrate.mjs`, `seed-demo.mjs` | Migrate và seed chạy bên trong ảnh csms |

```
internet ──443/80──▶ Caddy ──/ocpp/*──▶ csms:9000 (OCPP-J, Basic Auth kiểm lúc upgrade) ──▶ postgres:5432
                       │──/health──▶ csms:3000/health            (chỉ đường dẫn này)
                       └── còn lại: một dòng chữ
VPS 127.0.0.1:3000 ──▶ console vận hành (KHÔNG ra internet; xem bằng SSH tunnel)
VPS 127.0.0.1:8100 ──▶ HMI simulator   (profile sim; cũng chỉ qua SSH tunnel)
VPS 127.0.0.1:3000/api/driver/v1 ──▶ Driver API cho app tài xế (cùng listener console; dev vào bằng tunnel, DEV-ACCESS.md)
VPS 127.0.0.1:5432 ──▶ postgres     (BE-27; chỉ loopback, dev vào bằng tunnel với role app_dev)
```

### Khác với bộ khung ban đầu (và lý do)

| Bộ khung | Ở đây | Lý do |
|---|---|---|
| Dịch vụ `dashboard`, route mặc định proxy tới nó | **Bỏ**. Caddy trả một dòng chữ nêu địa chỉ wss | `apps/dashboard` chưa có mã build. **Thêm lại khi WP4 có build** (Dockerfile, compose, Caddyfile, matrix workflow) |
| `handle /api/*`, `/realtime*` proxy tới csms | **Bỏ** | Console (`/api/admin/*`, gồm POST ngắt kết nối và RemoteStop) chưa có xác thực — proxy ra là mở bảng điều khiển cho cả internet. Không có REST/realtime cho app trong repo. Thêm route khi `users` + `RolesGuard` có |
| Redis | **Bỏ** | `apps/csms` không dùng Redis |
| `JWT_SECRET`, `VNPAY_*`, `EINVOICE_*`, `ROUTING_API_KEY`, `HTTP_PORT`, `REDIS_URL` | **Bỏ** (chỉ còn ghi chú "chưa dùng" trong `.env.example`) | Code không đọc các biến này |
| `env_file: .env` | `environment:` tường minh cho từng dịch vụ | `env_file` đưa mọi secret vào mọi container |
| `pnpm db:migrate`, `pnpm db:seed:demo` | `node scripts/migrate.mjs`, `node scripts/seed-demo.mjs` | Repo dùng npm; hai script này là mới |
| `HEALTH_PATH=/api/v1/health` | `GET /health` (mới) trên console, kiểm trong container; thêm kiểm công khai `/ocpp/HEALTHCHECK` | Endpoint cũ không tồn tại |
| `postgres:16.4` | `postgres:16.4-alpine` | Khớp `infra/docker-compose.yml` và CI |
| Seed không có credential | `DEMO_CHARGE_POINT_PASSWORD` bắt buộc | `ALLOW_LEGACY_NO_CREDENTIAL=false` ⇒ trụ không credential bị 401 |
| `JWT_SECRET` chung | `DRIVER_API_JWT_*` chỉ cho csms, `DRIVER_API_DEV_AUTH` cố định `false` (BE-27) | Driver API (BE-21/22) đọc đúng các biến này; dev auth (`X-Driver-Id`) là giả danh, không được bật trên staging |

## Việc phải làm BẰNG TAY (không có gì trong repo tự làm được)

Phân công dưới đây là **đề xuất**; nhóm điều chỉnh. Cột "Ai" theo bộ khung gốc (Ân lo hạ tầng) và quyền admin repo (Trí).

| # | Việc | Ai (đề xuất) |
|---|---|---|
| 1 | **Quyết ngân sách:** VPS bằng ngân sách chung hay credit của trường (agenda 2.5 với GVHD); ghi nhận chấp nhận đơn giản hoá PDPL nếu dữ liệu ở Singapore | Nhóm (Ân + Trí) |
| 2 | **Thuê VPS Singapore**, Ubuntu 24.04, khoảng 2 vCPU / 4 GB (amd64 — workflow build `linux/amd64`) | Ân |
| 3 | **DNS A record** (ví dụ `staging.<tên-miền>`) trỏ về IP của VPS. Phải xong trước lần deploy đầu, nếu không Let's Encrypt không cấp được chứng chỉ | Ân |
| 4 | Mở cổng **22, 80, 443** ở firewall của nhà cung cấp. Đừng mở 3000, 5432, 8100 (compose chỉ gắn 3000/8100 vào loopback, nhưng đừng dựa vào đó) | Ân |
| 5 | Cài **Docker Engine + Compose plugin** (theo hướng dẫn chính thức cho Ubuntu 24.04), `git`, `curl` | Ân |
| 6 | Tạo **user deploy** thuộc nhóm `docker`; thêm **khoá công khai SSH của CI** vào `~/.ssh/authorized_keys`. Sinh cặp khoá riêng cho CI (`ssh-keygen -t ed25519`), không dùng lại khoá cá nhân | Ân |
| 7 | `git clone https://github.com/PowerMeApp/powerme.git ~/powerme` (repo public, không cần khoá) | Ân |
| 8 | Tạo `infra/staging/.env` từ `.env.example`, điền secret thật (xem [Checklist](#checklist-lần-deploy-đầu)). **Không commit, không gửi qua chat** | Ân |
| 9 | **Chọn và làm: ảnh GHCR công khai** (khuyến nghị) — sau lần build đầu, GitHub → Organization `PowerMeApp` → Packages → `powerme-csms` và `powerme-simulator` → *Package settings* → *Change visibility* → Public. Không có secret trong ảnh (mã nguồn đã public). Org có thể chặn gói công khai; khi đó dùng phương án 9b | Trí (admin org) |
| 9b | *Phương án dự phòng:* ảnh private ⇒ trên VPS chạy `docker login ghcr.io -u <user>` với **PAT chỉ có quyền `read:packages`** (đọc token từ stdin, không để trong lịch sử shell) | Ân |
| 10 | GitHub → Settings → **Environments** → tạo `staging` (nên bật *Required reviewers* để deploy cần người bấm duyệt) | Trí |
| 11 | Secrets (trong environment `staging`): `STAGING_HOST` (IP/tên miền VPS), `STAGING_USER` (user deploy), `STAGING_SSH_KEY` (khoá **riêng** của CI) | Trí |
| 12 | Repository **variable** `STAGING_ENABLED` = `true`. **Chỉ đặt sau khi lần deploy đầu bằng tay thành công.** Chưa đặt thì push tag chỉ build ảnh, job deploy bị bỏ qua, workflow vẫn xanh | Trí |
| 13 | Lần deploy đầu **bằng tay** trên VPS (có `--seed`); CI không làm được vì chưa có `.env` | Ân |
| 14 | Quy ước sao lưu ngoài VPS (xem [Rủi ro](#rủi-ro-và-giới-hạn-thật)); chưa có gì tự động | Nhóm |

## Checklist lần deploy đầu

1. Xong các việc 2–8 ở trên. Điền `.env`:
   - `DOMAIN` — tên miền thật; `REGISTRY=ghcr.io/powermeapp` (viết thường).
   - `POSTGRES_PASSWORD` — `openssl rand -hex 24` (chỉ chữ/số; nằm trong `DATABASE_URL`).
   - `DEMO_CHARGE_POINT_PASSWORD` — `openssl rand -base64 24` (>= 16 ký tự; bắt buộc để seed và chạy simulator).
   - `TAG` để nguyên; `deploy.sh` tự ghi.
2. **Tag phải được tạo SAU khi PR này vào `main`.** Các tag cũ (`review-2`, `review-2-v0`) không có Dockerfile nên build sẽ lỗi. Đẩy một tag mới (ví dụ `review-3`) — việc này kích hoạt workflow build ảnh (deploy vẫn bị bỏ qua vì `STAGING_ENABLED` chưa đặt). Tag là hành động của người có quyền; tài liệu này không tự đẩy tag.
3. Làm việc 9 (gói GHCR công khai) hoặc 9b. Kiểm: `docker pull ghcr.io/powermeapp/powerme-csms:review-3` chạy được trên VPS.
4. Trên VPS:
   ```bash
   cd ~/powerme && git fetch --tags --force origin && git checkout --detach refs/tags/review-3
   cd infra/staging && cp -n .env.example .env   # chỉ lần đầu; rồi sửa .env
   ./deploy.sh review-3 --seed
   ```
5. Kiểm tay: `curl -s https://<DOMAIN>/health` → `{"ok":true,"db":true}`; trụ lạ phải bị từ chối (`curl -i -H 'Upgrade: websocket' -H 'Connection: Upgrade' -H 'Sec-WebSocket-Version: 13' -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" https://<DOMAIN>/ocpp/HEALTHCHECK` → 404).
6. Chạy thử với simulator (mục dưới) để thấy trụ `RH24D1-00001` nối qua wss với mật khẩu.
7. Đặt việc 12 (`STAGING_ENABLED=true`) và secrets việc 11 rồi thử một lần `workflow_dispatch`.

## Dùng hằng ngày

Chạy trong `infra/staging` trên VPS.

| Việc | Lệnh |
|---|---|
| Deploy một tag (CI làm khi có `STAGING_ENABLED`) | `./deploy.sh review-3` |
| Deploy kèm nạp dữ liệu mẫu | `./deploy.sh review-3 --seed` |
| Deploy kèm simulator | `./deploy.sh review-3 --sim` (tự bật nếu simulator đang chạy) |
| Áp lại dữ liệu mẫu, xoay mật khẩu trụ demo (đổi `DEMO_CHARGE_POINT_PASSWORD` rồi chạy) | `./seed.sh` |
| Như trên nhưng không nạp dữ liệu app tài xế | `./seed.sh --no-app` |
| `.env` cũ thiếu biến mới (khoá JWT Driver API, mật khẩu tài xế mẫu) — không đổi mật khẩu cũ | `./init-env.sh --add-missing` rồi `./deploy.sh <tag> --seed` |
| Xoay mật khẩu tài xế mẫu | sửa `DEMO_DRIVER_PASSWORD` trong `.env` rồi `./seed.sh` |
| Cho dev vào DB/Driver API | [`DEV-ACCESS.md`](DEV-ACCESS.md) |
| Về trạng thái đầu cho kịch bản DS-01..DS-10 (**xoá toàn bộ DB**) | `./seed.sh --reset` |
| Lùi ảnh (chỉ khi an toàn, xem dưới) | `./rollback.sh` |
| Khôi phục DB rồi lùi ảnh | `./rollback.sh --restore-db backups/pre-<tag>-<giờ>.dump` |
| Nhật ký | `docker compose logs -f csms` |
| Trạng thái | `docker compose ps` |

`deploy.sh` từ chối chạy nếu `.env` còn `change-me`/`staging.example.com`, thiếu biến, hoặc giá trị sai dạng. Nó ghi `.env` (dòng `TAG=`) bằng bash thuần, không qua `sed`, nên giá trị chứa `& | \ /` không bị hỏng. Sao lưu DB trước khi migrate nằm ở `backups/` (giữ 10 bản).

## Xem console vận hành qua SSH tunnel

Console (`/api/admin/*`, trang tổng quan, POST ngắt kết nối / RemoteStop) **chưa có xác thực** nên không bao giờ đi qua Caddy. Trong container nó bind `0.0.0.0` (cần để cổng publish của Docker tới được), nhưng compose chỉ publish nó ra **`127.0.0.1:3000` của VPS**. Từ máy bạn:

```bash
ssh -L 3000:127.0.0.1:3000 <user>@<DOMAIN>
# rồi mở http://127.0.0.1:3000 trên máy bạn
```

Đừng đổi `ports` thành `3000:3000` và đừng thêm route console vào Caddyfile. Không dùng `docker compose` publish `0.0.0.0`.

> **Lệch so với yêu cầu ban đầu:** yêu cầu là console bind `127.0.0.1` trong container. Làm vậy thì SSH tunnel không bao giờ tới được (loopback của container không phải loopback của VPS). Giải pháp ở đây giữ cùng mục tiêu — không ra internet — bằng cách bind `0.0.0.0` trong container và publish chỉ ra loopback VPS. Đánh đổi: các container khác trong mạng compose (caddy, postgres, simulator) có thể gọi `csms:3000`; Caddy không có route tới đó. Mặc định của chính CSMS vẫn là `127.0.0.1` (`CONSOLE_HOST`), chỉ compose đặt `0.0.0.0`.

## Chạy simulator (profile `sim`)

Simulator là trụ D1 giả lập có HMI, nối `wss://<DOMAIN>/ocpp` với Basic Auth (`CP_ID=RH24D1-00001`, mật khẩu = `DEMO_CHARGE_POINT_PASSWORD`).

```bash
docker compose --profile sim up -d simulator      # hoặc ./deploy.sh <tag> --sim
ssh -L 8100:127.0.0.1:8100 <user>@<DOMAIN>        # rồi mở http://127.0.0.1:8100
```

Yêu cầu: đã `--seed` (để trụ tồn tại và có credential), `DEMO_CHARGE_POINT_PASSWORD` đúng. Nếu VPS không tự nối được IP công khai của chính nó (hairpin NAT), đặt `SIM_CSMS_URL=ws://csms:9000/ocpp` trong `.env` (đường trong mạng compose, không qua TLS — chỉ để demo). HMI cũng chưa có xác thực nên chỉ publish ra loopback như console.

## Rollback

`rollback.sh` có hai chế độ; chọn sai sẽ gây hỏng.

**Migration không đảo ngược được bằng lùi ảnh.** Migration 0001 và 0003 có `ALTER TYPE … ADD VALUE` (Postgres không có `DROP VALUE`: `payment_mode.unattributed`, `reconciliation_record_type.conflict/late_sample` ở 0001; `loyalty_transaction_type.restore` ở 0003); 0001 đổi tên cột (`cp_timestamp`); 0002 chỉ thêm cột và sửa dữ liệu `lifecycle`; 0003 đặt `NOT NULL` cho `top_ups.gateway_reference`/`expires_at`, thay UNIQUE sổ cái theo top-up và thêm CHECK. Ảnh cũ viết cho schema cũ sẽ lỗi trên schema mới (ví dụ ảnh trước 0003 INSERT `top_ups` không có `expires_at` sẽ bị từ chối). **Cụ thể: ảnh `review-2-v0` KHÔNG tương thích schema sau 0001** — không lùi về nó và không deploy nó lên DB đã migrate. Lùi qua 0003 chỉ đúng bằng `--restore-db` (bản sao lưu chụp trước lần deploy áp 0003).

- `deploy.sh` ghi lại migration nào mỗi lần deploy đã áp (`.deploy/migrated_<tag>`).
- `./rollback.sh` (lùi ảnh) **từ chối** nếu lần deploy đang chạy đã áp migration, và in danh sách file; với file có `RENAME`/`DROP`/`ALTER TYPE`/`SET NOT NULL`/`ALTER COLUMN` nó cảnh báo thêm là không additive. Phát hiện này chỉ là gợi ý theo từ khoá, không thay cho việc đọc migration.
- `./rollback.sh --force` bỏ chốt đó (chỉ dùng khi biết ảnh cũ chạy được với schema mới).
- `./rollback.sh --restore-db backups/pre-<tag>-<giờ>.dump` — cách đúng để lùi qua migration. Bản `pre-<tag>-*` được chụp **trước** lần deploy `<tag>`. Script dừng csms, **xoá và tạo lại** DB, `pg_restore`, rồi lùi ảnh. **Dữ liệu ghi sau lúc sao lưu (phiên sạc, thẻ…) sẽ mất.** Phải gõ `RESTORE` để xác nhận (hoặc `--yes`).
- `deploy.sh` khi kiểm sức khoẻ thất bại: nếu lần deploy **không** áp migration thì tự lùi ảnh về tag cũ; nếu **có** migration thì KHÔNG tự lùi, in lệnh khôi phục.

## Biến môi trường

Compose chỉ truyền cho `csms` những biến mà `apps/csms/src/config.ts` đọc: `DATABASE_URL` (ghép từ `POSTGRES_*`), `OCPP_PORT` (9000), `OCPP_PUBLIC_URL` (`wss://$DOMAIN/ocpp`), `CONSOLE_ENABLED`/`CONSOLE_HOST`/`CONSOLE_PORT`, `ALLOW_LEGACY_NO_CREDENTIAL` (**cố định `false`**, không đọc từ `.env`), `OFFLINE_GRACE_S` và các biến timeout/đối soát (có mặc định, xem `.env.example`). `OFFLINE_GRACE_S` mặc định 120 (WP1 chốt ngày 26/10/2026, ADR-0016).

**Driver API (BE-27).** `DRIVER_API_JWT_SECRET_BASE64` (base64 chuẩn của ≥ 32 byte ngẫu nhiên), `DRIVER_API_JWT_ISSUER` (`powerme-staging`), `DRIVER_API_JWT_AUDIENCE` (`powerme-driver-app`), `DRIVER_API_REFRESH_TTL_S` (trống = 30 ngày) đi từ `.env` vào csms; `DRIVER_API_DEV_AUTH` **cố định `false`** trong compose. `./init-env.sh` sinh ba biến JWT cho `.env` mới; `.env` cũ dùng `./init-env.sh --add-missing` (chỉ thêm biến còn trống, không đổi `POSTGRES_PASSWORD` hay mật khẩu trụ, không in giá trị, chạy lại không đổi gì).

`check_env` (lib.sh) **cảnh báo, không dừng** khi cả ba biến JWT trống: CI deploy bằng `.env` đang có trên VM, `.env` tạo trước BE-27 chưa có các biến này, và CSMS vẫn khởi động (chỉ `/api/driver` trả 503 `auth_unavailable`) — dừng thì deploy tự động đang chạy sẽ đỏ dù không có gì hỏng. `check_env` **dừng** khi đặt thiếu một trong ba hoặc sai dạng (khoá không phải base64 chuẩn ≥ 32 byte, TTL ngoài 3600..7776000, `DEMO_DRIVER_PASSWORD` < 12 ký tự): `loadDriverApiConfig` sẽ ném lỗi lúc khởi động, nên chặn trước sao lưu/migrate rẻ hơn để deploy hỏng ở bước kiểm sức khoẻ.

`DEMO_DRIVER_PASSWORD` (≥ 12 ký tự, `init-env.sh` sinh 16 hex) **không** vào container csms; chỉ vào lệnh seed (`run_csms_script`). Trống thì seed bỏ qua đặt mật khẩu và cảnh báo.

`VIETMAP_SEARCH_API_KEY` và `SMART_SEARCH_*` chưa truyền vào compose: smart search dùng mặc định trong code; `/places/*` trả 503 `provider_unavailable` trên staging.

## Dữ liệu mẫu cho app tài xế (BE-27)

`./deploy.sh <tag> --seed` và `./seed.sh` chạy `seed-demo.mjs`: `apps/csms/demo/seed.sql` (trụ demo `RH24D1-00001`, như trước) rồi `apps/csms/demo/seed-app.sql`, sau đó băm `DEMO_DRIVER_PASSWORD` bằng đúng hàm scrypt của BE-21 và ghi cho ba tài xế mẫu. Idempotent: chạy lại không nhân đôi dòng, không đụng phiên, sổ cái, trạng thái súng, lifecycle; số dư chỉ được đặt khi ví chưa có dòng sổ cái nào. `--no-app` bỏ phần này.

| Email | Kịch bản BM04 | Credit | Điểm | Xe (★ mặc định) |
|---|---|---|---|---|
| `app.ds01@powerme.test` | DS-01 đủ tiền, sạc được | 200.000 VND | 0 | ★ VinFast VF 8 Plus (CCS2) `51K-901.01`; Nissan Leaf (CHAdeMO) `51K-901.02` |
| `app.ds02@powerme.test` | DS-02 thiếu tiền (< `CHARGE_MINIMUM_START_VND` 50.000) → `topuprequired` | 30.000 VND | 0 | ★ VinFast VF e34 (CCS2) `51K-902.01` |
| `app.ds03@powerme.test` | DS-03 có điểm (≥ 500 điểm tối thiểu để dùng khi nạp) | 100.000 VND | 600 (hạn 12 tháng từ lần seed đầu) | ★ Hyundai Ioniq 5 (CCS2, không VinFast) `51K-903.01`; Wuling HongGuang MiniEV (Type2) `51K-903.02` |

Mật khẩu: một mật khẩu chung = `DEMO_DRIVER_PASSWORD` trong `.env` trên VM. **Không ghi ở đây, không có trong repo**; Trí gửi riêng. Hai tài xế `driver.demo@powerme.test`, `driver2.demo@powerme.test` của `seed.sql` không có mật khẩu và không có xe (giữ cho demo thẻ RFID `DEMO-CARD-0001`/`0002`, không đăng nhập app được).

Trạm (operator mẫu `0312345678`, biểu giá theo khung giờ của `seed.sql`: 2.800 / 3.800 / 5.500 VND/kWh). Toạ độ là vị trí gần đúng của địa danh thật; tên, công suất là giả.

| Mã | Khu vực | VinFast-only | Trụ (súng) |
|---|---|---|---|
| `HCM-APP-Q1-01` | Bến Thành, Q1 | | DC 120 (CCS2 120 + CCS2 60), AC 22 (Type2) |
| `HCM-APP-Q3-01` | Hồ Con Rùa, Q3 | | DC 60 (CCS2 60 + CHAdeMO 50) |
| `HCM-APP-Q10-01` | Vạn Hạnh Mall, Q10 | | AC 7 (Type2 ×2) |
| `HCM-APP-PN-01` | Phan Xích Long, Phú Nhuận | | DC 30 (CCS2) |
| `HCM-APP-BT-01` | Landmark 81, Bình Thạnh | | DC 120 (CCS2 60 ×2) |
| `HCM-APP-TD-01` | Thảo Điền, Thủ Đức | | DC 50 (CCS2 + CHAdeMO), AC 22 (Type2 ×2) |
| `HCM-APP-Q7-01` | Crescent Mall, Q7 | có | DC 150 (CCS2 150 + 75) |
| `HCM-APP-TD-02` | Vinhomes Grand Park, Thủ Đức | có | DC 60 (CCS2 ×2), AC 11 (Type2 ×2) |
| `HCM-APP-TB-01` | Cộng Hoà, Tân Bình | có | DC 60 (CCS2 ×2) |

Tổng: 9 trạm, 12 trụ, 22 súng; 8 mẫu xe (VinFast VF 3 / VF 5 Plus / VF e34 / VF 8 Plus, Hyundai Ioniq 5, BYD Atto 3, Nissan Leaf, Wuling HongGuang MiniEV — thông số gần đúng); 3 tài xế, 5 xe.

**Trạng thái súng:** trụ `PMAPP-*` ở `in_service` nhưng **không có credential và chưa từng kết nối OCPP**, nên app thấy `driver_status = offline` và không bắt đầu sạc được ở đó. Trạng thái súng chỉ đến từ OCPP (StatusNotification), seed không giả. Chỉ trụ demo `RH24D1-00001` (`HCM-DEMO-01`, Q1) có trạng thái sống khi simulator chạy. Trụ chưa từng kết nối không sinh cảnh báo Offline (OfflineAlertService bỏ qua `last_message_at` và `online_changed_at` cùng NULL).

## Bảo mật: những điều thật

- **Basic Auth qua wss nhờ Caddy TLS** — đây mới là chỗ OCPP Security Profile 2 trở thành thật: mật khẩu trụ (hash scrypt trong DB) được kiểm lúc nâng cấp WebSocket và đi trong TLS. Trước đó (CSMS chạy `ws://`) mật khẩu đi trần. Profile 3 (chứng chỉ máy khách) chưa làm.
- Chưa có TLS giữa Caddy và csms (cùng mạng Docker, cùng máy).
- `ALLOW_LEGACY_NO_CREDENTIAL=false` cố định: trụ không có credential bị 401.
- `/health` công khai trả đúng `{"ok":true,"db":true}` hoặc 503, không lộ phiên bản. Đây là đường dẫn console duy nhất ra ngoài.
- Địa chỉ IP trụ trong log của CSMS sẽ là IP của Caddy (CSMS không đọc `X-Forwarded-For`).
- Secret nằm trong `.env` trên VPS (quyền 600 do script đặt khi sửa); `gitleaks` chạy trên PR nhưng không bảo vệ VPS.

## Rủi ro và giới hạn thật

1. **Console vận hành không xác thực.** Ai có SSH vào VPS (hoặc chạy được container trong mạng compose) là ngắt được kết nối trụ và gửi RemoteStop. Chỉ chấp nhận được vì không ra internet.
2. **Chưa có dashboard.** Driver API cho app có (BE-21/22) nhưng **không** ra internet: cùng listener với console chưa xác thực, nên chỉ vào bằng SSH tunnel (DEV-ACCESS.md). Ra internet cho app thật cần tách listener hoặc xác thực console trước.
3. **Một máy, không HA.** Postgres và CSMS cùng VPS; VPS chết là staging chết. CSMS giữ trạng thái kết nối trong RAM nên mỗi lần restart trụ nối lại (ân hạn `OFFLINE_GRACE_S`).
4. **Sao lưu chỉ nằm trên cùng VPS** (`backups/`, 10 bản, chụp trước mỗi deploy). Mất VPS là mất cả dữ liệu lẫn sao lưu. Chưa có sao lưu định kỳ hay ngoài máy.
5. **Chưa có giám sát/cảnh báo.** `/health` công khai cho phép gắn dịch vụ giám sát ngoài (ví dụ UptimeRobot) — chưa gắn. Chưa gom log; Docker giữ 5×10 MB mỗi dịch vụ.
6. Lùi ảnh không đảo được migration (mục Rollback).
7. Cấp chứng chỉ Let's Encrypt cần DNS đúng và cổng 80 mở; sai nhiều lần dính giới hạn tần suất của họ. Chứng chỉ nằm trong volume `caddy_data` — `docker compose down -v` sẽ xoá nó.
8. `docker compose down -v` xoá luôn DB (`pgdata`). Đừng dùng `-v`.
9. Ảnh simulator kéo theo dependency của csms (vài chục MB) vì simulator không có `package.json` riêng.
10. Seed demo dùng một trụ sống và dữ liệu mẫu cố định; giá trong `seed.sql` là giá mẫu. Trạm cho app (`seed-app.sql`) là giả và luôn offline.
11. Workflow dùng action bên thứ ba `appleboy/ssh-action` (ghim `v1.2.5`) cầm khoá SSH của CI. Hạn chế bằng environment `staging` có người duyệt và user deploy không có sudo.
12. **Postgres publish ra `127.0.0.1:5432` của VM (BE-27).** Ai có SSH vào VM (kể cả user `devtunnel`) là tới được cổng DB; vẫn cần mật khẩu role. Dev dùng role `app_dev` (không DDL/superuser), không dùng `POSTGRES_USER`. Docker < 28 có lỗi cho máy cùng mạng L2 tới được cổng publish ở 127.0.0.1; trên Azure không có máy lạ cùng L2, và NSG chỉ mở 22/80/443.
13. **Cổng 3000 qua tunnel = console không xác thực.** Dev vào Driver API cũng vào được console. Chấp nhận cho nhóm phát triển; không cấp `devtunnel` cho người ngoài nhóm.

## Đã kiểm và chưa kiểm

**Đã kiểm (mô phỏng trên Windows, không có Docker):**
- `bash -n` và ShellCheck 0.11.0 sạch cho `lib.sh`, `deploy.sh`, `rollback.sh`, `seed.sh`.
- YAML của compose và workflow parse được; `actionlint` 1.7.12 sạch cho workflow; mọi `${…}` trong compose đều có trong `.env.example`.
- Chuỗi lệnh của `apps/csms/Dockerfile` (`npm ci --ignore-scripts`, build, `npm ci --omit=dev -w @powerme/csms`, chỉ copy các đường dẫn Dockerfile copy) chạy trong thư mục sạch; sau đó `migrate.mjs`, `seed-demo.mjs` và `node dist/main.js` chạy lên Postgres nhúng: `/health` 200, trụ không mật khẩu / sai mật khẩu bị 401, đúng mật khẩu nhận BootNotification Accepted, console chỉ lắng nghe `127.0.0.1` (khi không đặt `CONSOLE_HOST`). Số liệu cụ thể nằm trong mô tả PR.
- Logic `deploy.sh`/`rollback.sh`/`seed.sh` với `docker`, `curl`, `sleep` **giả**: từ chối `.env` mẫu, tag lạ, thiếu mật khẩu seed; deploy thành công; từ chối lùi ảnh sau migration; tự lùi khi không có migration; không tự lùi khi có migration; migrate lỗi giữa chừng trả `TAG` về cũ; `--restore-db`; `set_env` với ký tự đặc biệt; mật khẩu không xuất hiện trên argv của `docker`.

**BE-27 (Driver API, tunnel, dữ liệu app) — đã kiểm trên Windows, Postgres 17 nhúng:** `init-env.sh` tạo mới / từ chối ghi đè / `--add-missing` trên `.env` đầy đủ (không đổi byte nào) và trên `.env` trước BE-27 (thêm 4 biến, giữ `POSTGRES_PASSWORD` và `DEMO_PILLAR_PASSWORD`); `check_env` cảnh báo khi thiếu cả ba biến JWT, dừng khi thiếu một/khoá ngắn/không chuẩn/TTL sai; seed app chạy 3 lần không nhân đôi dòng; CSMS chạy với env như compose: đăng nhập tài xế mẫu, `/me`, `/stations` gần Q1, bắt đầu và dừng phiên trên trụ demo (simulator), DS-02 nhận `topuprequired`. Số liệu ở mô tả PR. **Chưa:** `docker compose up` với publish `127.0.0.1:5432`, `ssh -N` thật qua `devtunnel`, psql 16 thật chạy `create-dev-db-role.sh`.

**CHƯA kiểm được (cần Docker/VPS/GitHub thật):**
- `docker build` thật của hai Dockerfile (lỗi cú pháp Dockerfile, lớp cache, quyền file, `HEALTHCHECK` chạy trong alpine, user `node`).
- `docker compose config`/`up` thật; việc Compose chấp nhận cú pháp lồng `${SIM_CSMS_URL:-wss://${DOMAIN}/ocpp}` và `up --wait`.
- Caddyfile chưa được Caddy parse; chưa cấp chứng chỉ Let's Encrypt; chưa thử WebSocket qua Caddy; chưa thử `handle /health`.
- SSH deploy từ CI; kéo ảnh từ GHCR; quyền gói GHCR; ssh-action `v1.2.5`; `environment: staging`.
- Hành vi trên Ubuntu 24.04 (bash 5.2 thì cùng họ với bản đã thử, nhưng `flock`, `docker compose` plugin, `curl` chưa thử thật); simulator nối qua wss thật; hairpin NAT.
- `pg_dump`/`pg_restore` thật qua `docker compose exec` (script chỉ được thử với bản giả).

## Khi WP4 có dashboard

Thêm lại: Dockerfile cho `apps/dashboard`, dịch vụ `dashboard` trong compose, `handle` mặc định trong Caddyfile proxy tới nó, dòng matrix trong workflow, và (chỉ khi đã có xác thực) route `/api/*` / `/realtime*`.
