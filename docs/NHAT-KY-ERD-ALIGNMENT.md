# Nhật ký đồng bộ CSDL với Physical ERD v1.0 — đợt 1 (BE-16)

**Ngày:** 04/11/2026 · **Người làm:** Trí (WP2) theo bản tóm tắt của Ân (WP1) · **Migration:** `0010`, `0011`, `0012` · **Nguồn:** "ERD Alignment Decisions" (Ân duyệt 31/10/2026), các file tham chiếu của Ân `0009_erd-alignment-additive.sql`, `0010_erd-alignment-after-code.sql`, `0011_physical-guide-alignment.sql`, `powerme_physical.dbml`.

Không đổi luồng nghiệp vụ: chỉ liên kết mới, FK target, quy tắc xoá, index. Theo ADR-0008 migration **viết tay**; schema Drizzle sửa cùng lúc và đối chiếu máy với `drizzle-kit export --sql` (mục 3). Ân dặn "sửa schema Drizzle rồi sinh migration" — repo cấm `drizzle-kit generate` vì partition và nhiều ràng buộc chỉ viết tay được (xem `apps/csms/drizzle.config.ts`), nên làm theo quy ước repo.

## 1. Đánh số lại file của Ân

Repo đã có `0009_bo-payment-mode-free.sql` nên ba file của Ân (đánh số 0009/0010/0011 trong bộ của bà) không dùng được nguyên tên.

| File repo | Nội dung | Lấy từ file của Ân |
|---|---|---|
| `0010_erd-alignment-enum-reservation-fee.sql` | A1: `ADD VALUE 'reservation_fee'` — **file riêng, không BEGIN/COMMIT** | `0009` dòng A1 (bà cũng tách ra ngoài `BEGIN`) |
| `0011_erd-alignment-additive.sql` | A2, A3, A4, A5 (20 index), A6 | `0009` phần còn lại |
| `0012_erd-alignment-delete-rules-reviewer.sql` | C3 (quy tắc xoá) + B2 (`reviewed_by`) | `0011` mục C3 + `0010` mục B2 |

`scripts/migrate.mjs` và `test/helpers/apply-migrations.ts` gửi **từng file bằng một lệnh query riêng**, nên 0010 commit xong rồi 0011 (có CHECK dùng `reservation_fee`) mới chạy. Đã kiểm bằng chạy thật: 0000 → 0012 trên DB sạch thành công; nếu gộp A1 vào 0011 thì CHECK ở A4 báo "unsafe use of new value".

## 2. Thay đổi · quyết định · cách kiểm

| Thay đổi | Quyết định / BR | Cách kiểm |
|---|---|---|
| A1 enum `credit_transaction_type` + `reservation_fee` | Quyết định 11, BR-P27 | `erd-alignment.integration.test.ts` (thứ tự enum); migration tách file chạy thật |
| A2 bảng `admins` (`user_id` PK → `users`, CASCADE) + backfill | ISA mỗi subtype một bảng (Logical ERD) | test backfill trên DB 0009 có dữ liệu (chỉ user `admin`, không tài xế/nhân viên); test CASCADE và FK; `wf01`, `wf05` chèn thêm dòng `admins` khi tạo user admin |
| A3 `sessions.reservation_id` UNIQUE | Quyết định 10, BR-P29 | test: hai phiên cùng reservation → 23505; nhiều phiên NULL được; FK |
| A4 `credit_transactions.reservation_id` UNIQUE + CHECK | Quyết định 11, BR-P26/P27 | test: hợp lệ; thiếu `reservation_id` khi là phí → 23514; loại khác mà có `reservation_id` → 23514; loại khác không có → được; trùng → 23505 |
| A5 20 index cho FK chưa có index | Checklist Physical (hướng dẫn ERD của giảng viên) | truy vấn FK-thiếu-index chạy trong CI (`erd-alignment.integration.test.ts`), 3 ngoại lệ có lý do (mục 4) |
| A6 bỏ `sessions_charge_point_id_fkey` | Quy tắc "không FK dư" | migration kiểm trước FK tổng hợp phủ `charge_point_id` (thất bại nếu không); test: FK bỏ, FK tổng hợp còn, JOIN theo cột chạy, bộ ba lệch vẫn bị `sessions_connector_fk` chặn |
| C3 CASCADE: `connectors`, `connector_status_events` (theo charge point), `tariff_periods` (theo operator), `session_pauses` (theo session) | Hướng dẫn ERD 8.1 quy tắc 5–6 | `confdeltype` từng FK + test hành vi xoá cha |
| C3 RESTRICT: `credit_transactions`, `loyalty_transactions` (→ ví), `invoice_adjustments`, `meter_values`, `reconciliation_records`, `session_tariff_segments` (→ `sessions`) | Chứng từ kế toán phải lưu; cha đóng bằng trạng thái | `confdeltype` + test: xoá cha có dòng con → 23503 (Postgres dùng cùng SQLSTATE cho RESTRICT và NO ACTION; phân biệt bằng `confdeltype`) cho từng bảng; FK của `meter_values` ở mọi partition cùng quy tắc |
| B2 `reconciliation_records.reviewed_by` → `operator_staff` | D14 | test: operator_staff duyệt được; admin/tài xế → 23503; migration **dừng có thông báo** nếu có dòng vi phạm (mục 4) |

## 3. Đối chiếu máy schema TS ↔ SQL

`drizzle-kit export --sql` nạp vào DB nháp (sau khi tạo trước 5 sequence nghiệp vụ), so với DB đã áp 0000 → 0012, chỉ các bảng có trong schema TS (35 bảng; các bảng kỹ thuật WP3 chỉ có SQL), FK so theo định nghĩa, bỏ partition con, `ON ONLY` coi như thường:

| | SQL | Drizzle TS | Khớp |
|---|---|---|---|
| cột (tên, kiểu, nullable, độ dài, độ chính xác) | 317 | 317 | 317 |
| ràng buộc PK/UNIQUE/FK/CHECK (so cả định nghĩa) | 167 | 167 | 167 |
| index (tên + định nghĩa) | 121 | 120 | 120 |
| enum (so cả thứ tự giá trị) | 30 | 30 | 30 |

Khác biệt duy nhất: `loyalty_transactions_one_earn_per_session` (UNIQUE partial, từ migration WP3 trước BE-16) có ở SQL mà `billing.ts` chưa khai — **có sẵn từ trước PR này**, không sửa ở đây (ngoài phạm vi). Đối chiếu với `powerme_physical.dbml` của Ân: xem mô tả PR.

Số liệu toàn DB (đếm bằng truy vấn, 0009 → 0012): bảng 42 → **43**; cột 387 → 390; ràng buộc 225 → 231; FK 80 → 82; CHECK 57 → 58; index 129 → 152; enum 30 (giá trị 119 → 120).

## 4. Chỗ lệch bản tóm tắt / quyết định

- **A5 — 23 FK thiếu index theo truy vấn, không phải 20.** 20 FK là danh sách của Ân (đã thêm hết). 3 FK còn lại, giữ làm **ngoại lệ tường minh trong test** (không nới truy vấn): (1) `sessions_connector_fk` — FK tổng hợp 3 cột, được phủ bởi `sessions_connector_id_received_started_at_idx` (cột đầu `connector_id`), như Ân ghi trong file của bà, nhưng truy vấn đòi đúng bộ cột; (2) `charging_statements_driver_id_fkey` — bảng dẫn xuất đề xuất thay bằng view (chưa duyệt); (3) `top_ups_refunded_by_fkey` — cột sẽ bị bỏ ở B5. Nếu Ân muốn index cho (2) hoặc (3), thêm một dòng `CREATE INDEX` và xoá dòng ngoại lệ tương ứng — test sẽ báo ngoại lệ lỗi thời.
- **6 trong 20 index ở bảng kỹ thuật WP3** (`charge_tariff_boundary_evidence`, `driver_charge_intent_events` ×2, `driver_charge_intents`, `driver_start_recoveries`, `driver_stop_attempts`) không có trong schema Drizzle (cả bảng chỉ có ở SQL từ trước), nên chỉ có `CREATE INDEX` ở migration. 14 index còn lại có cả `index()` trong schema TS.
- **Bảng partition:** `meter_values` có FK tới `sessions` ở bảng cha, lan xuống 5 partition con; DROP/ADD constraint trên bảng cha áp cho tất cả. `ocpp_message_log` có FK tới `charge_points` (NO ACTION, không đổi). Không FK nào của hai bảng này thiếu index.
- **C3 — theo file 0011 của Ân (đúng danh sách):** `credit_transactions.session_id/top_up_id`, `loyalty_transactions.session_id/top_up_id`, `session_tariff_segments.tariff_period_id`, `reconciliation_records.reviewed_by` giữ FK thường. (Bản tóm tắt đầu nói "áp cho các FK của các bảng này tới cha" rộng hơn; file của Ân hẹp hơn nên theo file.)
- **B2 — dữ liệu vi phạm:** migration **thất bại rõ ràng** (`0012/B2: N reconciliation_records có reviewed_by không thuộc operator_staff (id: …)`) thay vì tự gán lại người duyệt, vì sửa tay "ai duyệt" là sửa hồ sơ kiểm toán. DB demo/seed không có dòng nào như vậy; không có code ghi `reviewed_by` trong `src/` (OPERATOR_RESOLVED chưa có trigger, G2).
- **Seed/demo:** `demo/seed.sql` và `scripts/seed-demo.mjs` không tạo user admin nên không có gì phải thêm; chỉ hai test (`wf01`, `wf05`) tạo admin và đã chèn `admins`.
- **Tên FK:** theo Postgres mặc định `*_fkey` (như file của Ân).

## 5. Chưa làm trong đợt này

C1 (độ dài `varchar(n)`), C2 (cột `created_at`/`updated_at`) — PR 2 xếp tầng; B1 (Nghĩa), B3 và B4 (Sơn), B5 (Khang, cùng bảng `refunds`); thay `charging_statements` bằng view (đề xuất chưa duyệt); ba "flag" chờ Trí quyết (`charge_points.lifecycle = offline`, `review` của STM-1, `seq_no` của `session_status_history`) — không đổi gì.
