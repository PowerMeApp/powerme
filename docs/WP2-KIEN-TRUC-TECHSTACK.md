# WP2 — Kiến trúc & Ngăn xếp công nghệ của CSMS

**Người đề xuất:** WP2 (Backend / IoT Integration Engineer)
**Người nhận:** WP1 — đưa vào SDD v1.0
**Cần chốt:** trong S2 (07/09 – 20/09/2026), trước khi BE-02 gộp vào `main`
**Liên quan:** WP3 (app), WP4 (dashboard), WP5 (simulator, billing) — mục 4 là hợp đồng giao tiếp với các bạn
**Kế thừa:** [ADR-0001 Monorepo npm workspaces](adr/0001-monorepo-npm-workspaces.md) · `CONTRIBUTING.md` · `infra/docker-compose.yml`
**Trạng thái:** 11 quyết định đánh số ADR-0002 → ADR-0012, mỗi quyết định một file trong [`docs/adr/`](adr/README.md)
**Cập nhật 11/09/2026:** thêm ADR-0012 sau khi đối chiếu manual gốc của hãng — trụ có thẻ ví tự trừ tiền và chế độ free vend
**Cập nhật 23/10/2026:** tách 11 ADR ra file riêng trong `docs/adr/`; mục 2 dưới đây chỉ còn tóm tắt và link. ADR-0002, 0003, 0004, 0008 đã **Chấp nhận**; còn lại giữ **Đề xuất**

---

## Tóm tắt cho WP1

**Kiểu kiến trúc:** *Modular monolith* — `apps/csms` chạy một tiến trình NestJS, bên trong chia module rõ ranh giới. **Không làm microservices.**

**Ngăn xếp** — những dòng ghi *đã ghim* là thứ nhóm đã commit, tài liệu này chỉ chính thức hoá:

| Lớp | Chọn | Phiên bản | Nguồn |
|---|---|---|---|
| Runtime | Node.js LTS | **24.18.1** | *đã ghim* — `.nvmrc`, CI |
| Ngôn ngữ | TypeScript, bật `strict` | **5.9.3** | *đã ghim* — `apps/csms/package.json` |
| Framework | NestJS | **12.2.0** | *đã ghim* — `apps/csms/package.json`, `package-lock.json` |
| Tầng vận chuyển OCPP-J | **ocpp-rpc** (MIT) | **2.2.1** — ghim cứng, không `^`/`~`; npm chưa có 3.x, bản 3.0.0 sắp tới là ESM breaking change | **mới — ADR-0004** |
| Cơ sở dữ liệu | PostgreSQL, partition gốc theo tháng | **16.4** | *đã ghim* — `infra/docker-compose.yml` |
| Cache, hàng đợi job | Redis + BullMQ | **7.4** | *đã ghim* — `infra/docker-compose.yml` |
| Realtime tới app và dashboard | Socket.IO + Redis adapter | *đề xuất* (4.x) — chưa có trong `package-lock.json` | **mới — ADR-0006** |
| ORM | Drizzle ORM + migration SQL thuần | | **mới — chốt cùng WP5** |
| Log | pino, JSON có cấu trúc | | |
| Metrics | prom-client → Prometheus + Grafana | | |
| Test | Jest (mặc định NestJS) · tích hợp chạy trên service container PostgreSQL + Redis mà CI đã có · e2e bằng SAP simulator · tải bằng k6 trong `infra/k6/` | | |
| Reverse proxy, TLS | Caddy 2 | *đề xuất* — chưa có trong repo | **mới — ADR-0011** |
| Triển khai | Docker Compose trên một VPS · GitHub Actions | | *đã có* |

**Năm quy ước dữ liệu bắt buộc ghi vào SDD** (chi tiết ở ADR-0009):
1. Mọi thời gian lưu `timestamptz` theo UTC, hiển thị giờ Việt Nam ở tầng giao diện
2. Mỗi bản tin lưu **hai** thời điểm: `cp_timestamp` (đồng hồ trụ, không tin cậy) và `received_at` (đồng hồ CSMS, tin cậy)
3. Điện năng lưu **Wh, kiểu số nguyên `bigint`** — không bao giờ lưu kWh dạng số thực
4. Tiền lưu **VND, kiểu số nguyên `bigint`**
5. `connectorId`: `1` = súng A · `2` = súng B · `0` = toàn trụ

**Bốn thứ các WP khác phải biết ngay** (chi tiết ở mục 4 và ADR-0012):
1. Lệnh điều khiển trụ là **bất đồng bộ**: REST trả `202` kèm `commandId`, kết quả về qua sự kiện realtime
2. Sự kiện realtime **có thể mất** — chỉ là gợi ý. **REST mới là nguồn sự thật**, client phải gọi lại REST khi nối lại
3. Giao dịch **có thể bị sửa sau khi đã kết thúc** (do engine đối soát) — billing và app phải xử lý sự kiện `transaction.amended`
4. **Không phải phiên nào cũng do CSMS thu tiền.** Trụ có thẻ ví trả trước và tự trừ tiền trên thẻ, kể cả khi offline. Billing của WP5 **không được** thu thêm qua VNPay cho những phiên này

---

## 1. Sơ đồ thành phần

```
  ┌─────────────────────────┐       ┌──────────────────┐   ┌──────────────────┐
  │ Trụ sạc — SAP simulator │       │ apps/mobile  WP3 │   │ apps/dashboard   │
  │ D1 / YJ-EU · 2 súng DC  │       │ Flutter          │   │ WP4 · React+Vite │
  └────────────┬────────────┘       └────────┬─────────┘   └────────┬─────────┘
               │ WSS /ocpp/{serialNumber}     │ HTTPS /api/v1       │
               │ subprotocol ocpp1.6          │ WSS   /realtime     │
               │ Basic Auth                   │                     │
  ┌────────────▼──────────────────────────────▼─────────────────────▼─────────┐
  │ Caddy 2 — kết thúc TLS, định tuyến theo đường dẫn                         │
  └────────────┬──────────────────────────────┬─────────────────────┬─────────┘
               │ /ocpp/* → cổng 9000          │ /api/*  → cổng 3000 │ /realtime
  ┌────────────▼──────────────────────────────▼─────────────────────▼─────────┐
  │ apps/csms — @powerme/csms · NestJS · Node.js 24 · MỘT tiến trình          │
  │                                                                           │
  │  ┌─────────────┐   ┌─────────────┐   ┌────────────────┐  ┌────────────┐   │
  │  │ocpp-gateway │──▶│  charging   │──▶│ reconciliation │  │  realtime  │   │
  │  │ (ocpp-rpc)  │   │state machine│   │ bật / tắt được │  │ Socket.IO  │   │
  │  └──────┬──────┘   └──────┬──────┘   └───────┬────────┘  └─────▲──────┘   │
  │         │ ghi trước       │                  │                 │          │
  │  ┌──────▼──────┐   ┌──────▼──────┐   ┌───────▼────────┐        │          │
  │  │ message-log │   │  metering   │   │ stations       │────────┘          │
  │  │ append-only │   │ MeterValues │   │ registry, auth │                   │
  │  └─────────────┘   └─────────────┘   └────────────────┘                   │
  │                                                                           │
  │  module của WP5:  billing · payments · invoicing                          │
  └────────────┬────────────────────────────────────────────┬─────────────────┘
               │                                            │
     ┌─────────▼─────────┐    kiểu dữ liệu dùng chung ┌─────▼──────────┐
     │ PostgreSQL 16.4   │    packages/shared         │ Redis 7.4      │
     │ nguồn sự thật     │    ocpp · domain · api ·   │ realtime, job  │
     └───────────────────┘    realtime                └────────────────┘
```

**Module do WP2 sở hữu:** `ocpp-gateway`, `message-log`, `charging`, `metering`, `reconciliation`, `realtime`, `stations`.
**Module do WP5 sở hữu, chạy chung tiến trình:** `billing`, `payments`, `invoicing`.

> **Đối chiếu với code (23/10/2026):** đây là bố cục đề xuất. `apps/csms/src/` hiện chỉ có `ocpp-gateway/`, `sessions/`, `reconciliation/`, `db/` (nhật ký bản tin nằm trong `ocpp-gateway/`; `charging`, `metering`, `realtime`, `stations`, `billing`, `payments`, `invoicing` chưa có thư mục). Xem [PACKAGE-DIAGRAM-CSMS.md](PACKAGE-DIAGRAM-CSMS.md).

Cổng HTTP `3000` (`CSMS_HTTP_PORT`). Cổng OCPP WebSocket chuẩn của Iteration 1 là **9000** (`OCPP_PORT` trong `infra/.env.example`, được ưu tiên hơn `CSMS_OCPP_WS_PORT=3001` cũ; mặc định trong `apps/csms/src/config.ts`). Trên máy dev không cần Caddy — trụ ảo nối thẳng `ws://localhost:9000/ocpp/{serialNumber}`.

---

## 2. Các quyết định kiến trúc

Đánh số tiếp theo [ADR-0001](adr/0001-monorepo-npm-workspaces.md). Theo quy ước của `docs/adr/README.md`, mỗi quyết định là **một file riêng** `docs/adr/NNNN-ten-quyet-dinh.md` theo `_template.md` — file ADR là nơi duy nhất giữ bối cảnh, quyết định, hệ quả và phương án đã loại. Dưới đây chỉ tóm tắt để đọc liền mạch; muốn tranh luận hay sửa thì sửa ở file ADR.

### ADR-0002 · Modular monolith, không làm microservices — *Chấp nhận*

`apps/csms` là một tiến trình NestJS chia module rõ ranh giới; `ocpp-gateway` tách được thành dịch vụ riêng sau này. Chưa scale ngang tầng WebSocket — ghi vào hướng phát triển.
→ [adr/0002-modular-monolith.md](adr/0002-modular-monolith.md)

### ADR-0003 · Node.js 24 LTS + TypeScript — *Chấp nhận*

Chính thức hoá `.nvmrc` 24.18.1, CI Node 24, NestJS 12.2.0, TypeScript `strict`. Việc kéo theo: nâng `engines.node` lên `>=24`.
→ [adr/0003-node-24-typescript-strict.md](adr/0003-node-24-typescript-strict.md)

### ADR-0004 · Dùng `ocpp-rpc` cho tầng vận chuyển OCPP-J — *Chấp nhận*

Ghim cứng `ocpp-rpc@2.2.1` (MIT), không `^`/`~` vì 3.0.0 sắp tới là ESM breaking change; vendor một bản copy dự phòng. Schema OCA đi kèm là CC BY-ND 4.0 — dùng nguyên văn. Ba việc thư viện không làm (tuần tự hoá chiều vào theo trụ, đóng phiên cũ khi nối lại cùng identity, logic nghiệp vụ) thuộc WP2.
→ [adr/0004-ocpp-rpc-tang-van-chuyen.md](adr/0004-ocpp-rpc-tang-van-chuyen.md)

### ADR-0005 · Nhật ký bản tin OCPP ghi trước, chỉ thêm không sửa — *Đề xuất*

Mọi frame vào `ocpp_message_log` trước khi xử lý nghiệp vụ; bảng chỉ INSERT. Là ground truth cho thí nghiệm mất dữ liệu và nguồn cho FE-08.
→ [adr/0005-nhat-ky-ban-tin-ocpp-append-only.md](adr/0005-nhat-ky-ban-tin-ocpp-append-only.md)

### ADR-0006 · Không dùng Redis pub/sub trên đường đi của giao dịch — *Đề xuất*

Pub/sub chỉ cho fanout tới giao diện; giao dịch đi bằng gọi hàm trong tiến trình sau khi ghi log, job nền qua BullMQ. Client phải coi sự kiện realtime là gợi ý, REST là sự thật.
→ [adr/0006-khong-redis-pubsub-tren-duong-giao-dich.md](adr/0006-khong-redis-pubsub-tren-duong-giao-dich.md)

### ADR-0007 · PostgreSQL 16.4 với partition gốc, không dùng TimescaleDB — *Đề xuất*

Giữ 16.4 đã ghim; `meter_values` và `ocpp_message_log` partition theo tháng, job BullMQ tạo partition trước. Việc kéo theo: ghim CI về `postgres:16.4-alpine`.
→ [adr/0007-postgresql-partition-goc.md](adr/0007-postgresql-partition-goc.md)

### ADR-0008 · Drizzle ORM + migration SQL thuần — *Chấp nhận, đã chốt cùng WP5*

ORM không cản viết SQL tay cho partition, unique idempotency, bảng append-only, mà vẫn có type-safety.
→ [adr/0008-drizzle-orm-migration-sql.md](adr/0008-drizzle-orm-migration-sql.md)

### ADR-0009 · Quy ước dữ liệu — *Đề xuất*

`timestamptz` UTC; hai thời điểm mỗi bản tin (`cp_timestamp` / `received_at`); Wh và VND kiểu `bigint`; connector 0/1/2; SN là định danh kỹ thuật, `display_code` là mã hiển thị; `origin`, `payment_mode`, `delivered_offline` trên giao dịch.
→ [adr/0009-quy-uoc-du-lieu.md](adr/0009-quy-uoc-du-lieu.md)

### ADR-0010 · Idempotency của StartTransaction — *Đề xuất*

Unique trên `(charge_point_id, connector_id, id_tag, meter_start_wh, cp_timestamp)`; trụ gửi lại thì trả đúng `transactionId` cũ. Nền móng của BE-07.
→ [adr/0010-idempotency-starttransaction.md](adr/0010-idempotency-starttransaction.md)

### ADR-0011 · Bảo mật OCPP: Security Profile 2 — *Đề xuất*

TLS kết thúc tại Caddy + Basic Auth riêng từng trụ; mật khẩu sinh lúc onboarding, hiện một lần, băm scrypt (ADR-0011 sửa 25/10; hiện chưa có TLS, CSMS chạy `ws://` tới khi dựng Caddy trên staging). Security Profile 3 để hướng phát triển.
→ [adr/0011-ocpp-security-profile-2.md](adr/0011-ocpp-security-profile-2.md)

### ADR-0012 · Phiên sạc bằng thẻ ví và free vend — *Đề xuất, cần cả nhóm chốt*

Trụ Ruihua có thẻ ví tự trừ tiền và chế độ free vend mà OCPP 1.6 không phân biệt được qua `StartTransaction`. Tách `origin` và `payment_mode`; phân loại thẻ bằng sổ `id_tags`; phiên `station_wallet` vẫn tính giá nhưng không thu qua VNPay. Ba câu hỏi mở chỉ hãng trả lời được.
→ [adr/0012-phien-the-vi-va-free-vend.md](adr/0012-phien-the-vi-va-free-vend.md)

---

## 3. Mô hình dữ liệu WP2 sở hữu

WP1 vẽ ERD từ danh sách này. Chỉ liệt kê cột quan trọng.

> **Tên bảng thật khác bản đề xuất này:** schema đã cài (`apps/csms/src/db/schema/`) dùng `sessions` thay `transactions`, `rfid_cards` thay `id_tags`; `remote_commands` đã tạo ở migration 0001 (25/10/2026; cột `status` thêm `sent`/`failed`, có `idempotency_key`, `payload`/`response` jsonb — xem THIET-KE-CSDL-VAT-LY.md mục 3.8). Bảng tên thật và lý do: [THIET-KE-CSDL-VAT-LY.md](THIET-KE-CSDL-VAT-LY.md).

| Bảng | Cột quan trọng | Ghi chú |
|---|---|---|
| `charge_points` | `id`, `serial_number` (unique), `display_code` (unique), `model` (D1 / YJ-EU), `site_id`, `password_hash`, `lifecycle` (registered / awaiting_connection / online), `last_seen_at`, `firmware_version`, `free_vend_id_tag` (nullable) | `lifecycle` khớp ràng buộc onboarding từ SRS phần cứng. `free_vend_id_tag` — ADR-0012 |
| `connectors` | `charge_point_id`, `connector_id` (0/1/2), `status`, `error_code`, `status_updated_at` | Khoá chính `(charge_point_id, connector_id)` |
| `id_tags` | `id_tag` (unique), `kind` (online_card / wallet_card), `user_id` (nullable), `status` (active / blocked / expired), `issued_at` | Sổ đăng ký thẻ — cách duy nhất CSMS phân biệt thẻ ví với thẻ xác thực. ADR-0012 |
| `ocpp_message_log` | `id`, `serial_number`, `direction` (in / out), `message_type` (2/3/4), `unique_id`, `action`, `payload` (jsonb), `cp_timestamp`, `received_at` | **Append-only, partition theo tháng** — ADR-0005 |
| `transactions` | `id` (chính là `transactionId` trả cho trụ), `charge_point_id`, `connector_id`, `id_tag`, `meter_start_wh`, `meter_stop_wh`, `cp_started_at`, `cp_stopped_at`, `received_started_at`, `stop_reason`, `origin` (app / rfid_online / rfid_wallet / hmi_password / free_vend), `payment_mode` (csms_billed / station_wallet / unattributed), `delivered_offline`, `status` | Unique theo khoá idempotency — ADR-0010. Ba cột `origin`, `payment_mode`, `delivered_offline` — ADR-0009 và ADR-0012 |
| `meter_values` | `transaction_id`, `connector_id`, `measurand`, `value`, `unit`, `cp_timestamp`, `received_at` | **Partition theo tháng.** Measurand DC: `SoC`, `Voltage`, `Current.Import`, `Power.Active.Import`, `Energy.Active.Import.Register` |
| `reconciliation_records` | `id`, `transaction_id`, `kind` (duplicate / replay / meter_gap / orphan_stop / settlement_mismatch / unknown_id_tag), `detected_at`, `detail` (jsonb), `resolution` | Mỗi hành động của engine đối soát để lại dấu vết — vừa để kiểm toán vừa là dữ liệu thí nghiệm |
| `remote_commands` | `id` (commandId), `charge_point_id`, `action`, `request`, `status` (pending / accepted / rejected / timeout), `requested_by`, `requested_at`, `completed_at` | Phục vụ lệnh bất đồng bộ — mục 4.2 |

---

## 4. Hợp đồng giao tiếp với các WP khác

**Phần quan trọng nhất cho việc phối hợp.** Theo ADR-0001, mọi kiểu dữ liệu của hợp đồng nằm trong `packages/shared` và **đổi ở đó cần hai người duyệt** (WP1 + WP2, theo `CODEOWNERS`):

| Hợp đồng | Vị trí trong `packages/shared` |
|---|---|
| Enum OCPP 1.6 — chép đúng spec mục 7 | `src/ocpp/` |
| Kiểu nghiệp vụ: ChargePoint, Connector, Session… | `src/domain/` |
| Client REST sinh từ OpenAPI — không sửa tay | `src/api/generated/` |
| Tên sự kiện và payload realtime (mục 4.3) | `src/realtime/` |

### 4.1. Với WP5 — kết nối simulator

| Thông số | Giá trị |
|---|---|
| Endpoint dev | `ws://localhost:9000/ocpp/{serialNumber}` |
| Endpoint staging | `wss://{host}/ocpp/{serialNumber}` |
| Subprotocol | `ocpp1.6` |
| Xác thực | Basic Auth — username = `serialNumber`, password = mật khẩu cấp lúc onboarding. Dev tắt được xác thực bằng biến môi trường |
| Template trụ | 2 connector DC, gửi `SoC`, `Voltage`, `Current.Import`, `Power.Active.Import`, `Energy.Active.Import.Register` |
| Heartbeat | CSMS trả `interval = 300` giây trong `BootNotification.conf` — khớp `OCPP_HEARTBEAT_INTERVAL_SECONDS` |

### 4.2. Với WP3 và WP4 — REST API

Tiền tố `/api/v1`, cổng `3000`. Xác thực người dùng bằng JWT (`JWT_SECRET` trong `infra/.env.example`).

| Phương thức | Đường dẫn | Mục đích | Dùng bởi |
|---|---|---|---|
| `GET` | `/stations` | Danh sách trụ kèm trạng thái từng súng | WP3, WP4 |
| `GET` | `/stations/{id}` | Chi tiết một trụ | WP3, WP4 |
| `POST` | `/stations` | Onboarding: nhận SN, trả mật khẩu **hiện một lần duy nhất** | WP4 |
| `POST` | `/stations/{id}/commands` | Gửi lệnh `remote-start` / `remote-stop` / `reset` / `unlock` → **trả `202` + `commandId`** | WP3, WP4 |
| `GET` | `/commands/{commandId}` | Tra trạng thái lệnh | WP3, WP4 |
| `POST` | `/sessions/qr` | App quét QR trên màn hình trụ → xác định trụ và súng, gửi remote start | WP3 |
| `GET` | `/transactions/{id}` | Chi tiết giao dịch kèm chuỗi meter | WP3, WP4, WP5 |
| `GET` | `/transactions?stationId=&from=&to=` | Lịch sử giao dịch | WP3, WP4 |
| `GET` | `/ocpp-messages?serialNumber=&from=&to=` | **Trình xem bản tin OCPP thô** (FE-08) | WP4 |

**🚨 Lệnh điều khiển là bất đồng bộ — đừng chờ đồng bộ.** Khi dashboard bấm "Dừng sạc", CSMS gửi `RemoteStopTransaction` xuống trụ và chờ trụ trả lời — có thể mất tới 60 giây nếu trụ chậm hoặc mất kết nối. REST trả ngay `202 Accepted` kèm `commandId`, kết quả thật về sau qua sự kiện `command.result`. **WP3 và WP4 phải thiết kế giao diện có trạng thái "đang chờ trụ phản hồi".**

### 4.3. Với WP3 và WP4 — sự kiện realtime

Socket.IO tại `/realtime`. Client tham gia room `station:{id}` hoặc `transaction:{id}`.

| Sự kiện | Payload |
|---|---|
| `station.connection` | `{ stationId, online, at }` |
| `connector.status` | `{ stationId, connectorId, status, errorCode, at }` |
| `transaction.started` | `{ transactionId, stationId, connectorId, origin, paymentMode, meterStartWh, startedAt }` |
| `transaction.meter` | `{ transactionId, socPct, voltageV, currentA, powerW, energyWh, at }` |
| `transaction.stopped` | `{ transactionId, meterStopWh, reason, stoppedAt }` |
| `transaction.amended` | `{ transactionId, kind, changedFields, at }` |
| `command.result` | `{ commandId, status, detail }` — `status` là `Accepted`, `Rejected` hoặc `Timeout` |
| `alert.raised` | `{ stationId, connectorId, errorCode, severity, at }` |

`alert.raised` với `errorCode = "Offline"` phát ra khi trụ im lặng quá **900 giây** — khớp `OCPP_OFFLINE_THRESHOLD_SECONDS`.

**🚨 Hai quy tắc bắt buộc với client:**

1. **Sự kiện là gợi ý, REST là sự thật.** Kênh realtime có thể mất bản tin theo thiết kế (ADR-0006). Mỗi khi socket nối lại, client **phải gọi lại REST** để đồng bộ trạng thái. Đừng xây giao diện mà trạng thái chỉ đến từ sự kiện.
2. **Giao dịch đã kết thúc vẫn có thể thay đổi.** Khi engine đối soát phát hiện replay hoặc lỗ hổng meter, nó sửa giao dịch và phát `transaction.amended`. App phải cập nhật lại màn hình lịch sử; billing phải tính lại.

### 4.4. Với WP5 — billing

- Billing tính tiền khi nhận `transaction.stopped`
- **Phiên `paymentMode = station_wallet`: vẫn tính giá để đối soát, nhưng tuyệt đối không tạo lệnh thu qua VNPay** — trụ đã trừ tiền trên thẻ (ADR-0012)
- Phiên `unattributed` (free vend, hoặc thẻ lạ) không có người để thu tiền — đưa vào báo cáo doanh thu thành dòng riêng
- Billing **phải xử lý `transaction.amended`** — tính lại tiền và, nếu hoá đơn đã phát hành, sinh bản ghi điều chỉnh thay vì sửa hoá đơn cũ
- Billing đọc chuỗi `meter_values` qua repository của module `metering`, **không truy vấn thẳng bảng** — để WP2 đổi được cấu trúc partition mà không làm vỡ billing

---

## 5. NFR WP2 cam kết — đưa vào SRS

Chỉ ghi những con số đo được. Con số nào chưa có cơ sở thì ghi rõ là giả thuyết.

| Mã | Yêu cầu | Ngưỡng | Đo bằng |
|---|---|---|---|
| NFR-OCPP-01 | Thời gian CSMS trả lời một CALL từ trụ | ≤ 1 giây ở p95 | Metric `prom-client`, dưới tải k6 |
| NFR-OCPP-02 | Độ trễ từ lúc CSMS nhận bản tin tới lúc giao diện hiện thay đổi | ≤ 3 giây ở p95 | Timestamp đầu cuối trong e2e test |
| NFR-OCPP-03 | Bản tin giao dịch mà CSMS đã trả `CALLRESULT` thì không bao giờ mất | 0 bản tin mất | **Thí nghiệm ablation** — đối chiếu log simulator với `ocpp_message_log` |
| NFR-OCPP-04 | Trụ nối lại cùng identity thay thế phiên cũ | Trong vòng 1 chu kỳ ping WebSocket (30 giây) | Kịch bản e2e ngắt–nối |
| NFR-OCPP-05 | Số trụ đồng thời chịu được | **Giả thuyết ≥ 100** trên 1 vCPU / 2 GB — xác nhận hoặc điều chỉnh sau lần đo baseline đầu tiên ở S3 | k6 trong `infra/k6/` |
| NFR-OCPP-06 | Kết nối trụ được mã hoá | 100% qua WSS, Security Profile 2 | Cấu hình Caddy, kiểm tra ở staging |
| NFR-OCPP-07 | Phát hiện trụ mất kết nối | Cảnh báo trong ≤ 900 giây kể từ bản tin cuối | Kịch bản e2e tắt simulator |

> **Về NFR-OCPP-05:** đừng cam kết con số tải trong SRS trước khi đo. Ghi là giả thuyết, đo ở S3, rồi cập nhật SRS. Hội đồng đánh giá cao NFR được xác nhận bằng đo đạc hơn là một con số đẹp tự đặt ra.

---

## 6. Việc cần chốt trong S2

| Việc | Ai quyết | Nếu không chốt được |
|---|---|---|
| Chấp nhận 11 ADR đề xuất và tách thành file trong `docs/adr/` | WP1 + WP2 | Giữ trạng thái *Đề xuất*, BE-02 vẫn làm theo nhưng ghi rủi ro |
| **Chốt ADR-0012:** mô hình hoá thẻ ví trong CSMS, hay tắt thẻ ví và free vend trong cấu hình trụ | WP2 + WP5, WP1 ghi nhận | Mặc định mô hình hoá theo ADR-0012 — rẻ, và chặn được lỗi thu tiền hai lần |
| Hỏi hãng Ruihua ba câu hỏi mở của ADR-0012 | WP1 — qua GVHD hoặc doanh nghiệp | Phân loại theo sổ đăng ký thẻ, ghi phần còn thiếu thành giới hạn nghiên cứu |
| Drizzle ORM | WP2 + WP5 | WP5 có quyền phủ quyết vì dùng chung |
| Nơi chạy staging | WP1 hỏi GVHD — mục 2.5 trong agenda | Tự thuê VPS |
| Nâng `engines.node` lên `>=24`, ghim CI về `postgres:16.4-alpine` | WP2 | Không chặn gì, nhưng để lâu sẽ lệch môi trường |

---

## 7. Thay đổi kéo theo khi ADR được chấp nhận

| Chỗ | Thay đổi |
|---|---|
| BE-02 | Dùng `ocpp-rpc` thay vì tự viết tầng RPC. Bổ sung: tuần tự hoá chiều vào theo từng trụ, đóng phiên cũ khi trụ nối lại cùng identity |
| BE-07 | Nền móng là ràng buộc idempotency của ADR-0010 và bảng `reconciliation_records` |
| BE-08 | Redis pub/sub **chỉ cho giao diện** — ADR-0006 |
| FE-08 | Đọc từ `ocpp_message_log` qua `GET /ocpp-messages` — có sẵn nhờ ADR-0005 |
| `apps/csms/README.md` | Sửa dòng BE-08; bổ sung `ocpp-rpc` vào hàng Stack |
| `packages/shared/README.md` | Sửa mô tả thư mục `realtime/` theo ADR-0006 |
| `docs/adr/README.md` | Thêm 11 dòng ADR-0002 → ADR-0012 vào bảng chỉ mục |
| Kế hoạch mục 1.3 và `apps/csms/README.md` | Thu hẹp "CSMS là nguồn sự thật cho hoá đơn" thành "nguồn sự thật cho bản ghi phiên và bản tính giá; phiên thẻ ví do trụ thu tiền" — ADR-0012 |
| `docs/AGENDA-GAP-GVHD.md` — mục tên hãng | Đã có câu trả lời: **Jiangxi Ruihua Intelligent Technology Co., Ltd.**, theo manual D1 |
| `simulator/README.md` | WP5 mô phỏng thêm phiên thẻ ví và phiên free vend bằng các `idTag` riêng |

---

*Tài liệu thuộc kế hoạch PowerMe 13 tuần. Thông tin `ocpp-rpc` kiểm chứng trực tiếp từ mã nguồn tại github.com/mikuso/ocpp-rpc ngày 11/09/2026. Cấu hình đã ghim đối chiếu với `.nvmrc`, `infra/docker-compose.yml`, `infra/.env.example` và `.github/workflows/ci.yml` tại commit `b3f2faf`. Hành vi phần cứng đối chiếu với manual gốc D1 (Jiangxi Ruihua, 02/2025) và YJ-EU trong thư mục Context của Drive dự án ngày 11/09/2026. Xem thêm NGHIEN-CUU-BO-SUNG-WP2.md và WP2-LO-TRINH-KY-THUAT.md.*
