# MB03 — edge case và bằng chứng kiểm thử

Kết quả local ngày **09/11/2026**, nhánh `wp3/mb-03-vietmap-search-suggest`, nền main
`6fd720d319a17405a39ac6a91d0e1bade49398e2`. Trạng thái GitHub xem nhánh/commit.
Ưu tiên [brief 07/11](../requirements/smart-station-search-brief-20261107.md);
[API/cách chạy](MB03-BACKEND-DISCOVERY.md), [quyết định và nghiên cứu](../adr/0017-driver-discovery-jwt-and-vietmap-adapter.md).

## Nguồn để chọn rủi ro

- [OWASP API1:2023](https://api-security.owasp.org/editions/2023/en/0xa1-broken-object-level-authorization/): quyền sở hữu phải được kiểm trên từng tài nguyên, kể cả cache hit.
- [OWASP API4:2023](https://api-security.owasp.org/editions/2023/en/0xa4-unrestricted-resource-consumption/): giới hạn trang, thời gian, response, số request và cache.
- [RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html): giới hạn thuật toán JWT, kiểm issuer/audience/type/claims.
- [Vietmap Route v4](https://maps.vietmap.vn/docs/map-api/route-version/route-v4/): đầu vào lat/lon, GeoJSON lon/lat, thời gian mili giây đổi sang giây.

GitHub source/tests, commit và license của jose, node-jsonwebtoken và ví dụ Vietmap nằm trong ADR-0017.
Đây là lựa chọn test có căn cứ, không phải chứng nhận bảo mật hay tuyên bố bao phủ mọi tình huống.

## Kết quả thực tế

| Bộ kiểm tra | Kết quả ngày 09/11 |
| --- | --- |
| HTTP + PostgreSQL: `driver-discovery.integration.test.ts` | **34/34 pass**, gồm sửa NUL/newline query cuối |
| HTTP + PostgreSQL: `driver-smart.integration.test.ts` | **57/57 pass** |
| 7 suite unit/hồi quy auth, provider, cache, smart config, config, console HTTP/router | **105/105 pass** |
| Format toàn repo; lint workspace hiện có; typecheck/build CSMS | Pass; hai test bổ sung đã kiểm format và typecheck lại |
| YAML OpenAPI 0.4 và local `$ref` | Pass bằng js-yaml đang có; không thay thế Redocly/schema validation đầy đủ |
| Script token local: kiểm đường dẫn thực qua subprocess | **7/7 pass**; gồm `..token` trong repo và đường khác ổ, không cấp token/kết nối DB |

Mỗi integration suite tạo **một DB mới** trên PostgreSQL 17.10 loopback; áp 16 migration.
Hai DB kiểm tra cuối: `powerme_mb03_driver_test_1794214618534_d988f4a9` và
`powerme_mb03_driver_test_1794214621382_612dd5b3`. Giữ lại để review; không reset/drop DB cũ.
Provider giả lập chỉ trong test để tái lập lỗi; API sản phẩm đọc inventory/ownership từ DB.
CI đã thêm runner riêng với PG16.4; **kết quả trên không xác nhận CI hoặc staging đã chạy**.

## Ma trận API → rủi ro → test

Đường dẫn trong bảng đều tương đối từ `apps/csms/`. Tên trong dấu backtick là tên test thực;
với `%s`, Jest mở rộng từng endpoint `me/stations/connector/autocomplete/place/route`.
Một test có thể kiểm nhiều input; số input trong vòng lặp không được cộng thành số test Jest.

| API / rủi ro | File và tên test | Kết quả |
| --- | --- | --- |
| Cả 6 route: thiếu/sai/hết hạn token, sai iss/aud/nbf/iat/alg/chữ ký, alg none | `test/driver-smart.integration.test.ts` — `%s rejects the JWT failure matrix before route execution` | Pass ×6 |
| Autocomplete: JWT ký hợp lệ nhưng header vượt 8192 ký tự | Cùng file — `rejects an otherwise valid signed JWT exceeding the 8192-character header bound` | Pass; 401 trước gọi provider |
| Cả 6 route: role/active DB, POST, origin lạ, preflight, Authorization trùng | Cùng file — `%s enforces DB role active state methods CORS and duplicate authorization` | Pass ×6 |
| Cả 6 route: query lạ/trùng, ID 0/âm/leading zero/exponent/overflow | Cùng file — `%s rejects unknown repeated or malformed query input` | Pass ×6 |
| 5 route có vehicle: xe người khác/không tồn tại, kể cả đã cache | Cùng file — `%s rejects other-owned and nonexistent vehicles before provider cache hits` | Pass ×5 |
| `/me`: không lộ trường private; tài xế chưa có xe | Cùng file — `me returns no private fields and an empty vehicle list for an owned vehicle-free driver` | Pass |
| `/stations`: bigint nguyên vẹn, snake_case, đơn vị số, tìm không dấu, connector chuẩn DB | `test/driver-discovery.integration.test.ts` — `returns DB inventory, lossless IDs, snake_case, numeric units and owned bootstrap` | Pass |
| `/stations`: thiếu SoC; ba nhãn reach; xa/rảnh/nhanh tốt hơn gần/bận/chậm | `test/driver-smart.integration.test.ts` — `B6.1 no SoC preserves legacy distance search with no_soc`; `B6.2 labels road 20/30/40 km ok tight risky with one 0.75 range factor`; `B6.3 farther free 120 kW beats nearby busy 30 kW by total completion time` | Pass ×3 |
| `/stations`: thiếu dung lượng/tầm, toàn risky, SoC 0 và bán kính rõ ràng | Cùng file — `B6.4 missing capacity or range falls back to legacy distance ordering`; `B6.5 all risky and zero SoC keep a bounded nearest fallback; explicit radius stays exact` | Pass ×2 |
| `/stations`: SoC 90/−1/80/NaN/Infinity/exponent/rỗng; max DC xe | Cùng file — `B6.6 rejects invalid SoC %s with invalid_search`; `B6.7 vehicle max DC caps 120 kW connector to 50 kW` | Pass ×8 |
| `/stations`: SoC 79.99, target thiếu/sai/≤SoC/>80; thiếu GPS | Cùng file — `accepts 79.99 SoC and validates optional target even without SoC`; `missing GPS smart fallback sorts by name; explicit distance without GPS remains invalid` | Pass ×2 |
| `/stations`: power súng null → trụ; max DC null; power đều thiếu; chọn súng ít tổng phút | Cùng file — `connector null power falls back to pillar; missing max DC is allowed; all absent power stays unknown`; `uses compatible connector with minimum total time rather than earliest free connector` | Pass ×2 |
| `/stations`: xếp trước phân trang, tie ổn định, trang rỗng, giữ name/distance cũ | Cùng file — `smart ranking precedes pagination and stable ties have no duplicate or missing sites` | Pass |
| `/stations`: unknown/offline/unavailable cuối; freeing soon 5 phút; fallback không giấu trạm thứ tư dùng được | Cùng file — `unknown offline unavailable sort last without estimates; freeing soon waits five minutes`; `implicit nearest fallback considers usable fourth station before closer offline stations` | Pass ×2 |
| `/stations`: giá 0/thiếu/hết hạn/tương lai/ngày hiệu lực ICT/ceil/unsafe bigint | Cùng file — `cost uses current ICT effective maximum tariff; zero is distinct from missing and unsafe bigint` | Pass |
| `/stations`: SQL metacharacters literal, trang/bán kính/tọa độ sai, biên tọa độ | Cùng file — `empty text matches and SQL metacharacters stay literal; invalid pagination and partial GPS fail` | Pass |
| `/stations`: NUL/newline/chuỗi dài, enum sai, exponent/hex/page không nguyên, query trùng | `test/driver-discovery.integration.test.ts` — `validates %s` (gồm `q=%00`, `q=%0A`) | Pass ×17 |
| `/stations`: stale khác offline; không hứa available khi thiếu/freshness kém | Cùng file — `keeps status, freshness and connectivity separate without promising availability` | Pass |
| `/stations`: phân trang cũ, filter trạm VinFast override, trang xa giữ total | Cùng file — `paginates sites stably, preserves empty pages and uses straight-line distance` | Pass |
| `/connectors/by-code`: slash/backslash/control/malformed percent/số cổng sai | Cùng file — `rejects malformed connector path %s` | Pass ×9 |
| Connector/route/search: xe không tương thích không được lộ resource | `test/driver-smart.integration.test.ts` — `connector rejects bad reference encoding and incompatible vehicles` | Pass |
| Autocomplete/place/route: consent, q ngắn/dài/control, focus thiếu nửa, ref sai | Cùng file — `address endpoints validate consent text focus and reference format` | Pass |
| 3 provider route: 401/403/423/429/500/network/timeout/JSON hỏng/quá cỡ/schema; no route/geometry/null coords | Cùng file — `%s sanitizes provider faults and never caches failed responses` | Pass ×3; lỗi không lộ key/URL |
| Route: đích canonical DB, không nhận URL đích; offline vẫn xem đường; thiếu tọa độ trạm | Cùng file — `route uses canonical DB destination and real road units even when station is offline` | Pass |
| Provider cache: đổi owner/visibility sau cache hit phải kiểm lại | Cùng file — `cached provider responses recheck vehicle and station ownership compatibility and visibility` | Pass |
| Provider: miss budget trả 429/Retry-After; hit vẫn được đọc | Cùng file — `provider miss budget returns Retry-After while cache hits remain available` | Pass |
| Auth chưa cấu hình/DB lỗi: 503/500 sạch; route advanced cũ đã bỏ | Cùng file — `missing JWT configuration fails unavailable and internal DB faults are sanitized`; `retired advanced suggestions route returns 404` | Pass ×2 |
| Auth: expiry bắt buộc/lifetime dài/subject sai, role spoof/subtype, dev header không bypass bearer | `test/driver-discovery.integration.test.ts` — `rejects missing/invalid/expired/future/incorrect issuer, audience, algorithm and signature`; `rejects JWT role spoofing, wrong DB role, absent subtype and suspended/closed accounts`; `does not trust query identity or disabled dev headers, including invalid bearer fallback` | Pass ×3 |
| Shared listener: không mở console chưa auth ra wildcard/LAN | Cùng file — `rejects duplicate authorization headers and refuses non-loopback shared listeners` | Pass |
| JWT config/ID: dev auth opt-in, config đủ/strong base64, bigint overflow | `src/driver/driver-auth.spec.ts` — `disables dev auth by default and requires explicit local/test configuration`; `requires complete JWT config with a strong base64 key`; `keeps bigint IDs lossless and rejects malformed/overflow IDs` | Pass ×3 |
| Provider: GeoJSON lon/lat, đảo tọa độ sai, route ms/matrix s, địa chỉ riêng inventory, no route | `src/driver/vietmap.spec.ts` — `validates actual unencoded GeoJSON lon/lat geometry and keeps traffic unknown`; `separates addresses and place coordinates from station inventory`; `keeps Route milliseconds and Matrix seconds explicit and preserves repeated points`; `fails closed on absent key, transport failures, oversized JSON and invalid schemas` | Pass ×4 |
| Provider: HTTP error sạch, timeout không lộ URL; redirect='error' | Cùng file — `sanitizes provider HTTP %s`; `aborts on timeout without leaking the provider URL`; assertion redirect trong test address/HTTP fixture | Pass; không có thử redirect qua server ngoài |
| Cache: coalesce, principal, TTL 120 s, failure không cache, concurrency 4, budget miss | `src/driver/provider-cache.spec.ts` — `coalesces concurrent calls, scopes principals, expires at two minutes and never caches failure`; `bounds concurrency and charges per-principal requests only on provider misses` | Pass ×2 |
| Cache: 120 miss/phút trên các principal khác nhau, hit vẫn dùng được, reset sau 60 giây | Cùng file — `caps misses across principals at 120 per minute and reopens the budget after expiry` | Pass |
| Cache: hủy caller không hủy việc chung; không mutate shared result; quá 128 eviction | Cùng file — `does not let one caller cancellation poison shared work or another caller`; `evicts beyond 128 entries without logging keys or retaining expired values` | Pass ×2 |
| Config smart: mặc định/override, zero/negative/NaN/Infinity/tiny/overflow | `src/sessions/smart-search.spec.ts` — `loads the brief assumptions and supports bounded process configuration`; `rejects invalid or numerically unsafe assumption %s=%s` | Pass ×12 |

Các suite config và console được chạy hồi quy trong tổng 105 unit test; không tính chúng là test
nghiệp vụ search mới. Không cộng các hàng bảng vì có test được dẫn lại theo nhiều rủi ro.

## Giới hạn bằng chứng

- Route/Matrix live probe ngày 06/11 và geometry ngày 07/11 nằm trong ADR-0017. Không gọi lại API tính phí ngày 09/11; test lỗi provider dùng fetch giả lập.
- ICT effective-date được kiểm bằng ngày hiện tại ±1 và ngày hiệu lực bao gồm hai đầu; chưa chạy đồng hồ giả qua đúng nửa đêm ICT. Đây là ước tính max tariff, không giải quyết clock quyết toán.
- Giới hạn 1024 budget entry chưa đo độc lập: budget global 120/phút và expiry đã chặn trước trong cấu hình mặc định. Không thử tất cả kiểu JWT claim ở mọi endpoint; không tuyên bố kiểm thử tải/coverage tuyệt đối.
- Chưa benchmark smart lấy hết ứng viên trong bán kính trên inventory lớn; fallback có giới hạn, không đảm bảo top ba toàn mạng ngoài bán kính.
- Chưa chạy login/OTP/refresh, Flutter, charge/stop HTTP, quyết toán RFID, thiết bị, staging/CI hoặc deployment. Upstream **BE-19** đã thêm kiểm credit thẻ online; đây không là thay đổi hay test mới của MB03.
- Kết quả local không đồng nghĩa task đã đạt DoD của CONTRIBUTING; vẫn cần review, CI và xác nhận môi trường nhóm.
