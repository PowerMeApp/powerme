# Nhật ký migration 0029 — khôi phục job quyết toán RFID (T148)

Ngày 24/11/2026. File:
[`0029_t148-rfid-settlement-recovery.sql`](../apps/csms/drizzle/0029_t148-rfid-settlement-recovery.sql).
Migration SQL viết tay, append số kế tiếp 0027 (ADR-0008); không sửa migration cũ.

## Vì sao

Settler cũ đánh dấu RFID online bình thường là `ineligible` vì thiếu app intent/
lịch sử operator assign. Trigger 0005 tạo job cho **mọi** phiên đã dừng nhưng chỉ
đánh thức job `pending`; `retryPending` không lấy `ineligible`. Chỉ sửa eligibility
không khôi phục được các khoản hợp lệ đã bị bỏ qua.

## Giới hạn dữ liệu

Trong một transaction, khóa `sessions` theo id rồi tạo/đưa job về pending khi:

- `origin=rfid`, `payment_mode=csms_billed`, `driver_id` không NULL tại phiên;
- status closed/review/reconciled, có received stop không sau `transaction_timestamp()`;
- job thiếu hoặc `ineligible`, chưa có charging statement và chưa có session debit.

Reason `t148_rfid_recovered`, next attempt `now()`, xóa last error cũ, giữ attempts.
ON CONFLICT chỉ cập nhật `ineligible`, bảo vệ job đã được worker chốt. Pending,
posted, phiên đang mở, mốc dừng tương lai, app/free vend/unattributed/vô chủ và
mọi bằng chứng tài chính đều giữ nguyên. Không đọc registry hiện tại, không
INSERT/UPDATE tiền hay loyalty. Job review chờ operator; job thiếu meter/giá chờ
bằng chứng; đây không phải lệnh debit không điều kiện.

Không thay schema/enum/index/trigger nên schema TypeScript/DBML không có delta.
Official migration runner và test helper tự đọc file số mới, không cần đổi runner
migration. MB03 test runner đăng ký suite mới, luôn tạo tên DB ngẫu nhiên loopback.

## Kiểm tra

[`migration-0029.integration.test.ts`](../apps/csms/test/migration-0029.integration.test.ts)
chạy trên PostgreSQL thật, DB mới riêng: missing/ineligible/closed-review,
pending/posted, posted statement, debit không statement, khác origin/mode/vô chủ,
phiên mở và mốc tương lai; snapshot session/ledger/loyalty/statement/segment không
đổi. Official runner áp 0029 lên trạng thái mô phỏng lịch sử, gọi lại runner không
áp lần nữa; thực thi nguyên SQL thêm hai lần không đổi kết quả. Job được khôi phục
settle được đúng một lần; review tiếp tục pending. Kết quả 1/1 pass, exit 0.

## Triển khai

**Phase 1 chưa áp runtime; phase 3 đã áp local sau backup và primary review.**
Phiên lịch sử 599 Wh đã posted đúng một lần (2.276 VND, 2 điểm); xem
[T148 hiện tại](tasks/t148-rfid-settlement.md). Staging vẫn chưa áp. Vì worker sẽ đọc job mới
và có thể thu các khoản lịch sử, primary cần review tập ứng viên trước khi áp.
Bản rollback không xóa ledger: không hoàn tác tài chính tự động. Nếu chưa áp thì
chưa có dữ liệu runtime cần hoàn tác; mọi vận hành sau review là bước riêng.
