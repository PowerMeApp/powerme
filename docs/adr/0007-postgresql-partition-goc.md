# ADR-0007 — PostgreSQL 16.4 với partition gốc, không dùng TimescaleDB

| | |
|---|---|
| Trạng thái | Đề xuất |
| Ngày | 11/09/2026 |
| Người đề xuất | Ngô Văn Minh Trí (WP2) |
| Người quyết định | WP2, WP5 |
| Liên quan | ADR-0005, ADR-0008 |

## Bối cảnh

PostgreSQL 16.4 đã ghim trong `infra/docker-compose.yml`. Hai bảng `meter_values` và `ocpp_message_log` (ADR-0005) tăng rất nhanh theo thời gian, cần cơ chế chia nhỏ và xoá dữ liệu cũ theo chính sách lưu trữ.

## Quyết định

Giữ PostgreSQL 16.4 đã ghim. `meter_values` và `ocpp_message_log` dùng **declarative partitioning theo tháng**. Không cài extension TimescaleDB.

Lý do: partition gốc đã có từ lâu, 16.4 đủ dùng — **không cần nâng phiên bản**, nên không phải viết ADR đổi bảng ghim trong `infra/README.md`. Quy mô đồ án, kể cả load test, nằm gọn trong khả năng của partition gốc.

## Hệ quả

**Được:**

- Không thêm extension phải vận hành; không đổi phiên bản đã ghim.

**Mất:**

- Partition phải được tạo trước. Một job BullMQ chạy hằng tháng tạo partition cho tháng kế tiếp.

**Việc kéo theo:** CI dùng `postgres:16-alpine`, còn `docker-compose` ghim `16.4-alpine`. Nên ghim CI về cùng `16.4-alpine` để test và dev chạy đúng một phiên bản.

## Các phương án đã cân nhắc và loại bỏ

| Phương án | Vì sao loại |
|---|---|
| TimescaleDB | Thêm một extension phải vận hành, và một số tính năng của nó theo giấy phép riêng chứ không phải Apache. |
| Nâng phiên bản PostgreSQL | 16.4 đủ dùng; nâng thì phải viết ADR đổi bảng ghim trong `infra/README.md`. |
