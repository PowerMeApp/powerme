# Hợp đồng REST cho app tài xế (T77) — trạng thái súng, thời gian còn lại, bắt đầu / dừng / theo dõi phiên

**Ngày:** 30/10/2026
**Task:** T77 — hợp đồng REST trạng thái và ETA, chuyển từ WP4 sang WP2 ở phiếu v1.3 §3.2g; gap G1 trong Design Brief WP2
**Người chịu trách nhiệm:** Ngô Văn Minh Trí (WP2) — hợp đồng; Lý Hoàng Sơn (WP3) — route HTTP (Tuần 9) và client Dart
**File hợp đồng:** [`driver-api.openapi.yaml`](driver-api.openapi.yaml) (OpenAPI 3.1, `redocly lint` sạch lỗi 30/10)
**Trạng thái:** **chỉ hợp đồng**. Trên `main` chưa có route HTTP nào cho tài xế; tầng dịch vụ đã có từ #58 (`DriverChargingService`, `station-search.ts`).

---

## 1. Vì sao cần hợp đồng này ngay

Hội đồng Review 2 (29/10) hỏi: *"nhóm cần một simulation bắn tín hiệu OCPP để app điện thoại lấy được tín hiệu hiển thị thông tin sạc"*. Trả lời đúng là: OCPP **không** đi vào điện thoại. Trụ nói OCPP với CSMS; app lấy trạng thái từ CSMS qua REST. Simulator và CSMS đã có; mắt xích thiếu là **đường REST** này. Hợp đồng chốt trước để WP3 dựng màn hình và sinh client Dart song song với WP2 viết route.

Tình huống chuỗi phải chạy được ở Review 3: HMI trụ đổi súng A sang `Charging` → CSMS ghi StatusNotification và MeterValues → trong **5 giây** app tài xế hiện "đang sạc · 1,2 kWh · còn khoảng 18–26 phút".

## 2. Tám đường dẫn và hàm đã có

| Đường dẫn | Hàm trong `DriverChargingService` | UC / BR | Có trên `main`? |
|---|---|---|---|
| `GET /stations` | `findStations` → `searchStations` | UC-CHG-01; BR-P03, P38, P39 | hàm có, route chưa |
| `GET /connectors/by-code/{code}/{no}` | `resolveConnector` | UC-CHG-02 bước quét QR; BR-P10 | hàm có, route chưa |
| `GET /connectors/{id}/time-left` | **chưa có** | FR-03; BR-P32, P40 | Tuần 9, hình dạng chốt ở đây |
| `POST /charges` | `start` | UC-CHG-02; D4; BR-P18, P19 | hàm có, route chưa |
| `GET /charges/{key}` | `getStart` | UC-CHG-02 (mất mạng giữa chừng) | hàm có, route chưa |
| `GET /sessions/{id}/progress` | `progress` | UC-CHG-04 | hàm có, route chưa; `estimated_cost_vnd` và `time_left` Tuần 9 |
| `POST /sessions/{id}/stop` | `stop` → `commandSnapshot` | UC-CHG-03; BR-P01 | hàm có, route chưa |
| `GET /sessions/{id}/statement` | `statement` | BR-P45, P34 | hàm có, route chưa |

Route sẽ nằm **cùng tiến trình HTTP** với console `/api/admin/*` (`console.http.ts`, cổng 3000), thêm nhánh `/api/driver/v1/*` vào `console.router.ts` theo đúng kiểu thuần đang có (router không đụng DB, test được từng mã lỗi). Không mở cổng mới, không thêm Nest controller cho đến khi có RolesGuard (ADR-0011).

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

Hợp đồng chỉ yêu cầu CSMS lấy được `driver_id` từ `Authorization: Bearer <JWT>`; đăng nhập OTP và phát hành token là MB-02 của WP3. Cho demo cục bộ: header `X-Driver-Id` khi `DRIVER_API_DEV_AUTH=true`, mặc định tắt, cấm trên staging (cùng tinh thần `ALLOW_LEGACY_NO_CREDENTIAL`). Console `/api/admin` hiện cũng chưa có xác thực (ghi ở đầu `console.http.ts`); RolesGuard là việc chung sau Review 3.

## 7. Lỗi: từ `ChargingError.code` sang HTTP

| HTTP | Mã `error` |
|---|---|
| 400 | `invalid_input`, `invalid_search`, `invalid_connector_reference`, `invalid_idempotency_key`, `reserved_idempotency_key`, `unsupported_mode`, `vehicle_not_owned_or_incompatible` |
| 401 / 403 | `unauthorized`, `forbidden` |
| 404 | `not_found` (không phân biệt "không có" và "không của bạn") |
| 409 | `idempotency_conflict`, `credit_unavailable`, `connector_unavailable`, `connector_busy_or_unknown`, `tariff_unavailable`, `session_not_stoppable`, `stop_pending_or_unknown` |
| 503 | `policy_unconfigured` |

Các mã `recovery_*`, `start_not_recoverable`, `stop_attempt_not_current` thuộc đường operator (T72), không có trong API tài xế.

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

Khi route có thật (Tuần 9), CI sẽ chạy `redocly lint` và một test khớp hợp đồng với response thật (`console.http.spec.ts` đã có mẫu dựng server với backend giả).

## 11. Chưa chốt, ai chốt

| # | Câu hỏi | Đề xuất | Ai |
|---|---|---|---|
| 1 | Đường cong sạc DC theo mẫu xe lấy từ đâu cho `soc_curve` | bảng `vehicle_models` thêm 3 điểm (kW tại 20/50/80 % SoC), Admin nhập | Trí + Khang |
| 2 | `estimated_cost_vnd` khi đang sạc tính theo biểu giá lúc nào | giá của đoạn hiện tại × Wh đã sạc, ghi rõ "ước tính" (BR-P02) | Trí + Khang |
| 3 | Chế độ sạc ngoài `energy_kwh` (tiền, thời gian) | giữ ngoài hợp đồng đến khi OCPP có lệnh đặt hạn mức; app làm hạn mức mềm | Sơn |
| 4 | Token tài xế là JWT tự ký hay phiên server | JWT HS256, 24 h, refresh khi mở app | Sơn + Trí |
