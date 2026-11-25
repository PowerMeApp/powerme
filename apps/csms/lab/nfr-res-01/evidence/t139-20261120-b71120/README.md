# T139 — p95 gợi ý trên staging, 20/11/2026

Đo ngày 20/11/2026, khoảng 10:48–10:53 ICT, qua SSH tunnel tới CSMS staging đang triển khai. Đây là 21 yêu cầu **tuần tự**, một pilot lạnh và 20 mẫu batch; mỗi lần bắt đầu cách nhau ít nhất 12.500 ms. Thời gian đo phía client gồm mạng/tunnel, HTTP và đọc JSON; không phải tải đồng thời hay đo riêng thời gian xử lý server.

Mỗi `GET /stations?sort=smart` dùng SoC 35%, bán kính 5 km, origin `(10.868697, 106.784288)`, `page_size=50`, `location_consent=true`, `q=T139b71120`. Có 50 site, mỗi site một CP và một connector CCS2. Fixture đánh dấu test, online/fresh/Available trong DB; không tạo socket OCPP và không thực hiện sạc. Backend chỉ lấy shortlist tối đa **6** trạm để gọi Route, có cache; không gọi 50 Route cho mỗi yêu cầu.

| Phạm vi | n | p50 (ms) | p95 (ms) | Max (ms) | `brief` |
|---|---:|---:|---:|---:|---:|
| Chính, gồm pilot lạnh | 21 | 433,86 | 1.390,14 | 4.439,04 | 1/21 (4,76%) |
| Pilot lạnh | 1 | 1.390,14 | 1.390,14 | 1.390,14 | 0 |
| Batch | 20 | 425,07 | 1.194,10 | 4.439,04 | 1/20 (5%) |

Percentile dùng nearest-rank: sắp tăng rồi lấy phần tử `ceil(p*n)`. Cả 21 phản hồi HTTP 200 và đủ đúng 50 ID. Có 20 mẫu `vietmap_route` (sáu road estimate/mẫu), một mẫu `brief`; cache ghi nhận một pilot lạnh, 18 mẫu warm, một lần estimate mới và một fallback. **Mẫu cuối fallback mất 4,439 giây vẫn nằm trong thống kê**, không bị loại. p95 đạt ngưỡng ≤2 giây nên không đổi cấu hình deadline; source được kiểm tra có `RANKING_DEADLINE_MS=4000`. SHA source đang triển khai không được xác minh. Một lượt đo nhỏ không chứng minh mọi yêu cầu ≤2 giây.

Console Vietmap ghi Route TODAY từ 0 lên 16, còn 1.484/1.500, quan sát khoảng 10:54 ICT. Đây là delta bộ đếm quan sát được, không phải instrument chính xác số upstream call riêng của lượt test. Ngân sách chặn trên đã duyệt là 126 Route (21×6).

Cleanup live ghi nhận **152 dòng station fixture và 3 dòng auth**, tổng 155 dòng sở hữu, đều không còn qua SELECT theo ID trên tám bảng; số dòng của 17 bảng trước/sau giống nhau. Verifier offline chỉ đối chiếu bản ghi kiểm chứng này, không truy vấn lại DB. [Manifest](manifest.json) đã lược thông tin kết nối và tài khoản, là audit lịch sử, **không dùng làm đầu vào cleanup**. Thời điểm baseline chính xác không được ghi; [result](result.json) giữ cửa sổ thời gian có bằng chứng.

## Kiểm tra offline

Từ gốc repo, Node.js 24, không cần DB, API, `.env` hay dependency:

```bash
node apps/csms/lab/nfr-res-01/verify-staging-evidence.mjs --self-test
```

[samples.jsonl](samples.jsonl) giữ nguyên byte của 21 mẫu thực, mỗi mẫu ghi thứ tự đủ 50 ID và `road_estimate` nullable (`distance_m`, `duration_s`, `computed_at`). SHA256 nằm trong `result.json`; verifier kiểm hash, schema/ID, cache, khoảng cách thời gian, percentile, fallback và aggregate. CI kiểm bản ghi offline, không chạy lại benchmark staging. JSON/JSONL là dữ liệu xuất tự động, ngoài giới hạn 400 dòng viết tay theo CONTRIBUTING. Harness seed/auth/cleanup một lần không được đưa vào repo.

50 tọa độ công khai từ [road-points.json](../../road-points.json) là đỉnh đường OSM, không phải trạm sạc đang vận hành. © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/); nguồn trích và truy vấn ArcGIS ở [README lab](../../README.md#nguồn-tọa-độ).
