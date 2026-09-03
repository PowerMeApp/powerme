# @powerme/csms — WP2

CSMS OCPP 1.6J. **Trái tim kỹ thuật của đồ án.**

| | |
|---|---|
| Chủ sở hữu | WP2 — Backend / IoT Engineer |
| Cột mốc | **M2 — 04/10/2026** (cổng kỹ thuật), M5 — 15/11/2026 |
| Stack | NestJS + TypeScript · PostgreSQL · Redis |
| Lộ trình chi tiết | [docs/WP2-LO-TRINH-KY-THUAT.md](../../docs/WP2-LO-TRINH-KY-THUAT.md) |

## Phạm vi

- **BE-02** Máy chủ WebSocket OCPP-J 1.6, định danh trụ theo SN trên đường dẫn
- **BE-03** Bản tin từ trụ lên: `BootNotification`, `Heartbeat`, `StatusNotification`, `Authorize`, `StartTransaction`, `MeterValues`, `StopTransaction`
- **BE-04** Lệnh xuống trụ: `RemoteStartTransaction`, `RemoteStopTransaction`, `Reset`, `UnlockConnector`, `GetConfiguration`, `ChangeConfiguration`, `TriggerMessage`
- **BE-05** State machine trụ và connector cho cấu hình súng đôi, lưu bền và khôi phục
- **BE-06** Lưu trữ MeterValues DC: SoC, điện áp, dòng, kWh
- **BE-07** Engine đối soát: phát lại hàng đợi offline, phát hiện replay theo timestamp, chống trùng giao dịch, phát hiện lỗ hổng chuỗi meter
- **BE-08** Fanout realtime qua Redis pub/sub

## Ràng buộc không được quên

- Khoá nghiệp vụ là `(chargePointId, connectorId)`. **`connectorId = 0` dành riêng cho trạng thái toàn trụ** theo OCPP 1.6 — không phải một súng.
- Chỉ làm **1.6J**. Không có 2.0.1 trong phạm vi.
- **CSMS là nguồn sự thật cho hoá đơn.** Giá trên trụ chỉ để hiển thị. Mọi lệch so với Settlement của trụ phải sinh bản ghi đối soát.
- Phải nhận được `StartTransaction` với `idTag` lạ (quẹt RFID / nhập mật khẩu trên HMI) và ghi nhận thành phiên vãng lai.
