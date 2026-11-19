# Nhật ký migration 0027 — `0027_dem-lan-giu-cho.sql`

**Ngày:** 19/11/2026 · **Task:** T32 Phần 8c (WP5, việc nền billing theo lease) · **Người chịu trách nhiệm:** Lê Bảo Khang · **Review:** Trí (chủ DB)
**File:** `apps/csms/drizzle/0027_dem-lan-giu-cho.sql` (áp lên DB đã có 0000 → 0025; **hai** transaction, xem mục 3)
**Nguồn:** Trí nêu khi merge 8b (#156); Khang đồng ý 17/11 và chốt chi tiết 19/11 (prompt T32 Phần 8c).

**Vì sao là 0027:** `0026` để cho PR của Sơn (chưa merge lúc viết). `scripts/migrate.mjs` áp mọi file chưa có trong `_migrations` theo tên, không đòi số liên tiếp; 0027 **không dùng gì của 0026**, nên merge theo thứ tự nào cũng được.

## 1. Thay đổi

| #   | Đối tượng | Thay đổi | Use case |
| --- | --- | --- | --- |
| 1 | enum `top_up_exception_kind` | thêm `retry_exhausted` | Top-up mà vòng quét querydr giữ chỗ quá 5 lần liên tiếp không ra kết quả → `expired` + ngoại lệ cho Admin (Billing Exceptions, "Kiểm tra lại") |
| 2 | cột `unfinished_claims` trên `top_ups`, `e_invoices`, `invoice_adjustments`, `refunds` | `integer NOT NULL DEFAULT 0`; dòng có sẵn nhận 0 | Bộ đếm lần giữ chỗ (lease, `due-rows.ts`) liên tiếp chưa ra kết quả: `claimDue` tăng 1, `lockLeased` của tx2 commit thì về 0 |
| 3 | CHECK `<bảng>_unfinished_claims_check` (bốn bảng) | `unfinished_claims >= 0` | |
| 4 | CHECK `top_ups_exception_kind_status_check` | DROP + ADD: `retry_exhausted` đi với `status = 'expired'` (cùng nhánh `unresolved_04/07`); nhánh cũ giữ nguyên | Không có `retry_exhausted` trên `pending` / `credited` |
| 5 | COMMENT | type `top_up_exception_kind`, `top_ups.exception_kind`, bốn cột mới, `top_ups.next_attempt_at` (lịch querydr mới 2/15/30/45/60 + mốc 75 khi RC 94, cũng T32 Phần 8c) | |

## 2. Vì sao một bộ đếm riêng, trên cả bốn bảng

- Trước 8c, dòng làm `handle` ném lỗi (tiến trình sập, lỗi lặp ở tx2, ví dụ lỗi sổ cái khi cộng tiền) giữ lease, hết lease lại được giữ chỗ, mãi mãi.
  - `top_ups` không có bộ đếm nào.
  - `e_invoices.attempt_count` chỉ tăng khi tx2 ghi được kết quả, nên không đếm được ca này.
- `attempt_count` giữ nguyên nghĩa (số lượt gọi bên ngoài đã ghi kết quả, guard của STM-7 / STM-10). `unfinished_claims` đếm việc khác: số lần giữ chỗ mà chưa tới được COMMIT của tx2.
- Cột có trên cả bốn bảng của `LeasedTable` để `claimDue` / `lockLeased` dùng chung một câu SQL. `refunds` và `invoice_adjustments` chưa có worker: chỉ có cột, xử lý khi hết lượt làm ở Phần 9.
- Giới hạn là hằng `UNFINISHED_CLAIM_LIMIT = 5` trong `due-rows.ts`, không để ở DB (không CHECK cận trên): dòng hết lượt giữ số 6 làm dấu vết.

## 3. Hai transaction trong một file

- PostgreSQL không cho **dùng** giá trị enum vừa `ADD VALUE` trong cùng transaction ("unsafe use of new value"), mà CHECK ở bước 4 tham chiếu `'retry_exhausted'`.
- Tiền lệ 0010/0011 tách thành hai file. Ở đây số đã chốt là 0027, nên dùng hai khối `BEGIN … COMMIT` trong cùng file:
  - khối 1: `ALTER TYPE … ADD VALUE IF NOT EXISTS 'retry_exhausted'`;
  - khối 2: cột, CHECK, COMMENT.
- `migrate.mjs` và `test/helpers/apply-migrations.ts` gửi cả file bằng một simple query; `COMMIT` ở giữa có hiệu lực.
- Khối 2 lỗi: giá trị enum đã commit, `_migrations` chưa ghi 0027. Chạy lại an toàn nhờ `IF NOT EXISTS` (có test).

## 4. Dữ liệu có sẵn

- Không backfill: dòng có sẵn nhận `0` qua DEFAULT (PG 11+ thêm cột có DEFAULT hằng không viết lại bảng).
- Không có giá trị enum hay ràng buộc nào làm dòng cũ vi phạm: CHECK mới chỉ mở rộng nhánh `expired`.

## 5. Test cũ phải sửa

- `apps/csms/test/billing-top-up-timeout.integration.test.ts`, ca `querydr_row_not_pending`: trước 8c `lockLeased` chỉ đọc nên dòng giữ nguyên hoàn toàn; nay tx2 commit nên `unfinished_claims` 1 → 0. Assertion đổi thành "giữ nguyên trừ `unfinished_claims = 0`".
- Ba test migration cũ chạy tới migration mới nhất nên thấy thay đổi của 0027. Chỉ thu phạm vi, không đổi điều chúng kiểm:
  - `migration-0015`: câu liệt kê cột `refunds` bỏ qua `unfinished_claims`;
  - `migration-0021`: enum kiểm ba giá trị đầu (migration sau chỉ thêm vào cuối); COMMENT `next_attempt_at` kiểm lịch mới vì 0027 viết lại;
  - `migration-0024`: so `top_ups` trước / sau chỉ trên các cột có trước 0024.
- `apps/csms/test/billing-worker.integration.test.ts`: logger giả thêm `error` (chữ ký `runLeasedBatch` nay nhận `Pick<Logger, 'warn' | 'error'>`).

## 6. Cách kiểm

- `apps/csms/test/migration-0027.integration.test.ts`:
  - nâng cấp DB có dòng trên bốn bảng (áp mọi migration có tên trước 0027, gồm 0026 nếu đã có): dòng cũ nhận 0, cột khác giữ nguyên; chạy lại không áp gì;
  - chạy lại file khi khối enum đã commit;
  - bốn cột `integer NOT NULL DEFAULT 0`; CHECK chặn số âm;
  - enum có `retry_exhausted`; `retry_exhausted` + `expired` được, + `pending` / `credited` / `failed` bị chặn; nhánh cũ giữ nguyên;
  - COMMENT; schema TS khớp.
- Code dùng cột: `due-rows.ts` (`claimDue`, `lockLeased`, `runLeasedBatch`), `TopUpService.onClaimsExhausted`, `EInvoiceService.onClaimsExhausted` / `adminRetry`. Test: `billing-worker`, `billing-top-up-timeout`, `billing-e-invoice` (mục "hết lượt giữ chỗ").
