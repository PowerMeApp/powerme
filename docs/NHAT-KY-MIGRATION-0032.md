# Nhật ký migration 0032 — `0032_refund-ghi-nhan-thu-cong.sql`

**Ngày:** 27/11/2026 · **Task:** T32 hoàn tiền thủ công (WP5) · **Người chịu trách nhiệm:** Lê Bảo Khang · **Review:** Trí (chủ DB)
**File:** `apps/csms/drizzle/0032_refund-ghi-nhan-thu-cong.sql` (áp lên DB đã có 0000 → 0031; một transaction)
**Nguồn:** quyết định D-AC / SRS BR-P51 (26/11), STM-10 v2.0, SD-2e v3.0, CD-2 v3.0; Khang chốt 27/11 khi lập plan.

**Vì sao là 0032:** `0031_rfid-credit-protection.sql` đã có trên `main`; ngày 27/11 không nhánh remote nào giữ số 0032 trở lên.

## 1. Thay đổi

| # | Đối tượng | Thay đổi | Use case |
| --- | --- | --- | --- |
| 1 | cột `refunds.failure_reason` | `text`, NULL được | Admin ghi lý do khi cổng từ chối hoàn (`markFailed`) |
| 2 | dữ liệu | dòng `failed` có sẵn: `failure_reason = left('Luồng gửi tự động cũ: ' \|\| COALESCE(last_error_message, 'không rõ'), 1000)`; không đổi `updated_at` | Không vi phạm CHECK mới |
| 3 | CHECK `refunds_failure_reason_length_check` | mới: `failure_reason IS NULL OR char_length(failure_reason) BETWEEN 1 AND 1000` | Cùng giới hạn với route (`fail` body `reason`) |
| 4 | CHECK `refunds_failure_reason_check` | mới: `status <> 'failed' OR failure_reason IS NOT NULL` | `failed` luôn có lý do; `requested` / `done` được giữ lý do cũ (làm lại) |
| 5 | CHECK `refunds_next_attempt_check` | DROP | Không còn worker refund; làm lại (`failed → requested`) không phải ghi lịch giả |
| 6 | `refunds.next_attempt_at` | DROP DEFAULT | Dòng mới không mang lịch worker không dùng |
| 7 | COMMENT | TABLE `refunds`; cột `status`, `failure_reason`, `gateway_refund_no`, `completed_at`, cột của luồng cũ; `top_ups.late_refunded_at`, `credit_accounts.closure_refunded_at` | Nghĩa theo luồng thủ công |

## 2. Vì sao

- Hoàn tiền làm thủ công: CSKH hoàn trên cổng merchant VNPay, Admin ghi nhận `requested → done` (mã hoàn của cổng), `requested → failed` (lý do), `failed → requested` (làm lại). PowerMe không gọi VNPay refund, nên không còn worker quét `refunds`.
- **Lý do khi `failed` (bắt buộc):** trước 0032 lý do nằm ở `last_error_message` do worker ghi; Admin đánh dấu thất bại cần cột riêng, không dùng lại cột lỗi của VNPay (sai nghĩa, có CHECK `last_error_kind ⇒ last_attempt_at`).
- **Giữ lý do khi làm lại** (Khang chốt 27/11): chưa có bảng audit, lý do lần trước là dấu vết duy nhất trong DB cho CSKH; lần thất bại sau ghi đè. Vì vậy CHECK chỉ là `failed ⇒ có lý do`, không phải `⇔`.
- **Bỏ `refunds_next_attempt_check`:** CHECK này buộc `requested ⇒ next_attempt_at NOT NULL`. Giữ nó thì `redo` phải ghi một lịch giả.

## 3. Không đổi

- Không xoá cột: `attempt_count`, `next_attempt_at`, `last_error_kind`, `last_error_message`, `last_attempt_at`, `unfinished_claims`, `confirmed_via_query` giữ cho dữ liệu cũ, code mới không ghi.
- Giữ `refunds_gateway_refund_no_check` / `refunds_confirmed_via_query_check` (0028): code mới luôn ghi `gateway_refund_no` khi `done`, nên không cần siết lại; dòng cũ (nếu có) vẫn hợp lệ.
- Giữ UNIQUE `refunds_gateway_refund_no_key`: "một mã hoàn chỉ ghi một lần" (BR-P51); `confirmDone` bắt 23505 trên ràng buộc này cho ca hai refund ghi cùng mã đồng thời.
- Giữ index `refunds_status_next_attempt_at_idx`: cột đầu `status` vẫn phục vụ danh sách chờ CSKH (`status IN ('requested','failed')`).

## 4. Dữ liệu có sẵn

- Staging dự kiến không có dòng `refunds` nào (chưa có route tạo hoàn trước PR này; Phần 11 chưa có). Nếu có dòng `failed` của worker cũ thì được điền lý do như mục 1 #2, giữ `updated_at`.
- Dòng `requested` cũ giữ `next_attempt_at` (không còn ai đọc).

## 5. Test cũ phải sửa

- `apps/csms/test/migration-0015.integration.test.ts`: danh sách cột `refunds` thêm `failure_reason`, `next_attempt_at` không còn DEFAULT; ca "requested phải có next_attempt_at" đổi thành "sau 0032: requested được để NULL; failed cần failure_reason"; mặc định `next_attempt_at` là NULL.
- `apps/csms/test/migration-0028.integration.test.ts`: refund `failed` trên DB sạch thêm `failure_reason`.
- Helper INSERT refund `failed` trong `driver-top-ups`, `admin-billing-route`, `billing-exceptions`, `fe14-admin-summary` thêm `failure_reason`.

## 6. Cách kiểm

- `apps/csms/test/migration-0032.integration.test.ts`:
  - tĩnh: một file số 0032 sau 0031; schema TS khớp (cột, hai CHECK, không còn `refunds_next_attempt_check`, `next_attempt_at` không DEFAULT);
  - nâng cấp DB có refund `failed` (có / không / quá dài lỗi cũ), `requested`, `done`: `failed` được điền lý do (cắt 1000), các cột khác và `updated_at` giữ nguyên; chạy lại không áp gì;
  - DB sạch: `failed` không lý do bị chặn; lý do 0 / 1001 ký tự bị chặn; `requested` / `done` giữ lý do được; `requested` mặc định `next_attempt_at` NULL; `done` vẫn cần mã, mã vẫn UNIQUE; COMMENT.
- Code dùng cột: `RefundService.markFailed` / `redo`, `BillingExceptionsQuery.listRefunds`. Test: `apps/csms/test/billing-refund.integration.test.ts`, `apps/csms/test/admin-billing-route.integration.test.ts`.
