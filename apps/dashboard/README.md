# @powerme/dashboard — WP4

Dashboard vận hành cho quản trị viên và kỹ thuật viên trạm.

| | |
|---|---|
| Chủ sở hữu | WP4 — Full-stack Developer |
| Cột mốc | M3 — 18/10/2026, **M4 — 01/11/2026** |
| Stack | React + Vite + TypeScript |

## Phạm vi

- **FE-01** Đăng nhập, phân quyền theo vai trò
- **FE-02** Onboarding trụ: SN, connector, site, vòng đời `Đã đăng ký → Chờ kết nối → Trực tuyến`
- **FE-03** Giám sát realtime: trạng thái từng súng, danh sách phiên đang chạy
- **FE-04** Trung tâm cảnh báo: ánh xạ mã lỗi OCPP sang hướng xử lý lấy từ SRS phần cứng
- **FE-05** Điều khiển từ xa: start, stop, reset, mở khoá súng
- **FE-06** Biểu giá bốn khung giờ Sharp / Peak / Shoulder / Off-peak
- **FE-07** Analytics cơ bản: doanh thu và tỉ lệ sử dụng
- **FE-08** **Trình xem bản tin OCPP thô** — thứ người trong ngành nhìn vào đầu tiên khi chấm

## Ràng buộc

Một trụ dual gun phải hiện **hai trạng thái độc lập** trong cùng một thẻ thiết bị. Gộp thành một trạng thái là sai mô hình.
