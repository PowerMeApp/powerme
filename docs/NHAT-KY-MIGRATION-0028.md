# Nhật ký migration 0028 — `0028_refund-xac-nhan-qua-truy-van.sql`

**Ngày:** 23/11/2026 · **Task:** T32 Phần 9a (WP5, hoàn tiền VNPay) · **Người chịu trách nhiệm:** Lê Bảo Khang · **Review:** Trí (chủ DB)
**File:** `apps/csms/drizzle/0028_refund-xac-nhan-qua-truy-van.sql` (áp lên DB đã có 0000 → 0027; một transaction)
**Nguồn:** Khang chốt 23/11 khi lập plan T32 Phần 9a.

**Vì sao là 0028:** số kế tiếp còn trống trên `main` và các nhánh remote lúc viết. Đề xuất index cho route admin (#197 / #200) trước đây dự kiến dùng 0028, nay dời sang số sau.

## 1. Thay đổi

| # | Đối tượng | Thay đổi | Use case |
| --- | --- | --- | --- |
| 1 | cột `refunds.confirmed_via_query` | `boolean NOT NULL DEFAULT false`; dòng có sẵn nhận `false` | Refund `done` nhờ querydr thấy lệnh hoàn, không có mã lệnh hoàn |
| 2 | CHECK `refunds_gateway_refund_no_check` | DROP + ADD (giữ tên): `status <> 'done' OR gateway_refund_no IS NOT NULL OR confirmed_via_query` | `done` vẫn phải có bằng chứng: mã hoàn, hoặc xác nhận qua querydr |
| 3 | CHECK `refunds_confirmed_via_query_check` | mới: `NOT confirmed_via_query OR (status = 'done' AND gateway_refund_no IS NULL)` | Cờ chỉ có trên dòng `done`, không đi cùng mã hoàn |
| 4 | COMMENT | `confirmed_via_query`, `gateway_refund_no`, `unfinished_claims` của `refunds` | |

## 2. Vì sao cần cột này

- Trước khi gửi lại refund, worker hỏi querydr để tránh hoàn hai lần (STM-10, D1).
- Response querydr của giao dịch gốc **không có trường riêng cho mã lệnh hoàn** (trang VNPay đọc 23/11), trong khi 0015 bắt buộc `gateway_refund_no` khi `done`.
- Hai cách không cần migration đều bị loại:
  - ghi mã giao dịch gốc vào cột "mã hoàn": sai nghĩa khi đối soát, và UNIQUE lỗi nếu hai refund `account_closure` cùng một top-up;
  - để refund `failed` dù tiền đã hoàn: STM-10 không có `failed → done`, nên dòng nằm `failed` mãi và `closure_refunded_at` không bao giờ được ghi.

## 3. Dữ liệu có sẵn

- Không backfill: dòng có sẵn nhận `false` qua DEFAULT (PG 11+ không viết lại bảng).
- Dòng `done` cũ đã có `gateway_refund_no` theo CHECK của 0015, nên không vi phạm CHECK mới.
- UNIQUE `refunds_gateway_refund_no_key` giữ nguyên; nhiều dòng NULL không đụng nhau.

## 4. Test cũ phải sửa

- `apps/csms/test/migration-0015.integration.test.ts`: câu liệt kê cột `refunds` bỏ qua thêm `confirmed_via_query` (kiểm ở test của 0028). Assertion của `refunds_gateway_refund_no_check` giữ nguyên: `done` không mã, không cờ vẫn bị chặn đúng tên CHECK.

## 5. Cách kiểm

- `apps/csms/test/migration-0028.integration.test.ts`:
  - nâng cấp DB có refund `requested` / `done` / `failed`: dòng cũ nhận `false`, cột khác giữ nguyên; chạy lại không áp gì;
  - hợp lệ: `done` + mã hoàn; `done` + cờ + mã NULL; `requested` / `failed` không cờ;
  - bị chặn: `done` không mã không cờ; cờ cùng mã hoàn; cờ trên `requested` / `failed`;
  - UNIQUE giữ nguyên; COMMENT; schema TS khớp.
- Code dùng cột: `RefundService.applyOutcome`. Test: `apps/csms/test/billing-refund.integration.test.ts`.
