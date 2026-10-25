# Nhật ký migration 0001 — `0001_quyet-dinh-be-11.sql`

**Ngày:** 25/10/2026 · **Task:** BE-11 (WP2) · **Người chịu trách nhiệm:** Ngô Văn Minh Trí
**File:** `apps/csms/drizzle/0001_quyet-dinh-be-11.sql` (áp lên DB đã có `0000_init.sql`; một transaction `BEGIN … COMMIT`)
**Nguồn:** quyết định của Trí 25/10/2026 · `docs/self-review/BM02-SELF-REVIEW-review-2.md` (F08–F13, F40) — **không sửa file đó**; phản hồi chính thức ở `BM02-TEAM-RESPONSE.md` do Trí cập nhật sau khi PR merge.

Bảng dưới liệt kê từng thay đổi, lý do và cách kiểm. "Test" là file trong `apps/csms/test/` hoặc `apps/csms/src/`, chạy bằng `DATABASE_URL=… npm test -w @powerme/csms`.

## 1. Thay đổi trong DB

| # | Thay đổi | Lý do (BM02 F-id / quyết định) | Cách kiểm |
|---|---|---|---|
| 1 | `ALTER TYPE payment_mode ADD VALUE 'unattributed'` | Quyết định 1 (Trí); F40 · ADR-0012: idTag lạ chưa biết ai thu tiền, trước đó bị gán `station_wallet` (coi như đã thu) | `migration-0001` "giá trị enum mới dùng được sau COMMIT"; `pg_enum` có `unattributed` cuối danh sách |
| 2 | `ALTER TYPE reconciliation_record_type ADD VALUE 'conflict'`, `'late_sample'` | F10: conflict là kết quả trung tâm của WF-03 nhưng chỉ phân biệt được bằng tiền tố text của `resolution` | `migration-0001` (insert được, thứ tự enum); `session-history` (record_type `conflict`/`late_sample`/`meter_gap`) |
| 3 | `CREATE TYPE remote_command_status` (`pending`, `sent`, `accepted`, `rejected`, `timeout`, `failed`) | F08 · `WP2-KIEN-TRUC-TECHSTACK.md` lệnh bất đồng bộ `202 + commandId` | `migration-0001` thứ tự giá trị |
| 4 | `connector_status_events.pillar_timestamp` → `cp_timestamp` (`RENAME COLUMN`) | Quyết định 2: thống nhất tên đồng hồ trụ với ADR-0009 và các bảng khác | `migration-0001` "đường nâng cấp": giá trị cũ còn nguyên, không còn cột `pillar_timestamp` ở bảng nào; `wf03-exp01` (g) |
| 5 | `sessions.orphaned_at timestamptz NULL` | F09 / F13: biết phiên từng orphaned; set lần đầu, giữ khi `orphaned → active` | `wf03-exp01` (n): chỉ tx3 có `orphaned_at = 14:19:01.000Z`; `session-history`: lần orphaned thứ hai không ghi đè |
| 6 | `meter_values.replayed boolean NOT NULL DEFAULT false`, `meter_values.epoch integer NULL` | F09: diagram WF-03 có hai thuộc tính này, DB không | `wf03-exp01` (o): 30 dòng `replayed = true` (6 MV × 5 SV) epoch 2; `migration-0001`: cột lan xuống 5 partition |
| 7 | `ocpp_message_log.replayed boolean NULL` | F09: null = không phân loại được; **truyền lúc INSERT** vì trigger append-only chặn UPDATE | `wf03-exp01` (p): 8 `true`, `null` cho frame không có `cp_timestamp`; `migration-0001`: UPDATE bị chặn |
| 8 | Bảng `remote_commands` (13 cột, 3 CHECK, partial UNIQUE `idempotency_key`, index `(charge_point_id, requested_at DESC)` và partial `(status)` cho `pending`/`sent`) | F08 · quyết định 4 | `migration-0001` mục `remote_commands` (CHECK, UNIQUE, enum, FK, định nghĩa index) |
| 9 | Bảng `session_status_history` + trigger `session_status_history_no_update_delete`, FK `ON DELETE RESTRICT` | F13 · quyết định 5. `CASCADE` mâu thuẫn trigger chặn DELETE nên chọn `RESTRICT` | `migration-0001` (UPDATE/DELETE bị chặn, xoá phiên cha bị FK chặn, `confdeltype = 'r'`) |

11 enum tự đặt giá trị ở 0000 (`user_account_status`, `operator_status`, `staff_role`, `connector_type`, `fault_source`, `maintenance_ticket_status`, `reservation_hold_mode`, `tariff_band`, `discount_type`, `credit_transaction_type`, `loyalty_transaction_type`) **giữ nguyên, không đổi giá trị** — đã duyệt bởi Trí 25/10/2026, chưa có Khang/Nghĩa duyệt riêng (kiểm lại giá trị ở `migration-0001`).

## 2. Thay đổi trong code (hành vi)

| # | Thay đổi | Lý do | Cách kiểm |
|---|---|---|---|
| 10 | `SessionsService.classifyIdTag`: idTag lạ → `payment_mode = 'unattributed'` (trước: `station_wallet`) | Quyết định 1 | `wf03-exp01` (a) tx4; `session-history` "payment_mode theo idTag" |
| 11 | `SessionsService`: mỗi chuyển trạng thái được state machine chấp nhận ghi một dòng `session_status_history` **cùng transaction** với `UPDATE sessions.status`. Các đường: StartTransaction (#2), StopTransaction (#9–#11), đối soát (#12/#12a/#16/#16a), StatusNotification (#5/#6/#18), `onStationOffline` (#13–#15, nay mỗi phiên một transaction), mẫu muộn (#19) | F13 · quyết định 5 | `wf03-exp01` (m) chuỗi đúng của tx1–tx4; `session-history` (#5, #6, #16, #19 và event bị từ chối không để lại dòng; lịch sử không ghi được thì `status` không đổi) |
| 12 | `SessionsService.transition()` đặt `sessions.orphaned_at` lần đầu sang `orphaned` | mục 5 | `wf03-exp01` (n), `session-history` |
| 13 | `ingestSamples` ghi `meter_values.replayed` (từ `ctx.replay.replayed`) và `epoch` (`ctx.epoch`) | mục 6 | `wf03-exp01` (o) |
| 14 | `OcppServer.processCall` truyền `replayed` (null nếu `skewS === null`) vào `OcppMessageLogger.log()` lúc INSERT | mục 7 | `wf03-exp01` (p) |
| 15 | `ReconciliationService.recordVerdict`: StopTransaction conflict → `conflict`; đối soát lại do mẫu muộn → `late_sample`; `meter_gap` chỉ cho `gap_detected` thuần; so trùng với bản ghi kết luận gần nhất trong cả ba loại | F10 · quyết định 7 | `wf03-exp01` (c): 1 `conflict` + 6 `late_sample`, 0 `meter_gap`; `session-history` (conflict, late_sample, meter_gap) |
| 16 | Console: `reconciliationKind()` và `IS_CONFLICT` hiểu loại mới và **vẫn đọc bản ghi cũ** (`meter_gap` + tiền tố); `RECONCILIATION_TYPES` thêm hai loại | quyết định 7 (không để dữ liệu demo cũ gây lỗi) | `console.mappers.spec.ts` (cả hai dạng); `console.integration` "tương thích dữ liệu cũ" (chèn bản ghi kiểu cũ vào DB, đếm và hiển thị là `conflict`) |
| 17 | `ConsoleQueries`/`SessionsService`/schema TS: `pillarTimestamp` → `cpTimestamp` | quyết định 2 | `npm run typecheck`, `wf03-exp01` (g) |

## 3. Hạ tầng

| # | Thay đổi | Lý do | Cách kiểm |
|---|---|---|---|
| 18 | `test/helpers/apply-migrations.ts` (`migrate`, `resetAndMigrate`) — áp tuần tự theo tên file, bảng `_migrations(name PK, applied_at)`; mọi test tích hợp dùng thay vì đọc cứng `0000_init.sql` | Có nhiều hơn một migration | Cả ba file test tích hợp chạy qua helper |
| 19 | `demo/migrate.mjs` + `demo/db-embedded.mjs` gọi nó: DB demo đã có 0000 (không có `_migrations`) được ghi nhận 0000 rồi áp 0001 lên dữ liệu hiện có (trước đây "schema đã có → bỏ qua", nên không bao giờ lên 0001) | Demo không mất dữ liệu khi nâng cấp | `migration-0001` mục "đường nâng cấp" (dựng DB kiểu cũ + dữ liệu, rồi `migrate`); đã chạy trên DB demo thật (xem PR) |
| 20 | Schema TS: `remoteCommands`, `sessionStatusHistory`, 3 enum, cột mới; `relations.ts` | Khớp SQL từng cột | Đối chiếu máy `drizzle-kit export --sql` ↔ SQL: 295 cột, 146 ràng buộc, 100 index, 29 enum, **0 khác biệt** (xem `THIET-KE-CSDL-VAT-LY.md` mục 8) |

## 4. Số liệu sau migration

Đếm bằng truy vấn trên Postgres thật (cách đếm: `THIET-KE-CSDL-VAT-LY.md` mục 1):

| | Sau 0000 | Sau 0001 |
|---|---|---|
| Bảng (không tính partition con) | 32 | **34** |
| Partition con | 10 | 10 |
| Enum | 28 | **29** |
| Index (kể cả PK/UNIQUE; partial) | 94 (7) | **100 (9)** |
| CHECK (`pg_constraint.contype = 'c'`) | 24 | **27** |
| FK | 50 | **53** |
| Cột | 270 | **295** |
| Trigger append-only | 1 | **2** |

## 5. Không làm (có chủ ý)

- **F11 — FK `reconciliation_records` → `ocpp_message_log`:** không làm; lý do ở `THIET-KE-CSDL-VAT-LY.md` mục 9. `message_log_id` vẫn nằm trong `resolution`.
- **Backfill** `meter_values.replayed/epoch`, `ocpp_message_log.replayed` và chuyển bản ghi đối soát cũ sang `conflict`/`late_sample`: không (bảng append-only; không sửa bản ghi đối soát đã có người xem).
- **Code gửi lệnh `remote_commands`:** BE-04.
- **F41 / Known Gap G9** (dung sai `before_epoch`) và **G10:** vẫn mở, không đụng.
- **Free vend:** ADR-0012 quyết định 3 viết `unattributed`, schema/code dùng `free`; giữ `free`, ghi ở ADR-0012 mục "Cập nhật 25/10/2026".
