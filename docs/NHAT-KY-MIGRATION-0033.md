# Nhật ký migration 0033 — đăng xuất một thiết bị / mọi thiết bị cho tài xế (BE-49)

Ngày 27–28/11/2026. File `0033_driver-token-version.sql`, sau 0031. Số 0032 đã được PR hoàn tiền thủ công
(#257, Khang) dùng; hai file không đụng cùng bảng nên áp theo thứ tự nào cũng được:
`scripts/migrate.mjs` áp **mọi** file chưa có trong `_migrations`, theo tên, nên 0032 đến sau 0033 vẫn
được áp.

Thêm:

- Cột `users.token_version integer NOT NULL DEFAULT 0` + CHECK `users_token_version_check` (`>= 0`).
  DEFAULT hằng số nên PostgreSQL không viết lại bảng; mọi dòng cũ nhận 0.
- Bảng `driver_refresh_revocations(jti uuid PK, user_id → drivers, revoked_at, expires_at)` + index
  `driver_refresh_revocations_user_id_idx` cho FK. Chỉ ghi thêm.

Drizzle: `src/db/schema/users.ts` (`tokenVersion` + check, `driverRefreshRevocations`). Thiết kế vật lý:
`docs/THIET-KE-CSDL-VAT-LY.md` mục 3.1 và bảng kỹ thuật.

Dùng để làm gì (UC-ACC-05):

- **Đăng xuất thiết bị này** — `POST /auth/logout {refresh_token}`: ghi jti của refresh token vào bảng.
  Refresh token đó và mọi access token mang claim `sid` = jti đó bị từ chối; thiết bị khác không ảnh
  hưởng.
- **Đăng xuất mọi thiết bị** — `POST /me/logout-all` (Cài đặt → Bảo mật, cần access token): tăng
  `token_version`; mọi token mang claim `ver` cũ bị từ chối.

`authenticateDriver` và `DriverAccounts.refresh` kiểm cả hai trong cùng câu truy vấn đã có (đọc `users`
mỗi request). Token phát trước bản này không có `ver` (coi là 0, bằng DEFAULT) và không có `sid`, nên
áp migration + deploy **không** đăng xuất ai.

Không đổi dữ liệu nào khác. Operator / admin cũng nằm ở `users` nhưng đăng nhập dashboard (`/api/auth/v1`,
FE-01) không đọc cột hay bảng này.

Dọn dẹp: dòng có `expires_at` đã qua là vô hại (refresh token tự hết hạn sau 30 ngày). Chưa có job dọn;
bảng lớn lên theo số lần đăng xuất, đủ nhỏ cho quy mô đồ án.

Kiểm: `test/driver-auth.integration.test.ts` (khối BE-49) trên DB test mới áp đủ chuỗi migration: đăng
xuất máy A không ảnh hưởng máy B; access token đã làm mới trên A cũng chết; gửi lại không thêm dòng;
đăng xuất mọi thiết bị làm chết cả máy gọi; token cũ không `ver`/`sid`; refresh token thiếu jti bị từ
chối; CHECK và PK. `erd-alignment*.integration.test.ts`, `migrate-script.integration.test.ts` vẫn đạt.

Rollback: cột và bảng chỉ được code BE-49 đọc/ghi. Lùi code về bản trước là đủ (code cũ bỏ qua claim
`ver`/`sid`); không cần xoá cột hay bảng.
