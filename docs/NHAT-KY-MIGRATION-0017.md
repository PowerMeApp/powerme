# Nhật ký migration 0017 — `0017_sdt-tai-xe-duy-nhat.sql`

**Ngày:** 12/11/2026 · **Task:** BE-30 (WP2) · **Người chịu trách nhiệm:** Ngô Văn Minh Trí
**File:** `apps/csms/drizzle/0017_sdt-tai-xe-duy-nhat.sql` (áp lên DB đã có 0000 → 0016; một transaction `BEGIN … COMMIT`)
**Nguồn:** BE-30 — tài xế đăng nhập bằng email **hoặc** số điện thoại + mật khẩu (mở rộng BE-21 / #102). App Flutter (Sơn) nối trên staging.

**Vì sao là 0017:** migration mới nhất trên `main` lúc làm là `0016_bo-the-wallet-station-wallet.sql` (T110, #110). Khang đang chuẩn bị một 0017 khác (billing Phần 6); PR nào merge sau phải đổi số (tên file, test `migration-0017`, nhật ký này).

## 1. Thay đổi

| # | Đối tượng | Thay đổi | Use case |
|---|---|---|---|
| 1 | `users.phone_number` (dữ liệu) | Số nhận ra được → E.164, `updated_at = now()`; số không nhận ra giữ nguyên | Tài xế demo `driver.demo@powerme.test` có `0900000001` (seed.sql cũ): sau 0017 là `+84900000001`, nên đăng ký mới với `0900000001` bị 409 `phone_taken` thay vì tạo tài khoản thứ hai cùng số |
| 2 | (kiểm tra) | Còn hai người cùng số sau chuẩn hoá → `RAISE EXCEPTION` liệt kê id từng nhóm, ROLLBACK cả file | Hai tài khoản cũ cùng `0901234567` và `+84901234567`: đăng nhập bằng số sẽ không biết vào tài khoản nào — người vận hành phải quyết, migration không tự chọn |
| 3 | index `users_phone_number_idx` | Bỏ | UNIQUE ở dòng 4 đã tạo btree trên đúng cột |
| 4 | `users_phone_number_key` | `UNIQUE (phone_number)` | Đăng nhập bằng số trỏ đúng một tài khoản; hai đăng ký song song cùng số → bên sau 409 `phone_taken` |
| 5 | COMMENT `users.phone_number` | E.164, UNIQUE, NULL = chưa có số | |

**Quy tắc chuẩn hoá** giống hệt `normalizePhoneNumber` (`apps/csms/src/driver/phone-number.ts`), viết lại bằng SQL trong hàm tạm `pg_temp.be30_normalize_phone` (chỉ sống trong phiên chạy migration, bị DROP cuối file — schema không thêm hàm nào). Test `migration-0017` chạy hàm SQL đó trên đúng bảng ca của unit test (`test/helpers/phone-cases.ts`, 34 ca) để hai bản không lệch nhau. Khác biệt duy nhất đã biết: `[[:space:]]` của PostgreSQL (locale C) chỉ là khoảng trắng ASCII, `\s` của JS gồm cả khoảng trắng Unicode — số cũ có NBSP sẽ thành "không nhận ra" (giữ nguyên), không sai dữ liệu.

**UNIQUE thường, không partial.** PostgreSQL mặc định `NULLS DISTINCT`: mọi tài khoản không có số cùng tồn tại được, y như partial index `WHERE phone_number IS NOT NULL`. Chọn CONSTRAINT vì: Drizzle khai được bằng `unique()` (schema TS khớp DB), `ON CONFLICT ON CONSTRAINT` dùng được, và lỗi 23505 mang `constraint = users_phone_number_key` để API trả đúng `phone_taken` khi hai đăng ký chạy song song.

**Không thêm CHECK định dạng:** dòng cũ không chuẩn hoá được vẫn phải hợp lệ; định dạng do Driver API giữ. Số như vậy không đăng nhập được (login chuẩn hoá đầu vào trước khi so) nhưng không mất.

**Không xoá / sửa tay dữ liệu người dùng:** chỉ đổi cách viết của cùng một số (`0900000001` → `+84900000001`). Gặp trùng thì dừng.

## 2. Chạy thật

**Đường nâng cấp như staging** (`scripts/migrate.mjs` của nhánh, Postgres 17 nhúng, cổng riêng): DB dựng bằng các file `drizzle/` và `demo/seed.sql` + `demo/seed-app.sql` lấy từ `origin/main` (0016), rồi migrate lên 0017:

| | Trước 0017 | Sau 0017 |
|---|---|---|
| Số điện thoại khác NULL | 5 (`0900000001`, `0900000002`, `+84900000101..103`) | 5 |
| NOTICE | — | `0017: 5 số điện thoại; 2 dòng chuẩn hoá về E.164; 0 dòng không nhận ra (giữ nguyên)` |
| Dòng bị đổi | — | **2** (`driver.demo`, `driver2.demo` → `+84900000001`, `+84900000002`) |
| Seed mới chạy thêm 2 lần | — | không lỗi, không đổi số nào |

Sau đó `seed-demo.mjs` (đặt mật khẩu tài xế mẫu) và CSMS bản nhánh: đăng nhập `0900000101`, `+84 900 000 102`, `84900000103` → 200.

**DB sạch (0000 → 0017):** áp được; test `migration-0017` phần 4 (hai người cùng số → 23505 `users_phone_number_key`; nhiều NULL cùng tồn tại).

**Có số trùng:** test `migration-0017` phần 2 — `0901234567` / `+84 901 234 567` / `84901234567` và hai dòng `abc`: migrate ném lỗi `0017: số điện thoại trùng sau chuẩn hoá (id 1, 2, 3; id 4, 5). Không sửa gì; …` (SQLSTATE 23505), dữ liệu, `updated_at`, `_migrations` và index cũ giữ nguyên; gỡ trùng bằng tay rồi migrate lại thì chạy được. Thông báo chỉ có id, không in số điện thoại.

## 3. Số liệu

Index: không đổi (bỏ `users_phone_number_idx`, thêm index của `users_phone_number_key`). UNIQUE: +1. Bảng, cột, CHECK, FK, enum: không đổi.

**Đối chiếu SQL ↔ Drizzle:** `drizzle-kit export --sql` nạp vào DB nháp (tạo trước 5 sequence nghiệp vụ), so với DB sạch đã áp 0000 → 0017: cột của `users` 9/9, ràng buộc 3/3, index 3/3 khớp (so theo định nghĩa). Test `migration-0017` kiểm thêm `getTableConfig(users)`: UNIQUE `users_email_key`, `users_phone_number_key`, không còn index thường.

## 4. Code và dữ liệu mẫu đi cùng

- `src/driver/phone-number.ts` (mới): `normalizePhoneNumber`; `driver-account.ts`: register chuẩn hoá + 409 `phone_taken`, login nhận `phone_number`.
- `src/db/schema/users.ts`: `unique('users_phone_number_key')` thay `index('users_phone_number_idx')`.
- `demo/seed.sql`: tài xế demo dùng `+84900000001`, `+84900000002` (trước là `0900000001`, `0900000002`). `demo/seed-app.sql`: giữ `+84900000101..103`, thêm UPDATE điền số cho tài xế mẫu chưa có số. Cả hai: số đã có người khác dùng thì để NULL thay vì làm hỏng seed.
- `docs/THIET-KE-CSDL-VAT-LY.md`: khoá của `users`.

## 5. Không làm (có chủ ý)

- OTP/SMS, Google/Firebase: ngoài phạm vi tới sau Defense 1.1 (ADR-0017).
- Đổi số / đổi mật khẩu: chưa có route.
- Kiểm độ dài số theo từng nước (không có thư viện số điện thoại).
