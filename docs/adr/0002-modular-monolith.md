# ADR-0002 — Modular monolith, không làm microservices

| | |
|---|---|
| Trạng thái | Chấp nhận |
| Ngày | 11/09/2026 — chấp nhận 23/10/2026 |
| Người đề xuất | Ngô Văn Minh Trí (WP2) |
| Người quyết định | WP1, WP2 |
| Liên quan | BE-01, BE-02, ADR-0001, ADR-0006 |

## Bối cảnh

13 tuần, hai người làm backend (WP2 + WP5). Gỡ lỗi một hệ phân tán — mất bản tin giữa các dịch vụ, lệch phiên bản hợp đồng, theo dõi request xuyên dịch vụ — sẽ nuốt trọn lịch.

Hệ phân tán còn làm nhiễu thí nghiệm của đề tài: nếu dữ liệu mất, không biết mất ở tầng OCPP hay ở message broker giữa các dịch vụ.

## Quyết định

`apps/csms` là **một tiến trình NestJS**, bên trong chia module rõ ranh giới. Không làm microservices.

Module `ocpp-gateway` có ranh giới rõ ràng để sau này tách được thành dịch vụ riêng.

Module do WP2 sở hữu: `ocpp-gateway`, `message-log`, `charging`, `metering`, `reconciliation`, `realtime`, `stations`. Module do WP5 sở hữu, chạy chung tiến trình: `billing`, `payments`, `invoicing`.

## Hệ quả

**Được:**

- (chưa ghi tách bạch trong tài liệu nguồn — lý lẽ ở mục Bối cảnh: không mất lịch cho gỡ lỗi hệ phân tán, không nhiễu kết quả thí nghiệm)

**Mất:**

- Chưa scale ngang được tầng kết nối WebSocket. Scale ngang cần sticky routing theo `serialNumber` cộng một registry ghi nhận trụ nào đang nối vào instance nào — **ghi vào chương hướng phát triển**.

## Các phương án đã cân nhắc và loại bỏ

| Phương án | Vì sao loại |
|---|---|
| Tách gateway và core thành hai dịch vụ nối qua message broker, theo kiểu CitrineOS | Đúng khi quy mô lớn, quá đắt cho 13 tuần. |

## Ghi chú trạng thái

- 11/09/2026 — Đề xuất trong [WP2-KIEN-TRUC-TECHSTACK.md](../WP2-KIEN-TRUC-TECHSTACK.md).
- 23/10/2026 — Chấp nhận: repo đã commit NestJS/TypeScript cho `apps/csms`.
