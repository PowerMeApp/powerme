# NFR-RES-01 — 50 trạm local

Chạy từ thư mục gốc repo, với Node.js ≥24 và dependency đã cài theo lockfile. Build CSMS trước bằng `npm run build -w @powerme/csms`. Launcher dùng Driver API đã biên dịch, bind HTTP vào loopback cổng ngẫu nhiên và bật Postgres nhúng trên cổng riêng. Trình chạy benchmark dùng chính `run.mjs`. Mỗi lượt tạo cụm Postgres mới, chạy migration và seed tài xế, xe CCS2 cùng 50 trạm. JWT chỉ tồn tại trong bộ nhớ và môi trường của tiến trình con.

```powershell
node apps/csms/lab/nfr-res-01/local.mjs

# Sau khi kiểm quota còn lại trong Vietmap Console
$env:NFR_LOCAL_SAMPLES = '20'
$env:NFR_ROUTE_REMAINING = '126'
node apps/csms/lab/nfr-res-01/local.mjs
```

Lệnh đầu chỉ xác nhận 50 ID, 50 tọa độ và 50 trạm có cổng CCS2 online/fresh/available, qua `sort=name`. Luồng đo lấy duy nhất `VIETMAP_SEARCH_API_KEY` từ `infra/.env`, sau đó chạy một pilot `sort=smart`. Chỉ chạy batch nếu pilot trả đủ sáu ước tính Vietmap và phát đúng sáu yêu cầu Route. Có thể chọn `NFR_LOCAL_SAMPLES` từ 1 đến 20 và đổi cổng Postgres mặc định 55436 bằng `NFR_LOCAL_PG_PORT`. Quota khai báo phải đủ cho cả pilot và batch, tối đa sáu lượt Route cho mỗi mẫu. Batch dừng khi fallback `brief` xuất hiện.

Bộ seed dùng 50 trạm đang rảnh, công suất 60/120 kW, giá 4.500 đ/kWh, SoC xuất phát 35%, bán kính 5 km. Heartbeat ban đầu đủ mới trong suốt batch nhờ cửa sổ freshness mặc định 600 giây. Các mẫu cách nhau 12,5 giây. Pilot là cache lạnh, còn batch có thể dùng cache 120 giây hoặc làm mới khi hết TTL. `provider_calls` trên từng mẫu cho biết số lượt Route được tạo trong tiến trình. Các số p50/p95 và tỷ lệ `brief` nằm trong dòng `summary`, cùng thứ tự trạm và ước tính route theo từng mẫu trong `evidence.jsonl` ở thư mục `.review/nfr-res-01-local/run-*` thuộc workspace PowerMe. Nghiệm thu NFR-RES-01 cần chạy lại trên staging. RQ2 có bộ kịch bản và cỡ mẫu riêng.

## Nguồn tọa độ

[road-points.json](road-points.json) chứa các dòng `[OSM way ID, latitude, longitude]`. Điểm là đỉnh của đường dân cư công cộng, làm tròn sáu chữ số, chọn trong bbox `106.767,10.855,106.810,10.887` quanh Thủ Đức. Dữ liệu đường gốc là bản trích công khai năm 2020. Tọa độ dùng làm vị trí giả lập để test, không đại diện cho trạm sạc đang vận hành. [Lớp đường ArcGIS](https://services.arcgis.com/4Ko8f1mCWFLyY4NV/ArcGIS/rest/services/Residential_Roads_HCMC/FeatureServer/0) · [Truy vấn GeoJSON](https://services.arcgis.com/4Ko8f1mCWFLyY4NV/ArcGIS/rest/services/Residential_Roads_HCMC/FeatureServer/0/query?where=1%3D1&geometry=106.767%2C10.855%2C106.81%2C10.887&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&outFields=osm_id&returnGeometry=true&resultRecordCount=120&f=geojson)

© OpenStreetMap contributors. File tọa độ được cung cấp theo ODbL 1.0. [Ghi công](https://www.openstreetmap.org/copyright) · [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)

## Cách dựng

Tái dùng lifecycle Postgres trong [demo harness](../../demo/db-embedded.mjs) và cách dựng Driver API trong [integration test](../../test/driver-smart.integration.test.ts). Fixture của [NFR-03](../nfr03/load-data.mjs) dùng SQL theo lô cho tải OCPP, với các trụ thuộc một trạm ẩn khỏi API tài xế. Lab này dùng một trụ mỗi trạm, operator active, và chọn các cổng mới cập nhật để đi qua đường gợi ý thật.

Embedded Postgres và Testcontainers đều chạy PostgreSQL thật với lifecycle riêng và đều có giấy phép MIT. Dùng Embedded Postgres đã ghim trong repo để tái dùng cơ chế đóng `pg_ctl` trên Windows. Testcontainers thích hợp khi cần khớp major version PostgreSQL của staging và có Docker. [Embedded Postgres source](https://github.com/leinelissen/embedded-postgres/blob/main/packages/embedded-postgres/src/index.ts) · [Embedded Postgres tests](https://github.com/leinelissen/embedded-postgres/blob/main/packages/embedded-postgres/tests/index.test.ts) · [Testcontainers PostgreSQL source](https://github.com/testcontainers/testcontainers-node/blob/main/packages/modules/postgresql/src/postgresql-container.ts) · [Testcontainers PostgreSQL tests](https://github.com/testcontainers/testcontainers-node/blob/main/packages/modules/postgresql/src/postgresql-container.test.ts)
