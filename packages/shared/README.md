# @powerme/shared

Hợp đồng dùng chung giữa CSMS và dashboard (TypeScript). App tài xế là Flutter, không import package này — app dùng `openapi.json` sinh từ NestJS. **Đổi ở đây là đổi cho cả hai đầu ra** — PR chạm vào package này cần hai người duyệt (xem [CODEOWNERS](../../.github/CODEOWNERS)).

## Nội dung dự kiến

```
src/
├── ocpp/          Enum và kiểu của OCPP 1.6J: ChargePointStatus, ChargePointErrorCode,
│                  Reason, MeasurandType, AuthorizationStatus...
├── domain/        Kiểu nghiệp vụ: ChargePoint, Connector, Session, Tariff, Reconciliation
├── api/
│   └── generated/ Client sinh tự động từ đặc tả OpenAPI — KHÔNG sửa tay
└── realtime/      Tên sự kiện và payload của luồng Socket.IO tới giao diện (ADR-0006)
```

## Quy tắc

- Enum OCPP chép **đúng theo spec 1.6 mục 7**, kèm chú thích số mục. Không tự đặt tên gọn hơn.
- Thư mục `api/generated/` do công cụ sinh ra, đánh dấu `linguist-generated` và không sửa tay.
- Package này không phụ thuộc vào NestJS hay React. Chỉ TypeScript thuần.
