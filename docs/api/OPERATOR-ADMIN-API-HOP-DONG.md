# Hợp đồng REST cho Operator Dashboard và Admin Console (T98) — onboarding, sự cố, doanh thu

**Ngày:** 10/11/2026 · **sửa 12/11/2026** (BE-31: theo code FE-01a #118 / FE-01b #119 và ADR-0018)
**Task:** T98 — hợp đồng API Operator/Admin, cần có trước T97 (Nghĩa nối dashboard) và T108 (màn hình doanh thu)
**Người chịu trách nhiệm:** Ngô Văn Minh Trí (WP2) — hợp đồng; route theo cột "Người làm" ở §3
**File hợp đồng:** [`operator-admin-api.openapi.yaml`](operator-admin-api.openapi.yaml) (OpenAPI 3.1, v0.1.0)
**Mẫu theo:** [`DRIVER-API-HOP-DONG.md`](DRIVER-API-HOP-DONG.md) và [`driver-api.openapi.yaml`](driver-api.openapi.yaml)
— cùng quy ước JSON, lỗi, id chuỗi, phân trang.
**Trạng thái trên `main` 9c90f34:** đăng nhập và RolesGuard **đã chạy** (FE-01a #118,
[ADR-0018](../adr/0018-dang-nhap-dashboard-jwt.md)): `POST /api/auth/v1/login`,
`GET /api/operator/v1/me`, `GET /api/admin/v1/me`. Phần xác thực trong tài liệu này theo đúng code
đó; chỗ code và bản 10/11 khác nhau thì **code thắng** (Trí chốt 12/11). Các route nghiệp vụ còn lại
chưa có: logic đang ở console `/api/admin/*` **không xác thực, chỉ loopback** (ADR-0011, ADR-0017),
hoặc là service chưa có route, hoặc chưa có code. Tài liệu này không viết code endpoint.

---

## 1. Vì sao cần hợp đồng này ngay

Hai việc đang chờ: Nghĩa nối dashboard thật (T97) và Khang/Nghĩa làm màn hình doanh thu (T108).
Dashboard trên nhánh `wp4/fe-01-dashboard-shell` (20c8a6b, chưa merge) đang gọi mock với đường dẫn
tự đặt (`/api/v1/operator/pillars`, `/api/admin/devices`…, camelCase, id số). Console thật lại ở
`/api/admin/*`, snake_case, không xác thực, không lọc operator. Không chốt một hợp đồng thì mỗi bên
nối theo một kiểu và phải sửa lại.

Tình huống chuỗi phải chạy ở Review 3: nhân viên của operator A đăng nhập → thấy 3 trụ của A, không
thấy trụ của operator B → súng 2 của `PM-D1-HCM-0001` báo `Faulted` → acknowledge → Reset bị chặn vì
súng 1 đang sạc (409 `sessions_active`) → xác nhận lần hai → Reset Accepted → cuối tháng xuất CSV
doanh thu, tổng CSV bằng đúng số trên màn hình. Cùng lúc token của tài xế gọi `/api/operator/v1/faults`
nhận 403 (F-13).

## 2. Nguyên tắc

### 2.1 Hai bề mặt, một tiến trình

| Bề mặt | Base path | Role JWT | Ai dùng | Màn hình SRS |
|---|---|---|---|---|
| Đăng nhập | `/api/auth/v1` | công khai | nhân viên operator và Admin, chung một endpoint | Table 5 #16, #26 |
| Operator | `/api/operator/v1` | `operator_staff` | nhân viên một operator đối tác | Table 5 #16–#25 |
| Admin | `/api/admin/v1` | `admin` | quản trị PowerMe | Table 5 #26–#33 |

Cùng cổng 3000 và cùng listener với console và Driver API (ADR-0017, ADR-0018: một handler raw HTTP
chọn theo tiền tố, không Nest controller, không cổng mới). `ConsoleServer` chuyển mọi URL khớp
`OPERATOR_API_PATH` = `^/api/(auth|operator|admin)/v1(/|?|$)` sang `operator-api.http.ts`
**trước** các route console, nên `/api/admin/v1/*` không bao giờ lọt vào `/api/admin/*` chưa xác
thực (ADR-0018 #7). Console `/api/admin/*` và `/api/operator/charge-points/onboard` (không `v1`) giữ
cho demo đến khi các route ở đây chạy, rồi bỏ — xem §5.

Bảng ủy quyền màn hình (Table 6) tách hẳn hai role: Operator không mở màn hình Admin và ngược lại.
Hợp đồng giữ đúng như vậy — **không endpoint nghiệp vụ nào cho cả hai role** (chỉ đăng nhập là
chung). Admin xem dữ liệu vận hành qua các route chỉ đọc của chính mình (`/admin/v1/sessions`,
`/reconciliation-records`, `/ocpp-messages`).

### 2.2 Xác thực (đã chạy — FE-01a #118, ADR-0018)

Code: `apps/csms/src/users/auth.ts` (IAuth, `StaffAccounts.login`), `users/roles-guard.ts`
(RolesGuard), `operator-api/operator-api.http.ts` (route); type phía dashboard
`packages/shared/src/api/auth.ts`; test `apps/csms/test/fe01-dashboard-auth.integration.test.ts`
(TC-F13-01..03).

**Đăng nhập — `POST /api/auth/v1/login`**, một endpoint cho cả hai vai trò. Token mang `role`; màn
đăng nhập của mỗi khu vực trên dashboard (`/operator/login` màn 16, `/admin/login` màn 26) tự từ chối
vai trò còn lại và không lưu token (FE-01b #119).

- Body `{email, password}`, đúng hai khoá chuỗi; khoá lạ (vd `role`) → 400 `invalid_input`.
  `Content-Type: application/json` (không thì 415 `unsupported_media_type`), body ≤ 16 KiB (413
  `payload_too_large`), chỉ `POST` (405 + `Allow`). Email được `trim()` + chữ thường, không kiểm
  định dạng; email > 254 ký tự hoặc mật khẩu > 128 ký tự → 401, không phải 400.
- 200 → `{access_token, token_type: "Bearer", expires_in: 28800, user}`; `user` cùng hình dạng với
  `/me` (cuối mục này). `Cache-Control: no-store`.

| Tình huống đăng nhập | Kết quả |
|---|---|
| Sai email, sai mật khẩu, user là tài xế, `operator_staff` thiếu dòng `operator_staff`, `admin` thiếu dòng `admins` | cùng **401** `invalid_credentials`; email không tồn tại vẫn băm giả một lần để thời gian như nhau |
| Mật khẩu đúng, `account_status` ≠ `active` (`suspended`, `closed`…) | **403** `account_locked` — chỉ báo **sau** khi mật khẩu đúng |
| Mật khẩu đúng, nhân viên của Operator ≠ `active` | **403** `operator_inactive` — cũng chỉ sau mật khẩu đúng |
| 5 lần sai / 60 s theo email + IP, hoặc 20 lần / 60 s theo IP | **429** `too_many_attempts` + `Retry-After` (giây), khoá 15 phút, kể cả khi mật khẩu đúng; quá 20 lần đang băm song song từ một IP → 429 `Retry-After: 1` |
| `DASHBOARD_JWT_*` để trống cả ba | **503** `auth_unavailable` |

Bộ đếm thử sai là một instance riêng của dashboard (cùng số với BR-P49 / BE-21, không chung bộ đếm
với tài xế), nằm trong bộ nhớ một tiến trình (ADR-0002) và lấy IP từ `req.socket.remoteAddress` —
xem §2.7 về proxy.

**Token.** JWT HS256 `typ: JWT`, claim `sub` (users.id), `role` (`operator_staff` | `admin`, đúng
enum `user_role` — "Operator" chỉ là nhãn UI), `iss`, `aud`, `iat`, `exp` = `iat` + **8 giờ** (một
ca), `jti`; nhân viên có thêm `operator_id`, `staff_role`. **Không có refresh token** (ADR-0018 #3 và
bảng phương án bị loại: "Access 15 phút + refresh token") — hết 8 giờ thì đăng nhập lại; dashboard
tự đăng xuất khi token hết hạn. Đăng xuất = xoá token ở trình duyệt; không thu hồi được từng token,
bù bằng việc kiểm DB ở mỗi request.

**Khoá ký riêng.** `DASHBOARD_JWT_SECRET_BASE64` (base64 chuẩn của ≥ 32 byte ngẫu nhiên),
`DASHBOARD_JWT_ISSUER`, `DASHBOARD_JWT_AUDIENCE` — **không dùng chung** khoá, issuer hay audience với
Driver API (`DRIVER_API_JWT_*`). Lộ một khoá chỉ mở một bề mặt. Hệ quả:

- Token tài xế gọi `/api/operator/v1/*` hoặc `/api/admin/v1/*` → **403 `forbidden`**: guard thử xác
  minh bằng khoá Driver API, đúng và `role = driver` thì là "token hợp lệ của vai trò khác" (F-13).
  Nếu Driver API chưa cấu hình khoá, guard không nhận ra được và trả 401.
- Token dashboard gọi `/api/driver/v1/*` → **401 `unauthorized`** (Driver API chỉ biết khoá của
  mình).

**Không có header dev** kiểu `X-Driver-Id` / `X-Operator-Id` cho hai bề mặt này (ADR-0018: loại vì
giới hạn theo Operator không chứng minh được).

**`/me`.** `GET /api/operator/v1/me` và `GET /api/admin/v1/me` trả `DashboardUser` **phẳng**, không
lồng object `operator`:

| Trường | Kiểu | Nhân viên | Admin |
|---|---|---|---|
| `user_id` | chuỗi số (bigint) | có | có |
| `email` | chuỗi (như lưu trong DB) | có | có |
| `full_name` | chuỗi | có | có |
| `role` | `operator_staff` \| `admin` | `operator_staff` | `admin` |
| `operator_id` | chuỗi số | có, không null | **vắng mặt** |
| `operator_name` | chuỗi (`operators.legal_name`) | có, không null | **vắng mặt** |
| `staff_role` | `manager` \| `technician` | có, không null | **vắng mặt** |

Với Admin ba khoá cuối không có trong JSON (không phải `null`) — TS shared khai báo là trường tuỳ chọn
(`operator_id?: string`…). Response đăng nhập dùng đúng type này (`LoginResponse.user`). Ở `/me`,
`operator_id` lấy từ lần đọc DB của guard ở chính request đó, không từ token.

### 2.2a RolesGuard, CORS, query string (hành vi hiện tại)

RolesGuard chạy **trước khi khớp route** trên **mọi** `/api/operator/v1/*` và `/api/admin/v1/*`, kể
cả đường dẫn chưa có route: không có token hợp lệ → 401, có token đúng vai trò → 404 `not_found`.
Thứ tự:

1. Đúng **một** header `Authorization: Bearer <jwt>` (≤ 8 192 ký tự). Thiếu, hai header, sai dạng,
   sai chữ ký / iss / aud, hết hạn (kiểm `exp` và tuổi từ `iat` ≤ 8 giờ, không dung sai đồng hồ)
   → **401 `unauthorized`** — trừ token tài xế hợp lệ → **403 `forbidden`** (ở trên).
2. `role` trong token khác bề mặt (token admin gọi `/operator/v1`, token nhân viên gọi
   `/admin/v1`) → **403 `forbidden`**.
3. Đọc lại DB ở **mỗi request** (`users` ⟕ `admins` ⟕ `operator_staff` ⟕ `operators`):
   - user không còn → 401; `users.role` khác bề mặt → 403 `forbidden`;
   - `account_status` ≠ `active` → **403 `account_locked`** (khoá tài khoản có hiệu lực ở request kế
     tiếp, không chờ token hết hạn — TC-F13-03);
   - Admin thiếu dòng `admins` → 403 `forbidden`;
   - nhân viên không còn dòng `operator_staff`, hoặc `operator_id` trong DB khác claim (bị chuyển
     Operator) → **401** (đăng nhập lại); Operator ≠ `active` → **403 `operator_inactive`**.

Phạm vi Operator của mọi route `/operator/v1` lấy từ lần đọc DB ở bước 3, **không bao giờ từ token,
query hay body** — đúng cách `ChargePointOnboardingService` và `SessionReviewService` đang làm. Mỗi
request vì vậy tốn thêm một truy vấn (ADR-0018 "Mất").

**CORS — hiện chỉ localhost.** Có header `Origin` mà không khớp
`http(s)://localhost | 127.0.0.1 | [::1]` (cổng bất kỳ) → **403 `forbidden_origin`** trước mọi kiểm
tra khác, ở cả đăng nhập lẫn route có guard. Preflight `OPTIONS` từ localhost → 204, cho phép
`Authorization, Content-Type` và `GET, POST, PUT, PATCH, DELETE, OPTIONS`. Request không có `Origin`
(curl, test) không bị chặn. Đủ cho Vite dev (`127.0.0.1:5173`, proxy `/api` không đổi Origin);
**chưa đủ cho staging** — xem §2.7.

**Query string — hiện bị 400 trước guard.** Mọi URL có query (kể cả `?` rỗng) dưới
`/api/{auth,operator,admin}/v1` nhận **400 `invalid_input`**, trước cả RolesGuard (nên một request
không token mà có query nhận 400, không phải 401). Đây là hành vi của v0.1 khi chỉ có `/me`; **sẽ
đổi** khi viết route danh sách đầu tiên (tham số `page`, `status`, `from`… trong YAML là hợp đồng cho
lúc đó) — khi đổi, giữ thứ tự guard trước, kiểm tham số sau.

**Lỗi tầng xác thực.** Body vẫn `{error, detail}` nhưng hiện `detail` = chính mã lỗi (chưa có câu
tiếng Việt); 500 → `internal_error`. Mọi response có `Cache-Control: no-store`. 401 hiện **không**
gửi header `WWW-Authenticate`.

### 2.3 Phạm vi dữ liệu theo operator

Mọi route `/operator/v1` chỉ trả và chỉ cho tác động lên trụ thuộc site của operator người gọi
(BR-P11, BR-P16). Tài nguyên của operator khác trả **404 `not_found`** như không tồn tại
(cách của `SessionReviewService`: không lộ dữ liệu liên-operator). Ngoại lệ có sẵn trong code:
onboarding vào site của operator khác trả 403 `site_of_other_operator` (SD-5a) vì site là thứ người
dùng chọn từ danh sách của mình, nhận 403 nghĩa là dashboard có lỗi.

### 2.4 JSON, lỗi, phân trang

- snake_case, id bigint dạng chuỗi, tiền VND nguyên, điện năng Wh nguyên, thời điểm ISO 8601 UTC,
  ngày (`date`) theo lịch Asia/Ho_Chi_Minh — như Driver API §8.
- Lỗi luôn `{error, detail}` (tầng xác thực hiện để `detail` = mã lỗi — §2.2a). Mã đã có trong code giữ nguyên văn: `ConsoleError` (`station_offline`,
  `sessions_active`, `fault_not_acknowledged`, `reset_in_progress`, `station_error`…),
  `OnboardingError`, `SessionReviewError`, `ChargingError` (`recovery_*`).
- Danh sách: `page` (từ 1) + `page_size` (1–100, mặc định 50) → `{items, total, page, page_size}`,
  giống `/stations` của tài xế. Riêng nhật ký OCPP giữ con trỏ `after` + `limit` (≤ 500) của console vì
  màn hình poll đuôi log.
- Phiên chỉ có `payment_mode` ∈ {`csms_billed`, `unattributed`}; thẻ RFID chỉ có
  `card_kind` ∈ {`online`, `free_vend`} — theo T110 (đang làm song song). Charging Credit giữ đúng
  tên Charging Credit (khoản trả trước, ADR-0013).

### 2.5 Lệnh và idempotency

- Lệnh xuống trụ qua `POST /operator/v1/charge-points/{id}/commands` trả **202** + `RemoteCommand`
  (bảng `remote_commands` đã có, migration 0001), kết quả đọc ở `GET /commands/{id}` — đúng WP2 §4.2
  "lệnh điều khiển là bất đồng bộ". Console hiện chờ đồng bộ tối đa 15 s rồi trả 200; route mới không
  chờ.
- Ngoại lệ có chủ đích: `POST /faults/{id}/reset` **giữ đồng bộ** như console (WF-04) vì kết quả
  Accepted/Rejected quyết định trạng thái sự cố (STM-6 t4/t6) ngay trong response.
- Header `Idempotency-Key` (8–64 ký tự; 64 vì cột `remote_commands.idempotency_key` là varchar(64))
  bắt buộc ở: gửi lệnh, Reset sự cố, đặt biểu giá, các lệnh hoàn tiền / thử lại hoá đơn. Cùng key +
  cùng body trong 24 giờ → trả lại response cũ, không gửi lệnh lần hai; cùng key khác body → 409
  `idempotency_conflict`. Tình huống: nhân viên bấm "Dừng sạc", Wi-Fi rớt, dashboard gửi lại cùng key →
  CSMS không gửi RemoteStop thứ hai.
- Các hành động đi theo state machine (acknowledge, close, resolve, lock…) không cần key: gọi lại lần
  hai trả 409 `invalid_transition` / `not_in_review`, không ghi gì.

### 2.6 Realtime

Không có trong v0.1. Dashboard poll REST (danh sách trụ 5 s, sự cố 5 s, lệnh đang chờ 2 s). Khi có
SSE/Socket.IO (`alert.raised`, `alert.updated`, `alert.resolved`, `command.result` — WP2 §4.3, WF-04 #8)
thì sự kiện chỉ là gợi ý, REST vẫn là sự thật (ADR-0006).

### 2.7 Triển khai / bảo mật

Tình huống: FE-01d mở dashboard trên staging qua Caddy (`https://$DOMAIN/`), CSMS vẫn một cổng 3000.
Cổng đó đang chở **cả** console cũ chưa xác thực lẫn các bề mặt có JWT, nên phải giữ bốn luật:

1. **Caddy chỉ chuyển đúng các tiền tố có xác thực**: `/api/auth/v1/*`, `/api/operator/v1/*`,
   `/api/admin/v1/*` (và `/api/driver/*` cho app tài xế — Driver API tự kiểm JWT). **Không** chuyển
   nguyên `/api/*`, cũng không chuyển `/api/admin/*` hay `/api/operator/*`: console cũ ở
   `/api/admin/*` (RemoteStop, Reset sự cố, ngắt kết nối trụ, đăng ký serial `POST /api/admin/charge-points`)
   và `/api/operator/charge-points/onboard` **chưa xác thực** và chạy chung cổng 3000 — chỉ được tới
   bằng SSH tunnel như hiện nay (`infra/staging/Caddyfile`, `DEV-ACCESS.md`). Khớp có dấu `/` sau
   `v1` (`/api/admin/v1/*`), **không** viết `/api/admin/v1*`: `/api/admin/v1abc` không khớp
   `OPERATOR_API_PATH` nên CSMS giao nó cho console chưa xác thực. Phác thảo:

   ```caddy
   @authed path /api/auth/v1/* /api/operator/v1/* /api/admin/v1/* /api/driver/*
   handle @authed {
   	reverse_proxy csms:3000
   }
   ```

   Còn `CONSOLE_ALLOW_NON_LOOPBACK=true` trong compose staging thì luật này là hàng rào duy nhất;
   mỗi lần sửa Caddyfile phải thử `curl https://$DOMAIN/api/admin/stations` → không được ra 200.
2. **Giới hạn đăng nhập phải đọc IP thật sau proxy.** `StaffAccounts.login` nhận
   `req.socket.remoteAddress`; sau Caddy đó là IP của Caddy, nên mọi người dùng chung một bộ đếm
   "20 lần / 60 s theo IP" (một kẻ dò mật khẩu khoá đăng nhập của cả nhóm 15 phút) và bộ đếm
   "email + IP" thành "theo email". Trước khi mở qua Caddy, route đăng nhập phải lấy giá trị **cuối**
   của `X-Forwarded-For` khi có cờ tin proxy, như `OCPP_TRUST_PROXY` của cổng OCPP
   (`ocpp-server.ts` `clientIp`). Driver API (`driver.http.ts`) đang cùng tình trạng. Việc của code
   (Nghĩa / FE-01d), hợp đồng chỉ ghi yêu cầu.
3. **CORS khi cùng origin.** Trình duyệt gửi header `Origin` cả với `POST` cùng origin, nên khi
   dashboard ở `https://$DOMAIN` gọi `POST /api/auth/v1/login`, listener hiện tại (chỉ cho phép
   localhost) sẽ trả 403 `forbidden_origin`. FE-01d cần thêm origin staging vào danh sách cho phép
   (đọc từ biến môi trường, không dùng `*`) — câu hỏi N8.
4. **Đặt đủ cả ba `DASHBOARD_JWT_*` cùng lúc.** `DASHBOARD_JWT_SECRET_BASE64` (sinh
   `openssl rand -base64 32`, **khác** `DRIVER_API_JWT_SECRET_BASE64`), `DASHBOARD_JWT_ISSUER`,
   `DASHBOARD_JWT_AUDIENCE`. Trống cả ba → CSMS chạy, mọi route dashboard 503 `auth_unavailable`;
   **đặt thiếu một** (hoặc khoá không phải base64 chuẩn của ≥ 32 byte) → `loadDashboardAuthConfig`
   ném lỗi và **CSMS không khởi động**. Trên main 9c90f34, `infra/staging/docker-compose.yml` chưa
   truyền ba biến này vào `csms` và `lib.sh check_env` chưa kiểm chúng (Driver API đã có cả hai) —
   cần thêm trước FE-01d.

Khi đổi khoá dashboard, mọi token đang dùng mất hiệu lực (nhân viên đăng nhập lại); không ảnh hưởng
token tài xế.

## 3. Bảng endpoint theo nhóm

Trạng thái: **đã chạy** = route có trên main, có JWT · **console** = logic đã chạy ở console
`/api/admin/*` (chưa xác thực, chưa lọc operator), phải chuyển sang đây · **service** = hàm service có
trong code, chưa có route · **in progress** = đang làm ở nhánh khác · **planned** = chưa có code. Cột
"Người làm" theo WP vì BM04 (nộp 09/11) không có trong repo — Trí sửa nếu lệch phân công. Đường dẫn bỏ
tiền tố `/api`.

### 3.1 Đăng nhập và hồ sơ người gọi (3)

| Endpoint | Role | UC / FR / BR | Trạng thái · người làm | Ghi chú |
|---|---|---|---|---|
| `POST /auth/v1/login` | công khai | F-13, UC-ACC-04/05, BR-P16, ADR-0018 | **đã chạy** (FE-01a #118) · Nghĩa | một endpoint cho nhân viên và Admin; token 8 giờ, không refresh; mã lỗi ở §2.2 |
| `GET /operator/v1/me` | operator_staff | BR-P16, Table 5 #17 | **đã chạy** (FE-01a #118) · Nghĩa | `DashboardUser` phẳng có `operator_id`, `operator_name`, `staff_role` |
| `GET /admin/v1/me` | admin | Table 5 #27 | **đã chạy** (FE-01a #118) · Nghĩa | `DashboardUser` không có ba trường Operator |

Bản 10/11 có `POST /{operator,admin}/v1/auth/login` và `/auth/refresh` (6 route). Bỏ theo ADR-0018:
một đăng nhập chung, **không có refresh** (ADR-0018 #3 loại "access 15 phút + refresh"; không ghi
"sẽ có"), nên không còn dòng `auth/refresh` nào kể cả `planned`. Không có `logout` phía server
(`/api/auth/v1/logout` → 404); đăng xuất là xoá token ở dashboard.

### 3.2 Onboarding và sổ đăng ký trụ (10)

| Endpoint | Role | UC / FR / BR | Trạng thái · người làm | Ghi chú |
|---|---|---|---|---|
| `GET /operator/v1/sites` | operator_staff | UC-OPS-01, BR-P11 | planned · Ân | ô chọn site trong sheet onboarding |
| `POST /operator/v1/charge-points` | operator_staff | UC-OPS-01, FR-09, STM-3 #2, SD-5a | **console (interim, T119)** `POST /api/operator/charge-points/onboard` · Ân | 201, mật khẩu hiện **một lần**, `no-store`; gọi lại → 409 `already_onboarded` |
| `POST /operator/v1/charge-points/{id}/disable` | operator_staff | STM-3 #4, ADR-0016 | planned · Ân | chỉ có `ChargePointLifecyclePolicy`, chưa có service ghi DB |
| `POST /operator/v1/charge-points/{id}/enable` | operator_staff | STM-3 #5 | planned · Ân | |
| `GET /admin/v1/charge-points` | admin | UC-ADM-03, UC-ADM-07, FR-15 | **console** (một phần) · Ân | console thiếu model, firmware, bảo hành, operator |
| `POST /admin/v1/charge-points` | admin | UC-ADM-03, FR-15, STM-3 #1 | **console (interim, T119)** `POST /api/admin/charge-points` · Ân | 409 `serial_already_registered` |
| `GET /admin/v1/charge-points/{id}` | admin | UC-ADM-03 | planned · Ân | |
| `PATCH /admin/v1/charge-points/{id}` | admin | UC-ADM-03 | planned · Ân | model, firmware, kW, bảo hành; không đổi serial |
| `PUT /admin/v1/charge-points/{id}/free-vend-tag` | admin | UC-ADM-05, BR-P09, ADR-0012 | planned · Ân | null = tắt; chỉ áp cho phiên bắt đầu sau đó (BR-P08) |
| `POST /admin/v1/charge-points/{id}/decommission` | admin | STM-3 #6 | planned · Ân | |

### 3.3 Giám sát trụ và lệnh từ xa (7)

| Endpoint | Role | UC / FR / BR | Trạng thái · người làm | Ghi chú |
|---|---|---|---|---|
| `GET /operator/v1/summary` | operator_staff | UC-OPS-02/03, Table 5 #17 | planned · Nghĩa (T97) | số trụ theo trạng thái, súng theo nhóm BR-P38, sự cố mở theo mức, hàng việc review/unattributed/T72 |
| `GET /operator/v1/charge-points` | operator_staff | UC-OPS-02, FR-10, BR-P10, BR-P38/39 | **console** `ConsoleQueries.stations` · Nghĩa | thêm lọc operator, site, phân trang; mỗi súng một trạng thái, không gộp |
| `GET /operator/v1/charge-points/{id}` | operator_staff | UC-OPS-02/04, Table 5 #20 | planned · Nghĩa | súng, sự cố mở, 20 lệnh gần nhất |
| `GET /operator/v1/charge-points/{id}/metrics` | operator_staff | UC-OPS-02, FR-10, BR-P43 | planned · Trí | `window=7d\|30d`; từ `connector_status_events` |
| `POST /operator/v1/charge-points/{id}/commands` | operator_staff | UC-OPS-04, FR-11, BR-P01/P06/P07 | **console** (chỉ remote_stop) · Trí | `action` ∈ `remote_start`, `remote_stop`, `reset`; 202; Idempotency-Key |
| `GET /operator/v1/commands/{id}` | operator_staff | UC-OPS-04 | planned · Trí | đọc `remote_commands` |
| `GET /operator/v1/ocpp-messages` | operator_staff | FE-08, PKG-2 | **console** `messages` · Nghĩa | chỉ trụ của operator; Table 6 chưa có màn hình này (câu hỏi N3) |

### 3.4 Sự cố (4)

| Endpoint | Role | UC / FR / BR | Trạng thái · người làm | Ghi chú |
|---|---|---|---|---|
| `GET /operator/v1/faults` | operator_staff | UC-OPS-03, FR-10, STM-6 | **console** `FaultService.list` · Nghĩa | `status=open\|all`, thêm `charge_point_id`, chuyển sang page/page_size |
| `POST /operator/v1/faults/{id}/acknowledge` | operator_staff | STM-6 t2 | **console** · Nghĩa | console ghi `acknowledged_by = null`; route mới ghi người gọi |
| `POST /operator/v1/faults/{id}/reset` | operator_staff | STM-6 t4, BR-P07, WF-04 #12 | **console** `resetFault` · Nghĩa | đồng bộ; `type`/`force` chuyển từ query vào body; Idempotency-Key |
| `POST /operator/v1/faults/{id}/close` | operator_staff | STM-6 t7, BR-P42 | **console** · Nghĩa | |

### 3.5 Phiên, đối soát, phiên review / unattributed, khôi phục T72 (15)

| Endpoint | Role | UC / FR / BR | Trạng thái · người làm | Ghi chú |
|---|---|---|---|---|
| `GET /operator/v1/sessions` | operator_staff | UC-OPS-05, FR-13, BR-P08 | **console** `sessions` · Trí | `queue=review\|unattributed` (giữ tên tham số của mock dashboard), lọc status/payment_mode/trụ/thời gian |
| `GET /operator/v1/sessions/{id}` | operator_staff | UC-OPS-05, FR-16 | **console** `session` · Trí | meter, tạm dừng, bản ghi đối soát |
| `POST /operator/v1/sessions/{id}/resolve` | operator_staff | UC-OPS-05, STM-1 #17 | **service** `SessionReviewService.resolveReview` · Trí | body `{resolution, note}`; mock dashboard chỉ gửi `note` |
| `POST /operator/v1/sessions/{id}/assign` | operator_staff | UC-OPS-05, BR-P06/P08 | **in progress** · Trí (T102) | giữ chỗ; body chốt ở T102 |
| `POST /operator/v1/sessions/{id}/close` | operator_staff | UC-OPS-05 | **in progress** · Trí (T102) | |
| `GET /operator/v1/reconciliation-records` | operator_staff | UC-OPS-05, FR-16, Table 7 #6–7 | **console** `reconciliation` · Trí | |
| `GET /operator/v1/charge-intents` | operator_staff | UC-OPS-04, T72 | planned · Trí | hàng việc start không rõ; chưa có hàm liệt kê |
| `GET /operator/v1/charge-intents/{id}/recovery` | operator_staff | T72 | **service** `startRecovery` · Trí | |
| `POST …/charge-intents/{id}/begin-recovery` | operator_staff | T72 | **service** `beginStartRecovery` · Trí | `{note}` bằng chứng bắt buộc |
| `POST …/charge-intents/{id}/complete-recovery` | operator_staff | T72 | **service** `completeStartRecovery` · Trí | |
| `POST …/charge-intents/{id}/restore-connector` | operator_staff | T72 | **service** `restoreRecoveredConnector` · Trí | |
| `POST …/charge-intents/{id}/retry-recovery` | operator_staff | T72 | **service** `retryStartRecovery` · Trí | `{kind: fence\|restore, note}`; RemoteStart không bao giờ gửi lại |
| `POST …/charge-intents/{id}/approve-late-start` | operator_staff | T72, UC-OPS-05 | **service** `approveLateStart` · Trí | |
| `POST /operator/v1/sessions/{id}/recover-stop` | operator_staff | BR-P01, T72, BE-17 | **service** `recoverStop` · Trí | 202 |
| `POST /operator/v1/sessions/{id}/tariff-boundary` | operator_staff | BR-P02, BR-P45, T72 | **service** `recordTariffBoundary` · Trí | 204 |

### 3.6 Biểu giá và khuyến mãi (6)

| Endpoint | Role | UC / FR / BR | Trạng thái · người làm | Ghi chú |
|---|---|---|---|---|
| `GET /operator/v1/tariffs` | operator_staff | UC-OPS-06, FR-12, BR-P02 | planned · Nghĩa (+ Khang) | bản đang hiệu lực + bản sắp hiệu lực |
| `PUT /operator/v1/tariffs` | operator_staff | UC-OPS-06, BR-P02, BR-P45 | planned · Nghĩa (+ Khang) | phủ kín 24 h, không chồng; `effective_from` ≥ hôm nay; không sửa bản cũ |
| `GET /operator/v1/promotions` | operator_staff | UC-OPS-07, FR-12 | planned · Nghĩa (+ Khang) | |
| `POST /operator/v1/promotions` | operator_staff | UC-OPS-07 | planned · Nghĩa (+ Khang) | mã duy nhất toàn nền tảng (`promotions_promotion_code_key`) |
| `PATCH /operator/v1/promotions/{id}` | operator_staff | UC-OPS-07 | planned · Nghĩa (+ Khang) | |
| `POST /operator/v1/promotions/{id}/deactivate` | operator_staff | UC-OPS-07 | planned · Nghĩa (+ Khang) | `valid_to = now()` (bảng không có cột active) |

### 3.7 Doanh thu và CSV (4)

| Endpoint | Role | UC / FR / BR | Trạng thái · người làm | Ghi chú |
|---|---|---|---|---|
| `GET /operator/v1/revenue` | operator_staff | UC-OPS-09, FR-18, BR-P46 | planned · Khang (T108) | `from`, `to` (ngày), `group_by=charge_point\|site\|day`, `site_id` |
| `GET /operator/v1/revenue.csv` | operator_staff | UC-OPS-09, BR-P46 | planned · Khang (T108) | cùng truy vấn với JSON |
| `GET /admin/v1/revenue` | admin | UC-ADM-10, BR-P46 | planned · Khang (T108) | thêm `group_by=operator`, `operator_id` |
| `GET /admin/v1/revenue.csv` | admin | UC-ADM-10, BR-P46 | planned · Khang (T108) | |

Định nghĩa ở §4.

### 3.8 Tài khoản, role, thẻ RFID (11)

| Endpoint | Role | UC / FR / BR | Trạng thái · người làm | Ghi chú |
|---|---|---|---|---|
| `GET /admin/v1/users` | admin | UC-ADM-01, FR-14, BR-P05 | planned · Trí | lọc role, trạng thái, operator, `q` |
| `POST /admin/v1/users` | admin | UC-ADM-01/02, BR-P16 | planned · Trí | chỉ `operator_staff`/`admin`; tài xế tự đăng ký (consent BR-P05) |
| `GET /admin/v1/users/{id}` | admin | UC-ADM-01 | planned · Trí | |
| `PATCH /admin/v1/users/{id}` | admin | UC-ADM-01 | planned · Trí | họ tên, điện thoại |
| `PUT /admin/v1/users/{id}/role` | admin | UC-ADM-02, BR-P16 | planned · Trí | một role mỗi user; tài xế không đổi role được (409) |
| `POST /admin/v1/users/{id}/lock` | admin | UC-ADM-01, F-13 | planned · Trí | `active → suspended`, có hiệu lực ở request kế tiếp |
| `POST /admin/v1/users/{id}/unlock` | admin | UC-ADM-01, F-13 | planned · Trí | `closed` không mở lại |
| `GET /admin/v1/operators` | admin | UC-ADM-02, BR-P11 | planned · Trí | để gán nhân viên và lọc báo cáo |
| `GET /admin/v1/rfid-cards` | admin | UC-ADM-04, FR-15, BR-P15 | planned · Ân | |
| `POST /admin/v1/rfid-cards` | admin | UC-ADM-04, BR-P15, BR-P23 | planned · Ân | `card_kind` ∈ `online`, `free_vend` |
| `PATCH /admin/v1/rfid-cards/{id}` | admin | UC-ADM-04, BR-P15 | planned · Ân | gắn/bỏ tài xế, khoá/mở; không đổi loại |

### 3.9 Tổng quan nền tảng (5) và ngoại lệ thanh toán (8)

| Endpoint | Role | UC / FR / BR | Trạng thái · người làm | Ghi chú |
|---|---|---|---|---|
| `GET /admin/v1/summary` | admin | UC-ADM-07, Table 5 #27 | **console** (một phần) · Nghĩa (T97) | console có trụ/phiên/đối soát/bản tin; thiếu user, thẻ, ngoại lệ |
| `GET /admin/v1/sessions` | admin | UC-ADM-07, FR-19 | **console** · Trí | chỉ đọc, lọc `operator_id` |
| `GET /admin/v1/sessions/{id}` | admin | UC-ADM-07 | **console** · Trí | admin không giải quyết phiên của operator |
| `GET /admin/v1/reconciliation-records` | admin | UC-ADM-07, FR-16 | **console** · Trí | |
| `GET /admin/v1/ocpp-messages` | admin | UC-ADM-07, FE-08 | **console** · Nghĩa | |
| `GET /admin/v1/billing/top-ups?status=credited` | admin | UC-ADM-08, BR-P21 | planned · Khang | hình dạng phần tử: WF-02 D10 |
| `POST /admin/v1/billing/top-ups/{id}/refund` | admin | SD-2e, BR-P21 | planned · Khang | 202 `{refund_id, status: requested}` |
| `GET /admin/v1/billing/top-ups/late-payments` | admin | BR-P13 | planned · Khang | |
| `POST /admin/v1/billing/top-ups/{id}/late-refund` | admin | SD-2e, BR-P13 | planned · Khang | 202 |
| `GET /admin/v1/billing/e-invoices?status=needs_review` | admin | BR-P44 | planned · Khang | |
| `POST /admin/v1/billing/e-invoices/{id}/retry` | admin | SD-2c, BR-P44 | planned · Khang | `last_error_kind` ∈ `transient`, `data` (theo DB) |
| `GET /admin/v1/billing/refunds?status=failed` | admin | STM-10, WF-02 D1 | planned · Khang | gồm cả `account_closure` |
| `POST /admin/v1/billing/refunds/{id}/retry` | admin | STM-10 | planned · Khang | một lượt, không reset bộ đếm |

Không còn route Admin "hoàn tiền tài khoản đóng": hệ thống tự hoàn khi tài xế đóng (WF-02 D6, 09/11),
nên `credit-accounts/{id}/closure-refund` trong mock dashboard bỏ.

### 3.10 Số liệu

**73 endpoint** (bản 10/11: 76): 1 dưới `/api/auth/v1` (đăng nhập, công khai — route công khai duy
nhất), 39 dưới `/api/operator/v1`, 33 dưới `/api/admin/v1`.

| Nhóm | Tổng | đã chạy | console | service | in progress | planned |
|---|---|---|---|---|---|---|
| Đăng nhập & `/me` | 3 | 3 | 0 | 0 | 0 | 0 |
| Onboarding & sổ trụ | 10 | 0 | 1 | 2 | 0 | 7 |
| Giám sát & lệnh | 7 | 0 | 3 | 0 | 0 | 4 |
| Sự cố | 4 | 0 | 4 | 0 | 0 | 0 |
| Phiên, đối soát, T72 | 15 | 0 | 3 | 9 | 2 | 1 |
| Biểu giá & khuyến mãi | 6 | 0 | 0 | 0 | 0 | 6 |
| Doanh thu | 4 | 0 | 0 | 0 | 0 | 4 |
| Tài khoản & role | 8 | 0 | 0 | 0 | 0 | 8 |
| Thẻ RFID | 3 | 0 | 0 | 0 | 0 | 3 |
| Tổng quan nền tảng | 5 | 0 | 5 | 0 | 0 | 0 |
| Ngoại lệ thanh toán | 8 | 0 | 0 | 0 | 0 | 8 |
| **Cộng** | **73** | **3** | **16** | **11** | **2** | **41** |

## 4. Doanh thu theo BR-P46

BR-P46 (dẫn trong AD-1 bản vẽ lại sau Review 2; **chưa có trong `report3-srs.md` bản 24/10**, cần
thêm vào Table 13): báo cáo doanh thu = tổng phiên `csms_billed` đã `reconciled`, mỗi phiên tính một
lần, operator chỉ thấy trạm của mình, CSV khớp màn hình, không tính phí nền tảng hay chia doanh thu.

Hợp đồng biến luật thành truy vấn:

| Luật | Trong API |
|---|---|
| Chỉ `csms_billed` đã `reconciled` | `csms_billed_revenue_vnd` = Σ `credit_transactions.amount_vnd` (giá trị tuyệt đối) loại `session_debit` của phiên `payment_mode = csms_billed AND status = reconciled` |
| Mỗi phiên một lần | unique index `credit_transactions_one_debit_per_session` đã bảo đảm một `session_debit` mỗi phiên; báo cáo join theo phiên, không theo dòng sổ cái khác |
| Phiên unattributed là dòng riêng (UC-OPS-09) | `unattributed_session_count`, `unattributed_energy_wh` — **không có cột tiền** (không có ai để thu) |
| Phiên chưa đối soát xong | không vào doanh thu; đếm ở `pending_reconciliation.session_count` để người xem biết số còn có thể tăng |
| Operator chỉ thấy trạm của mình | `/operator/v1/revenue` lọc theo operator từ DB; `/admin/v1/revenue` toàn nền tảng, nhóm/lọc theo operator |
| CSV khớp màn hình | `revenue.csv` nhận đúng tham số và chạy đúng truy vấn của JSON; cùng thứ tự dòng, dòng cuối `TOTAL` bằng `totals` |
| Không phí, không chia | không có trường `platform_fee`, `owner_share` (K1 đóng: D6 09/11 — không phí, không chia) |
| Kỳ báo cáo (K3, Trí chốt 12/11) | phiên `reconciled` vào kỳ theo **đúng mốc giờ quyết toán đã dùng để tính giá** — giờ trụ (`cp_stopped_at`) khi đồng hồ trụ đã được kiểm, hoặc giờ CSMS (`received_stopped_at`) khi rơi về; cách lưu mốc này chờ #120 (T101, Sơn) chốt, trước đó dùng `COALESCE(cp_stopped_at, received_stopped_at)`. Phiên `closed` / `review` (đếm ở unattributed / `pending_reconciliation`) vào kỳ theo `received_stopped_at`. Chia ngày theo UTC+7 (Asia/Ho_Chi_Minh, `[from 00:00, to + 1 ngày 00:00)` giờ VN); kỳ ≤ 366 ngày |
| Kỳ cũ có thể đổi | phiên đối soát muộn rơi vào kỳ của mốc giờ sạc, không vào kỳ lúc đối soát → báo cáo tháng trước có thể tăng sau khi đã xem; JSON có `generated_at`, màn hình và CSV ghi "tính đến lúc …" |

Tình huống kiểm: tháng 11 operator A có 40 phiên app, 3 phiên thẻ online, 2 phiên thẻ lạ. 1 phiên app
vẫn ở `review`. Báo cáo: `csms_billed_session_count = 42`, doanh thu = Σ 42 khoản trừ,
`unattributed_session_count = 2`, `pending_reconciliation.session_count = 1`. Operator resolve phiên
đó ngày 03/12 → báo cáo **tháng 11** xem lại có 43 phiên (phiên rơi vào ngày sạc, không vào tháng 12), CSV
đổi theo; màn hình ghi "tính đến lúc 03/12 09:15" để người xem biết vì sao số khác lần trước.

## 5. Ánh xạ từ console hiện tại

### 5.1 Route console → endpoint hợp đồng

| Console (`apps/csms/src/console/console.router.ts`) | Hàm | Thành | Phải thêm |
|---|---|---|---|
| `GET /` (trang HTML), `GET /health` | `CONSOLE_PAGE_HTML`, `health` | giữ nguyên, ngoài hợp đồng | — |
| `GET /api/admin/stations` | `ConsoleQueries.stations` | `GET /operator/v1/charge-points` và `GET /admin/v1/charge-points` | lọc operator, id/site/display_code, súng có `connector_id`, phân trang |
| `GET /api/admin/summary` | `ConsoleQueries.summary` | `GET /admin/v1/summary` (một phần) | user, thẻ, ngoại lệ; operator có `summary` riêng mới |
| `GET /api/admin/sessions?limit` | `ConsoleQueries.sessions` | `GET /operator/v1/sessions`, `GET /admin/v1/sessions` | lọc operator, `queue`, page/page_size thay `limit` |
| `GET /api/admin/sessions/{id}` | `ConsoleQueries.session` | `GET /operator/v1/sessions/{id}`, `GET /admin/v1/sessions/{id}` | 404 cho phiên của operator khác |
| `GET /api/admin/reconciliation?limit` | `ConsoleQueries.reconciliation` | `GET /{operator,admin}/v1/reconciliation-records` | lọc operator / phiên / `kind` |
| `GET /api/admin/messages?limit&after` | `ConsoleQueries.messages` | `GET /admin/v1/ocpp-messages`, `GET /operator/v1/ocpp-messages` | lọc trụ và operator; `station` → `charge_point_serial` |
| `POST /api/admin/sessions/{id}/remote-stop` | `ConsoleCommands.remoteStop` | `POST /operator/v1/charge-points/{id}/commands` `{action: remote_stop, session_id}` | 202 thay vì chờ 15 s, ghi `remote_commands`, Idempotency-Key |
| `GET /api/admin/faults?status&limit` | `ConsoleCommands.faults` | `GET /operator/v1/faults` | lọc operator, page/page_size |
| `POST /api/admin/faults/{id}/acknowledge` | `acknowledgeFault` | `POST /operator/v1/faults/{id}/acknowledge` | `acknowledged_by` = người gọi |
| `POST /api/admin/faults/{id}/reset?type&force` | `resetFault` | `POST /operator/v1/faults/{id}/reset` | `type`/`force` vào body, `requested_by`, Idempotency-Key |
| `POST /api/admin/faults/{id}/close` | `closeFault` | `POST /operator/v1/faults/{id}/close` | người gọi |
| `POST /api/admin/stations/{serial}/disconnect` | `ConsoleCommands.disconnect` | **không chuyển** — công cụ mô phỏng sự cố cho demo/thí nghiệm, chỉ ở console loopback | — |

Đổi kiểu chung khi chuyển: console trả id dạng **số** (`id: 12`) và dùng `station`/`serial` làm khoá
trụ; hợp đồng trả id **chuỗi** và `charge_point_id` + `serial_number`. Đổi ở tầng route (mapper), không
đổi service.

### 5.2 Mock dashboard (`wp4/fe-01-dashboard-shell`, `src/core/api/api.ts`) → hợp đồng

| Mock | Hợp đồng |
|---|---|
| `POST /api/v1/auth/login` | `POST /api/auth/v1/login` — một endpoint cho hai form đăng nhập (Table 5 #16, #26), mỗi form tự từ chối vai trò kia (ADR-0018; đã nối ở FE-01b #119) |
| `/api/v1/operator/*` | `/api/operator/v1/*` |
| `/pillars`, `/pillars/{id}` | `/charge-points`, `/charge-points/{id}` (T90 đổi tên) |
| `POST /pillars/{id}/commands` `{action: Reset\|UnlockConnector\|RemoteStopTransaction}` | `POST /charge-points/{id}/commands` `{action: reset\|remote_stop\|remote_start}`; UnlockConnector chưa có (N2) |
| `POST /faults/{id}/reset?type=` | body `{type, force}` |
| `GET /sessions?queue=`, `POST /sessions/{id}/resolve {note}` | giữ đường dẫn; body thêm `resolution` |
| `/charge-intents/{id}/{begin-recovery\|approve-late-start\|restore-connector}` | giữ; thêm `complete-recovery`, `retry-recovery`, `GET …/recovery` |
| `GET/PUT /tariffs {periods}` | giữ đường dẫn; body `{effective_from, periods}`, band theo enum DB (mục 6 #3) |
| `GET /analytics/revenue` → `PillarRevenue[]` | `GET /revenue` → `RevenueReport`; `utilisationPercent` không thuộc doanh thu, lấy từ `/charge-points/{id}/metrics` |
| `GET /tickets` | ngoài v0.1 (UC-OPS-08 là Should) |
| `/api/admin/devices`, `/cards`, `/free-vend-tags` | `/api/admin/v1/charge-points`, `/rfid-cards`, `PUT /charge-points/{id}/free-vend-tag` |
| `PATCH /api/admin/users/{id} {role}` | `PUT /api/admin/v1/users/{id}/role` |
| `/api/admin/system-health`, `/policy-templates` | ngoài v0.1 (UC-ADM-07 phần health, UC-ADM-06 là Should); dùng `summary` + `ocpp-messages` |
| `/api/admin/billing/*` | `/api/admin/v1/billing/*` (WF-02 D8 ghi `/api/admin/billing/…` — câu hỏi K4) |
| camelCase, `id: number`, `role: 'operator'` | snake_case, `id: string`, `role: 'operator_staff'` |

## 6. Chỗ SRS mơ hồ và lựa chọn của hợp đồng

| # | Mơ hồ | Chọn | Vì sao |
|---|---|---|---|
| 1 | Doanh thu: UC-OPS-09 trong SRS 24/10 là "Revenue Analytics" (Should); bản vẽ lại sau Review 2 (T91) đổi thành "View Revenue Share" và thêm UC-ADM-09 "Configure Platform Fee Rate", UC-ADM-10 "View Platform Revenue", màn hình ghi "charged · platform fee · own share". BR-P46 lại nói không tính phí/chia | Theo BR-P46: không có phí, không chia; UC-ADM-09 không có endpoint | K1 **đóng** (D6 09/11: không phí, không chia); bản vẽ Revenue Share / Platform Fee cần sửa theo (A5) |
| 2 | UC-ADM-10 và BR-P46 chưa có trong `report3-srs.md` | Dẫn từ `diagrams/report3/use-case/admin/ucd_admin.py` và `activity/AD-1` | cần cập nhật SRS bản Drive + bản local |
| 3 | Biểu giá: SRS UC-OPS-06 ghi 4 khung Sharp / Peak / Shoulder / Off-peak "for their sites"; DB `tariff_band` có 3 giá trị (`off_peak`, `normal`, `peak`) và `tariff_periods` theo **operator**, không theo site | Theo DB: 3 band, biểu giá theo operator | đổi enum là migration — câu hỏi K2/N4; mock dashboard đang dùng 4 tên SRS |
| 4 | UC-ADM-04 còn ghi loại thẻ thứ hai và Table 5 #30 cũng vậy | Chỉ `online`, `free_vend` | theo T110 |
| 5 | Role: tác vụ nói "operator", DB là `operator_staff` + `staff_role` (`manager`, `technician`); SRS không phân quyền theo `staff_role` | JWT `role = operator_staff`; hai `staff_role` cùng quyền trong v0.1 | không bịa phân quyền SRS không có (N5) |
| 6 | UC-ADM-01 "create … driver accounts" nhưng tài xế phải tự cho consent (BR-P05) | Admin chỉ tạo `operator_staff`/`admin`; xem, sửa, khoá được mọi role | consent không thể do người khác cho |
| 7 | UC-OPS-04 "remotely starts" — không nói idTag nào, ai trả tiền | `remote_start` bắt buộc `id_tag`, đi Authorize + phân loại như mọi phiên (BR-P06, BR-P08) | không đẻ ra phương thức thanh toán mới (T1) |
| 8 | FE-05 dashboard có "mở khoá súng" (UnlockConnector); SRS Table 7 #2 không có | Không đưa vào v0.1 | không có trong tập bản tin FR-16 (N2) |
| 9 | Ai tạo operator và site — SRS không có UC | Chỉ `GET /admin/v1/operators`, `GET /operator/v1/sites`; tạo bằng seed | A3 |
| 10 | UC-ADM-07 "Monitor Platform Health" (SRS) đổi thành "Monitor Charge Point Network" trong bản vẽ mới | Admin có `charge-points`, `sessions`, `reconciliation-records`, `ocpp-messages` chỉ đọc; không có `system-health` | Should; phần health là hạ tầng |
| 11 | Doanh thu tính vào ngày nào: lúc dừng hay lúc reconciled; và theo đồng hồ nào | Phiên `reconciled`: mốc giờ quyết toán đã dùng để tính giá (giờ trụ đã kiểm, hoặc giờ CSMS khi rơi về — chờ #120), dự phòng `COALESCE(cp_stopped_at, received_stopped_at)`; phiên `closed` / `review`: `received_stopped_at`; ngày UTC+7 | K3 Trí chốt 12/11: doanh thu và tiền đã trừ dựa trên cùng một mốc giờ, nên tổng theo ngày khớp với khung giá đã áp; phiên đối soát muộn vẫn rơi đúng ngày sạc, kỳ cũ có thể đổi → "tính đến lúc …" (§4) |
| 12 | BM04 (F-09, F-10, F-13, F-14, F-16, NFR-05) không có trong repo | Dùng nguyên văn F-13 và NFR-05 trong yêu cầu T98; FR theo phiếu v1.3 | Trí bổ sung file BM04 nếu số F lệch FR |

## 7. Câu hỏi mở

**Nghĩa (dashboard, T97)**

| # | Câu hỏi | Đề xuất |
|---|---|---|
| N1 | Chấp nhận snake_case + id chuỗi + base `/api/operator/v1` thay cho camelCase/id số/`/api/v1/operator` của mock? | Có — sinh client từ OpenAPI (WP2 §4) để không sửa tay |
| N2 | UnlockConnector có bắt buộc cho demo không? Nếu có cần thêm vào SRS Table 7 #2 trước | Bỏ khỏi v0.1 |
| N3 | Operator có cần trình xem bản tin OCPP (FE-08)? Table 6 không có màn hình này cho Operator | Giữ endpoint lọc theo operator, thêm dòng vào Table 5/6 |
| N4 | Màn hình biểu giá theo 3 band DB hay 4 khung SRS? | 3 band đến khi có migration |
| N5 | `technician` có bị cấm sửa biểu giá/khuyến mãi, xem doanh thu không? | Không cấm trong v0.1; nếu cần thì SRS ghi trước |
| N6 | Chu kỳ poll 5 s có đủ cho Review 3 hay cần SSE ngay? | Poll; SSE sau |
| N7 | `summary` operator có đủ trường như `OperatorSummary` của mock (thêm `uncertain_starts`)? | Theo schema `OperatorSummary` trong YAML |
| N8 | FE-01d qua Caddy cùng origin: trình duyệt gửi `Origin: https://$DOMAIN` với `POST /api/auth/v1/login` → hiện 403 `forbidden_origin`. Thêm danh sách origin từ biến môi trường? (§2.7 #3) | Có, biến môi trường, không `*` |
| N9 | Bộ giới hạn đăng nhập sau Caddy: đọc giá trị cuối của `X-Forwarded-For` theo cờ nào — dùng lại `OCPP_TRUST_PROXY` hay biến riêng? Driver API cùng tình trạng (§2.7 #2) | Biến riêng cho cổng 3000, cùng cách lấy giá trị cuối như `ocpp-server.ts` |
| N10 | Khi có route danh sách: bỏ luật "có query → 400" và kiểm tham số **sau** guard (để request không token luôn 401)? | Có |
| N11 | `detail` của lỗi xác thực hiện bằng mã lỗi; dashboard tự dịch mã hay CSMS trả câu tiếng Việt như các bề mặt khác? | CSMS trả câu tiếng Việt, mã giữ nguyên |
| N12 | Ai thêm `DASHBOARD_JWT_*` vào `infra/staging/docker-compose.yml`, `init-env.sh` và `lib.sh check_env` trước FE-01d (§2.7 #4)? | FE-01d, theo mẫu `DRIVER_API_JWT_*` |
| N13 | ADR-0018 còn trạng thái "Đề xuất" dù code đã merge — chuyển "Chấp nhận"? | Có |

**Khang (doanh thu T108, ngoại lệ thanh toán)**

| # | Câu hỏi | Đề xuất |
|---|---|---|
| ~~K1~~ | ~~Chốt BR-P46 "không phí/không chia" với bản vẽ Revenue Share + UC-ADM-09~~ | **Đóng** — D6 09/11: không phí, không chia. Còn việc Ân sửa bản vẽ (A5) |
| K2 | Doanh thu có trừ `adjustment` gắn phiên không? Nguồn: SRS Table 7 #11 — "amendments create compensating entries, never edits" (bút toán bù khi sửa phiên; BR-P20 chỉ là số dư âm, không phải nguồn của luật này) | Có, nếu `adjustment` mang `session_id`; xác nhận cách ghi |
| ~~K3~~ | ~~Xếp kỳ theo `ended_at` hay ngày reconciled?~~ | **Đã chốt** (Trí 12/11): `reconciled` theo đúng mốc giờ quyết toán dùng để tính giá (giờ trụ đã kiểm / giờ CSMS khi rơi về — chờ #120 chốt cách lưu), dự phòng `COALESCE(cp_stopped_at, received_stopped_at)`; `closed` / `review` theo `received_stopped_at`; chia kỳ UTC+7; kỳ cũ có thể đổi → "tính đến lúc …". Chi tiết §4 |
| K4 | Đường dẫn admin billing: `/api/admin/billing/…` (WF-02 D8) hay `/api/admin/v1/billing/…` (hợp đồng này)? | `/api/admin/v1/…` để một bề mặt có một tiền tố và một cơ chế JWT |
| K5 | Phiên unattributed có cần giá ước tính (Table 7 #11 "reports separately") không? | Không có tiền trong v0.1; chỉ phiên + Wh |
| K6 | Khuyến mãi áp vào giá lúc quyết toán chưa? Nếu chưa, `promotions` chỉ là CRUD | Ghi rõ trong T108 |

**Ân (onboarding T119, sổ trụ, thẻ)**

| # | Câu hỏi | Đề xuất |
|---|---|---|
| A1 | Mất mật khẩu trụ: cần `POST /operator/v1/charge-points/{id}/credential` (cấp lại, ADR-0011 "chưa có")? | Thêm ở v0.2, đổi băm + đóng socket cũ |
| A2 | `disable`/`enable` có gửi `ChangeAvailability` xuống trụ không, hay chỉ chặn ở CSMS? | Chỉ CSMS trong v0.1; BR-P07 cho phần cấu hình |
| A3 | Ai tạo operator, site? | Seed đến khi có UC |
| A4 | Free-vend tag trùng `card_identifier` thẻ đã đăng ký → 409? | Có (`tag_conflicts_with_card`) |
| A5 | Sửa bản vẽ Revenue Share / Platform Fee theo K1 | — |

**Trí (tự giữ)**: T1 `remote_start` của operator có cần thật cho Review 3 không; ~~T2 xác thực nhân viên
dùng chung bộ đếm thử sai với tài xế hay riêng~~ — đã trả lời bằng code FE-01a: **riêng** (một
`ChargePointLoginLimiter` cho dashboard, cùng số 5 / 20 / 60 s / 15 phút); T3 cập nhật SRS (UC-ADM-09/10, BR-P46, T110).

## 8. Kiểm chứng

```bash
npm ci --ignore-scripts
# parse YAML (js-yaml có sẵn trong node_modules)
node -e "require('js-yaml').load(require('fs').readFileSync('docs/api/operator-admin-api.openapi.yaml','utf8'))"
npx prettier --check docs/api/operator-admin-api.openapi.yaml docs/api/OPERATOR-ADMIN-API-HOP-DONG.md
```

Ngoài parse, một script tạm (không commit) đã kiểm: mọi `$ref` nội bộ giải được, `operationId` duy
nhất, path param khớp template, mọi operation có `x-roles`/`x-status`/`x-owner`/`x-refs`, mọi route
có bearer khai báo 401 và 403, route công khai có `security: []`, role khớp bề mặt, và không còn tên
payment_mode / loại thẻ mà T110 bỏ; từ 12/11 kiểm thêm `x-status` thuộc tập 5 giá trị (có
`implemented`), không còn component thừa (đã bỏ `RefreshRequest`, `AccessToken`, `LoginTokens`,
`StaffProfile`, `InvalidRefreshToken`) và đếm 73 operation (1 auth / 39 operator / 33 admin).
Ma trận ở §9 sinh từ `x-roles` bằng chính script đó. `prettier --check` qua vì `.prettierignore` bỏ
qua `docs/` và `**/*.md` (bảng viết tay), không phải vì file đã được định dạng. **Chưa chạy
Redocly** vì chưa có trong dependency (không tự tải công cụ chưa được duyệt — như Driver API §10).

## 9. Ma trận role × endpoint (NFR-05)

Sinh từ `x-roles` trong YAML. ✓ = được gọi · 403 = token hợp lệ nhưng sai role (F-13) · 401 = không
token hoặc token hỏng / hết hạn. Route công khai duy nhất là `POST /api/auth/v1/login`: ai cũng gọi
được, chỉ nhân viên hoặc Admin đăng nhập thành công (tài xế nhận 401 `invalid_credentials`). Test tự
động của NFR-05 nên lặp bảng này: với mỗi endpoint × mỗi role, gọi bằng token của role đó và so mã
trạng thái (2xx/4xx nghiệp vụ khác với 401/403). Ba điều kiện của hành vi hiện tại (§2.2a):

- gọi **không kèm query string** — hiện có query thì nhận 400 trước guard;
- cột `driver` = 403 chỉ khi CSMS có cấu hình `DRIVER_API_JWT_*` (guard cần khoá đó để nhận ra token
  tài xế), không thì 401;
- route chưa viết vẫn ra đúng 401 / 403 của bảng (guard chạy trước khi khớp route); token đúng vai trò
  nhận 404 cho tới khi route có. `test/fe01-dashboard-auth.integration.test.ts` (TC-F13-01) đã kiểm
  đúng điều này cho `/me` và một đường dẫn chưa có (`/x`) ở cả hai bề mặt.

| # | Endpoint | Không token | driver | operator_staff | admin | Trạng thái |
|---|---|---|---|---|---|---|
| 1 | `POST /api/auth/v1/login` | công khai | — | — | — | implemented |
| 2 | `GET /api/operator/v1/me` | 401 | 403 | ✓ | 403 | implemented |
| 3 | `GET /api/admin/v1/me` | 401 | 403 | 403 | ✓ | implemented |
| 4 | `GET /api/operator/v1/sites` | 401 | 403 | ✓ | 403 | planned |
| 5 | `GET /api/operator/v1/charge-points` | 401 | 403 | ✓ | 403 | console |
| 6 | `POST /api/operator/v1/charge-points` | 401 | 403 | ✓ | 403 | service |
| 7 | `GET /api/operator/v1/charge-points/{chargePointId}` | 401 | 403 | ✓ | 403 | planned |
| 8 | `GET /api/operator/v1/charge-points/{chargePointId}/metrics` | 401 | 403 | ✓ | 403 | planned |
| 9 | `POST /api/operator/v1/charge-points/{chargePointId}/disable` | 401 | 403 | ✓ | 403 | planned |
| 10 | `POST /api/operator/v1/charge-points/{chargePointId}/enable` | 401 | 403 | ✓ | 403 | planned |
| 11 | `GET /api/admin/v1/charge-points` | 401 | 403 | 403 | ✓ | console |
| 12 | `POST /api/admin/v1/charge-points` | 401 | 403 | 403 | ✓ | service |
| 13 | `GET /api/admin/v1/charge-points/{chargePointId}` | 401 | 403 | 403 | ✓ | planned |
| 14 | `PATCH /api/admin/v1/charge-points/{chargePointId}` | 401 | 403 | 403 | ✓ | planned |
| 15 | `PUT /api/admin/v1/charge-points/{chargePointId}/free-vend-tag` | 401 | 403 | 403 | ✓ | planned |
| 16 | `POST /api/admin/v1/charge-points/{chargePointId}/decommission` | 401 | 403 | 403 | ✓ | planned |
| 17 | `GET /api/operator/v1/summary` | 401 | 403 | ✓ | 403 | planned |
| 18 | `POST /api/operator/v1/charge-points/{chargePointId}/commands` | 401 | 403 | ✓ | 403 | console |
| 19 | `GET /api/operator/v1/commands/{commandId}` | 401 | 403 | ✓ | 403 | planned |
| 20 | `GET /api/operator/v1/ocpp-messages` | 401 | 403 | ✓ | 403 | console |
| 21 | `GET /api/operator/v1/faults` | 401 | 403 | ✓ | 403 | console |
| 22 | `POST /api/operator/v1/faults/{faultId}/acknowledge` | 401 | 403 | ✓ | 403 | console |
| 23 | `POST /api/operator/v1/faults/{faultId}/reset` | 401 | 403 | ✓ | 403 | console |
| 24 | `POST /api/operator/v1/faults/{faultId}/close` | 401 | 403 | ✓ | 403 | console |
| 25 | `GET /api/operator/v1/sessions` | 401 | 403 | ✓ | 403 | console |
| 26 | `GET /api/operator/v1/sessions/{sessionId}` | 401 | 403 | ✓ | 403 | console |
| 27 | `POST /api/operator/v1/sessions/{sessionId}/resolve` | 401 | 403 | ✓ | 403 | service |
| 28 | `POST /api/operator/v1/sessions/{sessionId}/assign` | 401 | 403 | ✓ | 403 | in_progress |
| 29 | `POST /api/operator/v1/sessions/{sessionId}/close` | 401 | 403 | ✓ | 403 | in_progress |
| 30 | `GET /api/operator/v1/reconciliation-records` | 401 | 403 | ✓ | 403 | console |
| 31 | `GET /api/operator/v1/charge-intents` | 401 | 403 | ✓ | 403 | planned |
| 32 | `GET /api/operator/v1/charge-intents/{intentId}/recovery` | 401 | 403 | ✓ | 403 | service |
| 33 | `POST /api/operator/v1/charge-intents/{intentId}/begin-recovery` | 401 | 403 | ✓ | 403 | service |
| 34 | `POST /api/operator/v1/charge-intents/{intentId}/complete-recovery` | 401 | 403 | ✓ | 403 | service |
| 35 | `POST /api/operator/v1/charge-intents/{intentId}/restore-connector` | 401 | 403 | ✓ | 403 | service |
| 36 | `POST /api/operator/v1/charge-intents/{intentId}/retry-recovery` | 401 | 403 | ✓ | 403 | service |
| 37 | `POST /api/operator/v1/charge-intents/{intentId}/approve-late-start` | 401 | 403 | ✓ | 403 | service |
| 38 | `POST /api/operator/v1/sessions/{sessionId}/recover-stop` | 401 | 403 | ✓ | 403 | service |
| 39 | `POST /api/operator/v1/sessions/{sessionId}/tariff-boundary` | 401 | 403 | ✓ | 403 | service |
| 40 | `GET /api/operator/v1/tariffs` | 401 | 403 | ✓ | 403 | planned |
| 41 | `PUT /api/operator/v1/tariffs` | 401 | 403 | ✓ | 403 | planned |
| 42 | `GET /api/operator/v1/promotions` | 401 | 403 | ✓ | 403 | planned |
| 43 | `POST /api/operator/v1/promotions` | 401 | 403 | ✓ | 403 | planned |
| 44 | `PATCH /api/operator/v1/promotions/{promotionId}` | 401 | 403 | ✓ | 403 | planned |
| 45 | `POST /api/operator/v1/promotions/{promotionId}/deactivate` | 401 | 403 | ✓ | 403 | planned |
| 46 | `GET /api/operator/v1/revenue` | 401 | 403 | ✓ | 403 | planned |
| 47 | `GET /api/operator/v1/revenue.csv` | 401 | 403 | ✓ | 403 | planned |
| 48 | `GET /api/admin/v1/revenue` | 401 | 403 | 403 | ✓ | planned |
| 49 | `GET /api/admin/v1/revenue.csv` | 401 | 403 | 403 | ✓ | planned |
| 50 | `GET /api/admin/v1/users` | 401 | 403 | 403 | ✓ | planned |
| 51 | `POST /api/admin/v1/users` | 401 | 403 | 403 | ✓ | planned |
| 52 | `GET /api/admin/v1/users/{userId}` | 401 | 403 | 403 | ✓ | planned |
| 53 | `PATCH /api/admin/v1/users/{userId}` | 401 | 403 | 403 | ✓ | planned |
| 54 | `PUT /api/admin/v1/users/{userId}/role` | 401 | 403 | 403 | ✓ | planned |
| 55 | `POST /api/admin/v1/users/{userId}/lock` | 401 | 403 | 403 | ✓ | planned |
| 56 | `POST /api/admin/v1/users/{userId}/unlock` | 401 | 403 | 403 | ✓ | planned |
| 57 | `GET /api/admin/v1/operators` | 401 | 403 | 403 | ✓ | planned |
| 58 | `GET /api/admin/v1/rfid-cards` | 401 | 403 | 403 | ✓ | planned |
| 59 | `POST /api/admin/v1/rfid-cards` | 401 | 403 | 403 | ✓ | planned |
| 60 | `PATCH /api/admin/v1/rfid-cards/{cardId}` | 401 | 403 | 403 | ✓ | planned |
| 61 | `GET /api/admin/v1/summary` | 401 | 403 | 403 | ✓ | console |
| 62 | `GET /api/admin/v1/sessions` | 401 | 403 | 403 | ✓ | console |
| 63 | `GET /api/admin/v1/sessions/{sessionId}` | 401 | 403 | 403 | ✓ | console |
| 64 | `GET /api/admin/v1/reconciliation-records` | 401 | 403 | 403 | ✓ | console |
| 65 | `GET /api/admin/v1/ocpp-messages` | 401 | 403 | 403 | ✓ | console |
| 66 | `GET /api/admin/v1/billing/top-ups` | 401 | 403 | 403 | ✓ | planned |
| 67 | `POST /api/admin/v1/billing/top-ups/{topUpId}/refund` | 401 | 403 | 403 | ✓ | planned |
| 68 | `GET /api/admin/v1/billing/top-ups/late-payments` | 401 | 403 | 403 | ✓ | planned |
| 69 | `POST /api/admin/v1/billing/top-ups/{topUpId}/late-refund` | 401 | 403 | 403 | ✓ | planned |
| 70 | `GET /api/admin/v1/billing/e-invoices` | 401 | 403 | 403 | ✓ | planned |
| 71 | `POST /api/admin/v1/billing/e-invoices/{invoiceId}/retry` | 401 | 403 | 403 | ✓ | planned |
| 72 | `GET /api/admin/v1/billing/refunds` | 401 | 403 | 403 | ✓ | planned |
| 73 | `POST /api/admin/v1/billing/refunds/{refundId}/retry` | 401 | 403 | 403 | ✓ | planned |
