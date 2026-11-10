# Hợp đồng REST cho Operator Dashboard và Admin Console (T98) — onboarding, sự cố, doanh thu

**Ngày:** 10/11/2026
**Task:** T98 — hợp đồng API Operator/Admin, cần có trước T97 (Nghĩa nối dashboard) và T108 (màn hình doanh thu)
**Người chịu trách nhiệm:** Ngô Văn Minh Trí (WP2) — hợp đồng; route theo cột "Người làm" ở §3
**File hợp đồng:** [`operator-admin-api.openapi.yaml`](operator-admin-api.openapi.yaml) (OpenAPI 3.1, v0.1.0)
**Mẫu theo:** [`DRIVER-API-HOP-DONG.md`](DRIVER-API-HOP-DONG.md) và [`driver-api.openapi.yaml`](driver-api.openapi.yaml)
— cùng quy ước JSON, lỗi, id chuỗi, phân trang, JWT.
**Trạng thái trên `main` 59eb4ba:** chưa có route nào trong hợp đồng này có xác thực. Phần đã chạy
nằm ở console `/api/admin/*` **không xác thực, chỉ loopback** (ADR-0011, ADR-0017); phần còn lại là
service chưa có route hoặc chưa có code. Tài liệu này không viết code endpoint.

---

## 1. Vì sao cần hợp đồng này ngay

Hai việc đang chờ: Nghĩa nối dashboard thật (T97) và Khang/Nghĩa làm màn hình doanh thu (T108).
Dashboard trên nhánh `wp4/fe-01-dashboard-shell` (20c8a6b, chưa merge) đang gọi mock với đường dẫn
tự đặt (`/api/v1/operator/pillars`, `/api/admin/devices`…, camelCase, id số). Console thật lại ở
`/api/admin/*`, snake_case, không xác thực, không lọc operator. Không chốt một hợp đồng thì mỗi bên
nối theo một kiểu và phải sửa lại.

Tình huống chuỗi phải chạy ở Review 3: nhân viên của operator A đăng nhập → thấy 3 trụ của A, không
thấy trụ của operator B → súng 2 của `PM-D1-HCM-0001` báo `Faulted` → acknowledge → Reset bị chặn vì
súng 1 đang sạc (409 `sessions_active`) → xác nhận lần hai → Reset Accepted → cuối tháng xuất CSV
doanh thu, tổng CSV bằng đúng số trên màn hình. Cùng lúc token của tài xế gọi `/api/operator/v1/faults`
nhận 403 (F-13).

## 2. Nguyên tắc

### 2.1 Hai bề mặt, một tiến trình

| Bề mặt | Base path | Role JWT | Ai dùng | Màn hình SRS |
|---|---|---|---|---|
| Operator | `/api/operator/v1` | `operator_staff` | nhân viên một operator đối tác | Table 5 #16–#25 |
| Admin | `/api/admin/v1` | `admin` | quản trị PowerMe | Table 5 #26–#33 |

Cùng cổng 3000 và cùng listener với console và Driver API (ADR-0017: một handler raw HTTP chọn theo
tiền tố, không Nest controller, không cổng mới). Console `/api/admin/*` (không `v1`) giữ cho demo đến
khi các route ở đây chạy, rồi bỏ — xem §5. `/api/admin/v1` khác `/api/admin` ở chỗ có `v1` **và** có
JWT; listener phải so khớp `/api/admin/v1/` trước `/api/admin/`.

Bảng ủy quyền màn hình (Table 6) tách hẳn hai role: Operator không mở màn hình Admin và ngược lại.
Hợp đồng giữ đúng như vậy — **không endpoint nào cho cả hai role**. Admin xem dữ liệu vận hành qua
các route chỉ đọc của chính mình (`/admin/v1/sessions`, `/reconciliation-records`, `/ocpp-messages`).

### 2.2 Xác thực (đề xuất, theo ADR-0017)

- `POST /{surface}/v1/auth/login` và `/auth/refresh` như BE-21 của tài xế: email + mật khẩu, scrypt,
  access token HS256 900 s, refresh token `typ: refresh+jwt` không có `role`, giới hạn thử sai 5 lần /
  60 s theo email + IP.
- Cùng khoá, issuer và audience với Driver API; claim `role` mang **giá trị enum DB**
  (`user_role`: `operator_staff`, `admin`). Dashboard hiển thị "Operator" là nhãn UI, không phải claim.
- **Mỗi request kiểm DB**: role khớp, `account_status = active`, có dòng `operator_staff` (operator
  `active`) hoặc `admins`. Phạm vi operator lấy từ `operator_staff.operator_id`, **không bao giờ từ
  token, query hay body** — đúng cách `ChargePointOnboardingService` và `SessionReviewService` đang làm.
- F-13 thành luật kiểm được: token hợp lệ nhưng role không có trong `x-roles` → **403 `forbidden`**
  (kể cả token tài xế); thiếu/sai/hết hạn → 401; tài khoản khoá → login 403 `account_locked`, và token
  còn hạn cũng bị 403 ở request kế tiếp vì DB được kiểm lại.
- Không có header dev kiểu `X-Driver-Id` cho hai bề mặt này. Cho tới khi JWT nhân viên chạy, dashboard
  dev dùng console loopback như hiện nay.

### 2.3 Phạm vi dữ liệu theo operator

Mọi route `/operator/v1` chỉ trả và chỉ cho tác động lên trụ thuộc site của operator người gọi
(BR-P11, BR-P16). Tài nguyên của operator khác trả **404 `not_found`** như không tồn tại
(cách của `SessionReviewService`: không lộ dữ liệu liên-operator). Ngoại lệ có sẵn trong code:
onboarding vào site của operator khác trả 403 `site_of_other_operator` (SD-5a) vì site là thứ người
dùng chọn từ danh sách của mình, nhận 403 nghĩa là dashboard có lỗi.

### 2.4 JSON, lỗi, phân trang

- snake_case, id bigint dạng chuỗi, tiền VND nguyên, điện năng Wh nguyên, thời điểm ISO 8601 UTC,
  ngày (`date`) theo lịch Asia/Ho_Chi_Minh — như Driver API §8.
- Lỗi luôn `{error, detail}`. Mã đã có trong code giữ nguyên văn: `ConsoleError` (`station_offline`,
  `sessions_active`, `fault_not_acknowledged`, `reset_in_progress`, `station_error`…),
  `OnboardingError`, `SessionReviewError`, `ChargingError` (`recovery_*`).
- Danh sách: `page` (từ 1) + `page_size` (1–100, mặc định 50) → `{items, total, page, page_size}`,
  giống `/stations` của tài xế. Riêng nhật ký OCPP giữ con trỏ `after` + `limit` (≤ 500) của console vì
  màn hình poll đuôi log.
- Phiên chỉ có `payment_mode` ∈ {`csms_billed`, `unattributed`}; thẻ RFID chỉ có
  `card_kind` ∈ {`online`, `free_vend`} — theo T110 (đang làm song song). Charging Credit giữ đúng
  tên Charging Credit (khoản trả trước, ADR-0013).

### 2.5 Lệnh và idempotency

- Lệnh xuống trụ qua `POST /operator/v1/charge-points/{id}/commands` trả **202** + `RemoteCommand`
  (bảng `remote_commands` đã có, migration 0001), kết quả đọc ở `GET /commands/{id}` — đúng WP2 §4.2
  "lệnh điều khiển là bất đồng bộ". Console hiện chờ đồng bộ tối đa 15 s rồi trả 200; route mới không
  chờ.
- Ngoại lệ có chủ đích: `POST /faults/{id}/reset` **giữ đồng bộ** như console (WF-04) vì kết quả
  Accepted/Rejected quyết định trạng thái sự cố (STM-6 t4/t6) ngay trong response.
- Header `Idempotency-Key` (8–64 ký tự; 64 vì cột `remote_commands.idempotency_key` là varchar(64))
  bắt buộc ở: gửi lệnh, Reset sự cố, đặt biểu giá, các lệnh hoàn tiền / thử lại hoá đơn. Cùng key +
  cùng body trong 24 giờ → trả lại response cũ, không gửi lệnh lần hai; cùng key khác body → 409
  `idempotency_conflict`. Tình huống: nhân viên bấm "Dừng sạc", Wi-Fi rớt, dashboard gửi lại cùng key →
  CSMS không gửi RemoteStop thứ hai.
- Các hành động đi theo state machine (acknowledge, close, resolve, lock…) không cần key: gọi lại lần
  hai trả 409 `invalid_transition` / `not_in_review`, không ghi gì.

### 2.6 Realtime

Không có trong v0.1. Dashboard poll REST (danh sách trụ 5 s, sự cố 5 s, lệnh đang chờ 2 s). Khi có
SSE/Socket.IO (`alert.raised`, `alert.updated`, `alert.resolved`, `command.result` — WP2 §4.3, WF-04 #8)
thì sự kiện chỉ là gợi ý, REST vẫn là sự thật (ADR-0006).

## 3. Bảng endpoint theo nhóm

Trạng thái: **console** = logic đã chạy ở console `/api/admin/*` (chưa xác thực, chưa lọc operator),
phải chuyển sang đây · **service** = hàm service có trong code, chưa có route · **in progress** = đang
làm ở nhánh khác · **planned** = chưa có code. Cột "Người làm" theo WP vì BM04 (nộp 09/11) không có
trong repo — Trí sửa nếu lệch phân công. Đường dẫn bỏ tiền tố `/api`.

### 3.1 Đăng nhập (6)

| Endpoint | Role | UC / FR / BR | Trạng thái · người làm | Ghi chú |
|---|---|---|---|---|
| `POST /operator/v1/auth/login` | công khai | F-13, BR-P16 | planned · Trí | dùng lại code BE-21; user khác role → 401 `invalid_credentials`; operator đình chỉ → 403 `operator_inactive` |
| `POST /operator/v1/auth/refresh` | công khai | F-13 | planned · Trí | |
| `GET /operator/v1/me` | operator_staff | BR-P16, Table 5 #17 | planned · Trí | user, operator, `staff_role` |
| `POST /admin/v1/auth/login` | công khai | F-13, BR-P16 | planned · Trí | cần dòng `admins` |
| `POST /admin/v1/auth/refresh` | công khai | F-13 | planned · Trí | |
| `GET /admin/v1/me` | admin | Table 5 #27 | planned · Trí | |

### 3.2 Onboarding và sổ đăng ký trụ (10)

| Endpoint | Role | UC / FR / BR | Trạng thái · người làm | Ghi chú |
|---|---|---|---|---|
| `GET /operator/v1/sites` | operator_staff | UC-OPS-01, BR-P11 | planned · Ân | ô chọn site trong sheet onboarding |
| `POST /operator/v1/charge-points` | operator_staff | UC-OPS-01, FR-09, STM-3 #2, SD-5a | **service** `ChargePointOnboardingService.onboard` · Ân (T119) | 201, mật khẩu hiện **một lần**, `no-store`; gọi lại → 409 `already_onboarded` |
| `POST /operator/v1/charge-points/{id}/disable` | operator_staff | STM-3 #4, ADR-0016 | planned · Ân | chỉ có `ChargePointLifecyclePolicy`, chưa có service ghi DB |
| `POST /operator/v1/charge-points/{id}/enable` | operator_staff | STM-3 #5 | planned · Ân | |
| `GET /admin/v1/charge-points` | admin | UC-ADM-03, UC-ADM-07, FR-15 | **console** (một phần) · Ân | console thiếu model, firmware, bảo hành, operator |
| `POST /admin/v1/charge-points` | admin | UC-ADM-03, FR-15, STM-3 #1 | **service** `registerDevice` · Ân (T119) | 409 `serial_already_registered` |
| `GET /admin/v1/charge-points/{id}` | admin | UC-ADM-03 | planned · Ân | |
| `PATCH /admin/v1/charge-points/{id}` | admin | UC-ADM-03 | planned · Ân | model, firmware, kW, bảo hành; không đổi serial |
| `PUT /admin/v1/charge-points/{id}/free-vend-tag` | admin | UC-ADM-05, BR-P09, ADR-0012 | planned · Ân | null = tắt; chỉ áp cho phiên bắt đầu sau đó (BR-P08) |
| `POST /admin/v1/charge-points/{id}/decommission` | admin | STM-3 #6 | planned · Ân | |

### 3.3 Giám sát trụ và lệnh từ xa (7)

| Endpoint | Role | UC / FR / BR | Trạng thái · người làm | Ghi chú |
|---|---|---|---|---|
| `GET /operator/v1/summary` | operator_staff | UC-OPS-02/03, Table 5 #17 | planned · Nghĩa (T97) | số trụ theo trạng thái, súng theo nhóm BR-P38, sự cố mở theo mức, hàng việc review/unattributed/T72 |
| `GET /operator/v1/charge-points` | operator_staff | UC-OPS-02, FR-10, BR-P10, BR-P38/39 | **console** `ConsoleQueries.stations` · Nghĩa | thêm lọc operator, site, phân trang; mỗi súng một trạng thái, không gộp |
| `GET /operator/v1/charge-points/{id}` | operator_staff | UC-OPS-02/04, Table 5 #20 | planned · Nghĩa | súng, sự cố mở, 20 lệnh gần nhất |
| `GET /operator/v1/charge-points/{id}/metrics` | operator_staff | UC-OPS-02, FR-10, BR-P43 | planned · Trí | `window=7d\|30d`; từ `connector_status_events` |
| `POST /operator/v1/charge-points/{id}/commands` | operator_staff | UC-OPS-04, FR-11, BR-P01/P06/P07 | **console** (chỉ remote_stop) · Trí | `action` ∈ `remote_start`, `remote_stop`, `reset`; 202; Idempotency-Key |
| `GET /operator/v1/commands/{id}` | operator_staff | UC-OPS-04 | planned · Trí | đọc `remote_commands` |
| `GET /operator/v1/ocpp-messages` | operator_staff | FE-08, PKG-2 | **console** `messages` · Nghĩa | chỉ trụ của operator; Table 6 chưa có màn hình này (câu hỏi N3) |

### 3.4 Sự cố (4)

| Endpoint | Role | UC / FR / BR | Trạng thái · người làm | Ghi chú |
|---|---|---|---|---|
| `GET /operator/v1/faults` | operator_staff | UC-OPS-03, FR-10, STM-6 | **console** `FaultService.list` · Nghĩa | `status=open\|all`, thêm `charge_point_id`, chuyển sang page/page_size |
| `POST /operator/v1/faults/{id}/acknowledge` | operator_staff | STM-6 t2 | **console** · Nghĩa | console ghi `acknowledged_by = null`; route mới ghi người gọi |
| `POST /operator/v1/faults/{id}/reset` | operator_staff | STM-6 t4, BR-P07, WF-04 #12 | **console** `resetFault` · Nghĩa | đồng bộ; `type`/`force` chuyển từ query vào body; Idempotency-Key |
| `POST /operator/v1/faults/{id}/close` | operator_staff | STM-6 t7, BR-P42 | **console** · Nghĩa | |

### 3.5 Phiên, đối soát, phiên review / unattributed, khôi phục T72 (15)

| Endpoint | Role | UC / FR / BR | Trạng thái · người làm | Ghi chú |
|---|---|---|---|---|
| `GET /operator/v1/sessions` | operator_staff | UC-OPS-05, FR-13, BR-P08 | **console** `sessions` · Trí | `queue=review\|unattributed` (giữ tên tham số của mock dashboard), lọc status/payment_mode/trụ/thời gian |
| `GET /operator/v1/sessions/{id}` | operator_staff | UC-OPS-05, FR-16 | **console** `session` · Trí | meter, tạm dừng, bản ghi đối soát |
| `POST /operator/v1/sessions/{id}/resolve` | operator_staff | UC-OPS-05, STM-1 #17 | **service** `SessionReviewService.resolveReview` · Trí | body `{resolution, note}`; mock dashboard chỉ gửi `note` |
| `POST /operator/v1/sessions/{id}/assign` | operator_staff | UC-OPS-05, BR-P06/P08 | **in progress** · Trí (T102) | giữ chỗ; body chốt ở T102 |
| `POST /operator/v1/sessions/{id}/close` | operator_staff | UC-OPS-05 | **in progress** · Trí (T102) | |
| `GET /operator/v1/reconciliation-records` | operator_staff | UC-OPS-05, FR-16, Table 7 #6–7 | **console** `reconciliation` · Trí | |
| `GET /operator/v1/charge-intents` | operator_staff | UC-OPS-04, T72 | planned · Trí | hàng việc start không rõ; chưa có hàm liệt kê |
| `GET /operator/v1/charge-intents/{id}/recovery` | operator_staff | T72 | **service** `startRecovery` · Trí | |
| `POST …/charge-intents/{id}/begin-recovery` | operator_staff | T72 | **service** `beginStartRecovery` · Trí | `{note}` bằng chứng bắt buộc |
| `POST …/charge-intents/{id}/complete-recovery` | operator_staff | T72 | **service** `completeStartRecovery` · Trí | |
| `POST …/charge-intents/{id}/restore-connector` | operator_staff | T72 | **service** `restoreRecoveredConnector` · Trí | |
| `POST …/charge-intents/{id}/retry-recovery` | operator_staff | T72 | **service** `retryStartRecovery` · Trí | `{kind: fence\|restore, note}`; RemoteStart không bao giờ gửi lại |
| `POST …/charge-intents/{id}/approve-late-start` | operator_staff | T72, UC-OPS-05 | **service** `approveLateStart` · Trí | |
| `POST /operator/v1/sessions/{id}/recover-stop` | operator_staff | BR-P01, T72, BE-17 | **service** `recoverStop` · Trí | 202 |
| `POST /operator/v1/sessions/{id}/tariff-boundary` | operator_staff | BR-P02, BR-P45, T72 | **service** `recordTariffBoundary` · Trí | 204 |

### 3.6 Biểu giá và khuyến mãi (6)

| Endpoint | Role | UC / FR / BR | Trạng thái · người làm | Ghi chú |
|---|---|---|---|---|
| `GET /operator/v1/tariffs` | operator_staff | UC-OPS-06, FR-12, BR-P02 | planned · Nghĩa (+ Khang) | bản đang hiệu lực + bản sắp hiệu lực |
| `PUT /operator/v1/tariffs` | operator_staff | UC-OPS-06, BR-P02, BR-P45 | planned · Nghĩa (+ Khang) | phủ kín 24 h, không chồng; `effective_from` ≥ hôm nay; không sửa bản cũ |
| `GET /operator/v1/promotions` | operator_staff | UC-OPS-07, FR-12 | planned · Nghĩa (+ Khang) | |
| `POST /operator/v1/promotions` | operator_staff | UC-OPS-07 | planned · Nghĩa (+ Khang) | mã duy nhất toàn nền tảng (`promotions_promotion_code_key`) |
| `PATCH /operator/v1/promotions/{id}` | operator_staff | UC-OPS-07 | planned · Nghĩa (+ Khang) | |
| `POST /operator/v1/promotions/{id}/deactivate` | operator_staff | UC-OPS-07 | planned · Nghĩa (+ Khang) | `valid_to = now()` (bảng không có cột active) |

### 3.7 Doanh thu và CSV (4)

| Endpoint | Role | UC / FR / BR | Trạng thái · người làm | Ghi chú |
|---|---|---|---|---|
| `GET /operator/v1/revenue` | operator_staff | UC-OPS-09, FR-18, BR-P46 | planned · Khang (T108) | `from`, `to` (ngày), `group_by=charge_point\|site\|day`, `site_id` |
| `GET /operator/v1/revenue.csv` | operator_staff | UC-OPS-09, BR-P46 | planned · Khang (T108) | cùng truy vấn với JSON |
| `GET /admin/v1/revenue` | admin | UC-ADM-10, BR-P46 | planned · Khang (T108) | thêm `group_by=operator`, `operator_id` |
| `GET /admin/v1/revenue.csv` | admin | UC-ADM-10, BR-P46 | planned · Khang (T108) | |

Định nghĩa ở §4.

### 3.8 Tài khoản, role, thẻ RFID (11)

| Endpoint | Role | UC / FR / BR | Trạng thái · người làm | Ghi chú |
|---|---|---|---|---|
| `GET /admin/v1/users` | admin | UC-ADM-01, FR-14, BR-P05 | planned · Trí | lọc role, trạng thái, operator, `q` |
| `POST /admin/v1/users` | admin | UC-ADM-01/02, BR-P16 | planned · Trí | chỉ `operator_staff`/`admin`; tài xế tự đăng ký (consent BR-P05) |
| `GET /admin/v1/users/{id}` | admin | UC-ADM-01 | planned · Trí | |
| `PATCH /admin/v1/users/{id}` | admin | UC-ADM-01 | planned · Trí | họ tên, điện thoại |
| `PUT /admin/v1/users/{id}/role` | admin | UC-ADM-02, BR-P16 | planned · Trí | một role mỗi user; tài xế không đổi role được (409) |
| `POST /admin/v1/users/{id}/lock` | admin | UC-ADM-01, F-13 | planned · Trí | `active → suspended`, có hiệu lực ở request kế tiếp |
| `POST /admin/v1/users/{id}/unlock` | admin | UC-ADM-01, F-13 | planned · Trí | `closed` không mở lại |
| `GET /admin/v1/operators` | admin | UC-ADM-02, BR-P11 | planned · Trí | để gán nhân viên và lọc báo cáo |
| `GET /admin/v1/rfid-cards` | admin | UC-ADM-04, FR-15, BR-P15 | planned · Ân | |
| `POST /admin/v1/rfid-cards` | admin | UC-ADM-04, BR-P15, BR-P23 | planned · Ân | `card_kind` ∈ `online`, `free_vend` |
| `PATCH /admin/v1/rfid-cards/{id}` | admin | UC-ADM-04, BR-P15 | planned · Ân | gắn/bỏ tài xế, khoá/mở; không đổi loại |

### 3.9 Tổng quan nền tảng (5) và ngoại lệ thanh toán (8)

| Endpoint | Role | UC / FR / BR | Trạng thái · người làm | Ghi chú |
|---|---|---|---|---|
| `GET /admin/v1/summary` | admin | UC-ADM-07, Table 5 #27 | **console** (một phần) · Nghĩa (T97) | console có trụ/phiên/đối soát/bản tin; thiếu user, thẻ, ngoại lệ |
| `GET /admin/v1/sessions` | admin | UC-ADM-07, FR-19 | **console** · Trí | chỉ đọc, lọc `operator_id` |
| `GET /admin/v1/sessions/{id}` | admin | UC-ADM-07 | **console** · Trí | admin không giải quyết phiên của operator |
| `GET /admin/v1/reconciliation-records` | admin | UC-ADM-07, FR-16 | **console** · Trí | |
| `GET /admin/v1/ocpp-messages` | admin | UC-ADM-07, FE-08 | **console** · Nghĩa | |
| `GET /admin/v1/billing/top-ups?status=credited` | admin | UC-ADM-08, BR-P21 | planned · Khang | hình dạng phần tử: WF-02 D10 |
| `POST /admin/v1/billing/top-ups/{id}/refund` | admin | SD-2e, BR-P21 | planned · Khang | 202 `{refund_id, status: requested}` |
| `GET /admin/v1/billing/top-ups/late-payments` | admin | BR-P13 | planned · Khang | |
| `POST /admin/v1/billing/top-ups/{id}/late-refund` | admin | SD-2e, BR-P13 | planned · Khang | 202 |
| `GET /admin/v1/billing/e-invoices?status=needs_review` | admin | BR-P44 | planned · Khang | |
| `POST /admin/v1/billing/e-invoices/{id}/retry` | admin | SD-2c, BR-P44 | planned · Khang | `last_error_kind` ∈ `transient`, `data` (theo DB) |
| `GET /admin/v1/billing/refunds?status=failed` | admin | STM-10, WF-02 D1 | planned · Khang | gồm cả `account_closure` |
| `POST /admin/v1/billing/refunds/{id}/retry` | admin | STM-10 | planned · Khang | một lượt, không reset bộ đếm |

Không còn route Admin "hoàn tiền tài khoản đóng": hệ thống tự hoàn khi tài xế đóng (WF-02 D6, 09/11),
nên `credit-accounts/{id}/closure-refund` trong mock dashboard bỏ.

### 3.10 Số liệu

**76 endpoint**: 41 dưới `/api/operator/v1`, 35 dưới `/api/admin/v1` (trong đó 4 route đăng
nhập/làm mới công khai).

| Nhóm | Tổng | console | service | in progress | planned |
|---|---|---|---|---|---|
| Đăng nhập | 6 | 0 | 0 | 0 | 6 |
| Onboarding & sổ trụ | 10 | 1 | 2 | 0 | 7 |
| Giám sát & lệnh | 7 | 3 | 0 | 0 | 4 |
| Sự cố | 4 | 4 | 0 | 0 | 0 |
| Phiên, đối soát, T72 | 15 | 3 | 9 | 2 | 1 |
| Biểu giá & khuyến mãi | 6 | 0 | 0 | 0 | 6 |
| Doanh thu | 4 | 0 | 0 | 0 | 4 |
| Tài khoản & role | 8 | 0 | 0 | 0 | 8 |
| Thẻ RFID | 3 | 0 | 0 | 0 | 3 |
| Tổng quan nền tảng | 5 | 5 | 0 | 0 | 0 |
| Ngoại lệ thanh toán | 8 | 0 | 0 | 0 | 8 |
| **Cộng** | **76** | **16** | **11** | **2** | **47** |

## 4. Doanh thu theo BR-P46

BR-P46 (dẫn trong AD-1 bản vẽ lại sau Review 2; **chưa có trong `report3-srs.md` bản 24/10**, cần
thêm vào Table 13): báo cáo doanh thu = tổng phiên `csms_billed` đã `reconciled`, mỗi phiên tính một
lần, operator chỉ thấy trạm của mình, CSV khớp màn hình, không tính phí nền tảng hay chia doanh thu.

Hợp đồng biến luật thành truy vấn:

| Luật | Trong API |
|---|---|
| Chỉ `csms_billed` đã `reconciled` | `csms_billed_revenue_vnd` = Σ `credit_transactions.amount_vnd` (giá trị tuyệt đối) loại `session_debit` của phiên `payment_mode = csms_billed AND status = reconciled` |
| Mỗi phiên một lần | unique index `credit_transactions_one_debit_per_session` đã bảo đảm một `session_debit` mỗi phiên; báo cáo join theo phiên, không theo dòng sổ cái khác |
| Phiên unattributed là dòng riêng (UC-OPS-09) | `unattributed_session_count`, `unattributed_energy_wh` — **không có cột tiền** (không có ai để thu) |
| Phiên chưa đối soát xong | không vào doanh thu; đếm ở `pending_reconciliation.session_count` để người xem biết số còn có thể tăng |
| Operator chỉ thấy trạm của mình | `/operator/v1/revenue` lọc theo operator từ DB; `/admin/v1/revenue` toàn nền tảng, nhóm/lọc theo operator |
| CSV khớp màn hình | `revenue.csv` nhận đúng tham số và chạy đúng truy vấn của JSON; cùng thứ tự dòng, dòng cuối `TOTAL` bằng `totals` |
| Không phí, không chia | không có trường `platform_fee`, `owner_share` |
| Kỳ báo cáo | phiên vào kỳ theo `ended_at` (= `received_stopped_at`, đồng hồ CSMS, ADR-0009) quy về ngày Asia/Ho_Chi_Minh; kỳ ≤ 366 ngày |

Tình huống kiểm: tháng 11 operator A có 40 phiên app, 3 phiên thẻ online, 2 phiên thẻ lạ. 1 phiên app
vẫn ở `review`. Báo cáo: `csms_billed_session_count = 42`, doanh thu = Σ 42 khoản trừ,
`unattributed_session_count = 2`, `pending_reconciliation.session_count = 1`. Operator resolve phiên
đó → lần xem sau 43 phiên, CSV đổi theo.

## 5. Ánh xạ từ console hiện tại

### 5.1 Route console → endpoint hợp đồng

| Console (`apps/csms/src/console/console.router.ts`) | Hàm | Thành | Phải thêm |
|---|---|---|---|
| `GET /` (trang HTML), `GET /health` | `CONSOLE_PAGE_HTML`, `health` | giữ nguyên, ngoài hợp đồng | — |
| `GET /api/admin/stations` | `ConsoleQueries.stations` | `GET /operator/v1/charge-points` và `GET /admin/v1/charge-points` | lọc operator, id/site/display_code, súng có `connector_id`, phân trang |
| `GET /api/admin/summary` | `ConsoleQueries.summary` | `GET /admin/v1/summary` (một phần) | user, thẻ, ngoại lệ; operator có `summary` riêng mới |
| `GET /api/admin/sessions?limit` | `ConsoleQueries.sessions` | `GET /operator/v1/sessions`, `GET /admin/v1/sessions` | lọc operator, `queue`, page/page_size thay `limit` |
| `GET /api/admin/sessions/{id}` | `ConsoleQueries.session` | `GET /operator/v1/sessions/{id}`, `GET /admin/v1/sessions/{id}` | 404 cho phiên của operator khác |
| `GET /api/admin/reconciliation?limit` | `ConsoleQueries.reconciliation` | `GET /{operator,admin}/v1/reconciliation-records` | lọc operator / phiên / `kind` |
| `GET /api/admin/messages?limit&after` | `ConsoleQueries.messages` | `GET /admin/v1/ocpp-messages`, `GET /operator/v1/ocpp-messages` | lọc trụ và operator; `station` → `charge_point_serial` |
| `POST /api/admin/sessions/{id}/remote-stop` | `ConsoleCommands.remoteStop` | `POST /operator/v1/charge-points/{id}/commands` `{action: remote_stop, session_id}` | 202 thay vì chờ 15 s, ghi `remote_commands`, Idempotency-Key |
| `GET /api/admin/faults?status&limit` | `ConsoleCommands.faults` | `GET /operator/v1/faults` | lọc operator, page/page_size |
| `POST /api/admin/faults/{id}/acknowledge` | `acknowledgeFault` | `POST /operator/v1/faults/{id}/acknowledge` | `acknowledged_by` = người gọi |
| `POST /api/admin/faults/{id}/reset?type&force` | `resetFault` | `POST /operator/v1/faults/{id}/reset` | `type`/`force` vào body, `requested_by`, Idempotency-Key |
| `POST /api/admin/faults/{id}/close` | `closeFault` | `POST /operator/v1/faults/{id}/close` | người gọi |
| `POST /api/admin/stations/{serial}/disconnect` | `ConsoleCommands.disconnect` | **không chuyển** — công cụ mô phỏng sự cố cho demo/thí nghiệm, chỉ ở console loopback | — |

Đổi kiểu chung khi chuyển: console trả id dạng **số** (`id: 12`) và dùng `station`/`serial` làm khoá
trụ; hợp đồng trả id **chuỗi** và `charge_point_id` + `serial_number`. Đổi ở tầng route (mapper), không
đổi service.

### 5.2 Mock dashboard (`wp4/fe-01-dashboard-shell`, `src/core/api/api.ts`) → hợp đồng

| Mock | Hợp đồng |
|---|---|
| `POST /api/v1/auth/login` | `POST /api/operator/v1/auth/login` hoặc `/api/admin/v1/auth/login` (hai form đăng nhập — Table 5 #16, #26) |
| `/api/v1/operator/*` | `/api/operator/v1/*` |
| `/pillars`, `/pillars/{id}` | `/charge-points`, `/charge-points/{id}` (T90 đổi tên) |
| `POST /pillars/{id}/commands` `{action: Reset\|UnlockConnector\|RemoteStopTransaction}` | `POST /charge-points/{id}/commands` `{action: reset\|remote_stop\|remote_start}`; UnlockConnector chưa có (N2) |
| `POST /faults/{id}/reset?type=` | body `{type, force}` |
| `GET /sessions?queue=`, `POST /sessions/{id}/resolve {note}` | giữ đường dẫn; body thêm `resolution` |
| `/charge-intents/{id}/{begin-recovery\|approve-late-start\|restore-connector}` | giữ; thêm `complete-recovery`, `retry-recovery`, `GET …/recovery` |
| `GET/PUT /tariffs {periods}` | giữ đường dẫn; body `{effective_from, periods}`, band theo enum DB (mục 6 #3) |
| `GET /analytics/revenue` → `PillarRevenue[]` | `GET /revenue` → `RevenueReport`; `utilisationPercent` không thuộc doanh thu, lấy từ `/charge-points/{id}/metrics` |
| `GET /tickets` | ngoài v0.1 (UC-OPS-08 là Should) |
| `/api/admin/devices`, `/cards`, `/free-vend-tags` | `/api/admin/v1/charge-points`, `/rfid-cards`, `PUT /charge-points/{id}/free-vend-tag` |
| `PATCH /api/admin/users/{id} {role}` | `PUT /api/admin/v1/users/{id}/role` |
| `/api/admin/system-health`, `/policy-templates` | ngoài v0.1 (UC-ADM-07 phần health, UC-ADM-06 là Should); dùng `summary` + `ocpp-messages` |
| `/api/admin/billing/*` | `/api/admin/v1/billing/*` (WF-02 D8 ghi `/api/admin/billing/…` — câu hỏi K4) |
| camelCase, `id: number`, `role: 'operator'` | snake_case, `id: string`, `role: 'operator_staff'` |

## 6. Chỗ SRS mơ hồ và lựa chọn của hợp đồng

| # | Mơ hồ | Chọn | Vì sao |
|---|---|---|---|
| 1 | Doanh thu: UC-OPS-09 trong SRS 24/10 là "Revenue Analytics" (Should); bản vẽ lại sau Review 2 (T91) đổi thành "View Revenue Share" và thêm UC-ADM-09 "Configure Platform Fee Rate", UC-ADM-10 "View Platform Revenue", màn hình ghi "charged · platform fee · own share". BR-P46 lại nói không tính phí/chia | Theo BR-P46: không có phí, không chia; UC-ADM-09 không có endpoint | BR-P46 là luật mới nhất Trí giao cho T98; bản vẽ cần sửa theo hoặc nhóm chốt lại (K1) |
| 2 | UC-ADM-10 và BR-P46 chưa có trong `report3-srs.md` | Dẫn từ `diagrams/report3/use-case/admin/ucd_admin.py` và `activity/AD-1` | cần cập nhật SRS bản Drive + bản local |
| 3 | Biểu giá: SRS UC-OPS-06 ghi 4 khung Sharp / Peak / Shoulder / Off-peak "for their sites"; DB `tariff_band` có 3 giá trị (`off_peak`, `normal`, `peak`) và `tariff_periods` theo **operator**, không theo site | Theo DB: 3 band, biểu giá theo operator | đổi enum là migration — câu hỏi K2/N4; mock dashboard đang dùng 4 tên SRS |
| 4 | UC-ADM-04 còn ghi loại thẻ thứ hai và Table 5 #30 cũng vậy | Chỉ `online`, `free_vend` | theo T110 |
| 5 | Role: tác vụ nói "operator", DB là `operator_staff` + `staff_role` (`manager`, `technician`); SRS không phân quyền theo `staff_role` | JWT `role = operator_staff`; hai `staff_role` cùng quyền trong v0.1 | không bịa phân quyền SRS không có (N5) |
| 6 | UC-ADM-01 "create … driver accounts" nhưng tài xế phải tự cho consent (BR-P05) | Admin chỉ tạo `operator_staff`/`admin`; xem, sửa, khoá được mọi role | consent không thể do người khác cho |
| 7 | UC-OPS-04 "remotely starts" — không nói idTag nào, ai trả tiền | `remote_start` bắt buộc `id_tag`, đi Authorize + phân loại như mọi phiên (BR-P06, BR-P08) | không đẻ ra phương thức thanh toán mới (T1) |
| 8 | FE-05 dashboard có "mở khoá súng" (UnlockConnector); SRS Table 7 #2 không có | Không đưa vào v0.1 | không có trong tập bản tin FR-16 (N2) |
| 9 | Ai tạo operator và site — SRS không có UC | Chỉ `GET /admin/v1/operators`, `GET /operator/v1/sites`; tạo bằng seed | A3 |
| 10 | UC-ADM-07 "Monitor Platform Health" (SRS) đổi thành "Monitor Charge Point Network" trong bản vẽ mới | Admin có `charge-points`, `sessions`, `reconciliation-records`, `ocpp-messages` chỉ đọc; không có `system-health` | Should; phần health là hạ tầng |
| 11 | Doanh thu tính vào ngày nào: lúc dừng hay lúc reconciled | `ended_at` (lúc trụ dừng, đồng hồ CSMS) | ổn định với người xem; phiên reconciled muộn vẫn rơi đúng ngày sạc (K3) |
| 12 | BM04 (F-09, F-10, F-13, F-14, F-16, NFR-05) không có trong repo | Dùng nguyên văn F-13 và NFR-05 trong yêu cầu T98; FR theo phiếu v1.3 | Trí bổ sung file BM04 nếu số F lệch FR |

## 7. Câu hỏi mở

**Nghĩa (dashboard, T97)**

| # | Câu hỏi | Đề xuất |
|---|---|---|
| N1 | Chấp nhận snake_case + id chuỗi + base `/api/operator/v1` thay cho camelCase/id số/`/api/v1/operator` của mock? | Có — sinh client từ OpenAPI (WP2 §4) để không sửa tay |
| N2 | UnlockConnector có bắt buộc cho demo không? Nếu có cần thêm vào SRS Table 7 #2 trước | Bỏ khỏi v0.1 |
| N3 | Operator có cần trình xem bản tin OCPP (FE-08)? Table 6 không có màn hình này cho Operator | Giữ endpoint lọc theo operator, thêm dòng vào Table 5/6 |
| N4 | Màn hình biểu giá theo 3 band DB hay 4 khung SRS? | 3 band đến khi có migration |
| N5 | `technician` có bị cấm sửa biểu giá/khuyến mãi, xem doanh thu không? | Không cấm trong v0.1; nếu cần thì SRS ghi trước |
| N6 | Chu kỳ poll 5 s có đủ cho Review 3 hay cần SSE ngay? | Poll; SSE sau |
| N7 | `summary` operator có đủ trường như `OperatorSummary` của mock (thêm `uncertain_starts`)? | Theo schema `OperatorSummary` trong YAML |

**Khang (doanh thu T108, ngoại lệ thanh toán)**

| # | Câu hỏi | Đề xuất |
|---|---|---|
| K1 | Chốt BR-P46 "không phí/không chia" với bản vẽ Revenue Share + UC-ADM-09 | Theo BR-P46; báo Ân sửa bản vẽ |
| K2 | Doanh thu có trừ `adjustment` gắn phiên (bút toán bù khi sửa phiên, BR-P20) không? | Có, nếu `adjustment` mang `session_id`; xác nhận cách ghi |
| K3 | Xếp kỳ theo `ended_at` hay ngày reconciled? | `ended_at` |
| K4 | Đường dẫn admin billing: `/api/admin/billing/…` (WF-02 D8) hay `/api/admin/v1/billing/…` (hợp đồng này)? | `/api/admin/v1/…` để một bề mặt có một tiền tố và một cơ chế JWT |
| K5 | Phiên unattributed có cần giá ước tính (Table 7 #11 "reports separately") không? | Không có tiền trong v0.1; chỉ phiên + Wh |
| K6 | Khuyến mãi áp vào giá lúc quyết toán chưa? Nếu chưa, `promotions` chỉ là CRUD | Ghi rõ trong T108 |

**Ân (onboarding T119, sổ trụ, thẻ)**

| # | Câu hỏi | Đề xuất |
|---|---|---|
| A1 | Mất mật khẩu trụ: cần `POST /operator/v1/charge-points/{id}/credential` (cấp lại, ADR-0011 "chưa có")? | Thêm ở v0.2, đổi băm + đóng socket cũ |
| A2 | `disable`/`enable` có gửi `ChangeAvailability` xuống trụ không, hay chỉ chặn ở CSMS? | Chỉ CSMS trong v0.1; BR-P07 cho phần cấu hình |
| A3 | Ai tạo operator, site? | Seed đến khi có UC |
| A4 | Free-vend tag trùng `card_identifier` thẻ đã đăng ký → 409? | Có (`tag_conflicts_with_card`) |
| A5 | Sửa bản vẽ Revenue Share / Platform Fee theo K1 | — |

**Trí (tự giữ)**: T1 `remote_start` của operator có cần thật cho Review 3 không; T2 xác thực nhân viên
dùng chung bộ đếm thử sai với tài xế hay riêng; T3 cập nhật SRS (UC-ADM-09/10, BR-P46, T110).

## 8. Kiểm chứng

```bash
npm ci --ignore-scripts
# parse YAML (js-yaml có sẵn trong node_modules)
node -e "require('js-yaml').load(require('fs').readFileSync('docs/api/operator-admin-api.openapi.yaml','utf8'))"
npx prettier --check docs/api/operator-admin-api.openapi.yaml docs/api/OPERATOR-ADMIN-API-HOP-DONG.md
```

Ngoài parse, một script tạm (không commit) đã kiểm: mọi `$ref` nội bộ giải được, `operationId` duy
nhất, path param khớp template, mọi operation có `x-roles`/`x-status`/`x-owner`/`x-refs`, mọi route
có bearer khai báo 401 và 403, route công khai có `security: []`, role khớp bề mặt, và không còn tên
payment_mode / loại thẻ mà T110 bỏ. Ma trận ở §9 sinh từ `x-roles` bằng chính script đó. **Chưa chạy
Redocly** vì chưa có trong dependency (không tự tải công cụ chưa được duyệt — như Driver API §10).

## 9. Ma trận role × endpoint (NFR-05)

Sinh từ `x-roles` trong YAML. ✓ = được gọi · 403 = token hợp lệ nhưng sai role (F-13) · 401 = không
token. Route công khai chỉ là đăng nhập/làm mới: ai cũng gọi được, chỉ tài khoản đúng role đăng nhập
thành công. Test tự động của NFR-05 nên lặp bảng này: với mỗi endpoint × mỗi role, gọi bằng token của
role đó và so mã trạng thái (2xx/4xx nghiệp vụ khác với 401/403).

| # | Endpoint | Không token | driver | operator_staff | admin | Trạng thái |
|---|---|---|---|---|---|---|
| 1 | `POST /api/operator/v1/auth/login` | công khai | — | — | — | planned |
| 2 | `POST /api/operator/v1/auth/refresh` | công khai | — | — | — | planned |
| 3 | `GET /api/operator/v1/me` | 401 | 403 | ✓ | 403 | planned |
| 4 | `POST /api/admin/v1/auth/login` | công khai | — | — | — | planned |
| 5 | `POST /api/admin/v1/auth/refresh` | công khai | — | — | — | planned |
| 6 | `GET /api/admin/v1/me` | 401 | 403 | 403 | ✓ | planned |
| 7 | `GET /api/operator/v1/sites` | 401 | 403 | ✓ | 403 | planned |
| 8 | `GET /api/operator/v1/charge-points` | 401 | 403 | ✓ | 403 | console |
| 9 | `POST /api/operator/v1/charge-points` | 401 | 403 | ✓ | 403 | service |
| 10 | `GET /api/operator/v1/charge-points/{chargePointId}` | 401 | 403 | ✓ | 403 | planned |
| 11 | `GET /api/operator/v1/charge-points/{chargePointId}/metrics` | 401 | 403 | ✓ | 403 | planned |
| 12 | `POST /api/operator/v1/charge-points/{chargePointId}/disable` | 401 | 403 | ✓ | 403 | planned |
| 13 | `POST /api/operator/v1/charge-points/{chargePointId}/enable` | 401 | 403 | ✓ | 403 | planned |
| 14 | `GET /api/admin/v1/charge-points` | 401 | 403 | 403 | ✓ | console |
| 15 | `POST /api/admin/v1/charge-points` | 401 | 403 | 403 | ✓ | service |
| 16 | `GET /api/admin/v1/charge-points/{chargePointId}` | 401 | 403 | 403 | ✓ | planned |
| 17 | `PATCH /api/admin/v1/charge-points/{chargePointId}` | 401 | 403 | 403 | ✓ | planned |
| 18 | `PUT /api/admin/v1/charge-points/{chargePointId}/free-vend-tag` | 401 | 403 | 403 | ✓ | planned |
| 19 | `POST /api/admin/v1/charge-points/{chargePointId}/decommission` | 401 | 403 | 403 | ✓ | planned |
| 20 | `GET /api/operator/v1/summary` | 401 | 403 | ✓ | 403 | planned |
| 21 | `POST /api/operator/v1/charge-points/{chargePointId}/commands` | 401 | 403 | ✓ | 403 | console |
| 22 | `GET /api/operator/v1/commands/{commandId}` | 401 | 403 | ✓ | 403 | planned |
| 23 | `GET /api/operator/v1/ocpp-messages` | 401 | 403 | ✓ | 403 | console |
| 24 | `GET /api/operator/v1/faults` | 401 | 403 | ✓ | 403 | console |
| 25 | `POST /api/operator/v1/faults/{faultId}/acknowledge` | 401 | 403 | ✓ | 403 | console |
| 26 | `POST /api/operator/v1/faults/{faultId}/reset` | 401 | 403 | ✓ | 403 | console |
| 27 | `POST /api/operator/v1/faults/{faultId}/close` | 401 | 403 | ✓ | 403 | console |
| 28 | `GET /api/operator/v1/sessions` | 401 | 403 | ✓ | 403 | console |
| 29 | `GET /api/operator/v1/sessions/{sessionId}` | 401 | 403 | ✓ | 403 | console |
| 30 | `POST /api/operator/v1/sessions/{sessionId}/resolve` | 401 | 403 | ✓ | 403 | service |
| 31 | `POST /api/operator/v1/sessions/{sessionId}/assign` | 401 | 403 | ✓ | 403 | in_progress |
| 32 | `POST /api/operator/v1/sessions/{sessionId}/close` | 401 | 403 | ✓ | 403 | in_progress |
| 33 | `GET /api/operator/v1/reconciliation-records` | 401 | 403 | ✓ | 403 | console |
| 34 | `GET /api/operator/v1/charge-intents` | 401 | 403 | ✓ | 403 | planned |
| 35 | `GET /api/operator/v1/charge-intents/{intentId}/recovery` | 401 | 403 | ✓ | 403 | service |
| 36 | `POST /api/operator/v1/charge-intents/{intentId}/begin-recovery` | 401 | 403 | ✓ | 403 | service |
| 37 | `POST /api/operator/v1/charge-intents/{intentId}/complete-recovery` | 401 | 403 | ✓ | 403 | service |
| 38 | `POST /api/operator/v1/charge-intents/{intentId}/restore-connector` | 401 | 403 | ✓ | 403 | service |
| 39 | `POST /api/operator/v1/charge-intents/{intentId}/retry-recovery` | 401 | 403 | ✓ | 403 | service |
| 40 | `POST /api/operator/v1/charge-intents/{intentId}/approve-late-start` | 401 | 403 | ✓ | 403 | service |
| 41 | `POST /api/operator/v1/sessions/{sessionId}/recover-stop` | 401 | 403 | ✓ | 403 | service |
| 42 | `POST /api/operator/v1/sessions/{sessionId}/tariff-boundary` | 401 | 403 | ✓ | 403 | service |
| 43 | `GET /api/operator/v1/tariffs` | 401 | 403 | ✓ | 403 | planned |
| 44 | `PUT /api/operator/v1/tariffs` | 401 | 403 | ✓ | 403 | planned |
| 45 | `GET /api/operator/v1/promotions` | 401 | 403 | ✓ | 403 | planned |
| 46 | `POST /api/operator/v1/promotions` | 401 | 403 | ✓ | 403 | planned |
| 47 | `PATCH /api/operator/v1/promotions/{promotionId}` | 401 | 403 | ✓ | 403 | planned |
| 48 | `POST /api/operator/v1/promotions/{promotionId}/deactivate` | 401 | 403 | ✓ | 403 | planned |
| 49 | `GET /api/operator/v1/revenue` | 401 | 403 | ✓ | 403 | planned |
| 50 | `GET /api/operator/v1/revenue.csv` | 401 | 403 | ✓ | 403 | planned |
| 51 | `GET /api/admin/v1/revenue` | 401 | 403 | 403 | ✓ | planned |
| 52 | `GET /api/admin/v1/revenue.csv` | 401 | 403 | 403 | ✓ | planned |
| 53 | `GET /api/admin/v1/users` | 401 | 403 | 403 | ✓ | planned |
| 54 | `POST /api/admin/v1/users` | 401 | 403 | 403 | ✓ | planned |
| 55 | `GET /api/admin/v1/users/{userId}` | 401 | 403 | 403 | ✓ | planned |
| 56 | `PATCH /api/admin/v1/users/{userId}` | 401 | 403 | 403 | ✓ | planned |
| 57 | `PUT /api/admin/v1/users/{userId}/role` | 401 | 403 | 403 | ✓ | planned |
| 58 | `POST /api/admin/v1/users/{userId}/lock` | 401 | 403 | 403 | ✓ | planned |
| 59 | `POST /api/admin/v1/users/{userId}/unlock` | 401 | 403 | 403 | ✓ | planned |
| 60 | `GET /api/admin/v1/operators` | 401 | 403 | 403 | ✓ | planned |
| 61 | `GET /api/admin/v1/rfid-cards` | 401 | 403 | 403 | ✓ | planned |
| 62 | `POST /api/admin/v1/rfid-cards` | 401 | 403 | 403 | ✓ | planned |
| 63 | `PATCH /api/admin/v1/rfid-cards/{cardId}` | 401 | 403 | 403 | ✓ | planned |
| 64 | `GET /api/admin/v1/summary` | 401 | 403 | 403 | ✓ | console |
| 65 | `GET /api/admin/v1/sessions` | 401 | 403 | 403 | ✓ | console |
| 66 | `GET /api/admin/v1/sessions/{sessionId}` | 401 | 403 | 403 | ✓ | console |
| 67 | `GET /api/admin/v1/reconciliation-records` | 401 | 403 | 403 | ✓ | console |
| 68 | `GET /api/admin/v1/ocpp-messages` | 401 | 403 | 403 | ✓ | console |
| 69 | `GET /api/admin/v1/billing/top-ups` | 401 | 403 | 403 | ✓ | planned |
| 70 | `POST /api/admin/v1/billing/top-ups/{topUpId}/refund` | 401 | 403 | 403 | ✓ | planned |
| 71 | `GET /api/admin/v1/billing/top-ups/late-payments` | 401 | 403 | 403 | ✓ | planned |
| 72 | `POST /api/admin/v1/billing/top-ups/{topUpId}/late-refund` | 401 | 403 | 403 | ✓ | planned |
| 73 | `GET /api/admin/v1/billing/e-invoices` | 401 | 403 | 403 | ✓ | planned |
| 74 | `POST /api/admin/v1/billing/e-invoices/{invoiceId}/retry` | 401 | 403 | 403 | ✓ | planned |
| 75 | `GET /api/admin/v1/billing/refunds` | 401 | 403 | 403 | ✓ | planned |
| 76 | `POST /api/admin/v1/billing/refunds/{refundId}/retry` | 401 | 403 | 403 | ✓ | planned |

