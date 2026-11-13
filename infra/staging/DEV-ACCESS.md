# Dev truy cập staging qua SSH tunnel (BE-27)

Mục tiêu: Sơn (app Flutter) và dev khác làm việc với **dữ liệu thật trên staging** (`powerme-staging.japaneast.cloudapp.azure.com`) thay vì DB local, mà **không mở thêm cổng nào ra internet**. Có hai đường, cùng đi qua một kết nối SSH:

| Đường | Trên VM | Trên máy dev | Dùng để |
|---|---|---|---|
| Driver API | `127.0.0.1:3000` (csms) | `127.0.0.1:3000` | app gọi `/api/driver/v1/...` như với CSMS local |
| Dashboard API (T128) | `127.0.0.1:3000` (csms, cùng cổng) | `127.0.0.1:3000` | dashboard (Vite trên máy dev) đăng nhập `/api/auth/v1/login`, gọi `/api/operator/v1/*`, `/api/admin/v1/*` |
| Postgres | `127.0.0.1:5432` (container postgres) | `127.0.0.1:5433` | **xem / sửa dữ liệu** bằng DBeaver, `psql`… |

NSG của Azure vẫn chỉ mở 22/80/443. Compose publish `3000` và `5432` **chỉ ra loopback của VM** (`127.0.0.1:…`), nên từ internet không tới được; muốn tới phải SSH vào VM trước. User SSH của dev là `devtunnel`: không có shell, chỉ được forward tới đúng hai đích trên.

> **Cảnh báo — đọc trước khi dùng**
>
> 1. **Không chạy một CSMS thứ hai trỏ vào DB staging** (kể cả `npm run demo`, `node dist/main.js` với `DATABASE_URL` của staging). CSMS staging đã chạy các bộ quét nền: hết giờ phiên (`SESSION_START_TIMEOUT_S`), trần 24 h (`SESSION_HARD_CAP_H`), gửi lại RemoteStop (BE-17), cảnh báo trụ offline, hết hạn top-up. Hai CSMS cùng quét một DB sẽ đóng phiên hai lần, gửi lệnh trùng, làm hỏng dữ liệu demo của cả nhóm. Muốn gọi API: dùng tunnel tới cổng **3000**. DB chỉ để xem/sửa dữ liệu.
> 2. **Sửa DB tay là sửa dữ liệu của cả nhóm.** Sổ cái credit/điểm là append-only theo nghiệp vụ: đừng `UPDATE balance_vnd` hay xoá dòng `credit_transactions`; sai thì nhờ Trí `./seed.sh` hoặc khôi phục bản sao lưu.
> 3. **Mật khẩu nhận qua kênh riêng** (tin nhắn trực tiếp), **không dán chat nhóm, không commit**, không để trong `.env` được commit (repo public). Gồm: mật khẩu role `app_dev`, mật khẩu tài xế mẫu (`DEMO_DRIVER_PASSWORD`), mật khẩu admin/staff mẫu của dashboard (`DEMO_STAFF_PASSWORD`).
> 4. Cổng 3000 cũng là **console vận hành chưa có xác thực** (có nút ngắt kết nối trụ, RemoteStop). Tunnel cho bạn quyền đó: chỉ mở `http://127.0.0.1:3000/` khi cần xem, đừng bấm lệnh lên trụ demo khi người khác đang demo.

## 1. Việc của Trí trên VM (một lần cho mỗi dev)

### a. Thêm khoá SSH của dev vào user tunnel

User `devtunnel` đã được tạo tay (shell `/usr/sbin/nologin`, home `/home/devtunnel`, `~/.ssh` 700, `authorized_keys` 600, owner `devtunnel`; sshd `AllowTcpForwarding yes`). Mỗi khoá là một dòng:

```
restrict,port-forwarding,permitopen="127.0.0.1:5432",permitopen="127.0.0.1:3000" ssh-ed25519 AAAA… son@laptop
```

`restrict` tắt mọi thứ (pty, agent, X11, forward, `~/.ssh/rc`), `port-forwarding` bật lại riêng forward cục bộ (`ssh -L`), và `permitopen` (nhiều lần, cách nhau dấu phẩy) giới hạn đích forward vào đúng hai cổng — cú pháp theo `man authorized_keys`. Shell `nologin` nên không chạy được lệnh; `ssh -N` không mở phiên shell nên forward vẫn chạy. `permitopen` so khớp **chuỗi** host: dev phải viết `127.0.0.1`, không phải `localhost`.

Dev gửi **file khoá công khai** (`~/.ssh/id_ed25519.pub`, không phải file không đuôi). Trí chạy bằng **`azureuser` + sudo** (user `deploy` không có sudo):

```bash
scp -i ~/.ssh/powerme_staging son.pub azureuser@<FQDN>:/tmp/son.pub
ssh -i ~/.ssh/powerme_staging azureuser@<FQDN>
sudo /home/deploy/powerme/infra/staging/add-dev-tunnel-key.sh /tmp/son.pub && rm /tmp/son.pub
```

Script idempotent: user/thư mục đã có thì giữ, khoá đã có (so `kiểu + base64`) thì không thêm, **không xoá khoá cũ**; tự gắn đúng option ở trên (bỏ option do người gửi tự đặt); từ chối khoá riêng, file nhiều dòng, base64 hỏng; in vân tay (SHA256) để đối chiếu với dev; cảnh báo nếu file có dòng thiếu `permitopen`. **Thu hồi khoá:** `sudo nano /home/devtunnel/.ssh/authorized_keys`, xoá dòng đó.

### b. Tạo role Postgres riêng `app_dev`

Chạy bằng **`deploy`** (nhóm docker, không cần sudo), khi stack đang chạy và compose đã publish `127.0.0.1:5432` (deploy một tag có PR này):

```bash
ssh -i ~/.ssh/powerme_staging deploy@<FQDN>
cd ~/powerme/infra/staging
./create-dev-db-role.sh             # chạy lại được; --rotate để đổi mật khẩu
cat ~/.powerme-app-dev-db-password  # rồi gửi riêng cho dev
```

`app_dev`: đăng nhập, `SELECT/INSERT/UPDATE/DELETE` mọi bảng `public` (cả bảng do migration sau tạo — `ALTER DEFAULT PRIVILEGES`), dùng sequence; **không** superuser, không tạo DB/role, không DDL (`CREATE/DROP/ALTER TABLE`), không `TRUNCATE`, chỉ đọc `_migrations`; tối đa 5 kết nối, câu lệnh quá 60 s bị cắt. Mật khẩu 48 ký tự hex, sinh ngẫu nhiên, nằm ở `~/.powerme-app-dev-db-password` (chmod 600, ngoài thư mục repo), không in ra, không lên argv.

## 2. Việc của dev (Windows / macOS)

### a. Mở tunnel

Windows (PowerShell, OpenSSH có sẵn trong Windows 10/11) và macOS (Terminal) như nhau:

```bash
ssh -N -L 5433:127.0.0.1:5432 -L 3000:127.0.0.1:3000 devtunnel@powerme-staging.japaneast.cloudapp.azure.com
```

- `-N`: không mở shell (user này không có shell). Lệnh "treo" là đúng — tunnel sống tới khi bạn Ctrl+C.
- Dùng khoá khác mặc định: thêm `-i ~/.ssh/<khoá>`. Giữ kết nối khi mạng chập chờn: thêm `-o ServerAliveInterval=30`.
- Cổng `5433` ở máy bạn để không đụng Postgres local (5432). Máy đã có gì ở cổng 3000 (CSMS local) thì đổi vế trái, vd `-L 3300:127.0.0.1:3000`, và dùng 3300 bên dưới.
- Lỗi `channel 2: open failed: administratively prohibited` = bạn viết `localhost` hoặc cổng khác ở vế phải; phải đúng `127.0.0.1:5432` / `127.0.0.1:3000`.

### b. Cấu hình

`.env` của bạn (KHÔNG commit):

```dotenv
DATABASE_URL=postgres://app_dev:<mật khẩu nhận riêng>@127.0.0.1:5433/powerme
```

App Flutter — base URL Driver API:

| Chạy app ở | Base URL |
|---|---|
| Máy tính (desktop/web), iOS Simulator | `http://127.0.0.1:3000/api/driver/v1` |
| Android Emulator | `http://10.0.2.2:3000/api/driver/v1` (`10.0.2.2` là loopback của máy chủ) |
| Điện thoại thật qua USB | `adb reverse tcp:3000 tcp:3000` rồi dùng `http://127.0.0.1:3000/api/driver/v1` |

HTTP thường (không TLS) chỉ chấp nhận được vì đi trong SSH tunnel tới loopback. Android 9+ chặn cleartext mặc định: cho phép `10.0.2.2`/`127.0.0.1` trong `network_security_config` của bản debug, không bật cho bản release.

### c. Đăng nhập bằng tài xế mẫu

Mật khẩu chung của ba tài xế mẫu (`DEMO_DRIVER_PASSWORD`) nhận riêng từ Trí. Bảng tài khoản, trạm và xe: [README.md › Dữ liệu mẫu cho app](README.md#dữ-liệu-mẫu-cho-app-tài-xế-be-27). Kiểm nhanh:

```bash
curl -s -X POST http://127.0.0.1:3000/api/driver/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"app.ds01@powerme.test","password":"<mật khẩu nhận riêng>"}'
# → 200 {access_token, expires_in: 900, refresh_token, ...}; 503 auth_unavailable = staging chưa có khoá JWT (báo Trí)
# BE-30: hoặc bằng số điện thoại (giả) của tài xế mẫu — mọi dạng 0900000101 / +84900000101 / 84900000101
curl -s -X POST http://127.0.0.1:3000/api/driver/v1/auth/login -H 'content-type: application/json' \
  -d '{"phone_number":"0900000101","password":"<mật khẩu nhận riêng>"}'
```

Chỉ trụ demo `RH24D1-00001` (`PM-D1-HCM-0001`, trạm `HCM-DEMO-01`) có trạng thái sống và bắt đầu sạc được — khi simulator đang chạy (`./deploy.sh <tag> --sim`, HMI ở `127.0.0.1:8100` của VM; user `devtunnel` không forward cổng này, nhờ Trí cắm súng hoặc mở thêm `permitopen`). Các trạm `HCM-APP-*` hiện `offline` (chưa từng kết nối OCPP).

### d. Đăng nhập dashboard (T128)

Cùng tunnel cổng 3000 (không cần mở thêm `permitopen`). Tài khoản: `staff.demo@powerme.test` (staff `manager` của operator mẫu, màn 16) và `admin.demo@powerme.test` (Admin, màn 26); mật khẩu chung (`DEMO_STAFF_PASSWORD`) nhận riêng từ Trí.

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:3000/api/auth/v1/login -H 'content-type: application/json' \
  -d '{"email":"staff.demo@powerme.test","password":"<mật khẩu nhận riêng>"}' | sed -E 's/.*"access_token":"([^"]+)".*/\1/')
curl -s http://127.0.0.1:3000/api/operator/v1/me -H "authorization: Bearer $TOKEN"
# → 200 {user_id, email, role: "operator_staff", operator_id, operator_name, staff_role}
# admin.demo@powerme.test: thay bằng /api/admin/v1/me. Token sai vai trò → 403; 503 auth_unavailable = staging chưa có DASHBOARD_JWT_* (báo Trí)
```

Chạy dashboard trên máy bạn với CSMS staging: `CSMS_URL=http://127.0.0.1:3000 npm run dev -w @powerme/dashboard` rồi mở `http://127.0.0.1:5173` (đổi cổng nếu tunnel dùng vế trái khác). **CORS không chặn**: CSMS chỉ nhận `Origin` là `localhost` / `127.0.0.1` / `[::1]` (mọi cổng) — đúng với Vite và tunnel; `curl` không gửi `Origin` nên cũng chạy. Dashboard **không** được mở qua `https://<DOMAIN>` (Caddy không proxy `/api`, và origin đó sẽ bị 403 `forbidden_origin`).

## 3. Phương án B: mở 5432 theo IP (kiểu MongoDB Atlas) — dự phòng, CHƯA bật

Sơn hỏi: "sao không add thẳng IP như Atlas?". Làm được, nhưng nhiều việc và rủi ro hơn tunnel:

- NSG Azure: thêm rule inbound TCP 5432 **chỉ từ IP công khai của dev** (không bao giờ `Any`).
- Compose: publish Postgres ra IP công khai của VM (không phải `0.0.0.0`; Docker tự mở iptables, vượt ufw) — **PR này không làm, và không được đổi sang `0.0.0.0`**.
- Postgres bắt buộc TLS: `ssl=on` + chứng chỉ/khoá server (tự ký thì dev phải `sslmode=verify-full` với CA tự ký; dùng chứng chỉ Let's Encrypt của Caddy thì phải lo gia hạn và quyền đọc khoá), `pg_hba.conf` dùng `hostssl … scram-sha-256` chỉ cho role `app_dev`, chặn `host` không TLS.
- Vẫn dùng role riêng `app_dev`, không bao giờ `POSTGRES_USER`.

Đánh đổi:

| | SSH tunnel (đang dùng) | Mở 5432 theo IP |
|---|---|---|
| Cổng mở ra internet | không thêm (chỉ 22 đã có) | thêm 5432 — Postgres trực tiếp trên internet, chịu dò mật khẩu và lỗi bảo mật của Postgres |
| IP động (4G, Wi-Fi quán, nhà mạng đổi IP) | không ảnh hưởng | mỗi lần đổi IP phải sửa NSG (cần quyền Azure) |
| Driver API cổng 3000 | đi cùng tunnel | vẫn phải tunnel (console chưa xác thực, không bao giờ mở) |
| Thu hồi | xoá một dòng `authorized_keys` | sửa NSG + đổi mật khẩu role |
| Repo public | không có gì để lộ | cấu hình TLS/pg_hba/NSG phải viết cẩn thận để không lộ IP/cách vào |

Kết luận: chỉ cân nhắc khi công cụ của dev không chạy được qua SSH (hiếm: DBeaver, DataGrip, `psql`, Flutter đều được). Muốn bật phải có PR riêng (TLS + pg_hba + NSG) và Trí duyệt.

## Đã kiểm và chưa kiểm

- `add-dev-tunnel-key.sh`: chạy trên Windows với `id/useradd/getent/chown` giả, `ssh-keygen` thật: khoá đã có thì không thêm, khoá mới thêm đúng một dòng, giữ dòng cũ, bỏ option tự đặt, từ chối khoá riêng/nhiều dòng/base64 hỏng; `ssh-keygen -l` đọc được cả file. **Chưa chạy trên VM**, chưa thử `ssh -N` thật qua `devtunnel`.
- `create-dev-db-role.sh`: SQL nó sinh (qua `docker` giả) đã chạy trên Postgres 17 nhúng: `app_dev` SELECT/INSERT/UPDATE được, TRUNCATE/CREATE TABLE/DROP/CREATE DATABASE/CREATE ROLE/DELETE `_migrations` bị chặn; chạy lại giữ mật khẩu, `--rotate` đổi mật khẩu; mật khẩu không có trên argv. Máy không có `psql`: các lệnh `\set`/`\if`/`\gset` được dịch bằng script, **chưa chạy bằng psql 16 thật trong container**.
- Publish `127.0.0.1:5432:5432`: YAML đã parse, **chưa `docker compose up` thật**.
