# Search/gợi ý trạm — baseline triển khai brief 07/11

Cập nhật 09/11/2026, nhánh `wp3/mb-03-vietmap-search-suggest`, base main `6fd720d319a17405a39ac6a91d0e1bade49398e2`.
Người dùng yêu cầu **ưu tiên brief 07/11** cho search/suggest MVP. Các phần khác vẫn theo repo.
Đây không là xác nhận phê duyệt toàn bộ SRS, AD-5 hoặc phân công WP.

Nguồn nguyên byte: [brief 07/11](sources/PowerMe-Smart-Station-Recommendation-Brief-07-11.md),
11.626 byte, SHA-256 `43f38f10a5147571081c4734287798a601fa364d11e3ab180d4d4e1e900e3959`.
Nguồn đọc từ Downloads; bản triển khai/bằng chứng lưu trực tiếp trên E.

## Điều chỉnh T96 — Vietmap Route ưu tiên, brief dự phòng

Giữ tài liệu nguồn 07/11 để đối chiếu. Khi có `sort=smart&location_consent=true`, vị trí hợp lệ,
SoC hợp lệ và xe sở hữu đủ thông số, áp dụng BR-P33/BR-P41 theo [Report 3](report3-srs.md) cập nhật.
Sau khi lọc bán kính, chọn tối đa 6 trạm có tổng thời gian tính được và cổng tốt nhất có trạng thái
fresh, dựa trên phút chờ + sạc rồi `site_id`. CSMS kết thúc giao dịch DB trước khi lấy Route v4.

- Đủ tuyến trong ngân sách 4 giây cho cả lượt, tối đa 2 tuyến đồng thời: xếp nhóm theo reach,
  tổng phút chạy + chờ + sạc, mét ùn tắc nặng khi cả nhóm có số liệu, mét đường bộ, `site_id`.
  Dùng ETA Vietmap một lần, nối các mục còn lại theo brief rồi cắt trang.
  API trả `ranking_source: vietmap_route` và `road_estimate` cho từng trạm có tuyến.
- Thiếu consent, điều kiện, ứng viên phù hợp hoặc một kết quả tuyến: xếp toàn bộ theo brief với
  `ranking_source: brief`. App dùng `road_estimate` cho km đường bộ và thời gian di chuyển.
  Mục không có trường này sẽ không hiện các số đo đường bộ. Xem [hợp đồng Driver API](../api/DRIVER-API-HOP-DONG.md#16-t96--xếp-hạng-gợi-ý-theo-đường-bộ-vietmap).

## Áp dụng cho MVP

- Giữ `GET /api/driver/v1/stations`, thêm `soc_percent`, `target_soc_percent` mặc định 80 và `sort=smart`.
- Có SoC + vị trí thì mặc định smart. `0 ≤ soc < target ≤ 80`, số hữu hạn; B5/B6 làm rõ giới hạn thay cho dòng 0–100 ở B2.
- Tầm = tầm công bố × SoC/100 × 0,75. Đường ước tính = haversine × 1,3; dự phòng 10 km chia `ok/tight/risky`.
- Phút chạy = km đường ước tính / 30 × 60. Chờ `available/freeing_soon/in_use` lần lượt 0/5/30 phút.
- Năng lượng = dung lượng pin × (target − SoC)/100. Công suất = min(súng, max DC xe), dùng công suất trụ khi súng null; max DC xe null không chặn tính.
- Phút sạc = kWh / (kW × 0,85) × 60; tổng = chạy + chờ + sạc. Chọn súng tương thích có tổng thấp nhất.
- Smart xếp `reach → tổng phút → khoảng cách → site_id`. Không tính được tổng, hoặc unknown/unavailable/offline, xếp cuối.
- Chi phí cận ước tính = kWh × giá cao nhất trong các khung còn hiệu lực của operator theo ngày server ICT, làm tròn lên VND. Thiếu giá/vượt số nguyên JSON an toàn trả null; giá 0 vẫn là 0. Không là quyết toán hay thống nhất clock billing.
- Đọc mọi ứng viên trong bán kính trước khi xếp hạng/cắt trang. `page_size=3` dùng cho ba gợi ý; không đổi mặc định client cũ.

Hằng số có biến `SMART_SEARCH_*` trong [env example](../../infra/.env.example), trả trong `estimate.assumptions`.
Không thêm bảng config hoặc migration.

## Fallback và điểm diễn giải

| Tình huống | Hành vi |
| --- | --- |
| Không SoC / vị trí / thông số xe | `estimate=null`, lý do `no_soc/no_location/missing_vehicle_specs`; mặc định khoảng cách nếu có vị trí, tên nếu không. Sort name/distance tường minh vẫn giữ. |
| Bán kính nhập rõ | Giữ bộ lọc cũ; không tự mở rộng nếu rỗng. |
| Smart không nhập bán kính | Tầm ước tính × 1,5. Nếu rỗng, tối đa 3 trạm gần nhất, ưu tiên có thể tính thời gian, giữ nhãn risky. Diễn giải kết hợp B3/B4/B6.5, đặc biệt SoC=0. |
| Thiếu công suất súng và trụ | Không có phút sạc/tổng; không bịa 0. |
| Không trạm tương thích/khớp tìm kiếm | Danh sách có thể rỗng; không tạo trạm giả. |

## Khác SRS/AD-5 trước brief

SRS §3.7/AD-5 có Fastest/Cheapest, travel provider, chờ theo phiên, arrival tariff và reliability penalty.
MVP này dùng B3, chờ hằng số, max tariff, không cắt bỏ cứng risky. Route thử nghiệm
`/stations/suggestions` đã bỏ (404), không duy trì hai thuật toán. SRS/AD-5 gốc giữ để đối chiếu;
ghi chú này có phạm vi hẹp, không sửa lại nguồn gốc.

Address/place và đường tới một trạm vẫn có API riêng. Thời gian Vietmap là ước tính di chuyển.

## Trạng thái và phần để sau

Backend đọc DB, không dùng fixture làm response sản phẩm. Test dùng PostgreSQL riêng và provider
giả lập chỉ trong test. Xem [bảng test](../api/MB03-EDGE-CASE-MATRIX.md) và [cách chạy](../api/MB03-BACKEND-DISCOVERY.md).

Theo phạm vi đã duyệt, để sau: seed mẫu xe hãng có nguồn thật/trụ 30 kW demo, `last_known_soc`,
reservation, wait thực, taper >80%, Cheapest/reliability nâng cao.
Flutter/client, login/OTP/refresh, API charge/stop/progress/statement, RFID credit/settlement và clock
billing chung không thuộc lượt search này. Test local không chứng minh staging, thiết bị, hiệu năng
toàn mạng hoặc Definition of Done đã đạt. Kết quả kiểm tra local ngày 09/11/2026; trạng thái
GitHub xem nhánh/commit, không suy ra từ snapshot tài liệu này.
