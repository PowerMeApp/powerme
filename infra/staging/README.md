# PowerMe staging (T04 / T84)

Hạ tầng staging theo kiến trúc ARCH-2 (Report 4, Figure 2): **một VPS Ubuntu 24.04 ở Singapore, Docker Compose**, TLS tự cấp bởi Caddy, ảnh Docker build trên GitHub Actions và kéo từ GHCR.

> **Trạng thái trung thực: đây là bộ cấu hình, CHƯA được chạy thử trên Docker hay VPS thật.** Máy của Trí không có Docker, nên Dockerfile chưa được `docker build`, Caddyfile chưa được Caddy đọc, `deploy.sh` chưa chạy trên Ubuntu 24.04, workflow chưa chạy trên GitHub. Phần đã kiểm (bằng mô phỏng trên máy Windows) và phần chưa kiểm nằm ở mục [Đã kiểm và chưa kiểm](#đã-kiểm-và-chưa-kiểm). Đừng coi `deploy.sh` đã được chứng minh cho tới khi có lần deploy thật đầu tiên — lần đó sẽ có lỗi vặt.

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
| Seed không có credential | `DEMO_PILLAR_PASSWORD` bắt buộc | `ALLOW_LEGACY_NO_CREDENTIAL=false` ⇒ trụ không credential bị 401 |

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
   - `DEMO_PILLAR_PASSWORD` — `openssl rand -base64 24` (>= 16 ký tự; bắt buộc để seed và chạy simulator).
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
| Áp lại dữ liệu mẫu, xoay mật khẩu trụ demo (đổi `DEMO_PILLAR_PASSWORD` rồi chạy) | `./seed.sh` |
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

Simulator là trụ D1 giả lập có HMI, nối `wss://<DOMAIN>/ocpp` với Basic Auth (`CP_ID=RH24D1-00001`, mật khẩu = `DEMO_PILLAR_PASSWORD`).

```bash
docker compose --profile sim up -d simulator      # hoặc ./deploy.sh <tag> --sim
ssh -L 8100:127.0.0.1:8100 <user>@<DOMAIN>        # rồi mở http://127.0.0.1:8100
```

Yêu cầu: đã `--seed` (để trụ tồn tại và có credential), `DEMO_PILLAR_PASSWORD` đúng. Nếu VPS không tự nối được IP công khai của chính nó (hairpin NAT), đặt `SIM_CSMS_URL=ws://csms:9000/ocpp` trong `.env` (đường trong mạng compose, không qua TLS — chỉ để demo). HMI cũng chưa có xác thực nên chỉ publish ra loopback như console.

## Rollback

`rollback.sh` có hai chế độ; chọn sai sẽ gây hỏng.

**Migration không đảo ngược được bằng lùi ảnh.** Migration 0001/0002 có `ALTER TYPE … ADD VALUE` (Postgres không có `DROP VALUE`) và đổi tên/kiểu cột (ví dụ `cp_timestamp`, `payment_mode`). Ảnh cũ viết cho schema cũ sẽ lỗi trên schema mới. **Cụ thể: ảnh `review-2-v0` KHÔNG tương thích schema sau 0001** — không lùi về nó và không deploy nó lên DB đã migrate.

- `deploy.sh` ghi lại migration nào mỗi lần deploy đã áp (`.deploy/migrated_<tag>`).
- `./rollback.sh` (lùi ảnh) **từ chối** nếu lần deploy đang chạy đã áp migration, và in danh sách file; với file có `RENAME`/`DROP`/`ALTER TYPE`/`SET NOT NULL`/`ALTER COLUMN` nó cảnh báo thêm là không additive. Phát hiện này chỉ là gợi ý theo từ khoá, không thay cho việc đọc migration.
- `./rollback.sh --force` bỏ chốt đó (chỉ dùng khi biết ảnh cũ chạy được với schema mới).
- `./rollback.sh --restore-db backups/pre-<tag>-<giờ>.dump` — cách đúng để lùi qua migration. Bản `pre-<tag>-*` được chụp **trước** lần deploy `<tag>`. Script dừng csms, **xoá và tạo lại** DB, `pg_restore`, rồi lùi ảnh. **Dữ liệu ghi sau lúc sao lưu (phiên sạc, thẻ…) sẽ mất.** Phải gõ `RESTORE` để xác nhận (hoặc `--yes`).
- `deploy.sh` khi kiểm sức khoẻ thất bại: nếu lần deploy **không** áp migration thì tự lùi ảnh về tag cũ; nếu **có** migration thì KHÔNG tự lùi, in lệnh khôi phục.

## Biến môi trường

Compose chỉ truyền cho `csms` những biến mà `apps/csms/src/config.ts` đọc: `DATABASE_URL` (ghép từ `POSTGRES_*`), `OCPP_PORT` (9000), `OCPP_PUBLIC_URL` (`wss://$DOMAIN/ocpp`), `CONSOLE_ENABLED`/`CONSOLE_HOST`/`CONSOLE_PORT`, `ALLOW_LEGACY_NO_CREDENTIAL` (**cố định `false`**, không đọc từ `.env`), `OFFLINE_GRACE_S` và các biến timeout/đối soát (có mặc định, xem `.env.example`). `OFFLINE_GRACE_S` mặc định 120 (WP1 chốt ngày 26/10/2026, ADR-0016).

## Bảo mật: những điều thật

- **Basic Auth qua wss nhờ Caddy TLS** — đây mới là chỗ OCPP Security Profile 2 trở thành thật: mật khẩu trụ (hash scrypt trong DB) được kiểm lúc nâng cấp WebSocket và đi trong TLS. Trước đó (CSMS chạy `ws://`) mật khẩu đi trần. Profile 3 (chứng chỉ máy khách) chưa làm.
- Chưa có TLS giữa Caddy và csms (cùng mạng Docker, cùng máy).
- `ALLOW_LEGACY_NO_CREDENTIAL=false` cố định: trụ không có credential bị 401.
- `/health` công khai trả đúng `{"ok":true,"db":true}` hoặc 503, không lộ phiên bản. Đây là đường dẫn console duy nhất ra ngoài.
- Địa chỉ IP trụ trong log của CSMS sẽ là IP của Caddy (CSMS không đọc `X-Forwarded-For`).
- Secret nằm trong `.env` trên VPS (quyền 600 do script đặt khi sửa); `gitleaks` chạy trên PR nhưng không bảo vệ VPS.

## Rủi ro và giới hạn thật

1. **Console vận hành không xác thực.** Ai có SSH vào VPS (hoặc chạy được container trong mạng compose) là ngắt được kết nối trụ và gửi RemoteStop. Chỉ chấp nhận được vì không ra internet.
2. **Chưa có dashboard** và chưa có REST/realtime cho app (không có gì để proxy).
3. **Một máy, không HA.** Postgres và CSMS cùng VPS; VPS chết là staging chết. CSMS giữ trạng thái kết nối trong RAM nên mỗi lần restart trụ nối lại (ân hạn `OFFLINE_GRACE_S`).
4. **Sao lưu chỉ nằm trên cùng VPS** (`backups/`, 10 bản, chụp trước mỗi deploy). Mất VPS là mất cả dữ liệu lẫn sao lưu. Chưa có sao lưu định kỳ hay ngoài máy.
5. **Chưa có giám sát/cảnh báo.** `/health` công khai cho phép gắn dịch vụ giám sát ngoài (ví dụ UptimeRobot) — chưa gắn. Chưa gom log; Docker giữ 5×10 MB mỗi dịch vụ.
6. Lùi ảnh không đảo được migration (mục Rollback).
7. Cấp chứng chỉ Let's Encrypt cần DNS đúng và cổng 80 mở; sai nhiều lần dính giới hạn tần suất của họ. Chứng chỉ nằm trong volume `caddy_data` — `docker compose down -v` sẽ xoá nó.
8. `docker compose down -v` xoá luôn DB (`pgdata`). Đừng dùng `-v`.
9. Ảnh simulator kéo theo dependency của csms (vài chục MB) vì simulator không có `package.json` riêng.
10. Seed demo dùng một trụ và dữ liệu mẫu cố định; giá trong `seed.sql` là giá mẫu.
11. Workflow dùng action bên thứ ba `appleboy/ssh-action` (ghim `v1.2.5`) cầm khoá SSH của CI. Hạn chế bằng environment `staging` có người duyệt và user deploy không có sudo.

## Đã kiểm và chưa kiểm

**Đã kiểm (mô phỏng trên Windows, không có Docker):**
- `bash -n` và ShellCheck 0.11.0 sạch cho `lib.sh`, `deploy.sh`, `rollback.sh`, `seed.sh`.
- YAML của compose và workflow parse được; `actionlint` 1.7.12 sạch cho workflow; mọi `${…}` trong compose đều có trong `.env.example`.
- Chuỗi lệnh của `apps/csms/Dockerfile` (`npm ci --ignore-scripts`, build, `npm ci --omit=dev -w @powerme/csms`, chỉ copy các đường dẫn Dockerfile copy) chạy trong thư mục sạch; sau đó `migrate.mjs`, `seed-demo.mjs` và `node dist/main.js` chạy lên Postgres nhúng: `/health` 200, trụ không mật khẩu / sai mật khẩu bị 401, đúng mật khẩu nhận BootNotification Accepted, console chỉ lắng nghe `127.0.0.1` (khi không đặt `CONSOLE_HOST`). Số liệu cụ thể nằm trong mô tả PR.
- Logic `deploy.sh`/`rollback.sh`/`seed.sh` với `docker`, `curl`, `sleep` **giả**: từ chối `.env` mẫu, tag lạ, thiếu mật khẩu seed; deploy thành công; từ chối lùi ảnh sau migration; tự lùi khi không có migration; không tự lùi khi có migration; migrate lỗi giữa chừng trả `TAG` về cũ; `--restore-db`; `set_env` với ký tự đặc biệt; mật khẩu không xuất hiện trên argv của `docker`.

**CHƯA kiểm được (cần Docker/VPS/GitHub thật):**
- `docker build` thật của hai Dockerfile (lỗi cú pháp Dockerfile, lớp cache, quyền file, `HEALTHCHECK` chạy trong alpine, user `node`).
- `docker compose config`/`up` thật; việc Compose chấp nhận cú pháp lồng `${SIM_CSMS_URL:-wss://${DOMAIN}/ocpp}` và `up --wait`.
- Caddyfile chưa được Caddy parse; chưa cấp chứng chỉ Let's Encrypt; chưa thử WebSocket qua Caddy; chưa thử `handle /health`.
- SSH deploy từ CI; kéo ảnh từ GHCR; quyền gói GHCR; ssh-action `v1.2.5`; `environment: staging`.
- Hành vi trên Ubuntu 24.04 (bash 5.2 thì cùng họ với bản đã thử, nhưng `flock`, `docker compose` plugin, `curl` chưa thử thật); simulator nối qua wss thật; hairpin NAT.
- `pg_dump`/`pg_restore` thật qua `docker compose exec` (script chỉ được thử với bản giả).

## Khi WP4 có dashboard

Thêm lại: Dockerfile cho `apps/dashboard`, dịch vụ `dashboard` trong compose, `handle` mặc định trong Caddyfile proxy tới nó, dòng matrix trong workflow, và (chỉ khi đã có xác thực) route `/api/*` / `/realtime*`.
