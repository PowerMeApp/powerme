# Kịch bản mock

Demo local hoàn toàn theo [phạm vi](../README.md), có nhãn “Dữ liệu demo”; không HTTP/backend/OCPP/payment/routing. Fixture có version, seed cố định và clock inject để chạy lại được.

MB-01 chỉ có store profile/xe/ngôn ngữ trong bộ nhớ, seed cố định và không I/O/timer/stream. Chưa có clock/versioned event, tám repository hoặc scenario tài chính bên dưới; đây là kế hoạch cho các slice tiếp. Preference đồng bộ không phát sinh pending/unknown hoặc response auth đến muộn. Chạy lại composition trả seed; test override được một repository khác.

Một store dùng chung cho repository của tám feature, giữ ID liên kết driver/vehicle/station/connector/command/session/credit/top-up/statement/invoice/loyalty. Repository trả domain snapshot; local stream phát theo clock. Reset trả seed ban đầu.

Widget không có timer tự tăng kWh/SOC/cost. Clock kích hoạt timeline/snapshot ở tầng demo; giá/rank/tiền lấy từ fixture/store, không tính tại UI/controller. Home/Payments/History/Statement đọc dữ liệu nhất quán. Scope/version guard áp dụng cả mock. Công cụ chọn kịch bản tách khỏi luồng tài xế; không dữ liệu cá nhân/khóa/thẻ thật.

| Kịch bản | Kết quả cần có |
| --- | --- |
| Đăng ký/consent | Tối đa 3 màn, không vào dữ liệu riêng khi chưa consent |
| A → logout → B | Xóa cache A; event/response scope A đến muộn bị bỏ |
| Search/filter | Tên/địa chỉ/không dấu, xe tương thích, empty; query cũ không ghi đè query mới |
| Status/suggestion | 5 status + updatedAt/quality; fixture Fastest/Cheapest top 3 có ETA/wait/reason |
| QR/quyền | Mã hợp lệ/sai, từ chối camera/location, nhập/chọn thủ công; không chạy URL trong QR |
| DS-01 | 200.000đ, giới hạn 10 kWh; accepted → active → system stop → closed → reconciled; posted, statement/balance/points đồng bộ |
| DS-02 | 30.000đ, fixture minimum lớn hơn số dư → từ chối, mời nạp; không tạo session/giữ tiền. Minimum là cấu hình demo, không policy mới |
| Bốn mode | autoFull/timed/energy/cost, limit có đơn vị; source mô phỏng xác nhận hết giới hạn |
| Accepted chưa effect | Chờ start/stop; chưa active/closed |
| Start transport timeout | Unknown, recover cùng key; late result theo snapshot |
| Start timeout được xác nhận | Source mô phỏng báo failed; timer widget không quyết định thất bại |
| Start/stop lặp | Cùng intent/key, không tạo đôi phiên/tài chính |
| Stop rejected/unknown | Hiện đúng nhánh, kiểm tra lại, không key mới khi chưa rõ kết quả |
| System stop | Mode limit/credit cutoff fixture → stopping → closed khi effect xác nhận |
| Charge Point offline ≤120 giây | Giữ lifecycle trước đó; active vẫn đang sạc, metrics cuối + “Dữ liệu có thể chưa cập nhật” |
| Charge Point offline >120 giây | Store phát orphaned → “Mất kết nối với trụ, dữ liệu đang chờ” |
| Handset offline | App stale, không tự orphaned |
| Reconnect/gap | Snapshot mới, bỏ event cũ/trùng, subscribe đúng scope |
| Paused/review/unknown | Nhãn riêng, không suy active/success hoặc null thành 0 |
| Settlement pending → posted | Closed chưa có debit cuối; posted cập nhật statement/balance/points một lần |
| station_wallet/unattributed | Không auto-debit credit hoặc auto-earn; giữ phân loại |
| Checkout demo | Success/rejected/timeout/đóng cửa sổ; return không tự cộng credit |
| Late top-up success | Snapshot order/ledger mới cập nhật sau unknown; duplicate không cộng hai lần |
| Invoice lỗi | Credit posted giữ nguyên; invoice pending/failed/issued độc lập, thuộc top-up |
| Loyalty | Earn/redeem/expiry/reversal thống nhất History; không tự nghĩ tỷ lệ |
| Fault report | Thành công sau store xác nhận; retry không nhân đôi |
| Reservation Should | Disclosure fee/cutoff, hold/cancel/void/expiry fixture; không status thứ sáu |

BR-P45: fixture minh họa chi phí chính xác mỗi segment, cộng rồi half-up một lần/phiên. Nếu cần demo engine tính tiền, đặt trong tầng mô phỏng, không thay billing production. Points/minimum/fee/cutoff là fixture có nhãn, không quyết định nghiệp vụ mới.

Đây là kế hoạch kiểm UI, không phải kết quả test đã chạy hoặc bằng chứng backend/DS-01 thật/VNPay/p95/RQ2.
