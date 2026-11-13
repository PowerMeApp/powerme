# Nhật ký migration 0021 — `0021_top-up-ipn-ngoai-le.sql`

**Ngày:** 13/11/2026 · **Task:** T32 Phần 6 (WP5, WF-02 SD-2b) · **Người làm:** Lê Bảo Khang · **Trí review** (chủ DB)
**File:** `apps/csms/drizzle/0021_top-up-ipn-ngoai-le.sql` (áp lên DB đã có 0000 → 0020; một transaction `BEGIN … COMMIT`)
**Nguồn:** `docs/spec/WF-02_decisions.md` D1 (`closure_refunded_at`), D3 (IPN, sổ điểm hỏng), D4 (khoản trễ, lịch querydr), D7 (điều kiện quét); `docs/tasks/WF-02_plan.md` Phần 6. Quyết định Khang + Ân 12–13/11 (T116 khoản trễ trên `credited` / `refunded`, T127 lịch querydr, sổ điểm hỏng → `exception_kind`).

**Vì sao là 0021:** `0020_t101_tariff_clock.sql` đã thuộc T101 (#120). PR nào merge trước giữ số; nếu PR khác lấy 0021 trước thì đổi file này sang số kế tiếp (tên file, test, nhật ký, tài liệu) và chạy lại test migration.

## 1. Thay đổi

| # | Đối tượng | Thay đổi | Use case |
|---|---|---|---|
| 1 | tiền kiểm | `top_up_id` nào có > 1 dòng loyalty `adjust` → `RAISE EXCEPTION` (SQLSTATE 23505) liệt kê `top_up_id (n dòng)`, cả file ROLLBACK, không sửa dòng nào | chặn mục 6 lặng lẽ "chọn" một dòng |
| 2 | `top_ups_late_payment_status_check` | `late_gateway_ref IS NULL OR status = 'expired'` (0003) → `late_gateway_ref IS NULL OR status <> 'pending'` | khoản trễ trên `failed` (D4 ⊕ 04/11) và lần trả thứ hai cho top-up `credited` / `refunded` (T116, Ân 12/11). Top-up `pending` nhận thành công thì cộng tiền, không phải khoản trễ |
| 3 | COMMENT `late_gateway_ref` / `late_paid_at` / `late_amount_vnd` | khoản trễ = khoản thành công có `vnp_TransactionNo` khác khoản đã ghi, tới khi top-up không còn `pending`; `late_gateway_ref` = **`vnp_TransactionNo`** (refund `late_payment` gửi số này); `late_paid_at` = `vnp_PayDate` (GMT+7), thiếu thì lúc nhận IPN; `late_amount_vnd` = `vnp_Amount / 100`. Bỏ chữ "cửa sổ 1 giờ / LATE_WINDOW" của 0003 | Admin hoàn khoản trễ (SD-2e) |
| 4 | `top_ups.next_attempt_at` | cột mới `timestamptz` nullable. Backfill: dòng `pending` → `expires_at + interval '2 minutes'`; dòng khác NULL. COMMENT: lịch `expires_at` + 2 rồi + 5, 10, 20, 40, 60 phút; NULL khi không còn `pending`. Không thêm `attempt_count`, không CHECK | querydr lại khi chưa ngã ngũ (T127, D4 ⊕ ĐIỀU KIỆN); vòng quét Phần 8 |
| 4b | `top_ups_pending_next_attempt_idx` | partial index `(next_attempt_at) WHERE status = 'pending'` — **đề xuất, Trí quyết**; không đồng ý thì bỏ khỏi file + `billing.ts` + test | vòng quét D7 `status = 'pending' AND next_attempt_at <= now()` |
| 5 | enum `top_up_exception_kind` | mới: `unresolved_04`, `unresolved_07`, `loyalty_error` (COMMENT từng giá trị) | Billing Exceptions (UC-ADM-08) |
| 5b | `top_ups.exception_kind`, `exception_reviewed_at` | hai cột nullable + CHECK `top_ups_exception_reviewed_check` (`exception_reviewed_at IS NULL OR exception_kind IS NOT NULL`) và `top_ups_exception_kind_status_check` (`loyalty_error` chỉ khi `credited` / `refunded`; `unresolved_04/07` chỉ khi `expired`) | Phần 6 ghi `loyalty_error`; Phần 8 ghi `unresolved_*`; Admin đánh dấu đã xem ở Phần 10 |
| 6 | `loyalty_transactions_one_adjust_per_top_up` | partial UNIQUE `(top_up_id) WHERE transaction_type = 'adjust' AND top_up_id IS NOT NULL`. **Không** thêm cột lý do cho `adjust`: từ Phần 6 `adjust` 0 gắn top-up chỉ còn nghĩa "điểm hết hạn trước lúc cộng tiền"; sổ điểm hỏng ghi bằng `exception_kind` | IPN / querydr lặp không ghi `adjust` hai lần (D3 ⊕) |
| 7 | COMMENT `credit_accounts.closure_refunded_at` | theo D1 chốt 09/11: lúc đóng không tạo refund nào → `= closed_at`; NULL chỉ có nghĩa "chưa hoàn xong" (0015 còn ghi "NULL = … không có gì để hoàn") | đóng tài khoản (SD-2f) |
| 7b | COMMENT `top_ups.completed_at` | nghĩa (Khang 13/11): lúc rời `pending` (credited / failed ở IPN, querydr; expired ở vòng quét Phần 8); không đổi khi `credited → refunded` và khi ghi khoản trễ. Chưa CHECK | đối soát thời điểm có kết quả |

`CREATE TYPE` trong transaction rồi dùng ngay là hợp lệ (chỉ `ALTER TYPE … ADD VALUE` mới không dùng được trong cùng transaction).

## 2. Chạy thật

**Test `migration-0021`** (`powerme_test`, Postgres 16.4 trong `powerme-postgres`):
- DB ngay trước 0021 (0000 → 0020) có seed demo + seed-app + một top-up `pending` và một `credited` → migrate: chỉ áp 0021; `id / status / expires_at / completed_at` của mọi top-up giữ nguyên; `next_attempt_at = expires_at + 2 phút` cho đúng các dòng `pending`, NULL cho dòng khác; `exception_*` NULL; CHECK / index / enum / COMMENT đúng; seed chạy lại không lỗi, không thêm dòng; migrate lần hai không áp gì.
- Dữ liệu cũ có hai dòng `adjust` cùng top-up → migrate ném `0021: top-up có hơn một dòng loyalty adjust (top_up_id <id> (2 dòng)). Không sửa gì; …` (SQLSTATE 23505); top-up chỉ có một dòng `adjust` không bị nêu; dữ liệu, `_migrations`, cột `next_attempt_at` chưa có (rollback cả file); xoá tay dòng thừa thì migrate chạy được.
- DB sạch (0000 → mới nhất): khoản trễ trên `credited` / `refunded` / `failed` / `expired` → được, trên `pending` → 23514 `top_ups_late_payment_status_check`; `exception_kind` đúng trạng thái → được (kèm `exception_reviewed_at`), sai trạng thái (7 ca) → 23514 `top_ups_exception_kind_status_check`; `exception_reviewed_at` không có `exception_kind` → 23514 `top_ups_exception_reviewed_check`; hai `adjust` cùng `top_up_id` → 23505 `loyalty_transactions_one_adjust_per_top_up`, `adjust` không gắn top-up không bị chặn; đối chiếu schema TS (`getTableConfig`).

Không chạy thử trên bản sao DB dev `powerme` (Phần 6 chỉ dùng `powerme_test`); đường nâng cấp có seed đã có trong test.

## 3. Số liệu

Đếm bằng truy vấn của `THIET-KE-CSDL-VAT-LY.md` mục 1 (cùng cách đếm), Postgres 16.4, trên `powerme_test` dựng từ 0000 → 0020 rồi áp 0021. Trạng thái 0020 (T101) là 44 bảng / 32 enum (125) / 163 index (18 partial) / 69 CHECK / 84 FK / 447 cột (so với sau 0019 là 44 / 32 (124) / 163 (18) / 67 / 84 / 444: 0020 thêm giá trị enum `tariff_clock_fallback`, 2 CHECK, 3 cột). Sau 0021: **44 bảng, 33 enum (128 giá trị), 165 index (20 partial), 71 CHECK, 84 FK, 450 cột**. 0021 cộng 1 enum (`top_up_exception_kind`, 3 giá trị), 2 index partial (`top_ups_pending_next_attempt_idx`, `loyalty_transactions_one_adjust_per_top_up`), 2 CHECK (`top_ups_exception_reviewed_check`, `top_ups_exception_kind_status_check`; `top_ups_late_payment_status_check` thay tại chỗ, không đổi số), 3 cột (`next_attempt_at`, `exception_kind`, `exception_reviewed_at`).

**Đối chiếu SQL ↔ Drizzle:** `billing.ts` / `enums.ts` khai `nextAttemptAt`, `exceptionKind` (`topUpExceptionKindEnum`), `exceptionReviewedAt`, hai CHECK mới, CHECK `top_ups_late_payment_status_check` mới, index `top_ups_pending_next_attempt_idx`, `loyalty_transactions_one_adjust_per_top_up`; test `migration-0021` kiểm bằng `getTableConfig`.

## 4. Code và test đi cùng

- **Code:** `TopUpService.create` ghi `next_attempt_at = expires_at + QUERYDR_FIRST_DELAY_MS` (2 phút, đồng hồ DB); `TopUpService.applyPaymentResult` (IPN) đặt `next_attempt_at = NULL` + `completed_at = now()` khi rời `pending`, ghi `late_*` cho khoản trễ, `exception_kind = 'loyalty_error'` khi sổ điểm hỏng. Mọi `UPDATE top_ups` thô có `updated_at = now()` (test quét mã nguồn của 0014).
- **Test cũ phải sửa** (chạy migrate tới bản mới nhất nên thấy 0021):
  - `test/migration-0003.integration.test.ts`: bỏ ca "khoản muộn trên top-up `credited` → `top_ups_late_payment_status_check`". Từ 0021 lần trả thứ hai trên `credited` là khoản trễ hợp lệ (T116); ca `pending` (vẫn bị chặn) giữ nguyên.
  - `test/migration-0019.integration.test.ts`: danh sách index của `getTableConfig(topUps)` thêm `top_ups_pending_next_attempt_idx`.
  - `test/migration-0015.integration.test.ts` kiểm COMMENT `closure_refunded_at` có chữ `account_closure`: COMMENT mới giữ chữ này, không phải sửa.
  - `test/billing-top-up.integration.test.ts` (Phần 5): TC-STM4-01 kiểm thêm `next_attempt_at = expires_at + 2 phút`, `completed_at` / `exception_kind` NULL.
- **Test mới:** `test/migration-0021.integration.test.ts`; IPN: `test/billing-ipn.integration.test.ts`, `test/vnpay-ipn-route.integration.test.ts`.
- Test A5 (`erd-alignment`): không có FK mới, không cần ngoại lệ.

## 5. Không làm (có chủ ý)

- Không thêm `attempt_count` cho `top_ups` (lần querydr thứ mấy suy từ `next_attempt_at − expires_at`, Phần 8).
- Không thêm CHECK cho `next_attempt_at` (vd. "NULL khi không còn `pending`") hay `completed_at`: chỉ COMMENT; seed và dòng cũ không cần sửa.
- Không thêm cột lý do cho loyalty `adjust`.
- Không sửa migration đã merge, các nhật ký cũ, dòng "Cập nhật 27/10" và ghi chú của Trí trong `THIET-KE-CSDL-VAT-LY.md`.
- Không đổi tên `late_gateway_ref` → `late_gateway_transaction_no` (decisions "Còn mở"); JSDoc / COMMENT ghi rõ là `vnp_TransactionNo`.
