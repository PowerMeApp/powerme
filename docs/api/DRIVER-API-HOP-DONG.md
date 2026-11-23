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
Charge/session/credit HTTP có từ BE-22 (dưới); time-left vẫn chỉ là hợp đồng.
**T96 (OpenAPI 0.13.0):** gợi ý dùng Vietmap khi tài xế đồng ý chia sẻ điểm đi. Bổ sung bước chỉ đường và giao thông từng đoạn. Xem §16.
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
— xem §2, §7 và §14. **Dùng được cho app từ T32 Phần 8** (14/11: IPN, trang return, quét top-up
quá hạn + querydr); chưa có e-invoice (Phần 7), chưa thử sandbox VNPay thật.

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
| `GET /billing/top-ups/quote` | `TopUpService.quote` (billing) | UC-PAY-01; BR-P35 | có (T32 Phần 5), dùng được cho app từ T32 Phần 8 (§14) |
| `POST /billing/top-ups` | `TopUpService.create` (billing) | UC-PAY-01; BR-P22, P35; WF-02 D2 | có (T32 Phần 5), dùng được cho app từ T32 Phần 8 (§14) |
| `GET /billing/top-ups/{id}` | `TopUpService.get` (billing) | UC-PAY-01 | có (T32 Phần 5), dùng được cho app từ T32 Phần 8 (§14) |
| `POST /connectors/{id}/fault-reports` | `FaultService.reportFromDriver` | UC-CHG-05; BR-P42 | có (FE-17) — xem §15 |

Route tài xế nằm **cùng tiến trình/cổng HTTP** với console `/api/admin/*` (mặc định 3000),
qua handler riêng `driver/driver.http.ts` (route sạc/credit ở `driver/charges.http.ts`, top-up ở
`driver/top-ups.http.ts`) do
`ConsoleServer` chọn trước handler admin. Không mở cổng mới hoặc Nest controller. Admin chưa có
auth nên shared listener bắt buộc loopback.

## 3. Trạng thái súng và thời gian còn lại: luật nghiệp vụ thành trường JSON

**Trạng thái** (BR-P38): CSMS giữ 9 giá trị OCPP nguyên văn trong `connectors.status`; API trả cả `status` (OCPP) lẫn `driver_status` (5 nhóm + `unknown`). App chỉ vẽ theo `driver_status`.

**Độ tươi** (BR-P39): `status_quality = stale` khi không có bản tin quá 2 chu kỳ heartbeat (mặc định 2 × 300 s, biến `CHARGE_STATION_STALE_MS`); `driver_status = offline` khi quá `OCPP_OFFLINE_THRESHOLD_SECONDS` (900 s). App hiện "có thể đã cũ" và thời điểm `status_updated_at`.

**Súng đang lỗi bị ẩn** (WF-04, AD-7): `GET /stations` không trả súng có sự cố mở (`fault_events.status` khác `resolved`); sự cố cả trụ (`connector_id` null, vd. `Offline` sau 900 s) ẩn mọi súng của trụ. Trạm hết súng thì biến khỏi kết quả và `total`. Sự cố `resolved` → súng hiện lại, không cần app làm gì. Sự cố do tài xế báo (`driver_report`, khi đủ điều kiện BR-P42) cũng ẩn súng như vậy (STM-6, AD-7); nhãn "reported issue" hiện ở tra mã QR (`reported_issue: true`, §15). Tra mã QR (`/connectors/by-code`) không ẩn súng; bắt đầu sạc vẫn bị chặn khi súng lỗi không `Available`.

**Thời gian còn lại** (BR-P32, BR-P40): luôn là **khoảng** `[min_minutes, max_minutes]` hoặc `kind = unknown`, không bao giờ là một mốc. `kind` nói ước tính dựa vào gì, theo thứ tự có dữ liệu:

| `kind` | Dữ liệu | Có trong CSMS? |
|---|---|---|
| `limit` | hạn mức gốc theo `billing_mode` (phút/Wh/VND/null), `sessions.limit_value`, và công suất hiện tại | có |
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
| 2 | `estimated_cost_vnd` khi đang sạc tính theo biểu giá lúc nào | Giá cao nhất hiện hành × Wh quan sát chính xác, ceil một lần; T134 estimate ở `metered_cost_vnd_estimate`, §17 | Trí + Khang |
| 3 | Bốn chế độ sạc | Đã có backend: CSMS gửi RemoteStopTransaction theo mode, sweep timed bền qua restart; hợp đồng §17 | Sơn |
| 4 | Login/OTP/refresh cho tài xế | BE-21 có đăng ký/đăng nhập email + mật khẩu và refresh không bảng (§6); BE-30 thêm đăng nhập số điện thoại + mật khẩu (§6a). OTP/SMS/Google/Firebase ngoài phạm vi, để sau Defense 1.1; hướng dự kiến: đổi token Firebase → JWT CSMS qua một route mới | Sơn + Trí |

## 12. BE-22 — cách app gọi route sạc và credit (cho Sơn, T96)

Mọi route cần `Authorization: Bearer <access_token>` từ `/auth/login` (§6); 401 → gọi `/auth/refresh`
rồi thử lại một lần. Id luôn là **chuỗi**; tiền (VND) và điện năng (Wh) là số nguyên.

**Bắt đầu (UC-CHG-02).** App sinh một UUID v4 cho mỗi lần tài xế bấm "Bắt đầu", lưu lại cùng màn
hình, rồi:

```
POST /charges   Idempotency-Key: <uuid>   Content-Type: application/json
{"connector_id":"12","vehicle_id":"3","mode":"energy_kwh","energy_limit_wh":20000}
→ 202 {intent_id, command_id, session_id, outcome, effect_confirmed, version, mode, max_energy_wh, max_duration_minutes, max_amount_vnd}
```

- Mất mạng / timeout: gửi lại **đúng key, đúng body** (không tạo intent thứ hai, không gửi lệnh lần
  hai) hoặc `GET /charges/<uuid>`. Đổi body với key cũ → 409 `idempotency_conflict`.
- Poll `GET /charges/<uuid>` mỗi 1–2 s cho tới khi `session_id` khác null → sang màn theo dõi.
- Dừng poll và báo lỗi theo `outcome`: `topuprequired` → "số dư dưới mức tối thiểu, nạp thêm";
  `requiresconfirmation` → hỏi theo cap của mode (`max_energy_wh`, `max_duration_minutes`,
  `max_amount_vnd`), đồng ý thì gửi **key mới**
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
| `GET /vehicle-models` | — | 200 `{items: [{vehicle_model_id, brand, model_name, connector_type, is_vinfast, battery_capacity_kwh, rated_range_km, max_dc_kw, image_url, image_credit}]}` sắp theo hãng, tên mẫu | — |
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
       "battery_capacity_kwh":87.7,"rated_range_km":457,"max_dc_kw":150,
       "image_url":"https://commons.wikimedia.org/wiki/Special:FilePath/VinFast_VF_8_DSC_8474.jpg?width=640",
       "image_credit":"Alexander Migl / Wikimedia Commons, CC BY-SA 4.0"}
```

**Ảnh mẫu xe (BE-38, OpenAPI 0.11.0).** `GET /vehicle-models`, mỗi phần tử `vehicles[]` của `GET /me` và kết quả `POST` / `PATCH /vehicles` có thêm `image_url` và `image_credit` (cả hai có thể `null`).

- `image_url` là ảnh ở máy chủ ngoài (Wikimedia Commons), **không** đi qua Driver API: app tải thẳng bằng `Image.network`, không gửi `Authorization`. URL trả 302 tới ảnh JPEG rộng khoảng 640–960 px; đổi `width=` trong URL để lấy cỡ khác.
- `null` hoặc tải lỗi (mất mạng, ảnh bị gỡ) → hiện ảnh mặc định của app, không để ô trống.
- `image_credit` khác `null` → hiện dòng này cạnh ảnh hoặc ở màn chi tiết xe. Ảnh dùng giấy phép CC BY-SA 4.0, điều kiện là ghi tên tác giả và giấy phép.
- 8 mẫu xe trong seed đều có ảnh. Mẫu xe thêm sau chưa có ảnh thì trả `null`.

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

> **Dùng được cho app từ T32 Phần 8 (14/11).** IPN `/billing/vnpay/ipn` và trang return
> `/billing/vnpay/return` có từ Phần 6 (13/11); return chỉ báo "đang xác nhận", app poll
> `GET /billing/top-ups/{id}`. Top-up `pending` quá `expires_at` được hỏi VNPay (querydr) theo lịch
> T32 Phần 8c (#194, 19/11): `expires_at` + 2 / 15 / 30 / 45 / 60 phút, thêm +75 chỉ khi lần +60
> trả RC 94; hết lịch → `expired`. Trong lúc chờ, tạo top-up mới bị chặn
> `pending_top_up_confirming`. Hoá đơn điện tử có từ Phần 7 (17/11), hiện dùng stub
> (`StubEInvoiceProvider`); chưa có route xem hoá đơn cho app. Sandbox VNPay: querydr đã thử từ máy
> dev ở Việt Nam (16/11); staging VM không gọi ra được `sandbox.vnpayment.vn` (xem
> `infra/staging/README.md`, mục VNPay sandbox).

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
     (thường ~2 phút sau `expires_at`; khi ngân hàng xác nhận chậm tối đa ~1 giờ, ~1 giờ 15 khi
     VNPay trả RC 94). Không có `payment_url`.
4. **Kết quả.** Return URL chỉ để hiển thị — **không** coi là đã nạp. Poll
   `GET /billing/top-ups/{top_up_id}` tới khi `status` rời `pending` (`credited` → đọc lại
   `GET /credit`; `failed` / `expired` → báo chưa nạp được). Tiền chỉ được cộng khi VNPay báo qua
   IPN có chữ ký hoặc querydr.
5. **422** là lỗi luật nghiệp vụ (BR-P22: 50.000–2.000.000 ₫ mỗi lần, số dư sau nạp ≤ 5.000.000 ₫
   tính đủ `amount_vnd`; BR-P35: ≥ 500 điểm, không quá điểm còn hiệu lực, không quá 50 % số tiền).
   CSMS không tự hạ số điểm: gọi lại `quote` rồi để tài xế chọn.

## 15. FE-17 — tài xế báo lỗi súng (UC-CHG-05, BR-P42)

`POST /api/driver/v1/connectors/{connector_id}/fault-reports`, body `{"description": "…"}` (chỉ mô tả, 5–500 ký tự sau khi bỏ khoảng trắng hai đầu; không có loại lỗi — khớp ERD Report 4). Không cần `Idempotency-Key`: CSMS tự từ chối báo cáo trùng.

| Trả về | Khi nào |
|---|---|
| **201** `{report_id, report_no, connector_id, reported_at, fault_event_id, reported_issue}` | Đã ghi. `fault_event_id` null = chưa đủ điều kiện, báo cáo chờ gộp (AD-7). `reported_issue: true` = súng đã mang nhãn và bị ẩn khỏi tìm kiếm. App hiện MSG11 "Thanks — the operator has been notified". |
| 400 `invalid_description` / `invalid_input` | Mô tả ngắn / dài / có ký tự điều khiển; JSON hỏng hoặc có trường lạ; id súng sai dạng |
| 401 / 403 | Như mọi route tài xế (§6) |
| 404 `not_found` | Súng không có, hoặc trụ không `in_service`, hoặc operator không `active` |
| 409 `duplicate_report` | Cùng tài xế, cùng súng trong 60 s (bấm hai lần); không ghi gì |
| 415 / 413 / 405 | Không phải `application/json`; quá 16 KiB; method khác POST |

Luật (WF-04-PLAN Q75–Q81, 11/11/2026):

- Súng (hoặc cả trụ) đang có sự cố mở → báo cáo gắn vào sự cố đó.
- **2 tài xế khác nhau trong 2 giờ**, hoặc **1 tài xế khi súng `Faulted` / `Unavailable` hoặc trụ Offline** → CSMS tạo sự cố `driver_report`, báo Operator, **ẩn súng** khỏi `/stations` (cả `sort=smart`) và gắn mọi báo cáo chờ trong 2 giờ.
- Cùng một tài xế báo nhiều lần chỉ tính một. Ở đường một tài xế, trong 2 giờ một tài xế chỉ tự mở được **một** sự cố trên một trụ; báo cáo ở súng khác vẫn `201`, `reported_issue: false`, chờ tài xế thứ hai (T131).
- Nhãn hiện ở `GET /connectors/by-code/{code}/{no}` (`reported_issue`). Nhãn xoá khi Operator đóng sự cố, hoặc **một phiên trên súng hoàn tất bình thường** (bắt đầu sau khi có sự cố theo giờ trụ đã đối soát, > 0 Wh, không dừng vì EmergencyStop / PowerLoss / Other). Súng đổi trạng thái (kể cả `Available`) **không** xoá nhãn (BR-P42, D-G 14/11); báo cáo gắn vào một sự cố của trụ (Faulted / Offline) cũng giữ nhãn khi sự cố đó tự đóng — chuyển sang một sự cố `driver_report` (T141, D-X 17/11) — ADR-0019.

## 16. T96 — xếp hạng gợi ý theo đường bộ Vietmap

Xếp hạng tự động ngừng gọi mới khi tổng lượt gọi trong cửa sổ một phút đạt 24/30 theo tài xế, 108/120 toàn hệ thống hoặc đã có 3/4 yêu cầu đang chạy. Khi chạm ngưỡng, gợi ý về `ranking_source=brief`. Tra địa chỉ, lấy tọa độ địa chỉ và xem tuyến do tài xế yêu cầu vẫn dùng phần hạn mức còn lại. Cache hit, yêu cầu gộp và yêu cầu bị từ chối trước khi gọi Vietmap không trừ lượt. Giới hạn trong CSMS không thay quota của Vietmap.


`GET /api/driver/v1/stations?vehicle_id=…&sort=smart&latitude=…&longitude=…&soc_percent=…&location_consent=true&page_size=3`.
Chỉ chuyển tọa độ khi tài xế gửi `sort=smart` và `location_consent=true` rõ ràng, có điểm đi và
pin hợp lệ, dùng xe sở hữu đủ thông số. Thiếu hoặc gửi `false` dùng brief, kể cả client cũ.
`sort=name`, `sort=distance` và chế độ tự chọn smart vẫn giữ hành vi tìm kiếm trước đó.

1. CSMS kiểm tra chủ xe, chuẩn cổng, trạng thái và bộ lọc. Haversine xác định bán kính và nhóm
   gần nhất dự phòng khi bán kính mặc định rỗng. Giữ nguyên bán kính nhập tay.
2. Sau khi trả kết nối DB, chọn tối đa 6 trạm có thể tính tổng và súng tốt nhất có trạng thái fresh,
   theo chờ + sạc, rồi `site_id`. Danh sách ứng viên không phụ thuộc số trang.
3. CSMS gọi Route v4 tối đa 2 lượt đồng thời, ngân sách chờ của cả lượt 4 giây, cache 2 phút theo
   tài xế. Có đủ tuyến thì xếp nhóm theo reach dựa trên mét đường bộ, tổng phút di chuyển + chờ +
   sạc, mét ùn tắc tăng dần nếu cả nhóm có dữ liệu đầy đủ, mét đường bộ, cuối cùng `site_id`.
   Phút di chuyển là `duration_s / 60` từ Vietmap và chỉ cộng một lần vào tổng. Phần ngoài nhóm nối
   phía sau theo thứ tự brief, rồi mới cắt trang. API trả `ranking_source: vietmap_route`.
4. Thiếu consent/điều kiện/ứng viên hợp lệ, thiếu tuyến, lỗi hoặc hết quota/thời gian → toàn bộ
   lượt dùng thứ tự brief và trả `ranking_source: brief`. Không trả `road_estimate` khi fallback.

Mỗi mục có tuyến thật trả `road_estimate: { distance_m, duration_s, computed_at }` với mét,
giây nguyên và mốc ISO 8601. Giữ `distance_m` cấp trạm cho client cũ và lọc bán kính. Khi thiếu
`road_estimate`, app bỏ số km và thời gian di chuyển theo đường bộ. `est_drive_min`/reach trong
brief là giả định xếp hạng. Tải hình học từ `GET /stations/{site_id}/route` khi tài xế chọn xem
đường. CSMS không dùng Matrix.

### Chỉ đường và giao thông theo đoạn

- `GET /stations/{site_id}/route` có thể trả thêm `instructions`, `traffic_segments` và
  `congested_distance_m`. Hai mốc `start_index/end_index` tính từ 0, gồm cả hai đầu theo
  `geometry.coordinates`. Bước rẽ có thể nằm tại một điểm. `sign` giữ dấu gốc, `duration_s`
  làm tròn lên từ mili giây. `text` dùng tên đường khi thiếu nội dung và có thể rỗng.
- Đoạn giao thông có ít nhất một cạnh, được sắp theo tuyến và có thể chung điểm đầu/cuối.
  Mức là `low`, `moderate`, `heavy`, `severe` hoặc `unknown`. Khoảng trống hoặc
  `unknown` nghĩa là chưa có thông tin. Geometry, khoảng cách và ETA vẫn trả khi thiếu các trường
  bổ sung. `traffic_quality: unknown` là giá trị tương thích client cũ.
- Cả truy vấn chi tiết và truy vấn gợi ý xin `annotations=congestion,congestion_distance`.
  Route và `road_estimate` chỉ trả `congested_distance_m` khi các đoạn có mức đã biết phủ toàn bộ
  geometry và từng đoạn `heavy/severe` có số mét với cặp chỉ số trùng khớp. Giá trị 0 xác nhận
  không có mét ùn tắc nặng trong dữ liệu đầy đủ. Dữ liệu khuyết không dùng để phân hạng. Số mét
  chỉ phá hòa khi cùng reach và cùng tổng phút, không thêm thời gian phạt.

Đối chiếu [Route v4](https://maps.vietmap.vn/docs/vi/map-api/route-version/route-v4/),
[Routing Agent Doc](https://maps.vietmap.vn/docs/assets/agents/routing.txt) và
[bản Playground công khai](https://tools.vietmap.vn/playground/assets/index-DQkfeQKM.js).
Playground dùng `paths[0].annotations` và các hàng `{ first, last, value }`. Mẫu công khai ghi
nhận mảng số mét có cả mức nhẹ. CSMS ghép theo cặp chỉ số và chỉ cộng heavy/severe.

## 17. Bốn chế độ sạc — hợp đồng backend WP3

`POST /charges` nhận đúng một shape dưới đây cùng `connector_id`, `vehicle_id` là chuỗi ID thật.
Không nhận trường hạn mức của mode khác, trường lạ, số lẻ, chuỗi số, zero hoặc giá trị vượt
9.007.199.254.740.991; thiếu mode là `invalid_input`, mode lạ là `unsupported_mode` (400).

| mode | Trường riêng | Điều kiện dừng tự động |
|---|---|---|
| `full` | không có | BMS/trụ gửi StopTransaction; vẫn cho manual stop và cutoff credit chung. SoC 100% từ app/telemetry không tự dừng |
| `timed` | `duration_minutes`: phút nguyên dương | Thời gian CSMS từ `received_started_at` đạt số phút, gồm pause; recovery sweep mỗi 10 giây, sống qua restart, không cần MeterValues hay điện thoại mở |
| `energy_kwh` | `energy_limit_wh`: Wh nguyên dương | Wh quan sát hợp lệ đạt hạn mức; giữ chính xác phần Wh lẻ khi so sánh |
| `amount_vnd` | `amount_limit_vnd`: VND nguyên dương | Ước tính tích lũy theo chính sách T134 đạt mục tiêu: nội suy mẫu ở biên tariff; fallback toàn phiên dùng tariff lúc CSMS nhận start |

Energy/money chỉ gửi lệnh dừng sau khi mẫu hợp lệ quan sát được đạt ngưỡng; điện năng và tiền
thực tế có thể vượt mục tiêu trong khoảng lấy mẫu, truyền lệnh và trụ thực sự dừng. Đây không
phải hard cap hoặc predictive stop. Timed có độ trễ sweep danh nghĩa tới 10 giây, cộng thời gian
xử lý/lệnh; lúc offline hoặc quá tải có thể lâu hơn. Chỉ StopTransaction thật chứng minh đã dừng.

```json
{"connector_id":"12","vehicle_id":"3","mode":"full"}
{"connector_id":"12","vehicle_id":"3","mode":"timed","duration_minutes":30}
{"connector_id":"12","vehicle_id":"3","mode":"energy_kwh","energy_limit_wh":20000}
{"connector_id":"12","vehicle_id":"3","mode":"amount_vnd","amount_limit_vnd":100000}
```

Snapshot thêm `mode`, `max_duration_minutes`, `max_amount_vnd`; vẫn giữ `max_energy_wh` và mọi
trường cũ. Cap không áp dụng tự động: trả 202 `requiresconfirmation`, command/session null,
chỉ cap đúng mode có giá trị; tài xế đồng ý rồi gửi key mới. Full giữ toàn bộ credit khả dụng;
timed giữ `ceil(min(kW connector, kW xe) × phút × giá cao nhất / 60)` VND, yêu cầu công suất
connector có giá trị (xe chưa có max thì connector vẫn là cận vật lý an toàn). Energy giữ
ceil(Wh × giá cao nhất / 1000), amount giữ số VND chọn. Mọi mode phải đạt minimum credit,
không gửi lệnh nếu không đạt. Cùng key/body không tạo phiên/lệnh nữa; đổi mode hay hạn mức với
key cũ là 409. Hash energy cũ giữ nguyên.

Progress thêm `billing_mode`, `limit_value` gốc (null/phút/Wh/VND theo mode), `elapsed_seconds`
(giây nguyên, dừng tại CSMS receipt của StopTransaction). `consumed_wh` vẫn Wh nguyên, làm tròn
xuống chỉ để hiển thị. Thiếu/xung đột/stale/replayed telemetry trả null/unknown, không coi là zero.
`metered_cost_vnd_estimate` là ước tính được dùng cho money cutoff. `metered_cost_quality` là
`exact` (đủ mẫu hoặc giá áp dụng là một tariff), `interpolated` (nội suy tại biên giá), hoặc
`unknown` (estimate null). `metered_cost_clock` là `cp`, `cp_offset`, `csms` hoặc null. Đồng hồ và
mẫu đo được đọc từ StartTransaction/MeterValues thật; không tạo StopTransaction giả để tính tiền.
Theo T134, mẫu thưa qua ranh giới được nội suy bằng cùng `meterAt` và làm tròn Wh tại biên như
quyết toán; clock offset đo được từ các cụm live được cộng vào trục giờ. Khi resolver không tin
đồng hồ, **toàn phiên dùng đúng tariff lúc CSMS nhận start**, không chia theo từng giờ nhận mẫu.
`metered_cost_vnd_min` / `max` vẫn cho biết cận từ số đo; ví dụ 2 kWh qua hai tariff 1.000/5.000
với thời gian bằng nhau: min=2.000, max=10.000, estimate=6.000, quality=`interpolated`. Money limit
6.000 dừng theo estimate đã duyệt, không đợi cận min đạt 6.000. Những trường này không ghi ledger.
Mất socket trong offline grace giữ `consumed_wh` quan sát cuối và quality `observed`; `is_online`
cảnh báo mất liên lạc. Số cũ này không được dùng để tự cắt: cutoff luôn kiểm fresh/current epoch.
Raw replay flag không đủ để loại một cụm live có clock offset được T134 xác minh; replay thật,
epoch lạ, sample xung đột hoặc thiếu bằng chứng vẫn không cho phép tự cắt theo meter.

`estimated_cost_vnd` cũ vẫn là **ước tính tối đa theo giá cao nhất**, không phải actual cost.
Tính từ milliWh chính xác rồi ceil một lần ra VND, trước khi floor Wh cho hiển thị:
99.999 Wh ở 5.000 VND/kWh trả maximum 500 VND, dù `consumed_wh` hiển thị 99.
Cutoff credit chung dùng số đo chính xác × giá cao nhất (BR-P19); nếu credit khả dụng đã bằng
hoặc dưới reserve, số dư tự nó đủ chứng minh cần dừng dù chỉ có SoC/chưa có mẫu energy. Không
bịa số Wh. Chỉ gửi lệnh tới trụ online, fresh, đúng registry epoch. Khi trụ offline/stale,
chỉ phiên `timed` đã đến hạn được thử lại qua DB sweep khi kết nối hợp lệ trở lại. Các mode
còn lại đánh giá lại cutoff khi nhận MeterValues mới hợp lệ; bằng chứng từ số dư không phụ
thuộc mẫu energy. RemoteStop Accepted chỉ là ACK, không đánh dấu đã dừng và không quyết toán.
StopTransaction thật quyết toán một lần theo BR-P20/45; giữ nguyên chính sách T134 đã merge,
shortfall và billing review.

Migration `0026_driver_charge_modes.sql` áp sau `0025_e-invoice-vat-rate.sql`; không sửa 0025.
Trong `driver_charge_intents`, `mode` dùng enum `billing_mode` có sẵn, NOT NULL DEFAULT
`energy_kwh`; thêm bốn bigint nullable `duration_minutes`, `amount_limit_vnd`,
`max_duration_minutes`, `max_amount_vnd`; `energy_limit_wh` thành nullable. CHECK buộc đúng
một hạn mức nguyên dương theo mode (full không có) và cap không âm chỉ ở mode tương ứng.
Hàng energy cũ giữ nguyên Wh, request hash và idempotency key; `sessions.billing_mode` và
`sessions.limit_value` dùng cột có sẵn, không thêm schema phiên hoặc đổi đơn vị dữ liệu cũ.

### Nghiên cứu nguồn và lựa chọn

Các nguồn chính thức và commit đã khảo sát được ghim dưới đây. Áp dụng khái niệm vào mã riêng,
không sao chép source hoặc thêm dependency. Ma trận edge case và kết quả kiểm chứng:
[docs/testing/T96-FOUR-CHARGE-MODES.md](../testing/T96-FOUR-CHARGE-MODES.md).

| Nguồn, giấy phép | Fit/kiến trúc | Điều áp dụng, tradeoff |
|---|---|---|
| [evcc core/loadpoint.go](https://github.com/evcc-io/evcc/blob/1d62b732f81caa53ae827b38bed0e5380776a1a7/core/loadpoint.go), [session tests](https://github.com/evcc-io/evcc/blob/1d62b732f81caa53ae827b38bed0e5380776a1a7/core/loadpoint_session_test.go), MIT | Energy limit trong control loop và metric reset theo phiên; vòng đời phiên phù hợp hơn phụ thuộc UI | Sweep CSMS + baseline theo transaction; thêm durability Postgres và locking vì nhiều CSMS worker. Không kéo Go runtime/dependency vào NestJS |
| [SAP OCPP16IncomingRequestService.ts](https://github.com/SAP/e-mobility-charging-stations-simulator/blob/1d0f190e4ea659a68efb83c86ecbdf12b25cda4b/src/charging-station/ocpp/1.6/OCPP16IncomingRequestService.ts), [RemoteStopUnlock tests](https://github.com/SAP/e-mobility-charging-stations-simulator/blob/1d0f190e4ea659a68efb83c86ecbdf12b25cda4b/tests/charging-station/ocpp/1.6/OCPP16IncomingRequestService-RemoteStopUnlock.test.ts), Apache-2.0 | Simulator xử lý RemoteStop; phân biệt ACK với StopTransaction là điều kiện cần cho billing | Giữ stop intent/attempt và chờ effect thật, test qua ocpp-rpc. Không nhận ACK làm bằng chứng debit; không kéo simulator/dependency mới |

Security giữ owner/vehicle/connector validation, khóa phiên, epoch fencing, reserved auto-key và
idempotency hiện có. Dữ liệu meter/clock không chắc chắn không được coi là tiền đã trả; cận trên
chỉ bảo vệ credit. Hai dự án có scope/stack khác nên implementation giữ kiến trúc hiện tại,
không port source; attribution bằng URL/commit/license trên, không phát sinh mã sao chép cần header.
