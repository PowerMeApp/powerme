# @powerme/mobile — WP3

App tài xế.

| | |
|---|---|
| Chủ sở hữu | WP3 — Mobile Developer |
| Cột mốc | **M3 — 18/10/2026** |
| Stack | Flutter (Dart) — hợp đồng API qua `openapi.json` sinh từ NestJS; ngoài npm workspaces (ADR-0001, phụ lục 10/2026) |

## Phạm vi

- **MB-01** Khởi tạo app, hệ thống thiết kế, đa ngôn ngữ Việt và Anh
- **MB-02** Đăng ký và đăng nhập OTP, hồ sơ người dùng, quản lý xe
- **MB-03** Bản đồ tìm trụ, bộ lọc, trạng thái realtime tới từng súng
- **MB-04** Quét QR trên màn hình trụ để ghép phiên, remote start và stop
- **MB-05** Màn hình sạc realtime: SoC, kWh, điện áp, dòng, thời gian, chi phí
- **MB-06** Lịch sử phiên, xem hoá đơn, báo lỗi trụ

## Ràng buộc

- Chỉ làm **chế độ sạc đầy tự động**. OCPP 1.6J không có lệnh chuẩn để đặt hạn mức kWh hay hạn mức tiền khi remote start — hạn mức mềm nằm ở mục "hướng phát triển".
- Có hai đường bắt đầu phiên **không đi qua app** (quẹt RFID, nhập mật khẩu trên HMI). App phải xử lý được việc thấy một phiên mà nó không tạo ra.
- Ngưỡng M3: SoC và kWh cập nhật **trong vòng vài giây** kể từ khi simulator gửi `MeterValues`.
