# Hợp đồng REST cho app tài xế (T77) — trạng thái súng, thời gian còn lại, bắt đầu / dừng / theo dõi phiên

**Ngày:** 30/10/2026
**Task:** T77 — hợp đồng REST trạng thái và ETA, chuyển từ WP4 sang WP2 ở phiếu v1.3 §3.2g; gap G1 trong Design Brief WP2
**Người chịu trách nhiệm:** Ngô Văn Minh Trí (WP2) — hợp đồng; Lý Hoàng Sơn (WP3) — route HTTP (Tuần 9) và client Dart
**File hợp đồng:** [`driver-api.openapi.yaml`](driver-api.openapi.yaml) (OpenAPI 3.1, `redocly lint` sạch lỗi 30/10)
**Trạng thái local 09/11/2026 trên nhánh MB03:** có route JWT `GET /stations`, connector resolution,
`GET /me`, `/places/autocomplete`, `/places/resolve`, `/stations/{site_id}/route`.
[Brief 07/11](../requirements/smart-station-search-brief-20261107.md) được người dùng ưu tiên cho search/gợi ý:
`/stations` thêm SoC/target/smart, tính reach và tổng phút trước phân trang; `/stations/suggestions`
thử nghiệm cũ đã bỏ (404). OpenAPI 0.4 có consent/ownership, GeoJSON lon/lat, nullable estimates và lỗi provider.
Charge/session/credit HTTP có từ BE-22 (dưới); time-left vẫn chỉ là hợp đồng. Route Vietmap thật tách khỏi xếp hạng theo công thức brief.
Xem [hướng dẫn MB03](MB03-BACKEND-DISCOVERY.md) cho trạng thái, token local, checks và giới hạn;
không suy ra OTP/login đã hoàn thành. Thay đổi chưa merge/commit/push khi bàn giao review.
**BE-21 (09/11/2026, OpenAPI 0.5.0):** thêm `POST /auth/register`, `/auth/login`, `/auth/refresh`
(email + mật khẩu, không cần bearer) — xem §6. OTP/Google/Firebase vẫn chưa làm.
**BE-22 (10/11/2026, OpenAPI 0.6.0, T95):** nối HTTP cho `POST /charges`, `GET /charges/{key}`,
`GET /sessions/{id}/progress`, `POST /sessions/{id}/stop`, `GET /sessions/{id}/statement` và thêm
`GET /credit`, `GET /credit/transactions` — xem §2, §7 và §12 (cách app gọi). Còn lại: `time-left`.

---

## 1. Vì sao cần hợp đồng này ngay

Hội đồng Review 2 (29/10) hỏi: *"nhóm cần một simulation bắn tín hiệu OCPP để app điện thoại lấy được tín hiệu hiển thị thông tin sạc"*. Trả lời đúng là: OCPP **không** đi vào điện thoại. Trụ nói OCPP với CSMS; app lấy trạng thái từ CSMS qua REST. Simulator và CSMS đã có; mắt xích thiếu là **đường REST** này. Hợp đồng chốt trước để WP3 dựng màn hình và sinh client Dart song song với WP2 viết route.

Tình huống chuỗi phải chạy được ở Review 3: HMI trụ đổi súng A sang `Charging` → CSMS ghi StatusNotification và MeterValues → trong **5 giây** app tài xế hiện "đang sạc · 1,2 kWh · còn khoảng 18–26 phút".

## 2. Tám đường dẫn và hàm đã có

| Đường dẫn | Hàm trong `DriverChargingService` | UC / BR | Trạng thái route |
|---|---|---|---|
| `GET /stations` | `findStations` → `searchStations` | UC-CHG-01; BR-P03, P38, P39 | có (MB03) |
| `GET /connectors/by-code/{code}/{no}` | `resolveConnector` | UC-CHG-02 bước quét QR; BR-P10 | có (MB03) |
| `GET /connectors/{id}/time-left` | **chưa có** | FR-03; BR-P32, P40 | chưa — hình dạng chốt ở đây |
| `POST /charges` | `start` | UC-CHG-02; D4; BR-P18, P19 | có (BE-22) |
| `GET /charges/{key}` | `getStart` | UC-CHG-02 (mất mạng giữa chừng) | có (BE-22) |
| `GET /sessions/{id}/progress` | `progress` | UC-CHG-04 | có (BE-22); `estimated_cost_vnd` cận trên, `time_left` luôn null |
| `POST /sessions/{id}/stop` | `stop` → `commandSnapshot` | UC-CHG-03; BR-P01 | có (BE-22) |
| `GET /sessions/{id}/statement` | `statement` | BR-P45, P34 | có (BE-22) |
| `GET /credit` | — (đọc `credit_accounts`, `driver/driver-credit.ts`) | UC-PAY-02; BR-P18 | có (BE-22) |
| `GET /credit/transactions` | — (đọc `credit_transactions`) | UC-PAY-02 | có (BE-22) |

Route tài xế nằm **cùng tiến trình/cổng HTTP** với console `/api/admin/*` (mặc định 3000),
qua handler riêng `driver/driver.http.ts` (route sạc/credit ở `driver/charges.http.ts`) do
`ConsoleServer` chọn trước handler admin. Không mở cổng mới hoặc Nest controller. Admin chưa có
auth nên shared listener bắt buộc loopback.

## 3. Trạng thái súng và thời gian còn lại: luật nghiệp vụ thành trường JSON

**Trạng thái** (BR-P38): CSMS giữ 9 giá trị OCPP nguyên văn trong `connectors.status`; API trả cả `status` (OCPP) lẫn `driver_status` (5 nhóm + `unknown`). App chỉ vẽ theo `driver_status`.

**Độ tươi** (BR-P39): `status_quality = stale` khi không có bản tin quá 2 chu kỳ heartbeat (mặc định 2 × 300 s, biến `CHARGE_STATION_STALE_MS`); `driver_status = offline` khi quá `OCPP_OFFLINE_THRESHOLD_SECONDS` (900 s). App hiện "có thể đã cũ" và thời điểm `status_updated_at`.

**Thời gian còn lại** (BR-P32, BR-P40): luôn là **khoảng** `[min_minutes, max_minutes]` hoặc `kind = unknown`, không bao giờ là một mốc. `kind` nói ước tính dựa vào gì, theo thứ tự có dữ liệu:

| `kind` | Dữ liệu | Có trong CSMS? |
|---|---|---|
| `limit` | hạn mức Wh của phiên (`sessions.limit_value`) và công suất hiện tại | có |
| `soc_curve` | SoC từ MeterValues (`measurand = SoC`) + đường cong sạc DC theo mẫu xe | SoC được lưu nếu trụ gửi; đường cong chưa có |
| `history` | thời lượng phiên gần đây trên cùng trụ | dữ liệu có (`sessions`), hàm chưa |
| `unknown` | không đủ dữ liệu, kèm `reason` | — |

Tình huống thật cho từng mức: tài xế đặt hạn mức 20 kWh và trụ đang 60 kW → `limit`, 18–22 phút. Trụ gửi SoC 42 % và xe là VF 8 → `soc_curve`. Trụ không gửi SoC (BR-P40 ghi "CSMS ghi nhận trụ có gửi SoC không") → `history` từ 30 phiên gần nhất. Trụ mới lắp, chưa có phiên → `unknown`, `reason = no_history`.

## 4. Bắt đầu và dừng: vì sao là 202 và vì sao có Idempotency-Key

Bắt đầu từ app là **D4**: ghi start intent bền trước, gửi RemoteStartTransaction sau, phiên chỉ tồn tại khi trụ gửi StartTransaction. Nên `POST /charges` trả **202** với `outcome` thay vì 201 với phiên. App poll `GET /charges/{key}` cho đến khi `session_id` khác null rồi chuyển sang `progress`.

Tình huống: tài xế bấm "Bắt đầu", app mất 4G ngay sau khi gửi. App gửi lại cùng `Idempotency-Key` → CSMS trả snapshot cũ, không tạo intent thứ hai, không gửi RemoteStart lần hai. Cùng key nhưng đổi `connector_id` → 409 `idempotency_conflict`.

Dừng tương tự: `POST /sessions/{id}/stop` trả 202 với `command_status`; phiên chỉ `closed` khi trụ gửi StopTransaction (BR-P01). `timeout` không phải thất bại: operator có đường khôi phục T72.

## 5. Phiên không do app tạo

README WP3 ghi: app phải xử lý được phiên nó không tạo ra (thẻ RFID online, mật khẩu HMI). Hợp đồng: `sessions/*` trả mọi phiên có `driver_id` là tài xế gọi, bất kể `origin`; `charges/*` chỉ có với phiên bắt đầu từ app. Thẻ ví (`station_wallet`) không gắn tài xế nên không xuất hiện trong app, đúng BR-P08.

Câu trả lời một dòng cho hội đồng về RFID: **thẻ online** để tài xế bắt đầu phiên không cần điện thoại, tiền trừ từ credit như app; **thẻ ví** là trụ tự thu, CSMS chỉ ghi nhận để đối soát.

## 6. Xác thực

MB03 xác minh HS256 JWT bằng jose 6.2.15: typ JWT, issuer/audience cấu hình, sub bigint chuỗi,
role driver, iat/exp, tối đa 900 giây; DB xác nhận active Driver/subtype mỗi request. Xe phải thuộc
Driver từ token. `X-Driver-Id` chỉ khi flag bật và môi trường được
khai báo local/development hoặc test/test; bearer sai không fallback. Console admin vẫn chưa có
auth nên server dùng chung bắt buộc loopback. Chi tiết và script token local ở hướng dẫn MB03.

**Đăng ký / đăng nhập / làm mới (BE-21, Trí hỗ trợ F-01 của Sơn).** Ba route `POST`, không cần
bearer, chỉ nhận `application/json` ≤ 16 KiB, trường lạ → 400:

| Route | Body | Thành công | Lỗi chính |
|---|---|---|---|
| `/auth/register` | `email`, `password` (8–128), `full_name`, `phone_number?` (E.164), `consent_version`, `consent: true` | 201 + token như login | 400 `consent_required` (không ghi gì, BR-P05), `invalid_email`, `invalid_password`, `invalid_input`; 409 `email_taken` |
| `/auth/login` | `email`, `password` | 200 `{access_token, token_type: Bearer, expires_in: 900, refresh_token, refresh_expires_in}` | 401 `invalid_credentials` (sai email = sai mật khẩu); 403 `account_locked`; 429 `too_many_attempts` |
| `/auth/refresh` | `refresh_token` | 200 `{access_token, token_type, expires_in}` | 401 `invalid_refresh_token`; 403 `account_locked` / `forbidden` |

- Access token đúng chuẩn verify ở trên (HS256, `typ: JWT`, `role: driver`, 900 s), nên dùng ngay với
  `/me`, `/stations`. Refresh token cùng khoá nhưng `typ: refresh+jwt`, `token_use: refresh`, không có
  `role`: không dùng làm access token và ngược lại. Sống `DRIVER_API_REFRESH_TTL_S` (mặc định 30 ngày,
  1 giờ–90 ngày), không xoay vòng: hết hạn thì đăng nhập lại.
- Không có bảng refresh token: không thu hồi từng token, logout = app xoá token. Khoá tài khoản
  (`account_status` ≠ `active`) có hiệu lực ngay vì refresh và mọi request đều kiểm DB.
- Tài khoản khoá: 403 `account_locked` (F-13 "tài khoản khoá không đăng nhập được"), chỉ trả khi mật
  khẩu đúng — để app hiện "tài khoản bị khoá, liên hệ hỗ trợ" mà người dò mật khẩu không biết được.
- Giới hạn thử sai: 5 lần / 60 s theo email + IP, 20 lần / 60 s theo IP → khoá 15 phút (Retry-After).
  Trong bộ nhớ một tiến trình: restart là mất, nhiều instance thì mỗi cái đếm riêng.
- Đăng ký tạo `users` (role driver, active, mật khẩu băm scrypt) + `drivers` (consent) trong một
  transaction; **không** tạo ví credit/loyalty (SRS không yêu cầu; `ensureAccounts` tạo khi cần).
- Chưa cấu hình JWT → 503 `auth_unavailable`. Không log mật khẩu, hash, token; response không có hash.

**Môi trường staging (BE-27).** Driver API chạy trên staging nhưng **không ra internet** (cùng
listener với console vận hành chưa xác thực; Caddy chỉ proxy `/ocpp/*` và `/health`). App dev gọi
qua SSH tunnel: `ssh -N -L 5433:127.0.0.1:5432 -L 3000:127.0.0.1:3000 devtunnel@<FQDN>`, base URL
`http://127.0.0.1:3000/api/driver/v1` (Android Emulator: `http://10.0.2.2:3000/api/driver/v1`).
JWT: issuer `powerme-staging`, audience `powerme-driver-app`, refresh 30 ngày; `X-Driver-Id` tắt.
Tài xế mẫu `app.ds01/ds02/ds03@powerme.test` (DS-01 200.000 VND, DS-02 30.000 VND, DS-03 600 điểm),
mật khẩu nhận riêng. Chỉ trụ demo `PM-D1-HCM-0001` bắt đầu sạc được; trạm `HCM-APP-*` luôn
`offline`. Hướng dẫn, cảnh báo: [infra/staging/DEV-ACCESS.md](../../infra/staging/DEV-ACCESS.md);
dữ liệu mẫu: [infra/staging/README.md](../../infra/staging/README.md#dữ-liệu-mẫu-cho-app-tài-xế-be-27).

## 7. Lỗi: từ `ChargingError.code` sang HTTP

| HTTP | Mã `error` |
|---|---|
| 202 (không phải lỗi) | `POST /charges` với tín dụng không đủ: `outcome = topuprequired` / `requiresconfirmation` trong body (BE-22, xem §12) |
| 400 | `invalid_input`, `invalid_search`, `invalid_connector_reference`, `invalid_idempotency_key` (thiếu / trùng / sai header `Idempotency-Key`, 8–100 ký tự `[A-Za-z0-9._:-]`), `reserved_idempotency_key`, `unsupported_mode`, `vehicle_not_owned_or_incompatible` |
| 401 / 403 | `unauthorized`, `forbidden`; `/auth/*`: `invalid_credentials`, `invalid_refresh_token`, `account_locked` |
| 400 / 409 / 413 / 415 / 429 (`/auth/*`) | `consent_required`, `invalid_email`, `invalid_password`; `email_taken`; `payload_too_large`; `unsupported_media_type`; `too_many_attempts` |
| 404 | `not_found` (không phân biệt "không có" và "không của bạn") |
| 405 / 413 / 415 (charges) | `method_not_allowed` (+ `Allow`); `payload_too_large` (> 16 KiB); `unsupported_media_type` (`POST /charges` không phải `application/json`) |
| 409 | `idempotency_conflict`, `credit_unavailable` (chưa có ví hoặc ví không `active`), `connector_unavailable`, `connector_busy_or_unknown`, `tariff_unavailable`, `session_not_stoppable`, `stop_pending_or_unknown` |
| 503 | `policy_unconfigured` |

Các mã `recovery_*`, `start_not_recoverable`, `stop_attempt_not_current` thuộc đường operator (T72), không có trong API tài xế; nếu lọt ra thì route trả 500 `internal_error` đã làm sạch. Ánh xạ nằm ở `chargingErrorStatus` (`driver/charges.http.ts`).

## 8. JSON: snake_case, id là chuỗi

Hàng `pg` trả snake_case và bigint dạng chuỗi; `ChargeSnapshot` trong service là camelCase. Hợp đồng chọn **snake_case và id chuỗi** cho toàn bộ API, tầng route đổi tên trường của `ChargeSnapshot` (`intentId → intent_id`...). Lý do: một quy ước cho cả `/api/admin` và `/api/driver`, và Dart client sinh từ OpenAPI không phải đoán kiểu số 64 bit.

## 9. Realtime

Không có trong phiên bản 0.1.0. App poll `progress` mỗi 5 s (đủ ngưỡng M3 "trong vài giây"). Tuần 10: `GET /sessions/{id}/events` dạng SSE, cùng hình dạng `SessionProgress`, được phép mất sự kiện vì app vẫn poll (ADR-0006: realtime không nằm trên đường nghiệp vụ).

## 10. Cách WP3 dùng ngay

```bash
# xem hợp đồng dạng web
npx -y @redocly/cli@1.34.3 preview-docs docs/api/driver-api.openapi.yaml
# sinh client Dart (openapi-generator cần Java)
npx -y @openapitools/openapi-generator-cli generate -i docs/api/driver-api.openapi.yaml -g dart-dio -o apps/mobile/lib/api
```

MB03 có [runner HTTP/Postgres riêng](../../apps/csms/scripts/test-driver-discovery.mjs) và
[hướng dẫn tái lập](MB03-BACKEND-DISCOVERY.md). Local response đã kiểm schema; chưa chạy Redocly
hoặc generated Dart client trong slice này. Không tự tải thêm công cụ khi dependency chưa được duyệt.

## 11. Chưa chốt, ai chốt

| # | Câu hỏi | Đề xuất | Ai |
|---|---|---|---|
| 1 | Đường cong sạc DC theo mẫu xe lấy từ đâu cho `soc_curve` | bảng `vehicle_models` thêm 3 điểm (kW tại 20/50/80 % SoC), Admin nhập | Trí + Khang |
| 2 | `estimated_cost_vnd` khi đang sạc tính theo biểu giá lúc nào | giá của đoạn hiện tại × Wh đã sạc, ghi rõ "ước tính" (BR-P02) | Trí + Khang |
| 3 | Chế độ sạc ngoài `energy_kwh` (tiền, thời gian) | giữ ngoài hợp đồng đến khi OCPP có lệnh đặt hạn mức; app làm hạn mức mềm | Sơn |
| 4 | Login/OTP/refresh cho tài xế | BE-21 có đăng ký/đăng nhập email + mật khẩu và refresh không bảng (§6). OTP/Google/Firebase ngoài phạm vi, để sau Defense 1.1; hướng dự kiến: đổi token Firebase → JWT CSMS qua một route mới | Sơn + Trí |

## 12. BE-22 — cách app gọi route sạc và credit (cho Sơn, T96)

Mọi route cần `Authorization: Bearer <access_token>` từ `/auth/login` (§6); 401 → gọi `/auth/refresh`
rồi thử lại một lần. Id luôn là **chuỗi**; tiền (VND) và điện năng (Wh) là số nguyên.

**Bắt đầu (UC-CHG-02).** App sinh một UUID v4 cho mỗi lần tài xế bấm "Bắt đầu", lưu lại cùng màn
hình, rồi:

```
POST /charges   Idempotency-Key: <uuid>   Content-Type: application/json
{"connector_id":"12","vehicle_id":"3","mode":"energy_kwh","energy_limit_wh":20000}
→ 202 {intent_id, command_id, session_id, outcome, effect_confirmed, version, max_energy_wh}
```

- Mất mạng / timeout: gửi lại **đúng key, đúng body** (không tạo intent thứ hai, không gửi lệnh lần
  hai) hoặc `GET /charges/<uuid>`. Đổi body với key cũ → 409 `idempotency_conflict`.
- Poll `GET /charges/<uuid>` mỗi 1–2 s cho tới khi `session_id` khác null → sang màn theo dõi.
- Dừng poll và báo lỗi theo `outcome`: `topuprequired` → "số dư dưới mức tối thiểu, nạp thêm";
  `requiresconfirmation` → hỏi "chỉ sạc được tối đa `max_energy_wh`", đồng ý thì gửi **key mới**
  với hạn mức đó; `rejected` → trụ từ chối; `start_timeout` / `released` → trụ không bắt đầu, thử
  lại. `sent`, `accepted`, `unknown` → tiếp tục poll (tài xế cắm súng).
- 409 `connector_unavailable` / `connector_busy_or_unknown` → súng không sẵn sàng, chọn súng khác.

**Theo dõi (UC-CHG-04).** `GET /sessions/{id}/progress` mỗi 5 s: `status`, `consumed_wh` (hiện
kWh = /1000), `estimated_cost_vnd` (ghi "tạm tính, tối đa"), `charge_point.is_online`.
`telemetry_quality = unknown` → "chưa có số đo". Phiên tài xế bắt đầu bằng thẻ RFID cũng xem được.

**Dừng (UC-CHG-03).** `POST /sessions/{id}/stop` với `Idempotency-Key` mới (UUID), không body → 202
`{command_id, command_status, session_status, effect_confirmed}`. Gửi lại cùng key an toàn.
`command_status = accepted` chưa là đã dừng: poll progress tới khi `meter_stop_wh` khác null, rồi
tới khi `settlement_state = posted` thì gọi `GET /sessions/{id}/statement` (trước đó 404). `timeout`
→ CSMS tự gửi lại (BE-17); app tiếp tục poll. 409 `session_not_stoppable` → phiên đã dừng.
Phiên RFID/HMI dừng tại trụ (route trả 404).

**Credit (UC-PAY-02).** `GET /credit` → `{balance_vnd, held_vnd, available_vnd, status, updated_at}`;
hiện `available_vnd` là số có thể dùng để sạc, `held_vnd` là "đang giữ cho phiên".
`status = none` → tài xế chưa có ví (chưa nạp lần nào). `GET /credit/transactions?page=1&page_size=20`
→ sổ cái mới nhất trước; dòng `session_debit` có `session_id` để mở bảng kê.

Id của tài xế khác, key của tài xế khác và id không tồn tại đều trả 404 `not_found` như nhau.
