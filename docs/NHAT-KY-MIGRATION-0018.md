# Nhật ký migration 0018 — `0018_go-xe-tai-xe.sql`

**Ngày:** 12/11/2026 · **Task:** BE-34 (WP2) · **Người chịu trách nhiệm:** Ngô Văn Minh Trí
**File:** `apps/csms/drizzle/0018_go-xe-tai-xe.sql` (áp lên DB đã có 0000 → 0017; một transaction `BEGIN … COMMIT`)
**Nguồn:** BE-34 — Sơn (app Flutter, nối API thật trên staging) báo Driver API thiếu thêm / gỡ xe. F-01 "Register; manage profile, vehicles"; UC-ACC-03 "Add / update / remove / view vehicles"; màn hình 13 "Profile & Vehicles".

**Vì sao là 0018:** migration mới nhất trên `main` lúc làm là `0017_sdt-tai-xe-duy-nhat.sql` (BE-30). Khang đang chuẩn bị một 0018 khác (top_ups idempotency theo tài khoản); PR nào merge sau phải đổi số (tên file, hằng `M0018` trong `test/migration-0018.integration.test.ts`, nhật ký này).

## 1. Thay đổi

| # | Đối tượng | Thay đổi | Use case |
|---|---|---|---|
| 1 | `vehicles.removed_at timestamptz` | Cột mới, NULL = đang dùng | Tài xế DS-01 bán chiếc Leaf `51K-901.02` đã sạc 3 lần: bấm "Gỡ xe" → xe biến khỏi app, 3 phiên cũ trong lịch sử vẫn ghi đúng xe (BR-P17) — xoá cứng thì vấp FK `sessions.vehicle_id` |
| 2 | (kiểm tra) | Hai xe cũ cùng khoá biển (bỏ `-` `.` khoảng trắng, in hoa) → `RAISE EXCEPTION` liệt kê id từng nhóm, ROLLBACK cả file | `51K-901.01` và `51k90101` là cùng một xe ngoài đời; migration không tự chọn xe nào "đúng" |
| 3 | `vehicles_plate_number_key` | Bỏ UNIQUE toàn bảng | |
| 4 | `vehicles_plate_key_active` | `UNIQUE INDEX ON vehicles ((upper(regexp_replace(plate_number, '[^A-Za-z0-9]', '', 'g')))) WHERE removed_at IS NULL` | Người mua chiếc Leaf ở trên đăng ký lại `51K-901.02` (gõ `51k90102`) → được, vì xe cũ đã gỡ; nhưng khi xe cũ còn dùng thì 409 `plate_taken` dù gõ khác dấu / hoa thường |
| 5 | `vehicles_removed_not_default` | `CHECK (removed_at IS NULL OR NOT is_default)` | Index `vehicles_one_default_per_driver` giữ nguyên; nhờ CHECK, xe đã gỡ không bao giờ chiếm chỗ "xe mặc định" |
| 6 | COMMENT | `vehicles.removed_at`, index mới, bảng `vehicles` | |

**Vì sao xoá mềm, không "chỉ xoá khi chưa có lịch sử":** phần lớn xe tài xế muốn gỡ là xe đã từng sạc (bán xe, đổi xe). Cách (b) trả 409 `vehicle_has_history` cho đúng các ca đó — tài xế không gỡ được xe và biển số bị khoá vĩnh viễn với người mua. Xoá mềm giữ lịch sử và giải phóng biển.

**Vì sao khoá so trùng bỏ dấu:** biển VN viết nhiều kiểu (`51K-901.01`, `51K-90101`, `51K 901.01`). So theo chuỗi gốc thì một xe đăng ký được hai lần dưới hai cách viết. API lưu dạng người dùng gõ đã in hoa, bỏ khoảng trắng (giữ `-` `.` để hiển thị), còn so trùng theo khoá chữ + số. Biểu thức của index PHẢI giống `PLATE_KEY_SQL` (`apps/csms/src/driver/vehicles.http.ts`) — test `migration-0018` kiểm chuỗi này.

**Không sửa / xoá dữ liệu cũ:** mọi xe hiện có giữ nguyên và đang dùng (`removed_at` NULL). Gặp trùng thì dừng.

## 2. Hệ quả cho SQL khác (sửa cùng PR)

`ON CONFLICT ON CONSTRAINT vehicles_plate_number_key` và `ON CONFLICT (plate_number)` không chạy được nữa (constraint không còn; index có điều kiện + biểu thức không suy ra từ `(plate_number)`).

- `demo/seed-app.sql`: `ON CONFLICT DO NOTHING` + `NOT EXISTS` theo khoá biển trên **mọi** xe (kể cả đã gỡ) — seed chạy lại không hồi sinh xe tài xế đã gỡ qua app.
- `scripts/driver-local-token.mjs`: `ON CONFLICT DO NOTHING`, đọc lại xe `MB03-LOCAL` chưa gỡ.
- Code đọc xe cho tài xế lọc `removed_at IS NULL`: `/me`, `station-search.ts` (`/stations`), `resolveConnector` (`/connectors/by-code`), `DriverChargingService.start` (`POST /charges`, thêm `FOR SHARE OF v`), `road-discovery.ts` (`/places/*`, `/stations/{id}/route`). Đường khớp intent ↔ StartTransaction không lọc: intent còn mở thì xe không gỡ được (409 `vehicle_in_use`).

## 3. Chạy thật

**Đường nâng cấp có seed** (test `migration-0018` phần 1, Postgres 17 nhúng cổng riêng): DB dựng bằng 0000 → 0017 + `seed.sql` + `seed-app.sql` (5 xe mẫu `51K-90x.0y`) → migrate: áp 0018, 5 xe giữ nguyên từng cột, `removed_at` NULL hết; seed chạy lại 2 lần không lỗi, không đổi xe; gỡ `51K-901.02` rồi seed lại → không có xe mới cùng biển.

**Có biển trùng** (phần 2): thêm `59A-123.45` / `59a12345` và `59A 123.46` / `59-A12346` → migrate ném `0018: biển số trùng khi bỏ dấu và khoảng trắng (id 6, 7; id 8, 9). Không sửa gì; …` (SQLSTATE 23505); xe, `_migrations` giữ nguyên, cột `removed_at` chưa có; sửa tay hai biển rồi migrate lại thì chạy được. Thông báo chỉ có id, không in biển.

**DB sạch (0000 → 0018)** (phần 3): cùng khoá với xe đang dùng → 23505 `vehicles_plate_key_active`; xe đã gỡ cùng biển cùng tồn tại; xe đã gỡ mà `is_default` → 23514 `vehicles_removed_not_default`.

**Server local trên DB có seed** (BE-34, curl): đăng nhập DS-01 → `GET /vehicle-models` → `POST /vehicles` → `/me` → `DELETE` → `/me` — xem mô tả PR.

## 4. Số liệu

Cột: +1 (`vehicles.removed_at`). UNIQUE: −1 (`vehicles_plate_number_key`). Index: +1 (`vehicles_plate_key_active`; index của UNIQUE cũ mất theo). CHECK: +1. Bảng, FK, enum: không đổi.

**Đối chiếu SQL ↔ Drizzle:** `drizzle-kit export --sql` nạp vào DB nháp (tạo trước 5 sequence nghiệp vụ), so với DB sạch đã áp 0000 → 0018 bằng `scripts/migrate.mjs`: cột của `vehicles` 8/8, ràng buộc 4/4, index 5/5 khớp (so theo `pg_get_constraintdef` / `pg_get_indexdef`). Test `migration-0018` kiểm thêm `getTableConfig(vehicles)`: không còn UNIQUE, có `removed_at`, index biểu thức + điều kiện và CHECK đúng chuỗi SQL.

## 5. Không làm (có chủ ý)

- Kiểm định dạng biển theo luật VN (mã tỉnh 2 số + sê-ri…): có biển quân đội / ngoại giao / tạm khác mẫu; API chỉ đòi chữ + số với `-` `.` ở giữa, khoá 5–10 ký tự, dạng lưu ≤ 12.
- Khôi phục xe đã gỡ, sửa biển / đổi mẫu xe: chưa có route (gỡ rồi thêm lại).
- Giới hạn số xe mỗi tài xế, chống "chiếm biển" của người khác: chưa có; người bị chiếm liên hệ vận hành (không có route admin cho việc này).
