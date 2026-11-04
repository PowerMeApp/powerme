# Nhật ký đồng bộ CSDL với Physical ERD v1.0 — đợt 1 và 2 (BE-16)

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

## 5. Chưa làm sau đợt 2

B1 (Nghĩa), B3 và B4 (Sơn), B5 (Khang, cùng bảng `refunds`); thay `charging_statements` bằng view (đề xuất chưa duyệt); ba "flag" chờ Trí quyết (`charge_points.lifecycle = offline`, `review` của STM-1, `seq_no` của `session_status_history`) — không đổi gì.

## 6. Đợt 2 — migration `0014_erd-alignment-varchar-audit.sql` (C1 + C2)

Xếp tầng lên đợt 1. Nguồn: mục C1 và C2 của `0011_physical-guide-alignment.sql` (Ân), danh sách cột lấy đúng từ file đó (không suy diễn).

| Thay đổi | Quyết định | Cách kiểm |
|---|---|---|
| C1: 48 cột `text` → `varchar(n)` (24 bảng; 37 cột ở 14 bảng có trong schema Drizzle, 11 cột ở 5 bảng kỹ thuật WP3 chỉ có SQL) | hướng dẫn ERD §9.1 "Mã VARCHAR(n) theo độ dài thật"; văn bản tự do giữ `text` | migration đo `max(char_length)` từng cột và **dừng** (không đổi gì) nếu có giá trị dài hơn; test: DB ở 0012 có `free_vend_tag` 25 ký tự → thất bại có thông báo `0014/C1 … dài nhất 25 > varchar(20)`, trạng thái cũ nguyên vẹn; sau khi sửa tay thì áp được; 48 cột đúng `character_maximum_length`; vượt độ dài → 22001 (email, serial, thẻ RFID, `vnp_TxnRef`, `unique_id` của bảng partition) |
| C1: bỏ CHECK `rfid_cards_card_identifier_check`, `driver_charge_intents_id_tag_check` | thay bằng `varchar(20)` (Ân) | test: hai ràng buộc không còn, 21 ký tự bị 22001, 20 ký tự được |
| C2: 7 cột `created_at` + 19 cột `updated_at` (`NOT NULL DEFAULT now()`) cho 21 bảng | hướng dẫn ERD §9.1; ISA dùng cột của `users` | test: từng bảng có đủ cột thêm, kiểu `timestamptz`, `NOT NULL`, default `now()`; dòng cũ nhận thời điểm chạy migration (không có dữ liệu thật hơn để backfill) |
| `updated_at` luôn được cập nhật | Ân: dùng `$onUpdate`, rà mọi UPDATE thô | schema TS: `.$onUpdate(() => new Date())`; 15 câu `UPDATE` thô trong `charge-settlement.service.ts`, `driver-charging.service.ts`, `sessions.service.ts` được thêm `updated_at = now()` (các bảng `driver_charge_intents`, `driver_stop_intents`, `remote_commands`, `charge_settlement_jobs`); test quét mã nguồn `src/` để mọi `UPDATE <bảng có updated_at> SET` mới đều phải có `updated_at`; test `$onUpdate` (`db.update(connectors)`) |

**Đối chiếu máy schema TS ↔ SQL sau 0014** (35 bảng trong schema TS): cột **339/339**, ràng buộc **166/166** (167 − 1: CHECK của `rfid_cards`; CHECK của `driver_charge_intents` nằm ngoài schema TS), enum **30/30**, index **120/121** (khác biệt có sẵn `loyalty_transactions_one_earn_per_session`). Số liệu toàn DB 0012 → 0014: cột 391 → 417 (391 gồm `validation_error` của #82), ràng buộc 231 → 229, CHECK 58 → 56; bảng 43, FK 82, index 152, enum 30 không đổi.

**Đối chiếu `powerme_physical.dbml`** (đích cuối của Ân; so tập bảng, 414 cột — tên, kiểu/độ dài, NOT NULL — và 80 `Ref` — tên, `ON DELETE`): 43/43 bảng trùng; cột/kiểu **khớp hết** trừ hai cột chờ B4/B5 và `charge_settlement_jobs.reason` (`varchar(50)` thay vì 30, xem trên) (`connector_status_events.connector_id`, `top_ups.refunded_by` còn ở DB, DBML đã bỏ) — 9 dòng "NULL" còn lại là khoá chính ghép mà DBML không gắn `pk` từng cột (giới hạn bộ so, không phải lệch); FK: quy tắc `ON DELETE` của cả 80 `Ref` **khớp**; khác: `connector_status_events_connector_id_fkey` (B4) và `top_ups_refunded_by_fkey` (B5) còn ở DB; đích FK của `policy_templates.created_by` (DBML → `admins`, B1) và `remote_commands.requested_by` (DBML → `operator_staff`, B3) còn là `users` ở DB — đúng danh sách chưa làm.

**Lệch file của Ân (1 cột):** `charge_settlement_jobs.reason` là `varchar(50)`, không phải 30 ([A] trong file của Ân): mã chạy thật ghi `tariff_coverage_or_boundary_meter_required` (42 ký tự); với 30 hai test WF-01 T72 ("tariff gap/overlap stays observable pending") rơi vào `transient_error`. Cần Ân xác nhận.

**Rủi ro hành vi và cách xử lý:** `ocpp_message_log.unique_id varchar(36)` và `action varchar(40)`. ocpp-rpc không giới hạn độ dài hai trường này ở tầng khung, và từ BE-07 (G12, migration 0013) gateway ghi cả frame hỏng/sai schema — đúng loại frame có UniqueId/action dài tuỳ ý — nên INSERT sẽ bị 22001 và dòng kiểm toán mất. `OcppMessageLogger.log` nay cắt hai trường định danh cho vừa cột (`raw` vẫn giữ frame nguyên văn); có test. Các trường còn lại (`id_tag`, `measurand`, `stop_reason`, `error_code`…) đã được `strictMode` kiểm theo schema OCA trước khi tới DB. `ALTER … TYPE` ghi lại cả bảng (kể cả `ocpp_message_log`, `meter_values`) — chạy ngoài giờ tải.
