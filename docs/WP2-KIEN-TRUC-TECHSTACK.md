# WP2 — Kiến trúc & Ngăn xếp công nghệ của CSMS

**Người đề xuất:** WP2 (Backend / IoT Integration Engineer)
**Người nhận:** WP1 — đưa vào SDD v1.0
**Cần chốt:** trong S2 (07/09 – 20/09/2026), trước khi BE-02 gộp vào `main`
**Liên quan:** WP3 (app), WP4 (dashboard), WP5 (simulator, billing) — mục 4 là hợp đồng giao tiếp với các bạn
**Kế thừa:** [ADR-0001 Monorepo npm workspaces](adr/0001-monorepo-npm-workspaces.md) · `CONTRIBUTING.md` · `infra/docker-compose.yml`
**Trạng thái:** Đề xuất — 11 quyết định đánh số ADR-0002 → ADR-0012
**Cập nhật 11/09/2026:** thêm ADR-0012 sau khi đối chiếu manual gốc của hãng — trụ có thẻ ví tự trừ tiền và chế độ free vend

---

## Tóm tắt cho WP1

**Kiểu kiến trúc:** *Modular monolith* — `apps/csms` chạy một tiến trình NestJS, bên trong chia module rõ ranh giới. **Không làm microservices.**

**Ngăn xếp** — những dòng ghi *đã ghim* là thứ nhóm đã commit, tài liệu này chỉ chính thức hoá:

| Lớp | Chọn | Phiên bản | Nguồn |
|---|---|---|---|
| Runtime | Node.js LTS | **24.18.1** | *đã ghim* — `.nvmrc`, CI |
| Ngôn ngữ | TypeScript, bật `strict` | 5.x | |
| Framework | NestJS | 11 | *đã chọn* — `README.md` |
| Tầng vận chuyển OCPP-J | **ocpp-rpc** (MIT) | **2.2.1** — ghim cứng, không `^`/`~`; npm chưa có 3.x, bản 3.0.0 sắp tới là ESM breaking change | **mới — ADR-0004** |
| Cơ sở dữ liệu | PostgreSQL, partition gốc theo tháng | **16.4** | *đã ghim* — `infra/docker-compose.yml` |
| Cache, hàng đợi job | Redis + BullMQ | **7.4** | *đã ghim* — `infra/docker-compose.yml` |
| Realtime tới app và dashboard | Socket.IO + Redis adapter | 4.x | **mới — ADR-0006** |
| ORM | Drizzle ORM + migration SQL thuần | | **mới — chốt cùng WP5** |
| Log | pino, JSON có cấu trúc | | |
| Metrics | prom-client → Prometheus + Grafana | | |
| Test | Jest (mặc định NestJS) · tích hợp chạy trên service container PostgreSQL + Redis mà CI đã có · e2e bằng SAP simulator · tải bằng k6 trong `infra/k6/` | | |
| Reverse proxy, TLS | Caddy 2 | | **mới — ADR-0011** |
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
               │ /ocpp/* → cổng 3001          │ /api/*  → cổng 3000 │ /realtime
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

Cổng `3000` (HTTP) và `3001` (OCPP WebSocket) khớp `CSMS_HTTP_PORT` và `CSMS_OCPP_WS_PORT` trong `infra/.env.example`. Trên máy dev không cần Caddy — trụ ảo nối thẳng `ws://localhost:3001/ocpp/{serialNumber}`.

---

## 2. Các quyết định kiến trúc đề xuất

Đánh số tiếp theo [ADR-0001](adr/0001-monorepo-npm-workspaces.md). Theo quy ước của `docs/adr/README.md`, **sau khi nhóm chấp nhận, mỗi quyết định được tách thành một file riêng** `docs/adr/NNNN-ten-quyet-dinh.md` theo `_template.md`. Tài liệu này là bản gom để review một lần.

### ADR-0002 · Modular monolith, không làm microservices

**Quyết định:** `apps/csms` là một tiến trình NestJS. Module `ocpp-gateway` có ranh giới rõ ràng để sau này tách được thành dịch vụ riêng.

**Lý do:** 13 tuần, hai người làm backend (WP2 + WP5). Gỡ lỗi một hệ phân tán — mất bản tin giữa các dịch vụ, lệch phiên bản hợp đồng, theo dõi request xuyên dịch vụ — sẽ nuốt trọn lịch. Và nó làm nhiễu thí nghiệm: nếu dữ liệu mất, không biết mất ở tầng OCPP hay ở message broker giữa các dịch vụ.

**Hệ quả:** chưa scale ngang được tầng kết nối WebSocket. Scale ngang cần sticky routing theo `serialNumber` cộng một registry ghi nhận trụ nào đang nối vào instance nào — **ghi vào chương hướng phát triển**.

**Phương án bị loại:** tách gateway và core thành hai dịch vụ nối qua message broker, theo kiểu CitrineOS. Đúng khi quy mô lớn, quá đắt cho 13 tuần.

### ADR-0003 · Node.js 24 LTS + TypeScript

**Quyết định:** Node.js 24 LTS, TypeScript `strict`. Chính thức hoá trạng thái đã có: `.nvmrc` ghim `24.18.1`, CI chạy `NODE_VERSION: '24'`.

**Lý do:**
- OCPP-J là WebSocket + JSON — đúng sở trường của Node
- Thư viện tầng vận chuyển tốt nhất tìm được (`ocpp-rpc`) là Node
- SAP simulator mà WP5 phải patch viết bằng TypeScript — **cùng ngôn ngữ**, WP2 đọc và hỗ trợ patch được
- Ba đầu ra dùng chung kiểu dữ liệu qua `packages/shared` — điều kiện tiên quyết của ADR-0001

**Lưu ý nhỏ:** `package.json` gốc khai báo `engines.node >= 22.0.0`, trong khi `.nvmrc` và CI dùng 24. Không lỗi, nhưng nên nâng `engines` lên `>=24` để khỏi có người chạy Node 22 rồi gặp khác biệt.

**Phương án bị loại:**
- *Java / Spring Boot* — hợp lý nếu bám SteVe, nhưng phá vỡ việc dùng chung kiểu dữ liệu của ADR-0001.
- *Go / ocpp-go* — README không hề đề cập hành vi offline hay configuration key liên quan; nhóm không dùng Go.

### ADR-0004 · Dùng `ocpp-rpc` cho tầng vận chuyển OCPP-J

**Quyết định:** không tự viết tầng RPC-over-WebSocket. Dùng `ocpp-rpc@2.2.1` (MIT), ghim cứng. Trên npm chưa có 3.x (kiểm 12/09/2026); 3.0.0 đang phát triển là ESM breaking change nên không để `^` hay `~`. Thư viện một maintainer (235/241 commit) → vendor một bản copy trong repo làm dự phòng, MIT cho phép.

**Đã kiểm chứng trực tiếp từ mã nguồn ngày 11/09/2026** (commit gần nhất của thư viện: 10/08/2026):

| Yêu cầu của OCPP-J | `ocpp-rpc` xử lý thế nào |
|---|---|
| Mỗi chiều chỉ một CALL đang chờ | `callConcurrency` **mặc định = 1**. Chú thích trong code: *"OCPP requires this to be set to 1"*. CALL dư được xếp hàng |
| Định danh trụ nằm trên URL | Server lấy đoạn cuối của đường dẫn làm `identity` |
| Basic Auth theo Security Profile 1 và 2 | Server tự parse header `Authorization` với username = identity, đưa `password` vào callback `auth` |
| Thoả thuận subprotocol | Tuỳ chọn `protocols`, ghi đè được trong callback `auth` |
| Validate bản tin theo schema OCA | `strictMode`, có sẵn schema OCA cho `ocpp1.6`, `ocpp2.0.1`, `ocpp2.1` |
| Timeout cho CALL | `callTimeoutMs` mặc định 60 000 ms |
| WebSocket ping/pong — khác với OCPP Heartbeat | `pingIntervalMs` mặc định 30 000 ms, tự ngắt kết nối chết |
| Không lộ stack trace ra ngoài | `respondWithDetailedErrors` mặc định `false` |

**Yêu cầu hệ thống:** Node.js ≥ 20. Phụ thuộc: `ws`, `ajv`, `backoff`.

**⚠️ Ba điều thư viện KHÔNG làm — WP2 phải tự làm:**

1. **Không giới hạn đồng thời cho CALL chiều vào.** Trụ tuân thủ spec sẽ không gửi dồn, nhưng **đừng dựa vào điều đó** — trụ đang replay hàng đợi offline hoặc trụ lỗi firmware có thể gửi dồn. Nếu handler chạy song song, bản ghi vào DB sai thứ tự và làm hỏng chính dữ liệu mà engine đối soát dựa vào. **WP2 phải tuần tự hoá xử lý chiều vào theo từng trụ.**
2. **Không xử lý trụ nối lại với cùng identity** khi kết nối cũ còn treo. WP2 phải chủ động đóng phiên cũ khi phiên mới cùng identity được xác thực.
3. **Không có logic nghiệp vụ OCPP nào** — không state machine, không giao dịch, không đối soát. Đó vẫn nguyên là phần việc của đồ án.

**⚠️ Bẫy giấy phép:** thư viện là MIT, nhưng **các file JSON schema của OCA đi kèm theo giấy phép CC BY-ND 4.0** (không phái sinh). Dùng nguyên văn, **không sửa đổi**. Ghi điều này vào SDD.

### ADR-0005 · Nhật ký bản tin OCPP ghi trước, chỉ thêm không sửa

**Quyết định:** mọi frame OCPP — cả chiều vào lẫn chiều ra — được ghi vào bảng `ocpp_message_log` **trước khi** xử lý nghiệp vụ. Bảng chỉ INSERT, không UPDATE, không DELETE, trừ việc xoá partition cũ theo chính sách lưu trữ.

**Lý do — một quyết định, bốn lợi ích:**
1. **Bền vững:** không có đường nào để mất bản tin trong bộ nhớ. Tiến trình sập ngay sau khi nhận, bản tin vẫn nằm trong DB
2. **Ground truth cho thí nghiệm:** so trực tiếp "simulator đã gửi gì" với "CSMS đã nhận gì" — đây chính là cách đo tỉ lệ mất dữ liệu
3. **Trình xem bản tin OCPP thô (FE-08) có sẵn** cho WP4
4. **Chứng cứ cho định nghĩa hoàn thành:** `CONTRIBUTING.md` yêu cầu mọi task chạm giao thức OCPP phải đính kèm log bản tin thật trong PR — bảng này sinh ra log đó

**Hệ quả:** thêm một lệnh INSERT cho mỗi bản tin, cỡ vài mili giây, thừa thãi so với timeout 60 giây. Bảng tăng rất nhanh → bắt buộc partition theo tháng (ADR-0007).

### ADR-0006 · 🚨 KHÔNG dùng Redis pub/sub trên đường đi của giao dịch

**Quyết định:** Redis pub/sub chỉ được dùng cho fanout realtime tới giao diện. **Tuyệt đối không** dùng nó để chuyển sự kiện giao dịch giữa các module.

**Lý do:** pub/sub là *bắn rồi quên*. Subscriber nào đang tắt hoặc đang khởi động lại thì **mất bản tin vĩnh viễn**. Đặt nó trên đường đi của giao dịch, chính CSMS của nhóm sẽ tự gây ra đúng loại mất dữ liệu mà đề tài đang đo — và làm bẩn toàn bộ kết quả thí nghiệm.

| Đường đi | Cơ chế | Mất có chấp nhận được không |
|---|---|---|
| Trụ → xử lý nghiệp vụ → DB | Gọi hàm trong tiến trình, sau khi đã ghi `ocpp_message_log` | ❌ **Không bao giờ** |
| Công việc nền: đối soát, sinh hoá đơn | BullMQ — có lưu bền, có retry | ❌ Không |
| CSMS → app và dashboard | Socket.IO qua Redis adapter, dùng pub/sub | ✅ Được — client gọi lại REST |

**Hệ quả với tài liệu đã commit:** hai file đang mô tả pub/sub mà chưa kèm giới hạn này, cần sửa khi ADR được chấp nhận:
- `apps/csms/README.md` — dòng BE-08 "Fanout realtime qua Redis pub/sub"
- `packages/shared/README.md` — thư mục `realtime/` "Tên kênh và payload của luồng Redis pub/sub"

### ADR-0007 · PostgreSQL 16.4 với partition gốc, không dùng TimescaleDB

**Quyết định:** giữ PostgreSQL 16.4 đã ghim. `meter_values` và `ocpp_message_log` dùng declarative partitioning theo tháng. Không cài extension TimescaleDB.

**Lý do:** partition gốc đã có từ lâu, 16.4 đủ dùng — **không cần nâng phiên bản**, nên không phải viết ADR đổi bảng ghim trong `infra/README.md`. Quy mô đồ án, kể cả load test, nằm gọn trong khả năng của partition gốc. TimescaleDB thêm một extension phải vận hành, và một số tính năng của nó theo giấy phép riêng chứ không phải Apache.

**Hệ quả:** partition phải được tạo trước. Một job BullMQ chạy hằng tháng tạo partition cho tháng kế tiếp.

**Lưu ý nhỏ:** CI dùng `postgres:16-alpine`, còn `docker-compose` ghim `16.4-alpine`. Nên ghim CI về cùng `16.4-alpine` để test và dev chạy đúng một phiên bản.

### ADR-0008 · Drizzle ORM + migration SQL thuần — *chốt cùng WP5*

**Quyết định đề xuất:** Drizzle ORM cho truy vấn, migration viết bằng SQL.

**Lý do:** bảng partition, ràng buộc unique phục vụ idempotency, bảng append-only — **ORM nào cũng phải viết bằng SQL tay** cho mấy thứ này. Nên chọn ORM không cản trở việc viết SQL mà vẫn cho type-safety.

**Cần WP5 đồng ý** vì billing, payments, invoicing dùng chung DB và chung ORM.

### ADR-0009 · Quy ước dữ liệu

| Loại dữ liệu | Quy ước | Vì sao |
|---|---|---|
| **Thời gian** | `timestamptz`, lưu UTC, chuyển sang `Asia/Ho_Chi_Minh` chỉ khi hiển thị | Tránh lỗi lệch múi giờ khi so sánh timestamp của trụ |
| **Hai thời điểm mỗi bản tin** | `cp_timestamp` — lấy từ payload, **không tin cậy**<br>`received_at` — đồng hồ CSMS, **tin cậy** | Đồng hồ trụ có thể sai. **Chênh lệch giữa hai giá trị là tín hiệu chính để phát hiện replay** |
| **Điện năng** | Wh, `bigint` | `meterStart`/`meterStop` trong OCPP là Wh. Nhầm sang kWh là sai hoá đơn 1000 lần |
| **Tiền** | VND, `bigint` | Không có lỗi làm tròn số thực |
| **Connector** | `1` súng A · `2` súng B · `0` toàn trụ | Khớp SRS phần cứng và OCPP 1.6 |
| **Định danh kỹ thuật của trụ** | **Số serial (SN)** của trụ, xuất hiện ở đoạn cuối URL `/ocpp/{serialNumber}` | SRS phần cứng §6: kỹ thuật viên gõ Server URL, Port **và SN** trên HMI. Khớp `CSMS_OCPP_PATH_PREFIX` trong `infra/.env.example` |
| **Mã hiển thị của trụ** | Cột riêng `display_code` dạng `PM-{model}-{tỉnh}-{số thứ tự}`, ví dụ `PM-D1-HCM-0001` | Người vận hành đọc mã này, không đọc SN. **Tách khỏi định danh kỹ thuật** để đổi tên site mà không phải cấu hình lại trụ |
| **Phiên bắt đầu bằng cách nào** | `origin`: `app` · `rfid_online` · `rfid_wallet` · `hmi_password` · `free_vend` | Manual gốc có năm cách khởi động phiên — ADR-0012 |
| **Ai thu tiền** | `payment_mode`: `csms_billed` · `station_wallet` · `unattributed` | Tách khỏi `origin`: cùng là quẹt thẻ, nhưng thẻ xác thực và thẻ ví trả tiền ở hai nơi khác nhau |
| **Đến trễ do offline** | `delivered_offline` kiểu boolean, do engine đối soát gán | **Không phải một loại nguồn gốc** — phiên nào cũng có thể bị trụ gửi bù sau khi nối lại |

### ADR-0010 · Idempotency của StartTransaction

**Quyết định:** ràng buộc unique trên khoá tự nhiên
`(charge_point_id, connector_id, id_tag, meter_start_wh, cp_timestamp)`.
Khi trụ gửi lại cùng một `StartTransaction`, CSMS trả về **đúng `transactionId` cũ** thay vì tạo giao dịch mới.

**Lý do:** lúc trụ gửi `StartTransaction` thì `transactionId` chưa tồn tại — CSMS mới là bên sinh ra nó — nên không dùng nó làm khoá chống trùng được. Trụ gửi lại khi mất `CALLRESULT` hoặc khi replay hàng đợi offline. Không idempotent thì một phiên sạc thành hai giao dịch và bị tính tiền hai lần. **Đây là bug kinh điển nhất của CSMS tự xây, và là nền móng của BE-07.**

### ADR-0011 · Bảo mật OCPP: Security Profile 2

**Quyết định:** TLS + Basic Auth riêng cho từng trụ. TLS kết thúc tại Caddy, chứng chỉ tự động. Mật khẩu từng trụ sinh lúc onboarding, **chỉ hiển thị một lần**, lưu dạng băm argon2.

**Lý do:** khớp NFR đã đăng ký "OCPP-J over TLS". `ocpp-rpc` đã hỗ trợ sẵn phần Basic Auth.

**Phương án bị loại:** Security Profile 3 — chứng chỉ phía client, cần dựng PKI. Quá đắt cho 13 tuần, ghi vào hướng phát triển.

### ADR-0012 · Phiên sạc bằng thẻ ví và free vend — *cần cả nhóm chốt*

**Bối cảnh — bản SRS tóm tắt đã bỏ sót, chỉ manual gốc của hãng mới có:**

| Nguồn | Nội dung |
|---|---|
| Manual D1, bản 02/2025, nhà sản xuất **Jiangxi Ruihua Intelligent Technology Co., Ltd.** — mục 3.4 *Offline model charging process* | Bật **"Wallet ID card"** thì dùng được thẻ tính tiền. Bật **"Online IDcard"** thì dùng thẻ xác thực. Chế độ **mật khẩu** lấy mật khẩu từ cài đặt nền của trụ. Nếu cài đặt nền bật **"plug-and-charge"**, phiên sạc bắt đầu ngay khi cắm súng |
| Manual D1 — quy trình quẹt thẻ | Màn hình *"Billing Interface & RFID Card Balance"* — trụ hiển thị số dư trên thẻ |
| Manual YJ-EU — quy trình sạc bằng thẻ | Bước *"Check IC Card Balance"* |
| Manual D1 — bảng thông số | Kết nối *"Ethernet / 4G router (option)"* · Cloud platform *"OCPP1.6J"* |

**⚠️ Bẫy thuật ngữ:** "plug-and-charge" trong manual Ruihua là một cài đặt của hãng — cắm súng là sạc, không xác thực. **Nó không phải Plug & Charge theo ISO 15118**, vốn là xác thực tự động bằng chứng thư số giữa xe và trụ. Trong code và báo cáo, gọi chế độ này là **free vend** để không bị hội đồng bắt lỗi.

**Vấn đề:**
- `StartTransaction` của OCPP 1.6 chỉ có `idTag`. **Không có trường nào cho biết phiên được trả bằng thẻ ví.** Manual cũng không mô tả trụ có gửi số dư hay số tiền đã trừ lên CSMS hay không.
- Nếu CSMS coi mọi phiên là phiên mình thu tiền, **khách dùng thẻ ví bị trừ tiền hai lần**: một lần trên thẻ, một lần qua VNPay.

**Quyết định đề xuất:**
1. Mỗi giao dịch mang hai thuộc tính tách biệt: `origin` (bắt đầu bằng cách nào) và `payment_mode` (ai thu tiền) — ADR-0009.
2. CSMS phân loại thẻ bằng **sổ đăng ký thẻ** `id_tags`. Người vận hành là bên phát hành thẻ, nên biết thẻ nào là thẻ ví, thẻ nào là thẻ xác thực.
3. Phiên free vend nhận diện qua `free_vend_id_tag` cấu hình riêng cho từng trụ → `payment_mode = unattributed`.
4. Phiên `station_wallet`: CSMS **vẫn tính giá** từ `MeterValues` để đối soát, nhưng **không bao giờ** tạo lệnh thu qua cổng thanh toán.
5. `StartTransaction` mang `idTag` không có trong sổ — thường là phiên đã diễn ra khi trụ offline — vẫn được ghi nhận với `payment_mode = unattributed`, kèm một `reconciliation_records` loại `unknown_id_tag` cho người vận hành xử lý. **Không xoá, không bỏ qua phiên đã diễn ra.**

**Ngoài phạm vi 13 tuần** — ghi vào hướng phát triển: phát hành thẻ, nạp tiền thẻ ví, quản lý số dư thẻ phía CSMS.

**Ba câu hỏi mở — chỉ hãng hoặc trụ thật trả lời được, simulator thì không:**
1. Khi dùng thẻ ví, trụ có gửi số tiền đã trừ hoặc số dư thẻ lên CSMS không — qua `DataTransfer` hay trường nào?
2. Phiên free vend gửi `idTag` giá trị gì?
3. Mật khẩu của chế độ mật khẩu đặt ở đâu, và có đồng bộ lên CSMS không?

**Hệ quả:**

**Được:**
- Không thu tiền hai lần.
- Báo cáo doanh thu tách được theo hình thức thanh toán.
- Thí nghiệm có thêm một kịch bản offline có thật, dẫn nguồn được: phiên thẻ ví bắt đầu khi router 4G của trụ mất sóng.

**Mất:**
- Nguyên tắc "CSMS là nguồn sự thật cho hoá đơn" phải **thu hẹp** thành "nguồn sự thật cho bản ghi phiên và bản tính giá". Tiền của phiên thẻ ví do trụ thu.
- Nếu câu hỏi mở 1 có câu trả lời "không", CSMS **không đối chiếu được** số tiền trừ trên thẻ — chỉ đối chiếu được bản tính của mình với dữ liệu đo của trụ. Ghi thành giới hạn nghiên cứu.
- Hoá đơn VAT của phiên thẻ ví xuất lúc nạp thẻ hay lúc sạc là câu hỏi pháp lý — chuyển cho WP5.

**Các phương án đã cân nhắc và loại bỏ:**

| Phương án | Vì sao loại |
|---|---|
| Coi mọi phiên là CSMS thu tiền | Khách dùng thẻ ví bị trừ tiền hai lần |
| Tắt Wallet ID card và free vend trong cấu hình trụ | Đơn giản nhất, nhưng bỏ đi đúng tình huống offline mà đề tài nghiên cứu, trong khi người vận hành thật cần thẻ ví khi mạng 4G yếu. **Giữ làm phương án dự phòng** nếu S5 trễ tiến độ |
| Nhận diện thẻ ví qua `DataTransfer` riêng của hãng | Chưa biết hãng có gửi hay không — phụ thuộc câu hỏi mở 1. Có thể bổ sung sau, không dùng làm nền |

---

## 3. Mô hình dữ liệu WP2 sở hữu

WP1 vẽ ERD từ danh sách này. Chỉ liệt kê cột quan trọng.

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
| Endpoint dev | `ws://localhost:3001/ocpp/{serialNumber}` |
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
