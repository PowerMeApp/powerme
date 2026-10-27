# Nhật ký migration 0003 — `0003_billing-wf02.sql`

**Ngày:** 27/10/2026 · **Task:** T73 (WP2, chủ DB) · **Người chịu trách nhiệm:** Ngô Văn Minh Trí
**File:** `apps/csms/drizzle/0003_billing-wf02.sql` (áp lên DB đã có 0000 + 0001 + 0002; một transaction `BEGIN … COMMIT`)
**Nguồn:** LERD-1 v0.4 (`diagrams/erd/LERD-1_Charging-Billing.puml`; thuộc tính WF-02 do Khang thêm ở v0.3) · CD-2, SD-2a/b/c (PR #47, nhánh `wp5/qa-03-so-do-wf02`) · SRS BR-P13, BR-P14, BR-P21, BR-P22, BR-P37, BR-P44 · quyết định của Trí 26/10/2026 (loại điểm thưởng, UNIQUE sổ cái, nghĩa `gateway_reference`).

Migration chỉ đổi schema. **Chưa có code billing** (TopUpService, LoyaltyService, EInvoiceService…) — các cột mới chưa có ai ghi ngoài test và `demo/seed.sql`. "Test" là file trong `apps/csms/test/`, chạy bằng `DATABASE_URL=… npm test -w @powerme/csms`.

## 1. Thay đổi trong DB

| # | Bảng | Thay đổi | Lý do / nguồn | Cách kiểm |
|---|---|---|---|---|
| 0 | — | Khối `DO` tiền kiểm: dừng cả migration (không áp gì) nếu có `top_ups.gateway_reference` NULL, `top_ups.status = 'refunded'` hoặc `credit_accounts.status = 'closed'` | Ba ràng buộc mới (#3, #8, #16) cần giá trị không suy ra được từ dữ liệu cũ; không tự bịa. Trên `main` chưa có code ghi các bảng này; dữ liệu duy nhất là `seed.sql` (một top-up `credited` có `gateway_reference`, ví `active`) nên điều kiện đều thoả | `migration-0003` "tiền kiểm": thông báo `0003: 1 top_ups có gateway_reference NULL…`, `_migrations` vẫn ở 0002, chưa có cột `expires_at`, chưa có `restore` |
| 1 | `loyalty_transaction_type` | `ADD VALUE 'restore'` (cuối danh sách) | BR-P37 (trả điểm đã dùng cho top-up bị hoàn; SD-2c E). Quyết định 26/10/2026: giữ `earn/redeem/expire/adjust` của 0000 (`adjust` lo bút toán bù), **không** dùng `earned/redeemed/restored/expired` của ERD/CD-2 | `migration-0003`: thứ tự `earn, redeem, expire, adjust, restore`; INSERT `restore` gắn `top_up_id` chạy được sau COMMIT |
| 2 | (enum mới) | `CREATE TYPE e_invoice_error_kind AS ENUM ('transient', 'data')` | BR-P44, SD-2b: lỗi tạm thời → tự thử lại; lỗi dữ liệu/cấu hình → `needs_review`. Enum (không CHECK text) theo quy ước `THIET-KE-CSDL-VAT-LY.md` §1 | `migration-0003`: giá trị enum; giá trị `other` bị từ chối (22P02) |
| 3 | `top_ups` | `gateway_reference` **đổi nghĩa** thành `vnp_TxnRef` (do CSMS sinh lúc tạo, SD-2a) và `SET NOT NULL`; UNIQUE giữ nguyên; `COMMENT` mới | Quyết định 26/10/2026; ERD: `GatewayReference {BK}`. Đóng câu 11 của `THIET-KE-CSDL-VAT-LY.md` §7. Giá trị cũ (chỉ của seed) giữ nguyên, không chuyển sang `gateway_transaction_no` vì chưa từng có code ghi `vnp_TransactionNo` | `migration-0003`: `is_nullable = NO`, INSERT thiếu cột → 23502, COMMENT chứa `vnp_TxnRef`, giá trị cũ còn nguyên |
| 4 | `top_ups` | + `gateway_transaction_no text NULL` | `vnp_TransactionNo` của VNPay, ghi khi IPN/querydr báo đã trả (SD-2b). Không UNIQUE (ERD không đánh `{U}`) | `migration-0003`: kiểu/nullable |
| 5 | `top_ups` | + `points_redeemed integer NOT NULL DEFAULT 0`, CHECK `>= 0` | LERD-1 v0.4 `PointsRedeemed`; BR-P35 | `migration-0003`: hàng cũ = 0; `-1` bị từ chối |
| 6 | `top_ups` | + `expires_at timestamptz`; backfill `created_at + interval '15 minutes'`; `SET NOT NULL`; **không DEFAULT**; CHECK `expires_at > created_at` | BR-P13 (hết hạn sau 15 phút); SD-2a: TopUpService đặt `expiresAt = now + 15 min`. Không đặt DEFAULT để hằng số nghiệp vụ chỉ ở một chỗ (service) và insert quên cột thì bị từ chối | `migration-0003`: hai hàng cũ ra đúng `10:15:00Z` / `08:15:00Z`; thiếu cột → 23502; `expires_at` trước `created_at` bị từ chối |
| 7 | `top_ups` | + `refunded_at timestamptz NULL`, + `refunded_by bigint NULL REFERENCES users (id)` | UC-ADM-08, STM-4 #7 (Admin hoàn). FK tới `users`; **DB không kiểm role Admin** | `migration-0003`: hoàn hợp lệ ghi được; `refunded_by` không tồn tại → 23503 |
| 8 | `top_ups` | CHECK `(status = 'refunded') = (refunded_at IS NOT NULL)`; CHECK `refunded_by IS NULL OR refunded_at IS NOT NULL` | `refunded` là trạng thái cuối của STM-4: đã hoàn thì phải biết lúc nào | `migration-0003`: `refunded` thiếu `refunded_at`, `refunded_at` khi chưa `refunded`, `refunded_by` thiếu `refunded_at` — đều 23514 |
| 9 | `top_ups` | + `late_gateway_ref text NULL UNIQUE`, `late_paid_at`, `late_amount_vnd bigint`, `late_refunded_at` | BR-P13 + SD-2c D: thanh toán tới sau cửa sổ 1 giờ được ghi trên top-up, không cộng ví, chờ Admin hoàn; UNIQUE để IPN lặp không ghi lần hai (TC-STM4-15) | `migration-0003`: mã muộn trùng → 23505 `top_ups_late_gateway_ref_key` |
| 10 | `top_ups` | CHECK ba cột `late_gateway_ref/late_paid_at/late_amount_vnd` cùng null hoặc cùng có, `late_amount_vnd >= 0`; CHECK `late_refunded_at` chỉ khi có `late_paid_at` và `>=` nó | SD-2c D ghi ba cột cùng một UPDATE; chỉ hoàn khoản đã nhận | `migration-0003`: thiếu cột, số âm, hoàn khi không có khoản muộn, hoàn trước lúc nhận — đều 23514 |
| 11 | `credit_transactions` | `DROP INDEX credit_transactions_one_per_top_up` (UNIQUE `(top_up_id)`); `CREATE UNIQUE INDEX credit_transactions_one_per_top_up_and_type ON (top_up_id, transaction_type) WHERE top_up_id IS NOT NULL` | Quyết định 26/10/2026 (ERD v0.3 §3 của Khang; SD-2c E): top-up đã hoàn có một dòng `top_up` và một dòng `refund`. Index cũ chặn dòng `refund`. `credit_transactions_one_debit_per_session` giữ nguyên | `migration-0003`: index cũ không còn, index mới đúng định nghĩa; `refund` sau `top_up` được; `top_up` thứ hai và `refund` thứ hai → 23505 |
| 12 | `e_invoices` | + `last_error_kind e_invoice_error_kind NULL`, `last_error_message text NULL`, `last_attempt_at timestamptz NULL`; CHECK `last_error_kind IS NULL OR last_attempt_at IS NOT NULL` | BR-P44, SD-2b (STM-7 #3 ghi `last_error_kind`, `last_error_message`); lỗi chỉ có sau một lần gọi | `migration-0003`: thiếu `last_attempt_at` → 23514; lỗi `data` hợp lệ ghi được |
| 13 | `credit_accounts` | + `closed_at timestamptz NULL`, `closure_refunded_at timestamptz NULL` | UC-ACC-02 (đóng tài khoản), BR-P21 (hoàn số dư khi đóng), UC-ADM-08 | `migration-0003`: kiểu/nullable; hàng cũ null |
| 14 | `credit_accounts` | CHECK `(status = 'closed') = (closed_at IS NOT NULL)`; CHECK `closure_refunded_at IS NULL OR (closed_at IS NOT NULL AND closure_refunded_at >= closed_at)` | `closed` là trạng thái cuối của STM-5; hoàn số dư chỉ sau khi đóng | `migration-0003`: `closed` thiếu `closed_at`, `closed_at` khi còn `active`, hoàn trước lúc đóng → 23514; đóng hợp lệ ghi được |

Mọi tiền là `bigint` VND, mọi thời điểm `timestamptz` (ADR-0009). Mỗi cột mới có `COMMENT ON COLUMN`.

**Transaction:** như 0001, `ALTER TYPE … ADD VALUE 'restore'` nằm trong `BEGIN … COMMIT` (được phép từ PostgreSQL 12) và không câu nào trong file dùng `restore`. `e_invoice_error_kind` là type mới tạo trong cùng transaction nên dùng được ngay cho cột `last_error_kind`.

## 2. Thay đổi ngoài file SQL

| # | Thay đổi | Lý do | Cách kiểm |
|---|---|---|---|
| 15 | `src/db/schema/enums.ts`: `restore` cuối `loyaltyTransactionTypeEnum`; enum mới `eInvoiceErrorKindEnum` | Khớp SQL | Đối chiếu máy (mục 4) |
| 16 | `src/db/schema/billing.ts`: 14 cột, UNIQUE `late_gateway_ref`, 9 CHECK, index ledger mới; `gatewayReference` `.notNull()`, `expiresAt` `.notNull()` không default | Khớp SQL; insert Drizzle không có `gatewayReference`/`expiresAt` sẽ lỗi lúc typecheck | `npm run typecheck`; đối chiếu máy |
| 17 | `src/db/schema/relations.ts`: `topUps.creditTransaction` (one) → `creditTransactions` (many); thêm `refunder` (→ `users`) | Một top-up nay có tới hai dòng ledger | `npm run typecheck` (chưa có code nào dùng hai relation này) |
| 18 | `demo/seed.sql`: INSERT `top_ups` thêm `expires_at = now() + interval '15 minutes'` | Cột thành NOT NULL không default | `demo:db` trên DB sạch (0000 → 0003 rồi seed) và `scripts/seed-demo.mjs` trên DB nâng cấp từ 0002 — đều chạy được |
| 19 | `test/migration-0001`, `migration-0002`: danh sách migration có thêm `0003_billing-wf02`; `migrate-script` không cần sửa (so với `listMigrations()`) | Thứ tự migration theo tên file | Các test đó xanh |
| 20 | `test/migration-0003.integration.test.ts` (23 test) | (a) nâng cấp từ 0002 có dữ liệu, (b) ràng buộc, (c) `migrate()` + `_migrations`, tiền kiểm | `DATABASE_URL=… npm test -w @powerme/csms` |
| 21 | `infra/staging/README.md` mục Rollback, chú thích đầu `rollback.sh`: nêu đúng migration nào có `ADD VALUE` (0001, 0003), 0003 có `SET NOT NULL` | Trước ghi "0001/0002 có ADD VALUE" — 0002 không có | `rollback.sh` vẫn bắt từ khoá `ALTER TYPE`/`SET NOT NULL` trong 0003 (cảnh báo không additive) — logic không đổi |

## 3. Rollback

**Không lùi ảnh được an toàn sau 0003.** Postgres không có `DROP VALUE` nên `restore` không gỡ được; ảnh trước 0003 INSERT `top_ups` không có `expires_at`/`gateway_reference` sẽ bị từ chối. Cách lùi đúng là `./rollback.sh --restore-db backups/pre-<tag>-<giờ>.dump` (bản chụp trước lần deploy áp 0003; dữ liệu ghi sau lúc chụp sẽ mất) — xem `infra/staging/README.md` mục Rollback.

## 4. Số liệu sau migration

Đếm bằng truy vấn trên Postgres 17 beta nhúng (cách đếm: `THIET-KE-CSDL-VAT-LY.md` mục 1). Cột "Sau 0002" đếm lại bằng cùng truy vấn trên DB chỉ áp 0000 → 0002 và khớp số đã ghi trước đó.

| | Sau 0002 | Sau 0003 |
|---|---|---|
| Bảng (không tính partition con) | 34 | 34 |
| Enum (giá trị) | 29 (117) | **30 (120)** |
| Index (partial) | 100 (9) | **101 (9)** |
| CHECK | 27 | **36** |
| FK | 53 | **54** |
| Cột | 297 | **311** |

Đối chiếu máy SQL ↔ Drizzle (`drizzle-kit export --sql` nạp vào DB nháp, so `information_schema.columns`, `pg_constraint`, `pg_indexes`, `pg_enum`): 311/311 cột, 157/157 ràng buộc, 30/30 enum khớp; 101 index ở hai phía, khác biệt duy nhất là 6 index của bảng partition (`ON ONLY`), đúng ADR-0008. CI chạy test trên Postgres 16.4.

## 5. Không làm (có chủ ý)

- **BM02 run 2 F11** (`ReconciliationRecord.MessageLogRef`): không đụng; lý do ở `THIET-KE-CSDL-VAT-LY.md` mục 9.
- **BM02 run 2 F12** (giá trị miền tariff band / origin / payment mode): không đụng.
- **Code billing** (TopUpService, CreditLedgerService, LoyaltyService, EInvoiceService, job hết hạn/thử lại): việc của WP5.
- **CD-2 (PR #47) và AD-1** vẫn ghi `earned/redeemed/restored/expired` / `[earned]`: không sửa nhánh/sơ đồ của người khác; cần Khang (CD-2) và WP1 (AD-1) đổi theo quyết định 26/10/2026.
- **PR #58** (Sơn, chưa merge) có migration đánh số 0003–0006 đụng `loyalty_transactions` và `session_tariff_segments`: khi rebase phải đổi số thành 0004+ và kiểm lại hai bảng đó trên schema sau 0003.
