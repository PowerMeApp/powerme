# Nhật ký migration 0015 — `0015_billing-refunds-wf02.sql`

**Ngày:** 04/11/2026 · **Task:** T32 (WP5, Phần 1 của `docs/tasks/WF-02_plan.md`) · **Người chịu trách nhiệm:** Lê Bảo Khang
**File:** `apps/csms/drizzle/0015_billing-refunds-wf02.sql` (áp lên DB đã có 0000 → 0014; một transaction `BEGIN … COMMIT`)
**Nguồn:** diagram WF-02 v2.0 (`diagrams/wf02/`: CD-2, SD-2c, SD-2d, SD-2e, SD-2f, 01/11/2026) · `docs/spec/WF-02_decisions.md` D1 (Refund, STM-10), D5 (InvoiceAdjustment), D7 (việc nền chạy bằng quét DB), D8 (số migration) · ERD Alignment Decisions (Physical ERD v1.0) **B5** và quy ước của đợt 1 (`docs/NHAT-KY-ERD-ALIGNMENT.md`: A2 bảng `admins`, A5 mọi FK có index, C3 quy tắc xoá) · SRS BR-P13, BR-P21, BR-P44, UC-ADM-08.

**Vì sao là 0015:** CD-2 ghi "0012", nhưng `0010`–`0012` đã dùng cho BE-16 (Trí, PR #84, merge trước theo thoả thuận ngày 04/11), `0013_log-frame-sai-schema.sql` cho BE-07 (PR #82), rồi `0014_erd-alignment-varchar-audit.sql` cho BE-16 đợt 2 (PR #86). Bản đầu của migration này mang số 0012 (PR #83, nhánh `wp5/t32-migration-refunds`, đã đóng); bản sau (PR #85, nhánh `wp5/t32-migration-refunds-0013`) lần lượt đổi thành 0013, 0014, rồi 0015 trên chính nhánh đó mỗi lần rebase lên `main`. 0013 của BE-07 chỉ đổi `ocpp_message_log`; 0014 của BE-16 đổi kiểu `top_ups`, `e_invoices` sang `varchar(n)` và thêm `updated_at` — 0015 theo đúng hai quy ước đó cho bảng / cột mới (mục 1).

Migration chỉ đổi schema. **Chưa có code billing ghi các cột mới**: `RefundService`, worker quét DB và `EInvoiceService` là Phần 9, 12 và 7 của plan. Mọi ràng buộc dưới đây có ca hợp lệ và ca bị từ chối trong `apps/csms/test/migration-0015.integration.test.ts`.

## 1. Bảng, cột và kiểu mới

| # | Bảng | Thay đổi | Use case / nguồn |
|---|---|---|---|
| 1 | (enum mới) | `refund_kind` (`top_up`, `late_payment`, `account_closure`) | Ba đường hoàn: Admin hoàn top-up (SD-2e), Admin hoàn khoản trả trễ (SD-2e), hệ thống hoàn số dư khi đóng tài khoản (SD-2f) |
| 2 | (enum mới) | `refund_status` (`requested`, `done`, `failed`) | STM-10 (D1). Không có `failed → done` |
| 3 | `refunds` (mới) | `id`, `top_up_id` FK `top_ups`, `kind`, `amount_vnd`, `status` (mặc định `requested`), `attempt_count`, `requested_by` FK **`admins (user_id)`** (nullable), `last_error_kind`, `last_error_message`, `last_attempt_at`, `gateway_refund_no varchar(20)`, `next_attempt_at` (DEFAULT `now()`), `created_at`, `updated_at` (C2), `completed_at` | Ghi quyết định hoàn cùng transaction với sổ cái, worker gửi VNPay sau, thử lại 5 phút / 30 phút / 2 giờ, tối đa 4 lượt (D1) |
| 4 | `invoice_adjustments` | + `refund_id` FK `refunds` (UNIQUE), `status e_invoice_status` (mặc định `requested`), `attempt_count`, `last_error_kind`, `last_error_message`, `last_attempt_at`, `next_attempt_at` (DEFAULT `now()`), `provider_adjustment_no varchar(20)` (UNIQUE), `created_at`, `updated_at` (C2) | Điều chỉnh hoá đơn sau khi refund `done`, cùng vòng đời và retry với e-invoice (D5, STM-7) |
| 5 | `invoice_adjustments` | `issued_at`: bỏ NOT NULL và DEFAULT `now()` | Trước 0015 điều chỉnh "phát hành" ngay khi INSERT. Nay hàng tạo ở `requested`, chỉ có `issued_at` khi nhà cung cấp trả số |
| 6 | `e_invoices` | + `next_attempt_at` (DEFAULT `now()`); hàng `requested` / `failed` có sẵn được backfill `now()`, hàng `issued` / `needs_review` giữ NULL | Worker hoá đơn quét `status IN ('requested','failed') AND next_attempt_at <= now()` (D7); hoá đơn đang chờ từ trước 0015 không bị bỏ sót |
| 7 | `top_ups` | + index `top_ups_status_expires_at_idx (status, expires_at)` | Vòng quét top-up `pending` quá 15 phút gọi querydr (SD-2d, D7) |
| 8 | `top_ups` | **B5:** bỏ cột `refunded_by` (cùng FK `top_ups_refunded_by_fkey`, CHECK `top_ups_refunded_by_check`, `top_ups_refunded_by_required_check`) | Physical ERD v1.0: người quyết định hoàn nằm ở `refunds.requested_by` (kind `top_up`), không lặp trên `top_ups`. `refunded_at` và `top_ups_refunded_check` (refunded ⇔ refunded_at) giữ nguyên |
| 9 | `credit_accounts`, `top_ups` | COMMENT mới cho `closure_refunded_at`, `late_refunded_at`, `refunded_at` | Nghĩa theo D1: `closure_refunded_at` / `late_refunded_at` là lúc refund tương ứng `done` (worker hoàn về nguồn, không còn là thao tác tay của Admin); `refunded_at` là lúc Admin quyết định hoàn |

Tiền là `bigint` VND, thời điểm là `timestamptz` (ADR-0009). Cột mới nào cũng có `COMMENT ON COLUMN`.

**Vì sao `next_attempt_at` có DEFAULT `now()`.** Dòng mới đến hạn ngay, nên worker nhặt được ở vòng quét kế tiếp, kể cả khi lời gọi chạy sớm qua `Scheduler` bị mất vì process khởi động lại (D7). CHECK ở mục 2 chặn trường hợp code ghi NULL khi dòng còn chờ xử lý.

**Theo quy ước của đợt ERD alignment (0010–0012 và 0014):**
- `requested_by` trỏ `admins (user_id)`, theo ISA của 0011, cùng cách 0012 chuyển `reconciliation_records.reviewed_by` sang `operator_staff`. DB chặn tài xế hay nhân viên vận hành ra quyết định hoàn. Hệ quả: nơi nào tạo user Admin cũng phải chèn dòng `admins`, như đã ghi ở 0011.
- **Mọi FK mới đều có index** (A5): `refunds_top_up_id_idx`, `refunds_requested_by_idx`, và UNIQUE `invoice_adjustments_refund_id_key`. Test A5 của Trí trong `erd-alignment.integration.test.ts` kiểm toàn DB nên tự bắt FK thiếu index.
- **Ba FK mới giữ NO ACTION** (C3): `refunds` và điều chỉnh là quan hệ kết hợp với top-up / refund, không phải con cấu thành. Như `credit_transactions.top_up_id`, chúng không nằm trong danh sách RESTRICT/CASCADE đã duyệt. Test C3 của Trí ("không FK nào ngoài danh sách bị đổi") vẫn qua.
- **C1 (0014):** mã do cổng / nhà cung cấp cấp là `varchar(n)` theo độ dài thật: `refunds.gateway_refund_no` và `invoice_adjustments.provider_adjustment_no` là `varchar(20)`, như `top_ups.gateway_transaction_no` (mã giao dịch VNPay) và `e_invoices.invoice_no`. Văn bản tự do (`last_error_message`, `reason`) giữ `text`.
- **C2 (0014):** bảng có trạng thái đổi theo thời gian có `created_at` + `updated_at NOT NULL DEFAULT now()`. `refunds` thêm `updated_at`; `invoice_adjustments` thêm cả hai, vì 0015 đổi `issued_at` thành nullable nên bảng mất cột thời điểm tạo. Schema TS dùng `.$onUpdate(() => new Date())`. Code billing sau này viết `UPDATE refunds / invoice_adjustments SET …` bằng SQL thô phải tự ghi `updated_at = now()`; test quét mã nguồn của 0014 bắt chỗ quên.

## 2. Ràng buộc mới và use case nó bảo vệ

| Ràng buộc | Bảng | Use case nó bảo vệ |
|---|---|---|
| UNIQUE partial `refunds_one_per_top_up_and_kind` `(top_up_id, kind) WHERE kind IN ('top_up','late_payment')` | refunds | Admin bấm "Hoàn" hai lần, hoặc hai Admin cùng hoàn một top-up, chỉ tạo **một** lệnh hoàn VNPay (SD-2e, BR-P21 "chỉ hoàn trọn"). `account_closure` không bị chặn vì một lần đóng tài khoản chia số dư thành nhiều phần (SD-2f) |
| CHECK `refunds_requested_by_check` (`kind = 'account_closure' OR requested_by IS NOT NULL`) + FK `refunds_requested_by_fkey` → `admins` | refunds | Hoàn top-up / khoản trễ là quyết định của Admin, sổ kiểm toán phải biết Admin nào (UC-ADM-08). Hai ràng buộc này thay `top_ups_refunded_by_required_check` của 0003 (B5). Hoàn khi đóng tài khoản do hệ thống tạo (`requested_by = NULL`, CD-2 note R8 Q1) |
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
| FK `refunds.top_up_id` → `top_ups`, `invoice_adjustments.refund_id` → `refunds` | | Refund luôn có top-up gốc (giao dịch VNPay để hoàn về); điều chỉnh luôn có refund gốc |

Index thêm (không phải ràng buộc): `refunds_status_next_attempt_at_idx`, `e_invoices_status_next_attempt_at_idx`, `invoice_adjustments_status_next_attempt_at_idx` (vòng quét D7), `refunds_top_up_id_idx` (tra refund theo top-up cho Billing Exceptions, SD-2f), `refunds_requested_by_idx` (A5), `top_ups_status_expires_at_idx`.

**Ràng buộc bỏ (B5):** `top_ups_refunded_by_check` (`refunded_by` ⇒ `refunded_at`) và `top_ups_refunded_by_required_check` (`refunded` ⇒ `refunded_by`), cùng FK `top_ups_refunded_by_fkey`. Không còn cột để kiểm. Phần "Admin nào hoàn" chuyển sang `refunds_requested_by_check` + FK tới `admins`. Ràng buộc "top-up `refunded` phải có refund `top_up`" chạy qua hai bảng nên không làm bằng CHECK: `TopUpService.refund` ghi cả hai trong cùng transaction (D1, Phần 9).

**Lựa chọn khi viết (D8 để người viết migration chọn):**

- **`last_error_kind` của `refunds` và `invoice_adjustments` dùng lại `e_invoice_error_kind`** (`transient`, `data`), không tạo enum chung mới. Lý do: nghĩa giống hệt (`transient` thì hẹn thử lại, `data` là bị từ chối), và helper retry dùng chung cho e-invoice và refund (D7) chỉ phải xử lý một kiểu. Không đổi tên enum vì nó thuộc 0003 đã merge. Cái giá là tên enum có chữ `e_invoice`; COMMENT của cột ghi rõ là dùng chung.
- **`invoice_adjustments.status` dùng lại `e_invoice_status`**, vì D5 ghi rõ điều chỉnh có cùng trạng thái và retry với e-invoice (STM-7).
- **`invoice_adjustments.refund_id` để nullable.** CD-2 chỉ vẽ Refund 1 – 0..1 InvoiceAdjustment, chưa loại trừ điều chỉnh không xuất phát từ refund (ví dụ sửa sai số liệu hoá đơn). Hiện chỉ `adjustForRefund` tạo điều chỉnh, và nó luôn ghi `refund_id`.

**Đã cân nhắc và KHÔNG làm ở DB:**

- **CHECK `refunds.amount_vnd ≤ top_ups.amount_paid_vnd`** (hay tổng các refund của một top-up ≤ số đã trả). Ràng buộc chạy qua hai bảng, CHECK không làm được. Làm bằng trigger thì ẩn logic nghiệp vụ khỏi service. `RefundService.create` kiểm trong cùng transaction có khoá dòng (Phần 9; khi đóng tài khoản thì chia tối đa `amount_paid_vnd` mỗi top-up, D6).
- **CHECK `attempt_count <= 4`.** `RETRY_LIMIT` là tham số cấu hình (D7). Như LATE_WINDOW ở 0003, ghi cứng vào CHECK thì đổi tham số phải viết migration.
- **RESTRICT cho FK của `refunds`.** Theo C3, RESTRICT chỉ dành cho FK tới cha cấu thành, theo danh sách đã duyệt. `refunds → top_ups` giống `credit_transactions.top_up_id` (đang để thường). Muốn đổi thì Ân / Trí đưa vào danh sách C3 trước.

## 3. Tiền kiểm và transaction

Khối `DO` đầu file dừng cả migration (`RAISE EXCEPTION`, không áp gì) trong hai trường hợp:

| Điều kiện | Vì sao không tự điền | Test |
|---|---|---|
| `invoice_adjustments` đã có hàng | Hàng cũ không có trạng thái, số điều chỉnh của nhà cung cấp hay refund gốc. Gán `issued` thì vi phạm `invoice_adjustments_issued_check`; gán `requested` thì worker gửi lại một điều chỉnh có thể đã phát hành | "invoice_adjustments đã có hàng" |
| `top_ups.status = 'refunded'` hoặc `refunded_by IS NOT NULL` | B5 bỏ `refunded_by`: thông tin "Admin nào hoàn" sẽ mất. Dựng lại dòng `refunds` cũng không được, vì refund `done` cần mã hoàn VNPay mà DB không có | "top-up đã refunded" |

Trên `main` chưa có code nào ghi `invoice_adjustments` hay hoàn top-up, và `demo/seed.sql` cũng không, nên cả hai điều kiện luôn thoả trên DB demo và staging. `e_invoices` không cần tiền kiểm: `next_attempt_at` là cột mới, được backfill trước khi thêm CHECK.

Mỗi test tiền kiểm dựng DB ngay trước 0015 có đúng một hàng vi phạm, gọi `migrate()` và kiểm: lỗi có tiền tố `0015:`, `_migrations` vẫn dừng ở 0014, chưa có bảng `refunds`, chưa có `e_invoices.next_attempt_at`, `top_ups.refunded_by` vẫn còn.

**Transaction:** file chỉ có `CREATE TYPE` mới (không có `ALTER TYPE … ADD VALUE`), `CREATE TABLE`, `ALTER TABLE`, `UPDATE`, `CREATE INDEX`, `COMMENT`. Tất cả đều transactional nên cả file nằm trong một `BEGIN … COMMIT`. Không phụ thuộc giá trị enum vừa thêm, nên không gặp vấn đề của 0010/0011.

## 4. Thay đổi ngoài file SQL

| # | Thay đổi | Lý do | Cách kiểm |
|---|---|---|---|
| 1 | `src/db/schema/enums.ts`: `refundKindEnum`, `refundStatusEnum` | Khớp SQL | Đối chiếu máy (mục 6) |
| 2 | `src/db/schema/billing.ts`: bảng `refunds` (`requestedBy` → `admins.userId`); cột, CHECK, UNIQUE, index mới cho `invoiceAdjustments`, `eInvoices`; index `topUps (status, expires_at)`; bỏ `topUps.refundedBy` và hai CHECK; `invoiceAdjustments.issuedAt` bỏ `.notNull().defaultNow()`; comment `closureRefundedAt`, `lateRefundedAt`, `refundedAt` | Khớp SQL | `npm run typecheck`; đối chiếu máy |
| 3 | `src/db/schema/relations.ts`: `refundsRelations` (`topUp`, `requester` → `admins`, `adjustment`); `topUps.refunds` (many); `invoiceAdjustments.refund`; bỏ `topUps.refunder` | TopUp 1 – 0..* Refund, Refund 1 – 0..1 InvoiceAdjustment (CD-2); B5 | `npm run typecheck` (chưa có code dùng) |
| 4 | `test/migration-0015.integration.test.ts` | Nâng cấp từ 0014 có dữ liệu, mọi ràng buộc, FK và quy tắc xoá, B5, DB sạch, tiền kiểm | `DATABASE_URL=… npm test -w @powerme/csms` |
| 5 | `test/migration-0003.integration.test.ts`: bỏ `refunded_by` khỏi các ca của 0003 (cột, dữ liệu, hoàn hợp lệ, 4 ca CHECK, ca FK); mỗi chỗ có chú thích "bỏ ở 0015 (B5)" | Test áp **mọi** migration rồi mới kiểm ràng buộc của 0003, nên sau 0015 các ca đó kiểm một cột không còn tồn tại. Thay vì nới helper `migrate` để dừng giữa chừng, test phản ánh schema hiện tại | Test xanh; các ràng buộc của 0003 không bị B5 đụng tới vẫn được kiểm |
| 6 | `test/erd-alignment.integration.test.ts` (Trí): xoá ngoại lệ A5 `top_ups_refunded_by_fkey`. `test/erd-alignment-2.integration.test.ts` (Trí): ca nâng cấp so `migrate()` với `[0014]` cứng → `.slice(0, 1)`, như #82 đã làm cho đợt 1 | Test "ngoại lệ không bị lỗi thời" của Trí đòi xoá khi FK đã hết; Trí ghi rõ ngoại lệ này chờ B5. (Hai ca nâng cấp từng ghi cứng danh sách migration đã được #82 sửa bằng `.slice(...)`, nên PR này không đụng nữa) | Test xanh |
| 7 | `docs/THIET-KE-CSDL-VAT-LY.md`: đầu file, mục 1 (số liệu), 3.6, 4.2 (gạch hai dòng `refunded_by`, thêm ràng buộc 0015), 4.4 (đếm FK), 8 | Mô tả bảng và ràng buộc mới, B5 | Đọc lại |

Không cần sửa `scripts/migrate.mjs`, `test/helpers/apply-migrations.ts`, `demo/seed.sql`: seed không ghi `e_invoices`, `invoice_adjustments` hay hoàn top-up, cũng không tạo user admin. Không file nào trong `src/` đọc hay ghi `top_ups.refunded_by`.

## 5. Rollback

0015 vừa **thêm** vừa **bỏ** một cột (B5).

Ảnh trước 0015 chạy trên schema sau 0015: không có code nào trên `main` ghi `top_ups.refunded_by`, `invoice_adjustments` hay `refunds`. INSERT `e_invoices` của ảnh cũ (nếu có) nhận `next_attempt_at = now()` từ DEFAULT. Riêng `invoice_adjustments`: nếu ảnh cũ INSERT mà không ghi `issued_at`, DB không chặn, nhưng hàng đó nhận `status = 'requested'` và `issued_at = NULL`, rồi bị worker coi là đang chờ phát hành. Hiện chưa có code làm vậy.

Gỡ hẳn 0015 (chỉ trên DB chưa có dữ liệu refund / hoàn thật):

```sql
BEGIN;
ALTER TABLE top_ups ADD COLUMN refunded_by bigint REFERENCES users (id),
  ADD CONSTRAINT top_ups_refunded_by_check CHECK (refunded_by IS NULL OR refunded_at IS NOT NULL),
  ADD CONSTRAINT top_ups_refunded_by_required_check CHECK (status <> 'refunded' OR refunded_by IS NOT NULL);
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
DELETE FROM _migrations WHERE name = '0015_billing-refunds-wf02';
COMMIT;
```

Script này dừng nếu đã có top-up `refunded` (CHECK `refunded_by_required` thêm lại sẽ vi phạm). Khi đã có hoàn thật thì không gỡ; lùi bằng bản chụp DB trước lần deploy (`./rollback.sh --restore-db …`, `infra/staging/README.md`), như 0003.

## 6. Số liệu sau migration và đối chiếu máy

Đếm bằng truy vấn trên Postgres 16.4 (container `powerme-postgres`). Cách đếm theo `THIET-KE-CSDL-VAT-LY.md` mục 1. Cùng truy vấn tái hiện đúng số sau 0003 ở đó (34 / 30 (120) / 102 (10) / 39 / 54 / 311) và số sau 0012 ở `NHAT-KY-ERD-ALIGNMENT.md` mục 3 (43 bảng, 390 cột, 82 FK, 58 CHECK, 152 index, 30 enum (120)). 0013 của BE-07 chỉ cộng một cột (`ocpp_message_log.validation_error`). Trạng thái 0014 tái hiện đúng số ở `NHAT-KY-ERD-ALIGNMENT.md` mục 6 (417 cột, 56 CHECK; bảng, FK, index, enum không đổi).

| | Sau 0014 | Sau 0015 | 0015 thay đổi |
|---|---|---|---|
| Bảng (không tính partition con) | 43 | **44** | + `refunds` |
| Enum (giá trị) | 30 (120) | **32 (126)** | + `refund_kind` (3), `refund_status` (3) |
| Index (partial) | 152 (15) | **163 (16)** | `refunds`: PK, `gateway_refund_no_key`, `one_per_top_up_and_kind` (partial), `top_up_id_idx`, `requested_by_idx`, `status_next_attempt_at_idx`; `invoice_adjustments`: `refund_id_key`, `provider_adjustment_no_key`, `status_next_attempt_at_idx`; `e_invoices_status_next_attempt_at_idx`; `top_ups_status_expires_at_idx` |
| CHECK | 56 | **66** | + 12 (`refunds` 7, `invoice_adjustments` 4, `e_invoices` 1), − 2 (`top_ups_refunded_by_check`, `top_ups_refunded_by_required_check`) |
| FK | 82 | **84** | + 3 (`refunds` 2, `invoice_adjustments` 1), − 1 (`top_ups_refunded_by_fkey`) |
| Cột | 417 | **442** | + 26 (`refunds` 15, `invoice_adjustments` 10, `e_invoices` 1), − 1 (`top_ups.refunded_by`) |

**Đối chiếu SQL ↔ Drizzle:** `npx drizzle-kit export --sql` được nạp vào DB nháp, sau khi tạo trước 5 sequence nghiệp vụ mà DDL Drizzle tham chiếu. Phía SQL là DB trống được `migrate.mjs` áp 0000 → 0015. Phép so gồm `information_schema.columns` (kiểu, nullable, default), `pg_constraint` (định nghĩa; FK so theo định nghĩa vì SQL đặt tên `*_fkey`, Drizzle đặt `*_fk`), `pg_indexes`, `pg_enum` (thứ tự giá trị), trên 8 bảng billing (`credit_accounts`, `credit_transactions`, `top_ups`, `refunds`, `e_invoices`, `invoice_adjustments`, `loyalty_accounts`, `loyalty_transactions`) cùng `admins` và 4 enum `refund_kind`, `refund_status`, `e_invoice_status`, `e_invoice_error_kind`. Kết quả: mọi thay đổi của 0015 đều khớp. Khác biệt duy nhất là index `loyalty_transactions_one_earn_per_session` (từ `0004_wp3_t31_charging.sql`) chưa có trong `billing.ts`. Lỗi này có từ trước, Trí cũng đã ghi ở `NHAT-KY-ERD-ALIGNMENT.md` mục 3. Phần 3 của plan (`LoyaltyService.earnForSession` dựa vào ràng buộc này) sẽ thêm vào schema TS.

## 7. Không làm (có chủ ý)

- **Code billing** (`RefundService`, `RefundStateMachine`, worker quét DB, `EInvoiceService.adjustForRefund`): Phần 2, 7, 9, 12 của plan.
- **Đổi tên `top_ups.late_gateway_ref` → `late_gateway_transaction_no`:** còn mở trong decisions, chưa chốt.
- **Ghi `credit_accounts.closure_refunded_at` / `top_ups.late_refunded_at` tự động bằng trigger** khi refund `done`: service làm trong cùng transaction chuyển `done` (Phần 9, 11). DB chỉ giữ CHECK của 0003.
- **Tài liệu của đợt ERD alignment** (`NHAT-KY-ERD-ALIGNMENT.md` mục 4, 5 và `DESIGN-BRIEF-WP2-INPUT.md` G19 vẫn ghi B5 "chưa làm"): chỉ thêm một dòng trỏ sang nhật ký này ở `NHAT-KY-ERD-ALIGNMENT.md` mục 5. Phần còn lại để Trí cập nhật, vì đó là tài liệu của BE-16.
