# Nhật ký migration 0024 — `0024_top-up-payment-conflicts.sql`

**Ngày:** 16/11/2026 · **Task:** T32 Phần 8b bổ sung (WP5) · **Người chịu trách nhiệm:** Lê Bảo Khang
**File:** `apps/csms/drizzle/0024_top-up-payment-conflicts.sql` (áp lên DB đã có 0000 → 0022; một transaction `BEGIN … COMMIT`)
**Nguồn:** Ân chốt 16/11 chiều, sau lỗi Gap 2 ngày 15/11: kết quả thanh toán mâu thuẫn (`conflicting_result`) chỉ được log error nên Admin không thấy.

**Vì sao là 0024, không phải 0023:** trên `main` (`e40a673`) migration mới nhất là `0022_anh-mau-xe.sql`, nhưng nhánh `feat/t134-do-lech-dong-ho-tru` của Trí (T134, chưa merge) đã có `0023_t134-do-lech-dong-ho-tru.sql`. Khang chọn nhường 0023. `scripts/migrate.mjs` áp mọi file chưa áp theo thứ tự tên và không đòi số liên tiếp, nên main tạm có lỗ 0023 không sao; DB đã áp 0024 vẫn áp 0023 về sau được vì hai migration độc lập (khác bảng). Test `migration-0024` chấp nhận có hay chưa có 0023.

## 1. Thay đổi

| #   | Đối tượng | Thay đổi | Use case |
| --- | --- | --- | --- |
| 1 | enum `top_up_payment_conflict_reason` | `extra_payment`, `amount_differs` | Phân loại lần trả mâu thuẫn cho Admin |
| 2 | enum `payment_result_source` | `ipn`, `querydr`, `recheck` | Biết kết quả tới từ đâu (`querydr` không sinh mâu thuẫn, giữ cho đủ) |
| 3 | bảng `top_up_payment_conflicts` | `id` identity, `top_up_id` → `top_ups` (NO ACTION), `gateway_transaction_no varchar(100)`, `amount_vnd bigint`, `paid_at`, `source`, `reason`, `created_at` / `updated_at`, `reviewed_at`, `reviewed_by` → `admins(user_id)`, `review_note` | VNPay báo trả thêm lần thứ ba, hoặc cùng giao dịch khác số tiền: Admin thấy ở Billing Exceptions (Phần 10), xử lý ngoài hệ thống |
| 4 | UNIQUE `top_up_payment_conflicts_top_up_txn_key (top_up_id, gateway_transaction_no)` | | VNPay gửi lại cùng IPN 10 lần → một dòng. Theo cặp (không theo một cột) để dòng `amount_differs` ghi được |
| 5 | CHECK `…_amount_check` | `amount_vnd >= 0` | |
| 6 | CHECK `…_reviewed_check` | `reviewed_at` ⇔ `reviewed_by` | Biết ai đã xử lý |
| 7 | CHECK `…_review_note_check` | đã xem thì `review_note` không rỗng | Ghi lại đã xử lý thế nào (không có nút hoàn) |
| 8 | index `…_reviewed_by_idx`, partial `…_unreviewed_idx (created_at) WHERE reviewed_at IS NULL` | | A5 (FK có index); danh sách chưa xem |
| 9 | COMMENT bảng, cột, enum | | |

`top_up_id` không cần index riêng: UNIQUE có cột đầu `top_up_id` (A5). Cột `updated_at` theo quy ước C2 (0014): Phần 10 sẽ UPDATE `reviewed_*`, nên mọi UPDATE thô phải ghi `updated_at = now()`.

**Không sửa dữ liệu cũ**, không tiền kiểm: bảng mới.

## 2. Vì sao bảng riêng, không dùng `top_ups.exception_kind`

- Mỗi top-up chỉ có một `exception_kind`; ghi `conflicting_payment` sẽ đè `loyalty_error` / `unresolved_04/07`.
- `late_*` đã giữ khoản trễ thứ nhất, không còn chỗ lưu `vnp_TransactionNo` và số tiền của lần trả mâu thuẫn.
- Một top-up có thể có nhiều lần trả mâu thuẫn (mỗi giao dịch một dòng).

Code ghi bảng này: `TopUpService.applyLockedResult`, nhánh `conflicting_result` có `reason` (chỉ từ `PAYMENT_SUCCEEDED`), `INSERT … ON CONFLICT (top_up_id, gateway_transaction_no) DO NOTHING`, cùng transaction và dưới khoá `top_ups` → `credit_accounts`; không đụng `top_ups`.

## 3. Cách kiểm

- `apps/csms/test/migration-0024.integration.test.ts`: nâng cấp DB có seed demo + seed-app + top-up (dữ liệu `top_ups` giữ nguyên, bảng mới rỗng, chạy lại không áp gì); UNIQUE theo cặp; ba CHECK; FK (`top_ups`, `admins` — user không phải admin bị chặn); enum, index, FK NO ACTION, COMMENT; schema TS khớp.
- `test/erd-alignment.integration.test.ts` (A5, C3) pass không sửa.
- Hành vi ghi dòng: `test/billing-ipn.integration.test.ts`, `test/billing-top-up-timeout.integration.test.ts` (mục "Phần 8b bổ sung").

## 4. Test của người khác phải sửa

Không có.
