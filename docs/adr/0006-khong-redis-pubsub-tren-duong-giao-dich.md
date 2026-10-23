# ADR-0006 — Không dùng Redis pub/sub trên đường đi của giao dịch

| | |
|---|---|
| Trạng thái | Đề xuất |
| Ngày | 11/09/2026 |
| Người đề xuất | Ngô Văn Minh Trí (WP2) |
| Người quyết định | WP1, WP2 |
| Liên quan | BE-08, ADR-0002, ADR-0005 |

## Bối cảnh

Redis pub/sub là *bắn rồi quên*. Subscriber nào đang tắt hoặc đang khởi động lại thì **mất bản tin vĩnh viễn**.

Đặt nó trên đường đi của giao dịch, chính CSMS của nhóm sẽ tự gây ra đúng loại mất dữ liệu mà đề tài đang đo — và làm bẩn toàn bộ kết quả thí nghiệm.

Hai file đã commit đang mô tả pub/sub mà chưa kèm giới hạn này:

- `apps/csms/README.md` — dòng BE-08 "Fanout realtime qua Redis pub/sub"
- `packages/shared/README.md` — thư mục `realtime/` "Tên kênh và payload của luồng Redis pub/sub"

## Quyết định

Redis pub/sub **chỉ** được dùng cho fanout realtime tới giao diện (Socket.IO qua Redis adapter). **Tuyệt đối không** dùng nó để chuyển sự kiện giao dịch giữa các module.

| Đường đi | Cơ chế | Mất có chấp nhận được không |
|---|---|---|
| Trụ → xử lý nghiệp vụ → DB | Gọi hàm trong tiến trình, sau khi đã ghi `ocpp_message_log` | **Không bao giờ** |
| Công việc nền: đối soát, sinh hoá đơn | BullMQ — có lưu bền, có retry | Không |
| CSMS → app và dashboard | Socket.IO qua Redis adapter, dùng pub/sub | Được — client gọi lại REST |

## Hệ quả

**Được:**

- Kết quả thí nghiệm mất dữ liệu không bị nhiễu bởi chính hạ tầng của CSMS.

**Mất:**

- Kênh realtime tới giao diện **có thể mất sự kiện theo thiết kế** — client (WP3, WP4) phải coi sự kiện là gợi ý, REST là nguồn sự thật, và gọi lại REST mỗi khi socket nối lại.
- Phải sửa hai file đã commit (`apps/csms/README.md`, `packages/shared/README.md`) khi ADR được chấp nhận.

## Các phương án đã cân nhắc và loại bỏ

| Phương án | Vì sao loại |
|---|---|
| Dùng Redis pub/sub để chuyển sự kiện giao dịch giữa các module | Bắn rồi quên: subscriber đang tắt hoặc khởi động lại thì mất bản tin vĩnh viễn — CSMS tự gây ra loại mất dữ liệu mà đề tài đang đo. |
