# ADR-0005 — Nhật ký bản tin OCPP ghi trước, chỉ thêm không sửa

| | |
|---|---|
| Trạng thái | Đề xuất |
| Ngày | 11/09/2026 |
| Người đề xuất | Ngô Văn Minh Trí (WP2) |
| Người quyết định | WP1, WP2 |
| Liên quan | BE-02, FE-08, ADR-0006, ADR-0007 |

## Bối cảnh

Đề tài đo tỉ lệ mất dữ liệu OCPP. Muốn đo được thì CSMS phải có một bản ghi không thể mất của mọi bản tin đã nhận và đã gửi, độc lập với việc xử lý nghiệp vụ có thành công hay không.

`CONTRIBUTING.md` còn yêu cầu mọi task chạm giao thức OCPP phải đính kèm log bản tin thật trong PR.

## Quyết định

Mọi frame OCPP — cả chiều vào lẫn chiều ra — được ghi vào bảng `ocpp_message_log` **trước khi** xử lý nghiệp vụ.

Bảng chỉ INSERT, không UPDATE, không DELETE, trừ việc xoá partition cũ theo chính sách lưu trữ.

## Hệ quả

**Được** — một quyết định, bốn lợi ích:

1. **Bền vững:** không có đường nào để mất bản tin trong bộ nhớ. Tiến trình sập ngay sau khi nhận, bản tin vẫn nằm trong DB.
2. **Ground truth cho thí nghiệm:** so trực tiếp "simulator đã gửi gì" với "CSMS đã nhận gì" — đây chính là cách đo tỉ lệ mất dữ liệu.
3. **Trình xem bản tin OCPP thô (FE-08) có sẵn** cho WP4.
4. **Chứng cứ cho định nghĩa hoàn thành:** bảng này sinh ra log bản tin thật mà `CONTRIBUTING.md` yêu cầu đính kèm trong PR.

**Mất:**

- Thêm một lệnh INSERT cho mỗi bản tin, cỡ vài mili giây — thừa thãi so với timeout 60 giây.
- Bảng tăng rất nhanh → bắt buộc partition theo tháng (ADR-0007).

## Các phương án đã cân nhắc và loại bỏ

| Phương án | Vì sao loại |
|---|---|
| (chưa ghi trong tài liệu nguồn) | |
