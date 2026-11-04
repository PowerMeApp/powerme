# Nhật ký migration 0012 — `0012_billing-refunds-wf02.sql`

**Ngày:** 04/11/2026 · **Task:** T32 (WP5, Phần 1 của `docs/tasks/WF-02_plan.md`) · **Người chịu trách nhiệm:** Lê Bảo Khang
**File:** `apps/csms/drizzle/0012_billing-refunds-wf02.sql` (áp lên DB đã có 0000 → 0009; một transaction `BEGIN … COMMIT`)
**Nguồn:** diagram WF-02 v2.0 (`diagrams/wf02/`: CD-2, SD-2c, SD-2d, SD-2e, SD-2f, 01/11/2026) · `docs/spec/WF-02_decisions.md` D1 (Refund, STM-10), D5 (InvoiceAdjustment), D7 (việc nền chạy bằng quét DB), D8 (số migration) · SRS BR-P13, BR-P21, BR-P44, UC-ADM-08.

Migration chỉ đổi schema. **Chưa có code billing ghi các cột mới**: `RefundService`, worker quét DB và `EInvoiceService` là Phần 9, 12 và 7 của plan. Số `0012` giữ theo CD-2. Trên `main` chưa có `0010`/`0011`, nhưng `migrate.mjs` áp theo thứ tự tên file nên vẫn chạy được. Mọi ràng buộc dưới đây có ca hợp lệ và ca bị từ chối trong `apps/csms/test/migration-0012.integration.test.ts` (23 test).

## 1. Bảng, cột và kiểu mới

| # | Bảng | Thay đổi | Use case / nguồn |
|---|---|---|---|
| 1 | (enum mới) | `refund_kind` (`top_up`, `late_payment`, `account_closure`) | Ba đường hoàn: Admin hoàn top-up (SD-2e), Admin hoàn khoản trả trễ (SD-2e), hệ thống hoàn số dư khi đóng tài khoản (SD-2f) |
| 2 | (enum mới) | `refund_status` (`requested`, `done`, `failed`) | STM-10 (D1). Không có `failed → done` |
| 3 | `refunds` (mới) | `id`, `top_up_id` FK, `kind`, `amount_vnd`, `status` (mặc định `requested`), `attempt_count`, `requested_by` FK `users` (nullable), `last_error_kind`, `last_error_message`, `last_attempt_at`, `gateway_refund_no`, `next_attempt_at` (DEFAULT `now()`), `created_at`, `completed_at` | Ghi quyết định hoàn cùng transaction với sổ cái, worker gửi VNPay sau, thử lại 5 phút / 30 phút / 2 giờ, tối đa 4 lượt (D1) |
| 4 | `invoice_adjustments` | + `refund_id` FK `refunds` (UNIQUE), `status e_invoice_status` (mặc định `requested`), `attempt_count`, `last_error_kind`, `last_error_message`, `last_attempt_at`, `next_attempt_at` (DEFAULT `now()`), `provider_adjustment_no` (UNIQUE) | Điều chỉnh hoá đơn sau khi refund `done`, cùng vòng đời và retry với e-invoice (D5, STM-7) |
| 5 | `invoice_adjustments` | `issued_at`: bỏ NOT NULL và DEFAULT `now()` | Trước 0012 điều chỉnh "phát hành" ngay khi INSERT. Nay hàng tạo ở `requested`, chỉ có `issued_at` khi nhà cung cấp trả số |
| 6 | `e_invoices` | + `next_attempt_at` (DEFAULT `now()`); hàng `requested` / `failed` có sẵn được backfill `now()`, hàng `issued` / `needs_review` giữ NULL | Worker hoá đơn quét `status IN ('requested','failed') AND next_attempt_at <= now()` (D7); hoá đơn đang chờ từ trước 0012 không bị bỏ sót |
| 7 | `top_ups` | + index `top_ups_status_expires_at_idx (status, expires_at)` | Vòng quét top-up `pending` quá 15 phút gọi querydr (SD-2d, D7) |
| 8 | `credit_accounts`, `top_ups` | COMMENT mới cho `closure_refunded_at`, `late_refunded_at` | Nghĩa theo D1: lúc refund tương ứng `done`. Hoàn về nguồn do worker làm, không còn là thao tác tay của Admin |

Tiền là `bigint` VND, thời điểm là `timestamptz` (ADR-0009). Cột mới nào cũng có `COMMENT ON COLUMN`.

**Vì sao `next_attempt_at` có DEFAULT `now()`.** Dòng mới đến hạn ngay, nên worker nhặt được ở vòng quét kế tiếp, kể cả khi lời gọi chạy sớm qua `Scheduler` bị mất vì process khởi động lại (D7). CHECK ở mục 2 chặn trường hợp code ghi NULL khi dòng còn chờ xử lý.

## 2. Ràng buộc mới và use case nó bảo vệ

| Ràng buộc | Bảng | Use case nó bảo vệ |
|---|---|---|
| UNIQUE partial `refunds_one_per_top_up_and_kind` `(top_up_id, kind) WHERE kind IN ('top_up','late_payment')` | refunds | Admin bấm "Hoàn" hai lần, hoặc hai Admin cùng hoàn một top-up, chỉ tạo **một** lệnh hoàn VNPay (SD-2e, BR-P21 "chỉ hoàn trọn"). `account_closure` không bị chặn vì một lần đóng tài khoản chia số dư thành nhiều phần (SD-2f) |
| CHECK `refunds_requested_by_check` (`kind = 'account_closure' OR requested_by IS NOT NULL`) | refunds | Hoàn top-up / khoản trễ là quyết định của Admin, sổ kiểm toán phải biết ai quyết (UC-ADM-08). Hoàn khi đóng tài khoản do hệ thống tạo (`requested_by = NULL`, CD-2 note R8 Q1) |
| CHECK `refunds_completed_check` (`(status = 'done') = (completed_at IS NOT NULL)`) | refunds | Billing Exceptions và `closure_refunded_at` / `late_refunded_at` biết refund xong lúc nào; refund chưa xong không có thời điểm hoàn tất |
| CHECK `refunds_gateway_refund_no_check` (`status <> 'done' OR gateway_refund_no IS NOT NULL`) + UNIQUE `refunds_gateway_refund_no_key` | refunds | Chỉ `done` khi VNPay xác nhận và trả mã hoàn, đủ để đối soát với sao kê VNPay. Một mã hoàn không gắn được cho hai refund |
| CHECK `refunds_amount_check` (`amount_vnd > 0`) | refunds | Không có lệnh hoàn 0 đồng hay âm (khi đóng tài khoản, phần chia cho mỗi top-up luôn dương) |
| CHECK `refunds_attempt_count_check`, `invoice_adjustments_attempt_count_check` (`>= 0`) | refunds, invoice_adjustments | Bộ đếm lượt thử (tối đa 4) không âm, nên lượt thứ 4 không bị đếm sai |
| CHECK `refunds_last_error_check`, `invoice_adjustments_last_error_check` (`last_error_kind` ⇒ `last_attempt_at`) | refunds, invoice_adjustments | Admin xem refund `failed` / điều chỉnh `needs_review` biết lần lỗi xảy ra lúc nào (UC-ADM-08), giống `e_invoices_last_error_check` của 0003 |
| CHECK `refunds_next_attempt_check` (`status <> 'requested' OR next_attempt_at IS NOT NULL`) | refunds | Refund chờ gửi luôn có lịch, worker quét DB (D7) không bỏ sót. Trường hợp không có lịch thì tiền đã trừ khỏi ví mà không bao giờ về nguồn |
| CHECK `e_invoices_next_attempt_check`, `invoice_adjustments_next_attempt_check` (`status NOT IN ('requested','failed') OR next_attempt_at IS NOT NULL`) | e_invoices, invoice_adjustments | Như trên cho hoá đơn: `failed` là "chờ thử lại" (STM-7), nên cũng phải có lịch |
| CHECK `invoice_adjustments_issued_check` (`status <> 'issued' OR (issued_at IS NOT NULL AND provider_adjustment_no IS NOT NULL)`) | invoice_adjustments | Không có điều chỉnh "đã phát hành" mà thiếu số của nhà cung cấp, giống `e_invoices_issued_check` |
| UNIQUE `invoice_adjustments_refund_id_key` | invoice_adjustments | Một refund điều chỉnh hoá đơn đúng một lần (Refund 1 – 0..1 InvoiceAdjustment, CD-2). Worker chạy lại `adjustForRefund` không tạo bản thứ hai |
| UNIQUE `invoice_adjustments_provider_adjustment_no_key` | invoice_adjustments | Một số điều chỉnh của nhà cung cấp không gắn được cho hai dòng |
| FK `refunds.top_up_id` → `top_ups`, `refunds.requested_by` → `users`, `invoice_adjustments.refund_id` → `refunds` | | Refund luôn có top-up gốc (giao dịch VNPay để hoàn về); người quyết là tài khoản có thật. Role Admin do `RolesGuard` kiểm, DB không kiểm |

Index thêm (không phải ràng buộc): `refunds_status_next_attempt_at_idx`, `e_invoices_status_next_attempt_at_idx`, `invoice_adjustments_status_next_attempt_at_idx` (vòng quét D7), `refunds_top_up_id_idx` (tra refund theo top-up cho Billing Exceptions, SD-2f), `top_ups_status_expires_at_idx`.

**Lựa chọn khi viết (D8 để người viết migration chọn):**

- **`last_error_kind` của `refunds` và `invoice_adjustments` dùng lại `e_invoice_error_kind`** (`transient`, `data`), không tạo enum chung mới. Lý do: nghĩa giống hệt (`transient` thì hẹn thử lại, `data` là bị từ chối), và helper retry dùng chung cho e-invoice và refund (D7) chỉ phải xử lý một kiểu. Không đổi tên enum vì nó thuộc 0003 đã merge. Cái giá là tên enum có chữ `e_invoice`; COMMENT của cột ghi rõ là dùng chung.
- **`invoice_adjustments.status` dùng lại `e_invoice_status`**, vì D5 ghi rõ điều chỉnh có cùng trạng thái và retry với e-invoice (STM-7).
- **`invoice_adjustments.refund_id` để nullable.** CD-2 chỉ vẽ Refund 1 – 0..1 InvoiceAdjustment, chưa loại trừ điều chỉnh không xuất phát từ refund (ví dụ sửa sai số liệu hoá đơn). Hiện chỉ `adjustForRefund` tạo điều chỉnh, và nó luôn ghi `refund_id`.

**Đã cân nhắc và KHÔNG làm ở DB:**

- **CHECK `refunds.amount_vnd ≤ top_ups.amount_paid_vnd`** (hay tổng các refund của một top-up ≤ số đã trả). Ràng buộc chạy qua hai bảng, CHECK không làm được. Làm bằng trigger thì ẩn logic nghiệp vụ khỏi service. `RefundService.create` kiểm trong cùng transaction có khoá dòng (Phần 9; khi đóng tài khoản thì chia tối đa `amount_paid_vnd` mỗi top-up, D6).
- **CHECK `attempt_count <= 4`.** `RETRY_LIMIT` là tham số cấu hình (D7). Như LATE_WINDOW ở 0003, ghi cứng vào CHECK thì đổi tham số phải viết migration.
- **`refunds.late_*`, liên kết refund ↔ dòng sổ cái.** Refund `late_payment` không ghi sổ cái (D1). Refund `top_up` và `account_closure` liên kết với sổ cái qua `top_up_id` và dòng `refund` của `credit_transactions` (UNIQUE `(top_up_id, transaction_type)` từ 0003), không cần thêm cột.

## 3. Tiền kiểm và transaction

Khối `DO` đầu file dừng cả migration (`RAISE EXCEPTION`, không áp gì) nếu `invoice_adjustments` đã có hàng. Hàng cũ không có trạng thái, số điều chỉnh của nhà cung cấp hay refund gốc. Gán `issued` thì vi phạm `invoice_adjustments_issued_check`, còn gán `requested` thì worker sẽ gửi lại một điều chỉnh có thể đã phát hành. Vì vậy, như 0003, migration không tự điền giá trị. Trên `main` chưa có code nào ghi bảng này, và `demo/seed.sql` cũng không, nên điều kiện này luôn thoả trên DB demo và staging.

`e_invoices` không cần tiền kiểm: cột `next_attempt_at` là cột mới, được backfill trước khi thêm CHECK, nên mọi hàng cũ đều thoả.

Test tiền kiểm dựng DB ngay trước 0012 có một điều chỉnh, gọi `migrate()` và kiểm: lỗi có tiền tố `0012:`, `_migrations` vẫn dừng ở 0009, chưa có bảng `refunds`, chưa có `e_invoices.next_attempt_at`.

**Transaction:** file chỉ có `CREATE TYPE` mới (không có `ALTER TYPE … ADD VALUE`), `CREATE TABLE`, `ALTER TABLE`, `UPDATE`, `CREATE INDEX`, `COMMENT`. Tất cả đều transactional nên cả file nằm trong một `BEGIN … COMMIT`.

## 4. Thay đổi ngoài file SQL

| # | Thay đổi | Lý do | Cách kiểm |
|---|---|---|---|
| 1 | `src/db/schema/enums.ts`: `refundKindEnum`, `refundStatusEnum` | Khớp SQL | Đối chiếu máy (mục 6) |
| 2 | `src/db/schema/billing.ts`: bảng `refunds`; cột, CHECK, UNIQUE, index mới cho `invoiceAdjustments`, `eInvoices`; index `topUps (status, expires_at)`; `invoiceAdjustments.issuedAt` bỏ `.notNull().defaultNow()`; comment `closureRefundedAt`, `lateRefundedAt` | Khớp SQL | `npm run typecheck`; đối chiếu máy |
| 3 | `src/db/schema/relations.ts`: `refundsRelations` (`topUp`, `requester`, `adjustment`); `topUps.refunds` (many); `invoiceAdjustments.refund` | TopUp 1 – 0..* Refund, Refund 1 – 0..1 InvoiceAdjustment (CD-2) | `npm run typecheck` (chưa có code dùng) |
| 4 | `test/migration-0012.integration.test.ts` (23 test) | Nâng cấp từ 0009 có dữ liệu, mọi ràng buộc, DB sạch, tiền kiểm | `DATABASE_URL=… npm test -w @powerme/csms` |
| 5 | `docs/THIET-KE-CSDL-VAT-LY.md`: đầu file, mục 1 (số liệu), mục 3.6, mục 4.2, mục 8 | Mô tả bảng và ràng buộc mới; bỏ "`refund_status` Planned" | Đọc lại |

Không cần sửa `scripts/migrate.mjs`, `test/helpers/apply-migrations.ts` và `demo/seed.sql`: seed không ghi `e_invoices` hay `invoice_adjustments`. Các test migration cũ (`migration-0001`, `-0002`, `-0003`, `-wp3`, `migrate-script`) so với `listMigrations()` nên tự có 0012 mà không phải sửa.

## 5. Rollback

0012 chỉ **thêm**: không `ADD VALUE` vào enum cũ, không đổi kiểu cột cũ. Ngoại lệ là `invoice_adjustments.issued_at` bỏ NOT NULL / DEFAULT. Ảnh trước 0012 vẫn chạy được trên schema sau 0012: nó không biết `refunds`, và INSERT `e_invoices` của nó (nếu có) nhận `next_attempt_at = now()` từ DEFAULT. Riêng `invoice_adjustments`: nếu ảnh cũ INSERT mà không ghi `issued_at`, DB không chặn, nhưng hàng đó nhận `status = 'requested'` và `issued_at = NULL`, rồi bị worker coi là đang chờ phát hành. Trên `main` chưa có code nào ghi bảng này nên không xảy ra.

Gỡ hẳn 0012 (chỉ trên DB chưa có dữ liệu refund thật):

```sql
BEGIN;
DROP INDEX top_ups_status_expires_at_idx, e_invoices_status_next_attempt_at_idx,
           invoice_adjustments_status_next_attempt_at_idx;
ALTER TABLE e_invoices DROP CONSTRAINT e_invoices_next_attempt_check, DROP COLUMN next_attempt_at;
ALTER TABLE invoice_adjustments
  DROP COLUMN refund_id, DROP COLUMN status, DROP COLUMN attempt_count, DROP COLUMN last_error_kind,
  DROP COLUMN last_error_message, DROP COLUMN last_attempt_at, DROP COLUMN next_attempt_at,
  DROP COLUMN provider_adjustment_no;
UPDATE invoice_adjustments SET issued_at = now() WHERE issued_at IS NULL;
ALTER TABLE invoice_adjustments ALTER COLUMN issued_at SET NOT NULL, ALTER COLUMN issued_at SET DEFAULT now();
DROP TABLE refunds;
DROP TYPE refund_status, refund_kind;
DELETE FROM _migrations WHERE name = '0012_billing-refunds-wf02';
COMMIT;
```

Khi đã có refund thật thì không gỡ. Làm như 0003: lùi bằng bản chụp DB trước lần deploy (`./rollback.sh --restore-db …`, `infra/staging/README.md`).

## 6. Số liệu sau migration và đối chiếu máy

Đếm bằng truy vấn trên Postgres 16.4 (container `powerme-postgres`). Cách đếm theo `THIET-KE-CSDL-VAT-LY.md` mục 1; cùng truy vấn tái hiện đúng số sau 0003 đã ghi ở đó (34 / 30 (120) / 102 (10) / 39 / 54 / 311).

| | Sau 0009 | Sau 0012 | 0012 cộng |
|---|---|---|---|
| Bảng (không tính partition con) | 42 | **43** | `refunds` |
| Enum (giá trị) | 30 (119) | **32 (125)** | `refund_kind` (3), `refund_status` (3) |
| Index (partial) | 129 (15) | **139 (16)** | `refunds`: PK, `gateway_refund_no_key`, `one_per_top_up_and_kind` (partial), `top_up_id_idx`, `status_next_attempt_at_idx`; `invoice_adjustments`: `refund_id_key`, `provider_adjustment_no_key`, `status_next_attempt_at_idx`; `e_invoices_status_next_attempt_at_idx`; `top_ups_status_expires_at_idx` |
| CHECK | 57 | **69** | `refunds` 7, `invoice_adjustments` 4, `e_invoices` 1 |
| FK | 80 | **83** | `refunds` 2, `invoice_adjustments` 1 |
| Cột | 387 | **410** | `refunds` 14, `invoice_adjustments` 8, `e_invoices` 1 |

**Đối chiếu SQL ↔ Drizzle:** `npx drizzle-kit export --sql` được nạp vào DB nháp `powerme_drizzle`, sau khi tạo trước 5 sequence nghiệp vụ mà DDL Drizzle tham chiếu. Phía SQL là DB `powerme` đã áp 0000 → 0012 bằng `migrate.mjs`. Phép so gồm `information_schema.columns` (kiểu, nullable, default), `pg_constraint` (định nghĩa), `pg_indexes`, `pg_enum` (thứ tự giá trị), trên 8 bảng billing (`credit_accounts`, `credit_transactions`, `top_ups`, `refunds`, `e_invoices`, `invoice_adjustments`, `loyalty_accounts`, `loyalty_transactions`) và 4 enum `refund_kind`, `refund_status`, `e_invoice_status`, `e_invoice_error_kind`. Kết quả: toàn bộ cột, ràng buộc, index và enum của 0012 khớp. Còn hai khác biệt, cả hai **có từ trước 0012**:

1. Tên FK: SQL dùng `*_fkey` (mặc định Postgres), Drizzle sinh `*_fk`, như đã ghi ở `THIET-KE-CSDL-VAT-LY.md` mục 8. Khi so theo định nghĩa thì mọi FK khớp.
2. Index `loyalty_transactions_one_earn_per_session` (partial UNIQUE `session_id WHERE transaction_type = 'earn'`) do `0004_wp3_t31_charging.sql` tạo nhưng chưa có trong `billing.ts`. Phần 3 của plan (sổ cái, `LoyaltyService.earnForSession`) sẽ bổ sung vào schema TS, vì đó là ràng buộc mà `earnForSession` dựa vào. 0012 không sửa.

Bảng WP3 (0004 → 0008) không có trong schema TS (35 bảng Drizzle so với 43 bảng SQL). Phép đối chiếu chỉ giới hạn ở billing.

## 7. Không làm (có chủ ý)

- **Code billing** (`RefundService`, `RefundStateMachine`, worker quét DB, `EInvoiceService.adjustForRefund`): Phần 2, 7, 9, 12 của plan.
- **Đổi tên `top_ups.late_gateway_ref` → `late_gateway_transaction_no`:** còn mở trong decisions, chưa chốt.
- **Ghi `credit_accounts.closure_refunded_at` / `top_ups.late_refunded_at` tự động bằng trigger** khi refund `done`: service làm trong cùng transaction chuyển `done` (Phần 9, 11). DB chỉ giữ CHECK của 0003.
