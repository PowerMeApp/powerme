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
**BE-30 (12/11/2026, OpenAPI 0.7.0):** đăng nhập bằng email **hoặc** số điện thoại + mật khẩu;
`phone_number` khi đăng ký được chuẩn hoá về E.164 và duy nhất (409 `phone_taken`, migration 0017)
— xem §6 và §6a. OTP/SMS và Google/Firebase vẫn ngoài phạm vi.
**BE-34 (12/11/2026, OpenAPI 0.8.0):** quản lý xe (F-01, UC-ACC-03): `GET /vehicle-models`,
`POST /vehicles`, `PATCH /vehicles/{id}` (đặt mặc định), `DELETE /vehicles/{id}` (xoá mềm,
migration 0018) — xem §13.
**T32 Phần 5 (12/11/2026, OpenAPI 0.9.0, WP5 — Khang):** thêm `GET /billing/top-ups/quote`,
`POST /billing/top-ups`, `GET /billing/top-ups/{id}` (nạp Charging Credit qua VNPay, WF-02 SD-2a)
— xem §2, §7 và §14. **Chưa dùng cho app** tới khi T32 Phần 6 và Phần 8 merge.

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
| `GET /vehicle-models`, `POST /vehicles`, `PATCH`/`DELETE /vehicles/{id}` | — (`driver/vehicles.http.ts`) | UC-ACC-03; BR-P03, BR-P17 | có (BE-34), §13 |
| `GET /billing/top-ups/quote` | `TopUpService.quote` (billing) | UC-PAY-01; BR-P35 | có (T32 Phần 5), **chưa dùng cho app** (§14) |
| `POST /billing/top-ups` | `TopUpService.create` (billing) | UC-PAY-01; BR-P22, P35; WF-02 D2 | có (T32 Phần 5), **chưa dùng cho app** (§14) |
| `GET /billing/top-ups/{id}` | `TopUpService.get` (billing) | UC-PAY-01 | có (T32 Phần 5), **chưa dùng cho app** (§14) |

Route tài xế nằm **cùng tiến trình/cổng HTTP** với console `/api/admin/*` (mặc định 3000),
qua handler riêng `driver/driver.http.ts` (route sạc/credit ở `driver/charges.http.ts`, top-up ở
`driver/top-ups.http.ts`) do
`ConsoleServer` chọn trước handler admin. Không mở cổng mới hoặc Nest controller. Admin chưa có
auth nên shared listener bắt buộc loopback.

## 3. Trạng thái súng và thời gian còn lại: luật nghiệp vụ thành trường JSON

**Trạng thái** (BR-P38): CSMS giữ 9 giá trị OCPP nguyên văn trong `connectors.status`; API trả cả `status` (OCPP) lẫn `driver_status` (5 nhóm + `unknown`). App chỉ vẽ theo `driver_status`.

**Độ tươi** (BR-P39): `status_quality = stale` khi không có bản tin quá 2 chu kỳ heartbeat (mặc định 2 × 300 s, biến `CHARGE_STATION_STALE_MS`); `driver_status = offline` khi quá `OCPP_OFFLINE_THRESHOLD_SECONDS` (900 s). App hiện "có thể đã cũ" và thời điểm `status_updated_at`.

**Súng đang lỗi bị ẩn** (WF-04, AD-7): `GET /stations` không trả súng có sự cố mở (`fault_events.status` khác `resolved`); sự cố cả trụ (`connector_id` null, vd. `Offline` sau 900 s) ẩn mọi súng của trụ. Trạm hết súng thì biến khỏi kết quả và `total`. Sự cố `resolved` → súng hiện lại, không cần app làm gì. Sự cố do tài xế báo (`driver_report`) chỉ gắn nhãn, không ẩn (BR-P41/P42). Tra mã QR (`/connectors/by-code`) chưa áp luật này; bắt đầu sạc vẫn bị chặn vì súng lỗi không `Available`.

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
| `/auth/register` | `email`, `password` (8–128), `full_name`, `phone_number?` (chuẩn hoá E.164, §6a), `consent_version`, `consent: true` | 201 + token như login | 400 `consent_required` (không ghi gì, BR-P05), `invalid_email`, `invalid_password`, `invalid_input`; 409 `email_taken`, `phone_taken` |
| `/auth/login` | `email` **hoặc** `phone_number` (đúng một), `password` | 200 `{access_token, token_type: Bearer, expires_in: 900, refresh_token, refresh_expires_in}` | 400 `invalid_input` (cả hai / không có định danh); 401 `invalid_credentials` (sai định danh = sai mật khẩu); 403 `account_locked`; 429 `too_many_attempts` |
| `/auth/refresh` | `refresh_token` | 200 `{access_token, token_type, expires_in}` | 401 `invalid_refresh_token`; 403 `account_locked` / `forbidden` |

- Access token đúng chuẩn verify ở trên (HS256, `typ: JWT`, `role: driver`, 900 s), nên dùng ngay với
  `/me`, `/stations`. Refresh token cùng khoá nhưng `typ: refresh+jwt`, `token_use: refresh`, không có
  `role`: không dùng làm access token và ngược lại. Sống `DRIVER_API_REFRESH_TTL_S` (mặc định 30 ngày,
  1 giờ–90 ngày), không xoay vòng: hết hạn thì đăng nhập lại.
- Không có bảng refresh token: không thu hồi từng token, logout = app xoá token. Khoá tài khoản
  (`account_status` ≠ `active`) có hiệu lực ngay vì refresh và mọi request đều kiểm DB.
- Tài khoản khoá: 403 `account_locked` (F-13 "tài khoản khoá không đăng nhập được"), chỉ trả khi mật
  khẩu đúng — để app hiện "tài khoản bị khoá, liên hệ hỗ trợ" mà người dò mật khẩu không biết được.
- Giới hạn thử sai: 5 lần / 60 s theo định danh đã chuẩn hoá (email lowercase, hoặc số E.164) + IP,
  20 lần / 60 s theo IP → khoá 15 phút (Retry-After). Email và số của cùng tài khoản đếm riêng (trần
  theo IP vẫn chung). Trong bộ nhớ một tiến trình: restart là mất, nhiều instance thì mỗi cái đếm riêng.
- Đăng ký tạo `users` (role driver, active, mật khẩu băm scrypt) + `drivers` (consent) trong một
  transaction; **không** tạo ví credit/loyalty (SRS không yêu cầu; `ensureAccounts` tạo khi cần).
- Chưa cấu hình JWT → 503 `auth_unavailable`. Không log mật khẩu, hash, token; response không có hash.

**Môi trường staging (BE-27).** Driver API chạy trên staging nhưng **không ra internet** (cùng
listener với console vận hành chưa xác thực; Caddy chỉ proxy `/ocpp/*` và `/health`). App dev gọi
qua SSH tunnel: `ssh -N -L 5433:127.0.0.1:5432 -L 3000:127.0.0.1:3000 devtunnel@<FQDN>`, base URL
`http://127.0.0.1:3000/api/driver/v1` (Android Emulator: `http://10.0.2.2:3000/api/driver/v1`).
JWT: issuer `powerme-staging`, audience `powerme-driver-app`, refresh 30 ngày; `X-Driver-Id` tắt.
Tài xế mẫu `app.ds01/ds02/ds03@powerme.test` (DS-01 200.000 VND, DS-02 30.000 VND, DS-03 600 điểm),
SĐT giả `+84900000101` / `+84900000102` / `+84900000103` (BE-30, đăng nhập bằng SĐT được), mật khẩu
nhận riêng. Chỉ trụ demo `PM-D1-HCM-0001` bắt đầu sạc được; trạm `HCM-APP-*` luôn
`offline`. Hướng dẫn, cảnh báo: [infra/staging/DEV-ACCESS.md](../../infra/staging/DEV-ACCESS.md);
dữ liệu mẫu: [infra/staging/README.md](../../infra/staging/README.md#dữ-liệu-mẫu-cho-app-tài-xế-be-27).

### 6a. Đăng nhập bằng số điện thoại (BE-30)

```http
POST /api/driver/v1/auth/login
Content-Type: application/json

{"phone_number": "0901234567", "password": "<mật khẩu>"}
```

- Body có **đúng một** định danh: `{email, password}` (như BE-21, app đang gọi kiểu này vẫn chạy y
  nguyên) hoặc `{phone_number, password}`. Gửi cả hai khoá (kể cả `null`) hoặc không khoá nào → 400
  `invalid_input`. Không có trường `identifier` chung: app biết người dùng gõ email hay số.
- Mọi đảm bảo của BE-21 giữ cho cả hai đường: cùng 401 `invalid_credentials` khi sai định danh hoặc
  sai mật khẩu (số không chuẩn hoá được cũng là 401, vẫn băm giả để thời gian như nhau), 403
  `account_locked` chỉ sau mật khẩu đúng, giới hạn thử sai theo định danh đã chuẩn hoá + IP (gõ
  `0901…` rồi `+84901…` vẫn là một bộ đếm).
- **Quy tắc chuẩn hoá** (`apps/csms/src/driver/phone-number.ts`; dùng cho cả register, login và dữ
  liệu cũ trong migration 0017):
  1. Bỏ khoảng trắng, `.`, `-`, `(`, `)`. Chuỗi gốc > 32 ký tự → không nhận.
  2. Còn lại: `+` tuỳ chọn ở đầu rồi toàn chữ số ASCII.
  3. Việt Nam — NSN 9–10 chữ số không bắt đầu bằng 0: `0`+NSN, `84`+NSN, `+84`+NSN, `+840`+NSN → `+84`+NSN.
     Ví dụ `0901234567`, `090.123.4567`, `84901234567`, `+84 901 234 567` → `+84901234567`.
  4. Nước khác: `+` + 7–15 chữ số, chữ số đầu khác 0 → giữ E.164 (vd `+14155550123`), không kiểm
     độ dài theo từng nước.
  5. Còn lại (vd `901234567` — thiếu 0/84 nên không biết nước nào) → register 400 `invalid_input`.
- Một số chỉ thuộc một tài khoản (UNIQUE `users_phone_number_key`, mọi role). Register với số đã có
  (bất kể định dạng) → 409 `phone_taken`; email trùng được báo trước (`email_taken`).
- **Ngoài phạm vi:** OTP/SMS (không có nhà cung cấp SMS, không xác minh số là của người đăng ký) và
  Google/Firebase — để sau Defense 1.1 (ADR-0017). Số điện thoại hiện chỉ là định danh đăng nhập
  thay email, không chứng minh sở hữu số. Chưa có route đổi số / đổi mật khẩu.

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
| 400 / 409 (xe, BE-34) | `invalid_plate_number`, `unknown_vehicle_model`; `plate_taken`, `vehicle_in_use` — §13 |
| 503 | `policy_unconfigured` |
| 409 (top-up, §14) | `idempotency_conflict`, `account_closed`, `top_up_pending` (+ `top_up_id`, `payment_url`), `pending_top_up_confirming` (+ `top_up_id`) — trường thêm đặt cùng cấp với `error`, `detail` |
| 422 (top-up, §14) | **lỗi luật nghiệp vụ**: BR-P22 `amount_out_of_range`, `balance_limit_exceeded`; BR-P35 `points_below_minimum`, `points_unavailable`, `points_exceed_cap` |
| 503 (top-up, §14) | `payment_unconfigured` (CSMS chưa có mã VNPay, không ghi dòng nào; hoặc server không kèm billing) |

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
| 4 | Login/OTP/refresh cho tài xế | BE-21 có đăng ký/đăng nhập email + mật khẩu và refresh không bảng (§6); BE-30 thêm đăng nhập số điện thoại + mật khẩu (§6a). OTP/SMS/Google/Firebase ngoài phạm vi, để sau Defense 1.1; hướng dự kiến: đổi token Firebase → JWT CSMS qua một route mới | Sơn + Trí |

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
`status = none` → tài xế chưa có ví (chưa tạo top-up nào; từ T32 Phần 5, tạo top-up là có ví dù chưa trả). `GET /credit/transactions?page=1&page_size=20`
→ sổ cái mới nhất trước; dòng `session_debit` có `session_id` để mở bảng kê.

Id của tài xế khác, key của tài xế khác và id không tồn tại đều trả 404 `not_found` như nhau.

## 13. BE-34 — quản lý xe (cho Sơn, màn hình 13 Profile & Vehicles)

Bốn route, cùng đảm bảo chung như các route khác: `Authorization: Bearer`, id là **chuỗi**, lỗi
`{error, detail}`, body `application/json` ≤ 16 KiB (415 / 413), method sai → 405 + `Allow`, query
lạ → 400 `invalid_input`. Phần tử xe trả về **cùng hình dạng** phần tử `vehicles[]` của `/me`.

| Route | Body | Thành công | Lỗi |
|---|---|---|---|
| `GET /vehicle-models` | — | 200 `{items: [{vehicle_model_id, brand, model_name, connector_type, is_vinfast, battery_capacity_kwh, rated_range_km, max_dc_kw}]}` sắp theo hãng, tên mẫu | — |
| `POST /vehicles` | `{plate_number, vehicle_model_id, is_default?}` | 201 + xe vừa thêm | 400 `invalid_input`, `invalid_plate_number`, `unknown_vehicle_model`; 409 `plate_taken` |
| `PATCH /vehicles/{id}` | đúng `{"is_default": true}` | 200 + xe | 400 `invalid_input`; 404 `not_found` |
| `DELETE /vehicles/{id}` | — | 204 (không body) | 404 `not_found`; 409 `vehicle_in_use` |

```http
POST /api/driver/v1/vehicles
Authorization: Bearer <access_token>
Content-Type: application/json

{"plate_number": "51k-901.01", "vehicle_model_id": "4", "is_default": true}
→ 201 {"vehicle_id":"6","plate_number":"51K-901.01","is_default":true,"vehicle_model_id":"4",
       "brand":"VinFast","model_name":"VF 8 Plus","connector_type":"ccs2","is_vinfast":true,
       "battery_capacity_kwh":87.7,"rated_range_km":457,"max_dc_kw":150}
```

- **Biển số.** NFKC, in hoa, bỏ mọi khoảng trắng; `-` và `.` giữ nguyên để hiển thị. Chỉ A–Z, 0–9,
  `-`/`.` nằm giữa (không đầu/cuối, không hai dấu liền nhau), dạng lưu ≤ 12 ký tự, phần chữ + số
  5–10 ký tự; sai → 400 `invalid_plate_number`. Không kiểm mẫu biển VN theo tỉnh (biển quân đội,
  ngoại giao khác mẫu). **So trùng bỏ dấu**: `51K-901.01`, `51k 901.01`, `51K90101` là một biển.
- **Biển đã có** trên một xe chưa gỡ của bất kỳ ai (kể cả chính mình) → 409 `plate_taken`, không
  nói xe của ai. App hiện "Biển số này đã được đăng ký"; nếu là người mua xe cũ thì người bán phải gỡ
  xe trước (hoặc liên hệ hỗ trợ).
- **Không có `Idempotency-Key`**: biển số là khoá tự nhiên. Mất phản hồi rồi gửi lại → 409
  `plate_taken`, không tạo xe thứ hai; app tải lại `/me` để thấy xe.
- **Xe mặc định.** Xe đầu tiên (tài xế chưa có xe mặc định) luôn thành mặc định, bất kể
  `is_default`. `is_default: true` ở POST, hoặc `PATCH {"is_default": true}`, chuyển cờ trong một
  transaction — luôn đúng một xe mặc định. Không có cách "bỏ mặc định" (PATCH `false` → 400).
- **Gỡ xe = xoá mềm** (migration 0018, `vehicles.removed_at`): lịch sử phiên và yêu cầu sạc giữ
  nguyên (BR-P17), xe biến khỏi `/me`, biển được giải phóng (đăng ký lại được). `vehicle_id` đã gỡ ở
  `/stations`, `/connectors/by-code`, `/places/*`, `/stations/{id}/route`, `PATCH`/`DELETE` → 404
  `not_found`; ở `POST /charges` → 400 `vehicle_not_owned_or_incompatible`.
- **409 `vehicle_in_use`**: xe có yêu cầu sạc chưa xong (chưa `rejected`/`settled`/`released` —
  gồm phiên đã dừng nhưng chưa quyết toán) hoặc phiên chưa kết thúc. App hiện "Xe đang sạc / đang
  quyết toán, thử lại sau".
- **Gỡ xe mặc định**: còn xe khác → xe còn lại **thêm sớm nhất** thành mặc định; gỡ xe cuối cùng →
  `vehicles[]` rỗng. App: sau 204 luôn tải lại `/me`; nếu đang dùng `vehicle_id` vừa gỡ cho tìm trạm
  thì chuyển sang xe mặc định mới, không còn xe thì đưa về màn hình thêm xe.
- Xe của tài xế khác, xe không tồn tại và xe đã gỡ đều 404 `not_found` như nhau.
- Chưa có: sửa biển / đổi mẫu xe (gỡ rồi thêm lại), khôi phục xe đã gỡ, giới hạn số xe mỗi tài xế.

## 14. Top-up (WF-02) — nạp Charging Credit qua VNPay (T32 Phần 5)

> **Chưa dùng cho app** tới khi T32 Phần 6 và Phần 8 merge. Trước Phần 6 chưa có IPN, nên tiền
> không bao giờ được cộng và trang return `/billing/vnpay/return` chưa có: thanh toán sandbox xong
> sẽ quay về 404. Trước Phần 8 không có gì chuyển top-up bỏ dở sang `expired`, nên tài xế đã tạo
> một top-up rồi bỏ sẽ bị chặn `pending_top_up_confirming` mãi.

Route ở `driver/top-ups.http.ts`, luật ở `billing/top-up.service.ts`; ánh xạ lỗi ở `topUpErrorJson`.
Luật: WF-02 decisions D2, BR-P22 theo ADR-0013, BR-P35.

1. **Báo giá (BR-P35).** `GET /billing/top-ups/quote?amount_vnd=200000` →
   `{points_available, max_points, max_discount_vnd}`. App hiện "dùng tối đa N điểm, giảm X ₫".
   Dưới 500 điểm → `max_points = 0` (không phải lỗi). Chỉ để hiển thị, không giữ chỗ.
2. **Tạo.** Mỗi lần tài xế bấm "Nạp" sinh một UUID v4 (giữ nguyên khi gửi lại sau lỗi mạng):
   ```
   POST /billing/top-ups   Idempotency-Key: <uuid>   Content-Type: application/json
   {"amount_vnd":200000,"points_to_redeem":600}
   → 201 {top_up_id, status:"pending", amount_vnd, points_redeemed, points_discount_vnd,
          amount_paid_vnd, created_at, expires_at, payment_url}
   ```
   `points_to_redeem` bỏ trống / `null` / 0 = không dùng điểm. Gửi lại cùng key cùng body → **200**
   cùng top-up; cùng key khác body → 409 `idempotency_conflict`. Mở `payment_url` (trình duyệt /
   webview); URL hết hạn lúc `expires_at` (15 phút).
3. **Đang có top-up chưa xong** — rẽ nhánh theo `error`, **không** theo việc có `payment_url`:
   - `top_up_pending` → hỏi "Bạn còn giao dịch nạp chưa thanh toán, tiếp tục?" và mở lại
     `payment_url` trong body lỗi;
   - `pending_top_up_confirming` → báo "Giao dịch trước đang được xác nhận, thử lại sau ít phút"
     (thường ~2 phút sau `expires_at`, tối đa ~1 giờ khi ngân hàng xác nhận chậm). Không có
     `payment_url`.
4. **Kết quả.** Return URL chỉ để hiển thị — **không** coi là đã nạp. Poll
   `GET /billing/top-ups/{top_up_id}` tới khi `status` rời `pending` (`credited` → đọc lại
   `GET /credit`; `failed` / `expired` → báo chưa nạp được). Tiền chỉ được cộng khi VNPay báo qua
   IPN có chữ ký hoặc querydr.
5. **422** là lỗi luật nghiệp vụ (BR-P22: 50.000–2.000.000 ₫ mỗi lần, số dư sau nạp ≤ 5.000.000 ₫
   tính đủ `amount_vnd`; BR-P35: ≥ 500 điểm, không quá điểm còn hiệu lực, không quá 50 % số tiền).
   CSMS không tự hạ số điểm: gọi lại `quote` rồi để tài xế chọn.
