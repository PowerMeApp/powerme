# ADR-0018 — Đăng nhập dashboard (Operator và Admin) bằng JWT, mật khẩu băm scrypt

| | |
|---|---|
| Trạng thái | Đề xuất |
| Ngày | 11/11/2026 |
| Người quyết định | WP4 (Trần Trọng Nghĩa) |
| Liên quan | FE-01a, UC-ACC-04/05, F-13, NFR-SEC-01, BR-P16, ADR-0011, ADR-0017; Report 4 thành phần 02 `operator-api`, 03 `users` |

## Bối cảnh

Operator Dashboard và Admin Console phải chạy trên dữ liệu thật của CSMS, và mỗi nhân viên vận hành chỉ thấy dữ liệu của Operator mình (BR-P16). Report 4 đặt phần này vào hai thành phần còn «planned»: `users` cung cấp **IAuth** (tài khoản, vai trò, JWT, **RolesGuard**) và `operator-api` cung cấp REST cho cả dashboard lẫn admin console. Console dev `/api/admin/*` hiện không đăng nhập nên chỉ nghe trên loopback.

SRS quy định: hai màn đăng nhập (16 Operator, 26 Admin), mỗi màn chỉ dẫn tới khu vực của vai trò mình; tài khoản bị khoá không đăng nhập được (UC-ACC-04, F-13); 100 % endpoint kiểm vai trò, có test tự động theo từng vai trò (NFR-SEC-01). SRS không quy định thời hạn token, refresh hay đường dẫn.

CSDL đã có `users.password_hash`, `admins`, `operator_staff(user_id, operator_id, staff_role)`. Driver API (ADR-0017, BE-21) đã có JWT HS256 bằng `jose` 6.2.15 và mật khẩu scrypt.

## Quyết định

Chúng ta sẽ:

1. Thêm **một** `POST /api/auth/v1/login` (email + mật khẩu) cho cả nhân viên vận hành và Admin, cùng listener với console và Driver API (cổng 3000). Token trả về mang `role`; màn đăng nhập của mỗi khu vực từ chối vai trò còn lại.
2. Băm mật khẩu bằng **scrypt**, dùng lại `stations/charge-point-credential.ts` (định dạng `scrypt$N$r$p$salt$hash`, ADR-0011).
3. Trả **JWT HS256** (`jose` 6.2.15, `typ: JWT`): `sub` = user id, `role` (`operator_staff` | `admin`), `iss`, `aud`, `iat`, `exp` = 8 giờ (một ca), `jti`; nhân viên có thêm `operator_id`, `staff_role`. Không có refresh token.
4. Khoá ký **riêng**: `DASHBOARD_JWT_SECRET_BASE64` (≥ 32 byte ngẫu nhiên), `DASHBOARD_JWT_ISSUER`, `DASHBOARD_JWT_AUDIENCE`. Thiếu cả ba → mọi route trả 503 `auth_unavailable`.
5. **RolesGuard** chạy trước khi khớp route trên mọi `/api/operator/v1/*` và `/api/admin/v1/*`:
   - thiếu, sai hoặc hết hạn token → **401**;
   - token hợp lệ nhưng sai vai trò → **403**, kể cả token tài xế (nhận ra bằng cách thử xác minh với khoá Driver API) — F-13;
   - mỗi request đọc lại DB: user còn, đúng vai trò, `active` (không thì 403 `account_locked`); nhân viên còn thuộc đúng Operator trong token (không thì 401, đăng nhập lại) và Operator `active` (không thì 403 `operator_inactive`); Admin còn dòng `admins`.
   Operator dùng để giới hạn dữ liệu lấy từ lần đọc DB này, **không bao giờ từ request**.
6. Đăng nhập sai email, sai mật khẩu, user là tài xế, hoặc thiếu dòng `operator_staff` / `admins` đều trả cùng 401 `invalid_credentials`, có băm giả để thời gian như nhau. Khoá tài khoản chỉ báo sau khi mật khẩu đúng. Thử sai: 5 lần / 60 s theo email + IP, 20 theo IP → 429, khoá 15 phút (cùng số với BR-P49 và BE-21).
7. `/api/admin/v1/*` được khớp **trước** `/api/admin/*` của console, nên không bao giờ lọt vào route không xác thực.
8. Dashboard giữ token trong `authSlice` (Redux Toolkit, `sessionStorage`); RTK Query thêm header Bearer; đăng xuất = xoá token.

Mã: `apps/csms/src/users/auth.ts` (IAuth), `users/roles-guard.ts` (RolesGuard), `operator-api/operator-api.http.ts` (IOperatorAPI).

## Hệ quả

**Được:**

- Giới hạn theo Operator kiểm chứng được, kể cả khi trình duyệt bị sửa (BR-P16).
- F-13 / NFR-SEC-01 thành luật có test: `test/fe01-dashboard-auth.integration.test.ts` (TC-F13-01..03).
- Khoá tài khoản hay Operator có hiệu lực ở request kế tiếp, không chờ token hết hạn.
- Không thêm phụ thuộc: `jose` đã ghim ở ADR-0017; một quy tắc băm mật khẩu cho toàn CSMS.

**Mất:**

- Mỗi request thêm một truy vấn DB.
- Không thu hồi được từng token; đăng xuất chỉ là xoá token ở trình duyệt (bù bằng mục 5).
- Bộ đếm thử sai nằm trong bộ nhớ một tiến trình (như ADR-0002); chuyển Redis khi chạy nhiều instance.
- Guard phải biết khoá Driver API để trả 403 thay vì 401 cho token tài xế.

## Các phương án đã cân nhắc và loại bỏ

| Phương án | Vì sao loại |
|---|---|
| Header dev `X-Operator-Id` | Giới hạn theo Operator không chứng minh được |
| Dùng chung khoá, issuer, audience với Driver API | Lộ một khoá là mở được cả hai bề mặt; khoá riêng vẫn trả được 403 cho token tài xế |
| Access 15 phút + refresh token | Thêm luồng làm mới cho dashboard; kiểm `active` mỗi request đã bù việc không thu hồi |
| Lấy `operatorId` chỉ từ token | Nhân viên chuyển Operator vẫn thấy dữ liệu cũ tới 8 giờ; so với DB không tốn thêm truy vấn |
| argon2 (`@node-rs/argon2`) | Phụ thuộc native; CSMS đã chọn scrypt (ADR-0011) |
| Session id lưu bảng | Cần migration; không cần khi đã kiểm DB mỗi request |
| Cookie httpOnly | Cần `credentials` trong CORS và chống CSRF trên server `http` thuần |
| `react-auth-kit` | Bản ổn định 3.x chỉ hỗ trợ React ≤ 18 |
