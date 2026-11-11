# MB03 backend search/gợi ý — chạy local và bàn giao review

Cập nhật 09/11/2026 trên `wp3/mb-03-vietmap-search-suggest`, base main `6fd720d`.
Ưu tiên [brief 07/11 và khác biệt](../requirements/smart-station-search-brief-20261107.md).
[OpenAPI 0.4](driver-api.openapi.yaml), [ADR-0017](../adr/0017-driver-discovery-jwt-and-vietmap-adapter.md),
[edge case/kết quả](MB03-EDGE-CASE-MATRIX.md). Kết quả kiểm tra local ngày 09/11/2026; trạng thái GitHub xem nhánh/commit.

## API hiện thực

Base HTTP console + `/api/driver/v1` (mặc định `http://127.0.0.1:3000`). Máy kiểm tra riêng dùng
13041; HTTP test tự chọn cổng loopback trống.

| GET route | Hành vi |
| --- | --- |
| `/me` | Hồ sơ tối thiểu, xe của active DB Driver từ JWT, không nhận identity query. |
| `/stations?vehicle_id=...` | Tìm tên/địa chỉ/mã trụ, xe tương thích, trạng thái/freshness. Có SoC/vị trí mặc định smart theo brief. |
| `/connectors/by-code/{displayCode}/{connectorNo}?vehicle_id=...` | Cổng chuẩn DB, cùng chuẩn đầu cắm owned vehicle; số cổng 1/2. Không suy ID từ site và số cổng. |
| `/places/autocomplete` | `vehicle_id`, `location_consent=true`, `q` 2–120; latitude/longitude tùy chọn cùng nhau. `{value:[address],computed_at,cached}`. |
| `/places/resolve` | Owned vehicle, consent, ref `auto:`/`geocode:`; trả địa chỉ/tọa độ, không là ID trạm. |
| `/stations/{site_id}/route` | Owned compatible vehicle, consent và tọa độ gốc; đích chỉ đọc DB. Trả mét, giây, GeoJSON `[longitude,latitude]`, thời điểm/cache. |

`/stations/suggestions` đã loại khỏi implementation/OpenAPI; gọi trả 404. Gợi ý dùng `/stations`
với `sort=smart&page_size=3&soc_percent=15&target_soc_percent=80&latitude=...&longitude=...`.
Charge/stop/progress/statement và credit có HTTP từ BE-22 (xem [hợp đồng §12](DRIVER-API-HOP-DONG.md)); time-left vẫn là hợp đồng dự kiến.

JSON snake_case, ID bigint chuỗi, UTC ISO; kW/tọa độ dạng số. Page `{items,total,page,page_size,estimate}`.
Thiếu SoC/vị trí/spec trả estimate null/lý do. Công thức/giả định công khai, không gọi Route/Matrix
để xếp hạng; distance_m vẫn haversine. Xếp mọi ứng viên trong bán kính trước phân trang. Thiếu
công suất/giá giữ null; VND ước tính ceil, khác quyết toán BR-P45. Route thật không fallback đường
chim bay, traffic unknown; vẫn xem đường tới trạm offline nhưng không xác nhận cổng cho phép Start.

Lỗi 400 input/search/reference; 401 + WWW-Authenticate; 403 role/state/subtype/origin; 404 không có/
không sở hữu/tương thích; 405 + Allow; 429 + Retry-After 60; 503 auth/policy/provider/location;
500 được làm sạch. Param lạ/trùng và chuỗi điều khiển bị từ chối. HTTP no-store; cache provider RAM
120 s/128 mục, principal riêng, tối đa 4 đồng thời, 30 miss/principal/phút và 120 miss/process/phút.
Request trùng dùng chung việc; hủy một caller không hủy caller khác; lỗi không cache. Provider
5 s/512 KiB, fixed HTTPS host, không redirect/retry hoặc log GPS/key/URL.

## Cấu hình và chạy

Node 24 theo `.nvmrc`, dependency hiện có theo lockfile; không cần thêm gói. Trong `infra/.env` private:
`DATABASE_URL`, cấu hình backend sẵn có, `VIETMAP_SEARCH_API_KEY`, `DRIVER_API_JWT_SECRET_BASE64`,
`DRIVER_API_JWT_ISSUER`, `DRIVER_API_JWT_AUDIENCE`; bounds/default `SMART_SEARCH_*` ở
[env example](../../infra/.env.example) và OpenAPI. Backend không tự đọc .env; nạp vào process:

```powershell
npm run build -w @powerme/csms
node --env-file=infra/.env apps/csms/dist/main.js
```

JWT HS256/typ JWT, sub bigint chuỗi, role driver, iss/aud/iat/exp bắt buộc, tối đa 900 giây. Key crypto
random ≥32 byte, base64 canonical, private ngoài Git; không dùng JWT_SECRET legacy, không in token/key.
DB kiểm active role/subtype mỗi request, ownership trước cache hit. OTP/login/refresh/revocation chưa có.
Local CORS chỉ localhost/loopback. Console admin chưa auth nên shared listener bắt buộc 127.0.0.1/::1;
mở LAN/proxy cần review auth/transport riêng.

Token local chỉ DB synthetic `powerme_mb03_baseline` port 54341, từ chối legacy DB:

```powershell
# DATABASE_URL và DRIVER_API_JWT_* đã được nạp riêng tư vào process.
$env:NODE_ENV = 'development'
$env:DRIVER_API_ENV = 'local'
$env:DRIVER_API_DEV_AUTH = 'false'
node apps/csms/scripts/driver-local-token.mjs E:/Project/PowerMe/.review/mb03-token-new.local
```

Script tạo/tái dùng synthetic Driver + owned CCS2 vehicle trong transaction, token 15 phút vào file mới
ngoài repo, không stdout; không seed trạm/session/credit/payment. Consent synthetic không là consent
người thật. Dùng thư mục private có ACL Windows, đổi filename khi cấp token mới. Dev X-Driver-Id mặc
định tắt; cần đồng thời flag và môi trường development/local hoặc test/test; bearer sai không fallback.

## Kiểm tra tái lập

TMP/TEMP process trong `.review` trên E. Không đưa DATABASE_URL người dùng vào test cũ.

```powershell
npm run lint
npm run typecheck -w @powerme/csms
npm run build -w @powerme/csms
npm test -w @powerme/csms -- --runInBand --runTestsByPath src/driver/driver-auth.spec.ts src/driver/vietmap.spec.ts src/driver/provider-cache.spec.ts src/sessions/smart-search.spec.ts src/config.spec.ts src/console/console.http.spec.ts src/console/console.router.spec.ts
# Nạp riêng tư MB03_TEST_ADMIN_DATABASE_URL: loopback /postgres trên cluster test.
$env:MB03_ALLOW_CREATE_TEST_DATABASE = 'true'
npm run test:driver-discovery -w @powerme/csms
```

Runner tạo hai DB mới `powerme_mb03_driver_test_<timestamp>_<random>`, mỗi suite một DB; không
reset/drop DB cũ, xóa admin URL và DATABASE_URL khỏi child. Áp 16 migration, fixture synthetic trong
DB riêng; giữ DB để review. CI gọi runner riêng với PostgreSQL 16.4; checks cũ giữ nguyên.
Kết quả thực/giới hạn ở [matrix](MB03-EDGE-CASE-MATRIX.md).

## Provider và giới hạn

Search key chỉ backend infra/.env; Tile mobile không đổi. Probe 06/11 xác nhận Autocomplete/Place/
Route/Matrix tại thời điểm đo. Route unencoded 07/11 trả LineString 4 điểm, 137,4 m/50 s; không lưu
key/URL/raw body. Không gọi lại API tính phí ngày 09/11. Nếu được yêu cầu, output file mới private:

```powershell
node apps/csms/scripts/vietmap-probe.mjs infra/.env E:/Project/PowerMe/.review/mb03-provider-new.json
# Một Route geometry request:
node apps/csms/scripts/vietmap-probe.mjs infra/.env E:/Project/PowerMe/.review/mb03-road-new.json --road-only
```

Chưa làm seed xe hãng có nguồn, last-known SoC, reservation, wait thực, reliability, Cheapest/arrival
tariff, đường thật cho ranking, taper >80%, Flutter/client hoặc auth lifecycle đầy đủ.
MB03 không đổi RFID/settlement hay clock khung giá chung. Upstream BE-19 đã có kiểm
credit thẻ online; xem [BE-19](../BE-19-CARD-AUTHORIZE.md). Local PG17 không chứng minh staging PG16, thiết bị,
load toàn mạng hay DoD. Chưa chạy Redocly, Dart generation, Flutter, payment hoặc deployment.
Snapshot đồng bộ 09/11/2026: bản kiểm tra này dựa trên main `6fd720d`, giữ các thay đổi
RFID/cảnh báo offline/resolve review từ upstream. Kết quả local nằm trong matrix; trạng thái
GitHub xem nhánh/commit. Tài liệu này không xác nhận CI hoặc staging đã chạy.
