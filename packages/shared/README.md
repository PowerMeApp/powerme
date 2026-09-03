# @powerme/shared

Hợp đồng dùng chung giữa CSMS, dashboard và app. **Đổi ở đây là đổi cho cả ba đầu ra** — PR chạm vào package này cần hai người duyệt (xem [CODEOWNERS](../../.github/CODEOWNERS)).

## Nội dung dự kiến

```
src/
├── ocpp/          Enum và kiểu của OCPP 1.6J: ChargePointStatus, ChargePointErrorCode,
│                  Reason, MeasurandType, AuthorizationStatus...
├── domain/        Kiểu nghiệp vụ: ChargePoint, Connector, Session, Tariff, Reconciliation
├── api/
│   └── generated/ Client sinh tự động từ đặc tả OpenAPI — KHÔNG sửa tay
└── realtime/      Tên kênh và payload của luồng Redis pub/sub
```

## Quy tắc

- Enum OCPP chép **đúng theo spec 1.6 mục 7**, kèm chú thích số mục. Không tự đặt tên gọn hơn.
- Thư mục `api/generated/` do công cụ sinh ra, đánh dấu `linguist-generated` và không sửa tay.
- Package này không phụ thuộc vào NestJS, React hay Expo. Chỉ TypeScript thuần.
