# Nhật ký migration 0033 — token_version cho đăng xuất tài xế (BE-49)

Ngày 27/11/2026. File `0033_driver-token-version.sql`, sau 0031. Số 0032 đã được PR hoàn tiền thủ công
(#257, Khang) dùng; hai file không đụng cùng bảng nên áp theo thứ tự nào cũng được
(`scripts/migrate.mjs` áp mọi file chưa có trong `_migrations`, theo tên).

Thêm một cột `users.token_version integer NOT NULL DEFAULT 0` và CHECK `users_token_version_check`
(`>= 0`). DEFAULT hằng số nên PostgreSQL không viết lại bảng; mọi dòng cũ nhận 0. Drizzle:
`src/db/schema/users.ts` (`tokenVersion` + check).

Dùng để làm gì: access và refresh token của Driver API mang claim `ver`. `authenticateDriver` và
`DriverAccounts.refresh` so claim với cột; `POST /auth/logout` tăng cột → mọi token cũ của tài xế bị
từ chối. Token phát trước bản này không có `ver`, được coi là 0, nên áp migration + deploy **không**
đăng xuất ai.

Không đổi dữ liệu nào khác. Operator / admin cũng nằm ở `users` nhưng đăng nhập dashboard không đọc
cột này (luồng `/api/auth/v1`, FE-01), nên không bị ảnh hưởng.

Kiểm: `test/driver-auth.integration.test.ts` (khối BE-49) chạy trên DB test mới áp đủ chuỗi migration:
cột bắt đầu 0, CHECK từ chối số âm, đăng xuất tăng đúng 1 kể cả khi gửi lại, token cũ không `ver`
còn dùng được tới lần đăng xuất đầu. `erd-alignment*.integration.test.ts` và
`migrate-script.integration.test.ts` vẫn đạt.

Rollback: cột chỉ được đọc bởi code BE-49. Lùi code về bản trước là đủ (code cũ bỏ qua cột và claim
`ver`); không cần xoá cột.
