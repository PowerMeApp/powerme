# Thiết kế CSDL mức vật lý — CSMS PowerMe

**Ngày:** 23/10/2026
**Task:** T11 / BE-06 — thiết kế CSDL mức vật lý
**Người chịu trách nhiệm:** Ngô Văn Minh Trí (WP2)
**Nguồn:** mô hình logic T10 (Ân, 20/10/2026) · state machine T12/T13 · ADR-0005, 0007, 0008, 0009, 0010, 0011, 0012 · `docs/PACKAGE-DIAGRAM-CSMS.md` (bảng → module chủ) · `apps/csms/lab/README.md` (định dạng trace)
**Sản phẩm:** `apps/csms/src/db/schema/*.ts` (Drizzle) · `apps/csms/drizzle/0000_init.sql` (migration viết tay) · tài liệu này

> Nguồn sự thật về cấu trúc DB là **migration SQL viết tay** (ADR-0008). Schema Drizzle phải khớp từng cột với SQL — mục 8 ghi cách đối chiếu đã chạy.

---

## 1. Quy ước áp dụng cho mọi bảng

| Quy ước | Giá trị | Nguồn |
|---|---|---|
| Khoá chính | `id bigint GENERATED ALWAYS AS IDENTITY`; bảng mở rộng của `users` dùng `user_id` làm PK/FK | T11 |
| Business key của ERD | `UNIQUE` riêng, không làm PK | T11 |
| Tên bảng / cột | `snake_case`, số nhiều cho bảng | T11 |
| Thời gian | `timestamptz`, lưu UTC | ADR-0009 |
| Hai đồng hồ | bảng nhận dữ liệu từ trụ có cả `cp_timestamp`/`pillar_timestamp` (đồng hồ trụ, **không tin**) lẫn `received_at` (đồng hồ CSMS, **tin**) | ADR-0009 |
| Điện năng | Wh, `bigint` | ADR-0009 |
| Tiền | VND, `bigint` | ADR-0009 |
| Enum | `CREATE TYPE ... AS ENUM` qua `pgEnum` của Drizzle; giá trị khớp T12/T13 | T11 |
| Cột dẫn xuất (`/x` trong ERD) | cột thường, **cập nhật cùng transaction với dòng ledger** | T10 §5.6 |
| Partition | `meter_values`, `ocpp_message_log` — `PARTITION BY RANGE (received_at)` theo tháng, tạo sẵn 2026-10 → 2027-01 + `DEFAULT` | ADR-0007 |

Số liệu: **32 bảng** (+10 partition con), **28 enum**, **94 index** (kể cả index do PK/UNIQUE tạo, trong đó 7 partial), **36 CHECK**, 5 sequence cho số nghiệp vụ, 1 trigger append-only.

---

## 2. Ánh xạ Conceptual → Logical → Physical

Trả lời T10 §2: tên bảng thật, module chủ theo `PACKAGE-DIAGRAM-CSMS.md`.

### LERD-1 Charging & Billing

| Conceptual | Logical (Ân) | Physical (bảng thật) | Module chủ | Ghi chú |
|---|---|---|---|---|
| Người dùng | User | `users` | users | một bảng, cột `role` |
| Tài xế | Driver | `drivers` | users | mở rộng, PK = `user_id` |
| Mẫu xe | VehicleModel | `vehicle_models` | sessions | |
| Xe | Vehicle | `vehicles` | sessions | |
| Thẻ RFID | RfidCard | `rfid_cards` | users (sổ thẻ) | ADR-0012 gọi là `id_tags` |
| Súng sạc | Connector | `connectors` | stations | |
| Phiên sạc | ChargingSession | `sessions` | sessions | package diagram gọi `transactions` — xem mục 7 |
| Tạm dừng | SessionPause | `session_pauses` | sessions | bảng thật |
| Mẫu đo | MeterReading | `meter_values` | sessions | partition |
| Khung giá | TariffPeriod | `tariff_periods` | tariffs (WP5) | |
| Đoạn tính giá | SessionTariffSegment | `session_tariff_segments` | tariffs (WP5) | |
| Khuyến mãi | Promotion | `promotions` | tariffs (WP5) | |
| Bản ghi đối soát | ReconciliationRecord | `reconciliation_records` | reconciliation | |
| Ví tín dụng | CreditAccount | `credit_accounts` | billing (WP5) | |
| Sổ cái ví | CreditTransaction | `credit_transactions` | billing (WP5) | |
| Nạp ví | TopUp | `top_ups` | billing (WP5) | |
| Hoá đơn điện tử | EInvoice | `e_invoices` | billing (WP5) | |
| Điều chỉnh hoá đơn | InvoiceAdjustment | `invoice_adjustments` | billing (WP5) | |
| Tài khoản điểm | LoyaltyAccount | `loyalty_accounts` | billing (WP5) | |
| Sổ cái điểm | LoyaltyTransaction | `loyalty_transactions` | billing (WP5) | |

### LERD-2 Operations & Administration

| Conceptual | Logical (Ân) | Physical (bảng thật) | Module chủ | Ghi chú |
|---|---|---|---|---|
| Nhân viên vận hành | OperatorStaff | `operator_staff` | users | mở rộng, PK = `user_id` |
| Quản trị viên | Admin | — | users | **không tạo bảng**; `users.role = 'admin'` |
| Đơn vị vận hành | Operator | `operators` | stations | |
| Trạm | Site | `sites` | stations | |
| Trụ sạc | ChargingPillar | `charge_points` | stations | |
| Sự kiện trạng thái súng | ConnectorStatusEvent | `connector_status_events` | stations | |
| Sự cố | FaultEvent | `fault_events` | stations | |
| Báo lỗi của tài xế | FaultReport | `fault_reports` | stations | |
| Phiếu bảo trì «Should» | MaintenanceTicket | `maintenance_tickets` | stations | tạo tối thiểu |
| Mẫu chính sách «Should» | PolicyTemplate | `policy_templates` | users | tạo tối thiểu |
| Đặt chỗ «Should» | Reservation | `reservations` | stations | tạo tối thiểu |

### Bảng kỹ thuật — chỉ có ở mức vật lý

| Bảng | Module chủ | Vì sao có |
|---|---|---|
| `ocpp_message_log` | ocpp-gateway | nhật ký frame append-only, ghi trước handler (ADR-0005) |
| `charge_point_connections` | stations | epoch kết nối — nền phát hiện phát lại (EXP-01) |

---

## 3. Mô tả từng bảng

Định dạng: mục đích · cột quan trọng · khoá/ràng buộc · partition nếu có. Cột `created_at`/`updated_at` có ở hầu hết bảng và không nhắc lại.

### 3.1. Module `users`

**`users`** — mọi người dùng, phân biệt bằng `role` (`driver` · `operator_staff` · `admin`).
Cột: `email` (BK), `full_name`, `phone_number`, `role`, `account_status` (`active` · `suspended` · `closed`), `password_hash` (argon2, null nếu chưa đặt).
Khoá: PK `id`; UNIQUE `email`; index `phone_number`.

**`drivers`** — mở rộng của `users` khi `role = driver`. Chỉ tồn tại vì Driver có thuộc tính riêng.
Cột: `user_id` (PK, FK → `users`, `ON DELETE CASCADE`), `consent_version`, `consent_given_at`.
Mọi FK "tới tài xế" trong schema trỏ vào `drivers.user_id`, không trỏ `users.id` — DB tự chặn việc gán phiên/xe/ví cho một tài khoản không phải tài xế.

**`operator_staff`** — mở rộng của `users` khi `role = operator_staff`.
Cột: `user_id` (PK, FK → `users`), `operator_id` (FK → `operators`), `staff_role` (`manager` · `technician`).
Các FK "người xử lý" (`fault_events.acknowledged_by`, `fault_reports.cleared_by`, `maintenance_tickets.assigned_to`) trỏ vào đây.

### 3.2. Module `stations`

**`operators`** — đơn vị vận hành. Cột: `tax_code` (BK), `legal_name`, `address`, `status`. UNIQUE `tax_code`.

**`sites`** — trạm/địa điểm của operator. Cột: `site_code` (BK), `operator_id` (FK), `site_name`, `address`, `latitude`/`longitude` `numeric(9,6)`. UNIQUE `site_code`.

**`charge_points`** — trụ sạc (ChargingPillar).
Cột: `serial_number` (BK, định danh kỹ thuật, đuôi URL `/ocpp/{serialNumber}` — ADR-0009), `display_code` (mã người vận hành đọc, `PM-D1-HCM-0001`, null tới khi onboard — ADR-0009), `site_id` (FK, null tới khi gắn trạm), `model`, `firmware_version`, `rated_power_kw numeric(7,2)`, `warranty_until date`, `lifecycle` (`registered` → `awaiting_connection` → `in_service` ⇄ `offline` · `disabled` · `decommissioned`), `free_vend_tag` (idTag của chế độ free vend, ADR-0012), `reports_soc`, `supports_reservation`, `current_epoch` (lần kết nối hiện tại), `basic_auth_password_hash` (argon2, Security Profile 2 — ADR-0011), `last_message_at`.
Khoá: UNIQUE `serial_number`, UNIQUE `display_code`; index `site_id`.

**`connectors`** — súng sạc, tối đa 2 mỗi trụ.
Cột: `charge_point_id` (FK), `connector_no smallint` (1 súng A · 2 súng B), `connector_type` (`ccs2` mặc định), `max_power_kw`, `status` (9 giá trị OCPP nguyên văn, mặc định `Unavailable`), `status_changed_at`.
Khoá: UNIQUE `(charge_point_id, connector_no)`; CHECK `connector_no IN (1, 2)`; UNIQUE siêu khoá `(id, charge_point_id, connector_no)` để `sessions` tham chiếu bộ ba (xem `sessions`).
`connector_no = 0` là toàn trụ theo OCPP 1.6 và **không có dòng** ở đây.

**`connector_status_events`** — mọi `StatusNotification` đã nhận. CSMS phản chiếu, không từ chối (T13): chuyển trạng thái bất thường so với bảng OCPP vẫn ghi, gắn cờ `unexpected_transition = true`.
Cột: `charge_point_id` (FK), `connector_no` (0 · 1 · 2), `connector_id` (FK, **null khi `connector_no = 0`**), `status`, `error_code` (mặc định `NoError`), `vendor_error_code`, `info`, `pillar_timestamp` (đồng hồ trụ), `received_at` (đồng hồ CSMS), `unexpected_transition`.
Khoá: UNIQUE `(charge_point_id, connector_no, received_at)`; CHECK `connector_no IN (0,1,2)`; CHECK `(connector_no = 0) = (connector_id IS NULL)`; index `(connector_id, received_at)`.

**`charge_point_connections`** — mỗi lần trụ mở WebSocket là một epoch (EXP-01). Bản tin có `cp_timestamp` sớm hơn `opened_at` của epoch hiện tại là ứng viên phát lại.
Cột: `charge_point_id` (FK), `epoch`, `opened_at`, `closed_at`, `close_reason` (mã đóng WS, ví dụ `1012 superseded`), `remote_address`.
Khoá: UNIQUE `(charge_point_id, epoch)`.

### 3.3. Module `sessions`

**`rfid_cards`** — sổ đăng ký thẻ (ADR-0012 gọi `id_tags`). Người vận hành phát hành thẻ nên biết thẻ nào là thẻ ví.
Cột: `card_identifier` (BK — giá trị idTag trên dây, CHECK ≤ 20 ký tự theo OCPP 1.6), `card_kind` (`online` · `wallet` · `free_vend`), `driver_id` (FK → `drivers`, null khi chưa gán), `status` (`unlinked` · `active` · `blocked`), `issued_at`.

**`vehicle_models`** — danh mục mẫu xe. UNIQUE `(brand, model_name)`; `connector_type`, `battery_capacity_kwh`, `rated_range_km`, `max_dc_kw`, `is_vinfast`.

**`vehicles`** — xe của tài xế. `plate_number` (BK), `driver_id` (FK → `drivers`), `vehicle_model_id` (FK), `is_default`. Partial UNIQUE `(driver_id) WHERE is_default` — một xe mặc định mỗi tài xế.

**`sessions`** — phiên sạc = một giao dịch OCPP. Bảng trung tâm của hệ thống.
Cột định danh: `transaction_no integer` (BK; `transactionId` CSMS cấp cho trụ qua sequence `sessions_transaction_no_seq`, kiểu int32 vì OCPP 1.6), `connector_id`, `charge_point_id`, `connector_no`, `id_tag` (idTag nguyên văn trong `StartTransaction`, kể cả khi không tra được thẻ).
Cột liên kết tuỳ chọn: `driver_id`, `vehicle_id`, `rfid_card_id`, `promotion_id`.
Cột phân loại (ADR-0012): `origin` (`app_qr` · `rfid` · `hmi_password` · `free_vend`), `payment_mode` (`csms_billed` · `station_wallet` · `free`), `billing_mode` (`full` · `timed` · `energy_kwh` · `amount_vnd`) + `limit_value` (phút / Wh / VND tuỳ `billing_mode`).
Cột trạng thái: `status` — 9 giá trị theo T12/T13: `pending` → `active` ⇄ `paused` → `stopping` → `closed` → (`review` →) `reconciled`; nhánh lỗi `orphaned`, `failed`. `closed → review` khi đối soát phát hiện conflict; `review → reconciled` khi operator giải quyết.
Cột thời gian (ADR-0009, hai đồng hồ): `cp_started_at` / `received_started_at`, `cp_stopped_at` / `received_stopped_at`. `StartedAt`/`EndedAt` của ERD ánh xạ sang cặp này.
Cột đo: `meter_start_wh`, `meter_stop_wh`, `stop_reason` (Reason OCPP nguyên văn), `delivered_offline` (engine đối soát gán).
Cột dẫn xuất: `energy_wh`, `total_cost_vnd` — cập nhật cùng transaction lúc đóng phiên / ghi ledger.
Khoá:
- UNIQUE `transaction_no`.
- **UNIQUE `(charge_point_id, connector_no, id_tag, meter_start_wh, cp_started_at)`** — ADR-0010, khoá tự nhiên chống `StartTransaction` phát lại; handler bắt lỗi unique và trả lại đúng `transaction_no` cũ.
- FK tổng hợp `(connector_id, charge_point_id, connector_no)` → `connectors (id, charge_point_id, connector_no)` — ba cột luôn nhất quán dù khoá ADR-0010 dùng `charge_point_id + connector_no` còn ERD dùng `connector_id`.
- CHECK `meter_stop_wh >= meter_start_wh`; CHECK `limit_value > 0`.
- Index `(connector_id, received_started_at)`, `driver_id`, `status`.

Timeout và ngưỡng skew của state machine **không nằm trong DB**: xem `XAC-NHAN-STATE-MACHINE-T13.md` mục 1.3 — biến cấu hình `SESSION_START_TIMEOUT_S=120`, `SESSION_HARD_CAP_H=24`, `REPLAY_SKEW_THRESHOLD_S=5`, đã thêm vào `infra/.env.example`.

**`session_pauses`** — khoảng tạm dừng trong phiên (`SuspendedEV` / `SuspendedEVSE`). Bảng thật, không JSON.
Cột: `session_id` (FK), `paused_at`, `resumed_at` (null khi đang dừng), `pause_cause` (`ev` · `evse`). UNIQUE `(session_id, paused_at)`; CHECK `resumed_at >= paused_at`.

**`meter_values`** — một `SampledValue` = một dòng. **Partition theo tháng trên `received_at`.**
Cột: `session_id` (FK), `cp_timestamp` (đồng hồ trụ), `received_at` (đồng hồ CSMS, khoá partition), `measurand` (nguyên văn OCPP: `Energy.Active.Import.Register`, `Power.Active.Import`, `SoC`, `Voltage`, `Current.Import`…), `value numeric(14,3)`, `unit`, `context`, `phase`.
Khoá: PK `(id, received_at)` — Postgres bắt PK/UNIQUE của bảng partition phải chứa khoá partition. Vì thế **BK `(session_id, cp_timestamp, measurand)` của ERD không thể là UNIQUE**; chỉ có index thường trên bộ đó. Dedupe là việc của engine đối soát (`reconciliation_records.record_type = duplicate`), đúng tinh thần ADR-0005 "lưu hết, xử lý sau".
Partition: `meter_values_2026_10` … `_2027_01` + `meter_values_default`. Job BullMQ hằng tháng tạo partition tháng kế (ADR-0007).

### 3.4. Module `tariffs` (WP5)

**`tariff_periods`** — khung giá theo giờ trong ngày của operator. `band` (`off_peak` · `normal` · `peak`), `time_start`/`time_end` (`time`, giờ địa phương; khung qua nửa đêm tách hai dòng), `price_per_kwh_vnd bigint`, `effective_from`/`effective_to` (`date`). UNIQUE `(operator_id, band, time_start, time_end, effective_from)`; CHECK giá ≥ 0, `effective_to >= effective_from`.

**`promotions`** — `promotion_code` (BK), `operator_id`, `discount_type` (`percent` · `fixed_vnd`), `discount_value` (CHECK: percent ≤ 100), `valid_from`/`valid_to`.

**`session_tariff_segments`** — phiên cắt theo khung giá. PK `(session_id, tariff_period_id)` theo ERD; `segment_start`/`segment_end`, `energy_wh`, `amount_vnd`. Tổng `amount_vnd` = `sessions.total_cost_vnd` trước khuyến mãi.

### 3.5. Module `reconciliation`

**`reconciliation_records`** — kết quả engine đối soát (BE-07).
Cột: `session_id` (FK), `record_no` (từ 1, BK cùng `session_id`), `record_type` (`replay` · `duplicate` · `meter_gap` · `orphan_stop` · `unknown_id_tag` — theo package diagram và ADR-0012), `gap_start`/`gap_end`, `energy_difference_wh`, `reviewed_by` (FK → `users`, operator hoặc admin), `reviewed_at`, `resolution`.
Khoá: UNIQUE `(session_id, record_no)`; CHECK `(reviewed_by IS NULL) = (reviewed_at IS NULL)`; partial index `(record_type, created_at) WHERE reviewed_at IS NULL` cho màn hình "cần xử lý".

### 3.6. Module `billing` (WP5)

**`credit_accounts`** — ví tín dụng, **đúng một mỗi tài xế** (UNIQUE `driver_id`). `status` (`active` · `in_shortfall` · `closed`), `balance_vnd` (dẫn xuất).

**`top_ups`** — nạp ví qua cổng. `gateway_reference` (BK, null tới khi cổng trả về — UNIQUE khi có), `credit_account_id`, `amount_vnd`, `points_discount_vnd`, `amount_paid_vnd` (dẫn xuất, CHECK `= amount_vnd - points_discount_vnd`), `status` (`pending` · `credited` · `failed` · `expired` · `refunded`), `idempotency_key` (UNIQUE — app retry không tạo trùng), `completed_at`.

**`credit_transactions`** — sổ cái ví, append-only. `entry_no` tăng dần trong từng ví (BK cùng `credit_account_id`), `transaction_type` (`top_up` · `session_debit` · `refund` · `adjustment`), `amount_vnd` (âm = trừ), `balance_after_vnd` (dẫn xuất), `session_id`, `top_up_id`.
Khoá: partial UNIQUE `(session_id) WHERE transaction_type = 'session_debit'` — một phiên chỉ bị trừ một lần; partial UNIQUE `(top_up_id) WHERE top_up_id IS NOT NULL` — một top-up chỉ vào ledger một lần; CHECK loại `session_debit` phải có `session_id`, loại `top_up` phải có `top_up_id`.

**`e_invoices`** — hoá đơn VAT cho top-up credited. `invoice_no` (BK, null khi còn `requested`/`failed`), `top_up_id` (**UNIQUE** — một hoá đơn mỗi top-up), `status` (`requested` · `issued` · `failed` · `needs_review`), `amount_vnd`, `vat_amount_vnd`, `issued_at`, `attempt_count`. CHECK: `issued` phải có `invoice_no` và `issued_at`.

**`invoice_adjustments`** — `e_invoice_id` + `adjustment_no` (BK), `reason`, `amount_vnd`, `issued_at`.

**`loyalty_accounts`** — đúng một mỗi tài xế (UNIQUE `driver_id`); `points_balance` (dẫn xuất).

**`loyalty_transactions`** — `loyalty_account_id` + `entry_no` (BK), `transaction_type` (`earn` · `redeem` · `expire` · `adjust`), `points`, `expires_at`, `session_id`, `top_up_id`.

### 3.7. Vận hành (LERD-2) — `fault_events`, `fault_reports`, «Should»

**`fault_events`** — sự cố trên trụ/súng. `event_no` (BK, sequence), `charge_point_id`, `connector_id` (null = toàn trụ), `source` (`ocpp` · `driver_report` · `operator`), `error_code` (ChargePointErrorCode nguyên văn), `status` (`raised` · `acknowledged` · `resetting` · `resolved`), `raised_at`, `acknowledged_by` (FK → `operator_staff`), `acknowledged_at`, `resolved_at`. Partial index `WHERE status <> 'resolved'`.

**`fault_reports`** — tài xế báo lỗi từ app. `report_no` (BK), `driver_id`, `connector_id`, `description`, `reported_at`, `fault_event_id` (null tới khi operator gắn), `cleared_at`, `cleared_by` (FK → `operator_staff`).

**`maintenance_tickets`** «Should» — `ticket_no` (BK), `fault_event_id`, `assigned_to` (null khi chưa giao), `status` (`open` · `in_progress` · `closed`), `opened_at`, `closed_at`. CHECK `(status = 'closed') = (closed_at IS NOT NULL)`.

**`policy_templates`** «Should» — `template_code` (BK), `created_by` (FK → `users`, admin), `template_type text`, `content`.

**`reservations`** «Should» — `reservation_no integer` (BK; `reservationId` gửi xuống trụ, int32), `driver_id`, `connector_id`, `status` (`active` · `fulfilled` · `cancelled_free` · `cancelled_late` · `expired_no_show` · `voided`), `hold_mode` (`reserve_now` — gửi `ReserveNow` xuống trụ · `csms_only` — chỉ giữ chỗ phía CSMS), `created_at`, `expires_at`.
Khoá: **partial UNIQUE `(connector_id) WHERE status = 'active'`** và **`(driver_id) WHERE status = 'active'`** — phát hiện EXP-02: tính duy nhất phải nằm ở DB, không ở thư viện.

### 3.8. Module `ocpp-gateway`

**`ocpp_message_log`** — mọi frame OCPP hai chiều, **ghi trước khi gọi handler** (ADR-0005). **Partition theo tháng trên `received_at`.**
Cột (khớp định dạng trace của lab): `charge_point_id`, `epoch`, `direction` (`in` · `out`), `message_type` (2 CALL · 3 CALLRESULT · 4 CALLERROR), `unique_id` (MessageId OCPP-J), `action` (chỉ CALL), `cp_timestamp` (từ payload nếu có), `received_at`, `raw jsonb`.
Khoá: PK `(id, received_at)`; CHECK `message_type IN (2,3,4)`; CHECK `(message_type = 2) = (action IS NOT NULL)`; index `(charge_point_id, received_at)`, `(charge_point_id, unique_id)` (ghép CALL ↔ CALLRESULT), `(action, received_at)`.
Append-only ở mức DB: trigger `ocpp_message_log_no_update_delete` từ chối mọi UPDATE/DELETE; xoá dữ liệu cũ bằng `DROP TABLE` partition (không qua trigger).
Partition: `ocpp_message_log_2026_10` … `_2027_01` + `_default`.

---

## 4. Danh sách UNIQUE / CHECK / partial index và nghiệp vụ nó bảo vệ

### 4.1. Ràng buộc T10 §5 và ADR

| # | Ràng buộc | Bảng | Nghiệp vụ |
|---|---|---|---|
| 1 | UNIQUE `credit_accounts.driver_id`, UNIQUE `loyalty_accounts.driver_id` | billing | một ví và một tài khoản điểm cho mỗi tài xế (T10 §5.1) |
| 2 | CHECK `connector_no IN (1,2)` + UNIQUE `(charge_point_id, connector_no)` | connectors | tối đa 2 súng mỗi trụ (T10 §5.2) |
| 3a | UNIQUE `top_ups.gateway_reference`, UNIQUE `top_ups.idempotency_key` | billing | không ghi nhận một lần nạp hai lần (T10 §5.3) |
| 3b | partial UNIQUE `credit_transactions (top_up_id) WHERE top_up_id IS NOT NULL` | billing | một top-up tối đa một dòng ledger (T10 §5.3) |
| 4 | partial UNIQUE `credit_transactions (session_id) WHERE transaction_type = 'session_debit'` | billing | một phiên chỉ bị trừ tiền một lần (T10 §5.4) |
| 5 | UNIQUE `e_invoices.top_up_id` | billing | một hoá đơn cho mỗi top-up (T10 §5.5) |
| 6 | mọi cột tiền/Wh là `bigint`; cột dẫn xuất là cột thường có chú thích | toàn bộ | không lỗi làm tròn; snapshot cập nhật cùng transaction (T10 §5.6, ADR-0009) |
| 7 | partial UNIQUE `reservations (connector_id) WHERE status='active'`, `(driver_id) WHERE status='active'` | reservations | một đặt chỗ active mỗi súng và mỗi tài xế — tại DB, không ở thư viện (EXP-02) |
| 8 | UNIQUE `sessions (charge_point_id, connector_no, id_tag, meter_start_wh, cp_started_at)` | sessions | `StartTransaction` phát lại không sinh giao dịch thứ hai (ADR-0010) |
| 9 | `cp_*`/`pillar_timestamp` cạnh `received_at` ở `sessions`, `meter_values`, `connector_status_events`, `ocpp_message_log` | — | chênh lệch hai đồng hồ là tín hiệu phát hiện replay (ADR-0009) |
| 10 | trigger chặn UPDATE/DELETE trên `ocpp_message_log` | ocpp-gateway | nhật ký chỉ thêm, không sửa (ADR-0005) |

### 4.2. Ràng buộc bổ sung ở mức vật lý

| Ràng buộc | Bảng | Nghiệp vụ |
|---|---|---|
| FK tổng hợp `(connector_id, charge_point_id, connector_no)` → `connectors` | sessions | ba cột định danh súng không bao giờ lệch nhau |
| CHECK `meter_stop_wh >= meter_start_wh` | sessions | trụ báo meter lùi là dữ liệu cần đối soát, không phải phiên hợp lệ |
| CHECK `(connector_no = 0) = (connector_id IS NULL)` | connector_status_events | sự kiện toàn trụ không gắn súng; sự kiện súng phải gắn súng |
| UNIQUE `(charge_point_id, connector_no, received_at)` | connector_status_events | BK của ERD (Connector + ReceivedAt), mở rộng cho `connector_no = 0` |
| UNIQUE `(charge_point_id, epoch)` | charge_point_connections | epoch không trùng trong một trụ |
| CHECK `char_length(card_identifier) <= 20` | rfid_cards | giới hạn idTag của OCPP 1.6 |
| partial UNIQUE `vehicles (driver_id) WHERE is_default` | vehicles | một xe mặc định mỗi tài xế |
| CHECK `amount_paid_vnd = amount_vnd - points_discount_vnd` | top_ups | cột dẫn xuất không lệch nguồn |
| CHECK loại `session_debit` phải có `session_id`; loại `top_up` phải có `top_up_id` | credit_transactions | ledger không có dòng "trừ tiền phiên" mà không biết phiên nào |
| CHECK `issued` ⇒ có `invoice_no` và `issued_at` | e_invoices | không có hoá đơn "đã phát hành" mà không có số |
| CHECK `(status='closed') = (closed_at IS NOT NULL)` | maintenance_tickets | đóng phiếu phải có thời điểm |
| CHECK `(message_type = 2) = (action IS NOT NULL)` | ocpp_message_log | CALL có action; CALLRESULT/CALLERROR không |
| CHECK `(reviewed_by IS NULL) = (reviewed_at IS NULL)` | reconciliation_records | "đã xử lý" phải có cả người lẫn lúc |
| CHECK percent ≤ 100, `valid_to > valid_from` | promotions | giá trị khuyến mãi hợp lệ |

---

## 5. Trả lời bốn câu của Ân (T10) — theo quyết định T11 của Trí

1. **User / Driver / OperatorStaff / Admin là một bảng hay nhiều bảng?** Một bảng `users` có cột `role`, cộng hai bảng mở rộng **chỉ khi subtype có thuộc tính riêng**: `drivers` (`user_id` PK/FK, `consent_version`, `consent_given_at`) và `operator_staff` (`user_id` PK/FK, `operator_id`, `staff_role`). **Không tạo `admins`** — Admin không có thuộc tính riêng, `role = 'admin'` là đủ; `policy_templates.created_by` trỏ `users.id`.
2. **Bảng thẻ tên gì?** `rfid_cards`, không phải `id_tags`. Cột `card_identifier` chứa giá trị idTag trên dây. ADR-0012 vẫn gọi khái niệm là "sổ đăng ký thẻ `id_tags`" — cần cập nhật ADR (mục 7).
3. **SessionPause có cần bảng riêng không?** Có — `session_pauses` là bảng thật với `paused_at`, `resumed_at`, `pause_cause`, không lưu JSON trong `sessions`. Lý do: cần truy vấn "tổng thời gian tạm dừng" cho `billing_mode = timed` và cần UNIQUE `(session_id, paused_at)`.
4. **Tên bảng thật là gì?** Bảng ở mục 2. Tóm tắt khác tên so với ERD: ChargingPillar → `charge_points`; ChargingSession → `sessions`; MeterReading → `meter_values`; RfidCard → `rfid_cards`.

---

## 6. Chỗ mô hình logic của Ân lệch ADR — đã xử lý thế nào

| Chỗ lệch | Xử lý |
|---|---|
| MeterReading chỉ có `ReadingTime`, thiếu `received_at` (ADR-0009 bắt buộc hai đồng hồ) | `meter_values` có `cp_timestamp` (= ReadingTime) **và** `received_at`; `received_at` là khoá partition |
| ChargingSession chỉ có `StartedAt`/`EndedAt` | tách thành `cp_started_at`/`received_started_at`, `cp_stopped_at`/`received_stopped_at` |
| ChargingSession không có `id_tag` nhưng khoá ADR-0010 cần nó | thêm `sessions.id_tag text NOT NULL` (idTag nguyên văn); `rfid_card_id` vẫn là FK tuỳ chọn cho thẻ tra được |
| ChargingSession BK = `TransactionNo`; ADR-0010 cần khoá tự nhiên | giữ cả hai: UNIQUE `transaction_no` + UNIQUE khoá tự nhiên 5 cột |
| ChargingPillar thiếu `display_code` (ADR-0009), `current_epoch`, `basic_auth_password_hash` (ADR-0011) | thêm cả ba vào `charge_points` |
| ERD không có `ocpp_message_log`, `charge_point_connections` (ADR-0005, EXP-01) | tạo ở mức vật lý, ghi rõ "bảng kỹ thuật" |
| MeterReading BK `(ChargingSession, ReadingTime, Measurand)` không thể UNIQUE trên bảng partition | chỉ index thường; dedupe giao cho engine đối soát (mục 3.3) |
| ConnectorStatusEvent gắn `Connector(FK)` nhưng OCPP có `connectorId = 0` (toàn trụ) | thêm `charge_point_id` + `connector_no` (0/1/2), `connector_id` null khi 0 |
| ADR-0009 ghi `origin`: `app · rfid_online · rfid_wallet · hmi_password · free_vend` và `payment_mode`: `... · unattributed`; T12/T13 chốt `app_qr · rfid · hmi_password · free_vend` và `... · free` | **dùng giá trị T12/T13** theo yêu cầu "khớp chính xác"; ADR-0009 và ADR-0012 cần sửa cho khớp (mục 7) |
| `PACKAGE-DIAGRAM-CSMS.md` gọi bảng là `transactions`, `id_tags`, `remote_commands` | dùng `sessions`, `rfid_cards` theo T11; `remote_commands` không có trong T10/T11 nên **chưa tạo** (mục 7) |

---

## 7. Chỗ cần Trí / Khang / Nghĩa xác nhận

Những chỗ tôi phải chọn một giá trị để schema biên dịch được, nhưng không có nguồn chốt. Tôi chọn phương án hẹp nhất và ghi ở đây thay vì tự quyết.

**Cho Trí (WP2):**

1. **Enum chưa có nguồn giá trị** — tôi tự đặt, cần duyệt hoặc đổi: `user_account_status` (active/suspended/closed), `operator_status` (như trên), `staff_role` (manager/technician), `connector_type` (ccs2/chademo/gbt/type2), `fault_source` (ocpp/driver_report/operator), `maintenance_ticket_status` (open/in_progress/closed), `reservation_hold_mode` (reserve_now/csms_only — suy từ EXP-02), `tariff_band` (off_peak/normal/peak — theo ba khung giờ EVN), `discount_type` (percent/fixed_vnd), `credit_transaction_type` (top_up/session_debit/refund/adjustment), `loyalty_transaction_type` (earn/redeem/expire/adjust).
2. **ADR-0009 / ADR-0012 lệch enum T12/T13** (`origin`, `payment_mode`, tên `id_tags`). Schema theo T12/T13; hai ADR cần một dòng "Ghi chú trạng thái" cập nhật.
3. **`remote_commands`** có trong package diagram (module `stations`) nhưng không có trong T10. Tạo ở BE-04 hay thêm vào migration 0001?
4. **`meter_values.session_id NOT NULL`** theo ERD → `MeterValues` không kèm `transactionId` (ngoài phiên) sẽ không lưu được vào bảng này (frame thô vẫn còn trong `ocpp_message_log`). Nếu BE-06 cần lưu cả mẫu ngoài phiên thì đổi thành nullable + thêm `connector_id`.
5. **`connector_status_events.pillar_timestamp`** giữ tên của Ân; các bảng khác dùng `cp_timestamp` (ADR-0009). Có muốn đổi thành `cp_timestamp` cho thống nhất không?
6. **`sessions.stop_reason` là `text`** (không enum) để trụ báo gì cũng ghi được; `connectors.status` lại là enum 9 giá trị theo quyết định T13. Hai cách khác nhau cho hai cột — chấp nhận hay enum hoá `stop_reason` (11 giá trị Reason của OCPP 1.6)?
7. **`users.password_hash`** không có trong T10; thêm vì `users` module xác thực JWT. Nếu đăng nhập OTP thuần thì bỏ.
8. **Partition tạo sẵn 2026-10 → 2027-01**: thử nghiệm M5/M6 (11–12/2026) nằm trong khoảng; dữ liệu khác rơi vào `_default`. Job BullMQ tạo partition kế là việc của BE-06 hay BE-07?

**Cho Khang (WP5 — billing/tariffs):**

9. **`tariff_periods` không có ràng buộc chống chồng khung giờ** giữa các dòng (cần `EXCLUDE USING gist` + extension `btree_gist`). Hiện chỉ UNIQUE 5 cột. Có cần không?
10. **`session_tariff_segments` PK `(session_id, tariff_period_id)`** theo ERD: một phiên không thể đi qua cùng một khung giá hai lần (ví dụ phiên dài qua hai ngày). Với `SESSION_HARD_CAP_H=24` thì vẫn có thể xảy ra ở biên. Chấp nhận, hay đổi PK sang `id` + UNIQUE `(session_id, segment_start)`?
11. **`top_ups.gateway_reference` nullable** (chưa có khi tạo lệnh nạp). ERD để BK — cần xác nhận với luồng VNPay thật: `vnp_TxnRef` do mình sinh (có ngay) hay `vnp_TransactionNo` của VNPay (có sau)?
12. **`e_invoices.invoice_no` nullable** khi còn `requested`/`failed`.
13. **`promotions.discount_value bigint`** dùng chung cho percent (0..100) và VND; tách hai cột nếu Khang muốn rõ hơn.

**Cho Nghĩa (WP1 — ERD/SDD):**

14. Cập nhật ERD T10 theo mục 6: thêm `received_at` cho MeterReading, cặp `cp_*/received_*` cho ChargingSession, `id_tag` cho ChargingSession, ba cột mới của ChargingPillar, và ghi hai bảng kỹ thuật ở phụ lục.
15. `Admin` không có bảng — ERD nên vẽ là role, không vẽ entity, để tránh finding "ERD có mà DB không có".

---

## 8. Kiểm chứng đã chạy

```bash
npm run typecheck -w @powerme/csms            # tsc --noEmit, TypeScript 7.0.2 — qua
npx drizzle-kit export --sql                  # DDL sinh từ schema TS, dùng để đối chiếu
```

Đối chiếu SQL viết tay ↔ DDL Drizzle: nạp cả hai vào PGlite (Postgres chạy trong tiến trình, không cần Docker) rồi so `information_schema.columns`, `pg_constraint`, `pg_indexes`, `pg_enum`. Kết quả: **270 cột, 138 ràng buộc, 94 index, 28 enum khớp cả hai phía**; khác biệt duy nhất là partition (Drizzle không biểu diễn được, đúng ADR-0008).

Chạy migration trên PGlite và thử ràng buộc: `connector_no = 3`, `StartTransaction` phát lại, bộ ba súng lệch, hai ví một tài xế, hai đặt chỗ active cùng súng / cùng tài xế, UPDATE/DELETE `ocpp_message_log`, hai `session_debit` một phiên, sự kiện toàn trụ gắn súng — **tất cả bị từ chối đúng**; dòng `meter_values` có `received_at` tháng 10/2026 vào `meter_values_2026_10`, dòng tháng 5/2027 vào `meter_values_default`.

Áp dụng migration lên Postgres thật:

```bash
psql "$DATABASE_URL" -f apps/csms/drizzle/0000_init.sql
```
