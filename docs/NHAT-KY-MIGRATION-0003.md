# Nhật ký migration 0003 — `0003_billing-wf02.sql`

**Ngày:** 27/10/2026 · **Task:** T73 (WP2, chủ DB) · **Người chịu trách nhiệm:** Ngô Văn Minh Trí
**File:** `apps/csms/drizzle/0003_billing-wf02.sql` (áp lên DB đã có 0000 + 0001 + 0002; một transaction `BEGIN … COMMIT`)
**Nguồn:** LERD-1 v0.4 (`diagrams/erd/LERD-1_Charging-Billing.puml`; thuộc tính WF-02 do Khang thêm ở v0.3) · CD-2, SD-2a/b/c (PR #47, nhánh `wp5/qa-03-so-do-wf02`) · SRS (`docs/requirements/report3-srs.md`) BR-P13, BR-P14, BR-P21, BR-P22, BR-P35, BR-P37, BR-P44, UC-PAY-01, UC-PAY-03, UC-ACC-02, UC-ADM-08 · quyết định của Trí 26/10/2026 (loại điểm thưởng, UNIQUE sổ cái, nghĩa `gateway_reference`) và 27/10/2026 (bốn ràng buộc bổ sung trên PR #60, mục 2).

Migration chỉ đổi schema. **Chưa có code billing** (TopUpService, LoyaltyService, EInvoiceService…) — các cột mới chưa có ai ghi ngoài test và `demo/seed.sql`. "Test" là file trong `apps/csms/test/`, chạy bằng `DATABASE_URL=… npm test -w @powerme/csms`; mọi ràng buộc dưới đây có ca hợp lệ và ca bị từ chối trong `migration-0003.integration.test.ts` (31 test).

## 1. Cột và kiểu mới

| # | Bảng | Thay đổi | Use case / nguồn |
|---|---|---|---|
| 1 | `loyalty_transaction_type` | `ADD VALUE 'restore'` (cuối danh sách) | Admin hoàn một top-up đã dùng điểm thì điểm được trả lại (BR-P37, SD-2c E). Quyết định 26/10/2026: giữ `earn/redeem/expire/adjust` (`adjust` lo bút toán bù cho phiên bị sửa/hoàn), **không** dùng `earned/redeemed/restored/expired` của ERD/CD-2 |
| 2 | (enum mới) | `e_invoice_error_kind` (`transient`, `data`) | Lỗi tạm thời được tự thử lại, lỗi dữ liệu chuyển Admin (BR-P44, SD-2b). Enum (không CHECK text) theo quy ước `THIET-KE-CSDL-VAT-LY.md` §1 |
| 3 | `top_ups` | `gateway_reference` **đổi nghĩa** thành `vnp_TxnRef` (do CSMS sinh lúc tạo, SD-2a); COMMENT mới. Giá trị cũ (chỉ của seed) giữ nguyên | Tài xế tạo top-up (UC-PAY-01) và IPN tìm top-up bằng `vnp_TxnRef` (SD-2b). Đóng câu 11 của `THIET-KE-CSDL-VAT-LY.md` §7 |
| 4 | `top_ups` | + `gateway_transaction_no text` | Lưu `vnp_TransactionNo` khi VNPay báo đã trả (SD-2b) để đối chiếu và hoàn tiền với cổng |
| 5 | `top_ups` | + `points_redeemed integer NOT NULL DEFAULT 0` | Tài xế dùng điểm khi nạp (UC-PAY-03, BR-P35); hoàn top-up phải trả đúng số điểm (BR-P37) |
| 6 | `top_ups` | + `expires_at timestamptz`, hàng cũ điền `created_at + 15 phút`, rồi NOT NULL, **không DEFAULT** | Top-up chưa trả hết hạn sau 15 phút (BR-P13; job hết hạn của SD-2c C). 15 phút chỉ nằm ở TopUpService (SD-2a), DB chỉ bắt có giá trị |
| 7 | `top_ups` | + `refunded_at`, `refunded_by bigint REFERENCES users (id)` | Admin hoàn top-up (STM-4 #7, UC-ADM-08) |
| 8 | `top_ups` | + `late_gateway_ref`, `late_paid_at`, `late_amount_vnd bigint`, `late_refunded_at` | Khoản trả tới sau cửa sổ 1 giờ: ghi trên top-up, không cộng ví, Admin hoàn về nguồn (BR-P13, SD-2c D, UC-ADM-08) |
| 9 | `e_invoices` | + `last_error_kind`, `last_error_message`, `last_attempt_at` | Thử lại hoá đơn 5 phút / 30 phút / 2 giờ và Admin xử lý `needs_review` cần biết lỗi gần nhất (BR-P44, STM-7 #3) |
| 10 | `credit_accounts` | + `closed_at`, `closure_refunded_at` | Tài xế yêu cầu đóng tài khoản (UC-ACC-02) rồi Admin hoàn số dư chưa dùng (BR-P21, UC-ADM-08) |

Mọi tiền là `bigint` VND, mọi thời điểm `timestamptz` (ADR-0009). Mỗi cột mới có `COMMENT ON COLUMN`.

## 2. Mọi ràng buộc của 0003 và use case nó bảo vệ

"Mới 27/10" = bốn ràng buộc Trí duyệt trên PR #60 ngày 27/10/2026.

| Ràng buộc | Bảng | Use case nó bảo vệ |
|---|---|---|
| `gateway_reference` NOT NULL (UNIQUE `top_ups_gateway_reference_key` có từ 0000) | top_ups | IPN của VNPay luôn tìm được đúng một top-up bằng `vnp_TxnRef` (SD-2b, BR-P13) |
| UNIQUE `top_ups_gateway_transaction_no_key` partial `WHERE gateway_transaction_no IS NOT NULL` (**mới 27/10**) | top_ups | Một giao dịch VNPay chỉ cộng tiền cho đúng một top-up: IPN phát lại hoặc lỗi code gắn cùng `vnp_TransactionNo` vào top-up thứ hai bị từ chối (BR-P13) |
| UNIQUE `top_ups_late_gateway_ref_key` | top_ups | IPN muộn bị VNPay gửi lại không ghi khoản muộn lần hai (SD-2c D, TC-STM4-15) |
| `expires_at` NOT NULL; CHECK `top_ups_expires_at_check` (`expires_at > created_at`) | top_ups | Mọi top-up đều có hạn để job hết hạn quét được; hạn không thể trước lúc tạo (BR-P13) |
| CHECK `top_ups_points_redeemed_check` (`>= 0`) | top_ups | Không có top-up "dùng âm điểm" làm tăng số dư điểm (BR-P35) |
| CHECK `top_ups_points_check` (`(points_redeemed = 0) = (points_discount_vnd = 0)`) (**mới 27/10**) | top_ups | Tài xế đổi 500 điểm lấy 5.000 VND: lỗi ghi giảm giá mà 0 điểm sẽ cho tiêu điểm mà không trừ số dư điểm, và hoàn (STM-4 #7) không trả lại đúng số điểm (BR-P35, BR-P37). **Không** ghi cứng tỉ lệ 100 điểm = 1.000 VND — chính sách Admin cấu hình |
| CHECK `top_ups_refunded_check` (`(status = 'refunded') = (refunded_at IS NOT NULL)`) | top_ups | Màn Billing Exceptions và đối soát biết top-up được hoàn lúc nào (STM-4 #7, UC-ADM-08) |
| CHECK `top_ups_refunded_by_check` (`refunded_by` ⇒ `refunded_at`) | top_ups | Không có "người hoàn" cho top-up chưa được hoàn (UC-ADM-08) |
| CHECK `top_ups_refunded_by_required_check` (`status <> 'refunded' OR refunded_by IS NOT NULL`) (**mới 27/10**) | top_ups | Hoàn top-up là thao tác tay của Admin (STM-4 #7, UC-ADM-08): sổ kiểm toán phải biết Admin nào hoàn. Hoàn khi đóng ví ghi ở `credit_accounts.closure_refunded_at`, không bị ảnh hưởng |
| FK `top_ups.refunded_by` → `users (id)` | top_ups | Người hoàn là tài khoản có thật (UC-ADM-08). DB không kiểm role Admin — `RolesGuard` lo |
| CHECK `top_ups_late_payment_check` (ba cột `late_*` cùng có hoặc cùng trống, `late_amount_vnd >= 0`) | top_ups | Admin thấy đủ mã, lúc nhận và số tiền của khoản muộn cần hoàn (SD-2c D, UC-ADM-08) |
| CHECK `top_ups_late_payment_status_check` (`late_gateway_ref IS NULL OR status = 'expired'`) (**mới 27/10**) | top_ups | Chỉ top-up `expired` nhận khoản muộn và vẫn `expired`; IPN cũ cho top-up `failed`/`credited` trả RspCode 02 và không ghi gì (SD-2c D). Chặn service lỗi ghi khoản muộn lên top-up `credited` — tức nhận tiền hai lần (BR-P13) |
| CHECK `top_ups_late_refunded_check` (`late_refunded_at` ⇒ có `late_paid_at` và `>=` nó) | top_ups | Admin chỉ hoàn khoản muộn đã thực nhận, không hoàn trước lúc nhận (BR-P13, UC-ADM-08) |
| UNIQUE `credit_transactions_one_per_top_up_and_type` `(top_up_id, transaction_type) WHERE top_up_id IS NOT NULL` (thay `credit_transactions_one_per_top_up`) | credit_transactions | Một top-up cộng ví đúng một lần (`top_up`, BR-P13) và hoàn tối đa một lần (`refund`, BR-P21 "chỉ hoàn trọn", SD-2c E); index cũ chặn luôn dòng `refund` |
| CHECK `e_invoices_last_error_check` (`last_error_kind` ⇒ `last_attempt_at`) | e_invoices | Admin xử lý hoá đơn `needs_review` biết lần gọi lỗi xảy ra lúc nào (BR-P44, UC-ADM-08) |
| Kiểu enum `e_invoice_error_kind` cho `last_error_kind` | e_invoices | Job thử lại chỉ thử lại lỗi `transient`; lỗi `data` sang `needs_review` (BR-P44); giá trị lạ bị từ chối |
| CHECK `credit_accounts_closed_check` (`(status = 'closed') = (closed_at IS NOT NULL)`) | credit_accounts | Biết ví đóng lúc nào để chọn các top-up gần nhất mà hoàn số dư (UC-ACC-02, BR-P21) |
| CHECK `credit_accounts_closure_refunded_check` (`closure_refunded_at` ⇒ có `closed_at` và `>=` nó) | credit_accounts | Số dư chỉ được hoàn khi ví đã đóng (BR-P21, UC-ADM-08) |

**Đã cân nhắc và KHÔNG làm ở DB (quyết định của Trí 27/10/2026):**

- **CHECK `late_paid_at > expires_at + 1 giờ`.** Cửa sổ trả muộn 1 giờ (LATE_WINDOW, BR-P13) là tham số nghiệp vụ cấu hình được; ghi cứng vào CHECK thì đổi tham số phải viết migration, và DB sẽ từ chối đúng khoản mà service đã phân loại theo giá trị mới. **TopUpService kiểm** (`now ≤ expiresAt + LATE_WINDOW` → cộng ví, sau đó → ghi khoản muộn, SD-2c D).
- **`refund_status` (requested / done / failed).** SD-2c ghi "not modelled yet": gọi hoàn tiền với cổng thất bại sau khi commit thì cần trạng thái để thử lại. Giữ **Planned**, không có cột ở 0003.

## 3. Tiền kiểm và transaction

Khối `DO` đầu file dừng cả migration (`RAISE EXCEPTION`, không áp gì, không điền giá trị giả) nếu dữ liệu cũ vi phạm ràng buộc mới:

| Điều kiện | Ràng buộc bị vi phạm nếu cho qua | Test |
|---|---|---|
| `top_ups.gateway_reference IS NULL` | `gateway_reference` NOT NULL | "tiền kiểm: top-up gateway_reference NULL" |
| `top_ups.status = 'refunded'` | `top_ups_refunded_check`, `top_ups_refunded_by_required_check` (hàng cũ không có `refunded_at`/`refunded_by`) | "tiền kiểm: top-up refunded" |
| `top_ups.points_discount_vnd <> 0` | `top_ups_points_check` (hàng cũ nhận `points_redeemed = 0`; số điểm thật không suy ra được) | "tiền kiểm: top-up có giảm giá điểm" |
| `credit_accounts.status = 'closed'` | `credit_accounts_closed_check` | "tiền kiểm: ví closed" |

Ràng buộc chỉ trên cột **mới** (`late_*` chỉ khi `expired`, UNIQUE `gateway_transaction_no`, `late_payment_check`, `e_invoices_last_error_check`, `closure_refunded_check`) không cần tiền kiểm: các cột đó chưa có trước 0003, hàng cũ nhận NULL nên luôn thoả. Trên `main` dữ liệu billing duy nhất là `seed.sql` (một top-up `credited` có `gateway_reference`, `points_discount_vnd = 0`, ví `active`) nên tiền kiểm cho qua.

Mỗi test tiền kiểm dựng DB ở 0002 có đúng một hàng vi phạm, gọi `migrate()` và kiểm: lỗi có tiền tố `0003:`, `_migrations` vẫn dừng ở 0002, chưa có cột `expires_at`, chưa có giá trị `restore`.

**Transaction:** như 0001, `ALTER TYPE … ADD VALUE 'restore'` nằm trong `BEGIN … COMMIT` (được phép từ PostgreSQL 12) và không câu nào trong file dùng `restore`. `e_invoice_error_kind` là type mới tạo trong cùng transaction nên dùng được ngay.

## 4. Thay đổi ngoài file SQL

| # | Thay đổi | Lý do | Cách kiểm |
|---|---|---|---|
| 1 | `src/db/schema/enums.ts`: `restore` cuối `loyaltyTransactionTypeEnum`; enum mới `eInvoiceErrorKindEnum` | Khớp SQL | Đối chiếu máy (mục 6) |
| 2 | `src/db/schema/billing.ts`: 14 cột, UNIQUE `late_gateway_ref`, UNIQUE partial `gateway_transaction_no`, 12 CHECK, index ledger mới; `gatewayReference`, `expiresAt` `.notNull()` không default | Khớp SQL; insert Drizzle thiếu hai cột này lỗi lúc typecheck | `npm run typecheck`; đối chiếu máy |
| 3 | `src/db/schema/relations.ts`: `topUps.creditTransaction` (one) → `creditTransactions` (many); thêm `refunder` (→ `users`) | Một top-up nay có tới hai dòng ledger | `npm run typecheck` (chưa có code dùng hai relation này) |
| 4 | `demo/seed.sql`: INSERT `top_ups` thêm `expires_at = now() + interval '15 minutes'` | Cột NOT NULL không default | DB sạch 0000 → 0003 + `seed-demo.mjs`; DB ở 0002 + seed cũ → `migrate.mjs` → `seed-demo.mjs` — đều thoát 0 |
| 5 | `test/migration-0001`, `migration-0002`: danh sách migration có `0003_billing-wf02`; `migrate-script` so với `listMigrations()` nên không sửa | Thứ tự migration theo tên file | Các test đó xanh |
| 6 | `test/migration-0003.integration.test.ts` (31 test) | (a) nâng cấp từ 0002 có dữ liệu, (b) mọi ràng buộc, (c) `migrate()` + `_migrations`, tiền kiểm 4 kịch bản | `DATABASE_URL=… npm test -w @powerme/csms` |
| 7 | `infra/staging/README.md` mục Rollback, chú thích đầu `rollback.sh` | Nêu đúng migration nào có `ADD VALUE` (0001, 0003; trước ghi nhầm 0002) | `rollback.sh` vẫn bắt `ALTER TYPE`/`SET NOT NULL` trong 0003 (cảnh báo không additive) — logic không đổi |

## 5. Rollback

**Không lùi ảnh được an toàn sau 0003.** Postgres không có `DROP VALUE` nên `restore` không gỡ được; ảnh trước 0003 INSERT `top_ups` không có `expires_at`/`gateway_reference` sẽ bị từ chối. Cách lùi đúng là `./rollback.sh --restore-db backups/pre-<tag>-<giờ>.dump` (bản chụp trước lần deploy áp 0003; dữ liệu ghi sau lúc chụp sẽ mất) — xem `infra/staging/README.md` mục Rollback.

## 6. Số liệu sau migration

Đếm bằng truy vấn trên Postgres 17 beta nhúng (cách đếm: `THIET-KE-CSDL-VAT-LY.md` mục 1). Cột "Sau 0002" đếm lại bằng cùng truy vấn trên DB chỉ áp 0000 → 0002 và khớp số đã ghi trước đó.

| | Sau 0002 | Sau 0003 |
|---|---|---|
| Bảng (không tính partition con) | 34 | 34 |
| Enum (giá trị) | 29 (117) | **30 (120)** |
| Index (partial) | 100 (9) | **102 (10)** |
| CHECK | 27 | **39** |
| FK | 53 | **54** |
| Cột | 297 | **311** |

Đối chiếu máy SQL ↔ Drizzle (`drizzle-kit export --sql` nạp vào DB nháp, so `information_schema.columns`, `pg_constraint`, `pg_indexes`, `pg_enum`): 311/311 cột, 160/160 ràng buộc PK/UNIQUE/FK/CHECK, 30/30 enum khớp; 102 index ở hai phía, khác biệt duy nhất là 6 index của bảng partition (`ON ONLY`), đúng ADR-0008. CI chạy test trên Postgres 16.4.

## 7. Không làm (có chủ ý)

- **BM02 run 2 F11** (`ReconciliationRecord.MessageLogRef`): không đụng; lý do ở `THIET-KE-CSDL-VAT-LY.md` mục 9.
- **BM02 run 2 F12** (giá trị miền tariff band / origin / payment mode): không đụng.
- **Code billing** (TopUpService, CreditLedgerService, LoyaltyService, EInvoiceService, job hết hạn/thử lại): việc của WP5. Cửa sổ 1 giờ phải được kiểm ở TopUpService (mục 2).
- **`refund_status`:** Planned (mục 2).
- **CD-2 (PR #47) và AD-1** vẫn ghi `earned/redeemed/restored/expired` / `[earned]`: không sửa nhánh/sơ đồ của người khác; cần Khang (CD-2) và WP1 (AD-1) đổi theo quyết định 26/10/2026.
- **PR #58** (Sơn, chưa merge) có migration đánh số 0003–0006 đụng `loyalty_transactions` và `session_tariff_segments`: khi rebase phải đổi số thành 0004+ và kiểm lại hai bảng đó trên schema sau 0003.
