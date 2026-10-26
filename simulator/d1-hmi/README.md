# Trụ giả lập D1 có màn hình HMI bấm được (QA-01)

Trụ sạc DC 120 kW hai súng chạy bằng Node thuần, có giao diện HMI trên trình duyệt để **tương tác trực tiếp** khi demo: cắm/rút súng, quẹt thẻ, nhập mật khẩu, chọn chế độ sạc, rớt mạng, gây lỗi, khởi động lại — và xem nhật ký OCPP chạy trực tiếp. Mục đích: cho CSMS một "trụ" có thể bấm được trước hội đồng, với hành vi bám quan sát thật (EXP-01) thay vì kịch bản cố định.

> **Mô phỏng — hành vi chưa xác nhận bằng firmware Ruihua.** Mọi chỗ trụ "làm gì khi..." mà manual hãng im lặng đều là lựa chọn của chúng tôi, liệt kê ở bảng giả định bên dưới.

## Chạy

Chỉ cần Node 24 và `ocpp-rpc` đã có trong `node_modules` (`npm ci` ở gốc repo). Không Docker, không build.

```bash
node simulator/d1-hmi/server.mjs
# mở http://127.0.0.1:8100
```

| Biến môi trường | Mặc định | Ý nghĩa |
|---|---|---|
| `CSMS_URL` | `ws://localhost:9000/ocpp` | Endpoint CSMS (identity được nối vào cuối đường dẫn) |
| `CP_ID` | `RH24D1-00001` | Identity của trụ |
| `HMI_PORT` | `8100` | Cổng HMI (chỉ nghe `127.0.0.1`) |
| `STALE_METERSTOP` | tắt | `1` = sau một lần rớt mạng, `StopTransaction` mang `meterStop` **cũ** (chỉ số lúc rớt) dù trụ vẫn sạc tiếp — tái hiện hiện tượng 3 của EXP-01 để CSMS ra phiên `review`. `npm run demo` của CSMS bật sẵn (`STALE_METERSTOP=0` để tắt) |
| `RETRY_MS` `REPLAY_LOSS` `METER_INTERVAL` `PING_SEC` `REBOOT_MS` `SPEED` | 30000 / 0.25 / 10 / 30 / 3000 / 1 | Chủ yếu cho kiểm thử; xem đầu `server.mjs` |

Để CSMS chấp nhận, cần có sẵn trụ `RH24D1-00001` và các `idTag` mẫu: `DEMO-CARD-0001` (thẻ hợp lệ), `DEMO-WALLET-0001` (thẻ ví). `DEMO-UNKNOWN-999` cố tình không đăng ký. Mật khẩu HMI mẫu: `123456` (giả).

## Kiểm thử

```bash
node simulator/d1-hmi/smoke.mjs
```

Dựng một CSMS ocpp-rpc tối thiểu trong chính script, chạy `server.mjs` trỏ vào đó, điều khiển qua HTTP như HMI thật và khẳng định chuỗi bản tin OCPP (Boot → Status ×3 → Authorize → Start → MeterValues → rớt mạng → nối lại không Boot → phát bù với timestamp cũ → RemoteStop/Stop → lỗi → half-open → reboot). In PASS/FAIL từng dòng, exit code ≠ 0 nếu có FAIL. Không nằm trong CI.

## Cấu trúc

| File | Việc |
|---|---|
| `station.mjs` | Trạng thái súng, mô hình điện, client OCPP, hàng đợi buffer, kết nối lại, snapshot cho HMI |
| `ocpp-commands.mjs` | Lệnh CSMS → trụ (RemoteStart/Stop, Trigger, Reset, Config, ...) |
| `hmi-actions.mjs` | Lệnh người dùng bấm trên HMI |
| `model.mjs` | Hằng số, 9 trạng thái OCPP, thẻ mẫu, đường công suất, rút gọn payload |
| `server.mjs` | HTTP + SSE; `POST /api/<hành động>` |
| `public/index.html` | HMI (CSS/JS inline, sáng/tối theo hệ thống, nút "Chữ lớn" cho máy chiếu) + khung SVG của hình trụ |
| `public/tru-sac.css`, `public/tru-sac.js` | Hình trụ sạc minh hoạ có hoạt ảnh (QA-02); phục vụ qua `GET /static/<tên>.css\|js` (chỉ tên file đơn trong `public/`, `..` và gạch chéo bị 404) |
| `smoke.mjs` | Kiểm thử chuỗi bản tin |
| `docs/` | Ảnh chụp HMI |

## Hình trụ sạc minh hoạ (QA-02)

Đầu trang HMI có khối **"Trụ sạc PowerMe"**: hình SVG tự vẽ (không logo/ảnh/kiểu dáng của hãng nào) để người xem hội đồng thấy trạng thái trụ mà không phải đọc số. Dòng chú thích cố định dưới hình: *"Hình minh hoạ — không phải ảnh sản phẩm thật"*. Hình **chỉ phản ánh** — dùng đúng snapshot SSE mà hai panel súng đang dùng (`connectors[]`, `net`, `queue`, `speed`, `cpId`), không có nguồn dữ liệu thứ hai và không điều khiển gì.

Hình có: thân trụ + màn hình LCD (mỗi súng một nửa: kW, SoC, thời gian, tiền tạm tính khi sạc; "Sẵn sàng — quẹt thẻ hoặc quét QR"; "Cắm súng vào xe"; "Rút súng"; mã lỗi; dải trên cùng báo "Mất kết nối — thử lại sau N s"), hai khay súng A/B có **đèn viền**, dây cáp, xe điện trượt vào khi súng được cắm với **thanh pin đổ theo SoC thật**, ăng-ten (xanh = online, vàng = đang nối, xám gạch chéo đỏ = mất kết nối), bong bóng số bản tin chờ phát bù khi hàng đợi buffer > 0, và nhịp "Phát bù N bản tin → CSMS" (gói nhỏ bay đi) khi hàng đợi về 0 sau khi nối lại.

| Trạng thái OCPP | Đèn viền | Kiểu | Nhãn trên hình |
|---|---|---|---|
| `Available` | xanh lá | tĩnh | Sẵn sàng |
| `Preparing` | xanh dương | nhấp nháy chậm (2 s) | Chuẩn bị |
| `Charging` | xanh lá | "thở" (3 s); chấm chạy dọc cáp | Đang sạc |
| `SuspendedEV` | hổ phách | nháy đều 1,6 s | Tạm dừng · **xe tạm dừng** |
| `SuspendedEVSE` | hổ phách | xung đôi rồi nghỉ (2 s) | Tạm dừng · **trụ tạm dừng** |
| `Finishing` | tím | tĩnh | Kết thúc |
| `Faulted` | đỏ | nháy nhanh (0,5 s) | Lỗi (+ mã lỗi trên LCD) |
| `Unavailable` | xám | tĩnh | Ngừng |
| `Reserved` | lục lam | tĩnh | Đặt trước |

Chấm chạy trên cáp có tốc độ tỉ lệ công suất (`6 + 0,5·kW` đơn vị/giây); khi bấm "Tăng tốc ×10" nhanh gấp đôi (không gấp 10 để mắt còn theo được). Hiện HMI chưa có đường vào `SuspendedEV`, `SuspendedEVSE`, `Reserved` (xem "Chưa làm") nên ba kiểu đèn đó chỉ kiểm bằng dữ liệu giả đưa thẳng vào hàm vẽ, chưa kiểm bằng HMI thật.

**Tắt hoạt ảnh:** nút **"Tắt hoạt ảnh"** ở góc khối (nhớ trong `localStorage`; thêm `?anim=off` vào URL để tắt riêng lần mở đó); hoặc đặt "giảm chuyển động" trong hệ điều hành (`prefers-reduced-motion: reduce` — hình tự tắt hoạt ảnh và khoá nút). Khi tắt, màu đèn và chữ vẫn giữ, chỉ mất chuyển động (xe hiện ngay, đèn sáng liên tục; hai kiểu "tạm dừng" chỉ còn phân biệt bằng nhãn chữ). Nút **"Thu gọn"** gập khối lại (cũng được nhớ). Nút "Chữ lớn" phóng to cả hình. Dưới 700 px bố cục về một cột.

Ảnh chụp thật (Edge headless, 1500×1000, nối vào CSMS giả tối thiểu, lái bằng API): [`docs/tru-san-sang.png`](docs/tru-san-sang.png), [`docs/tru-dang-sac-hai-sung.png`](docs/tru-dang-sac-hai-sung.png) (và `...-khung2.png`, cách khung đầu 0,4 s để thấy chấm trên cáp dịch chỗ), [`docs/tru-rot-mang.png`](docs/tru-rot-mang.png), [`docs/tru-phat-bu.png`](docs/tru-phat-bu.png), [`docs/tru-loi-sung.png`](docs/tru-loi-sung.png), [`docs/tru-finishing.png`](docs/tru-finishing.png). Ảnh tĩnh không chứng minh được chuyển động; xem trực tiếp trên trình duyệt.

## Mô hình rớt mạng — từ MỘT lần quan sát trên SAP, không phải firmware thật

Nút "Rớt mạng" bám [EXP-01](../../apps/csms/lab/EXP-01-ngat-ket-noi-81s.md) (chạy một lần, trên simulator SAP v4.12.0):

- Thử nối lại **cố định mỗi 30 s**, không backoff.
- Trong lúc offline, MeterValues / StartTransaction / StopTransaction / StatusNotification vào hàng đợi, **giữ timestamp gốc**.
- Nối lại **không gửi BootNotification**; socket mới = epoch mới.
- Phát bù: bản tin trạng thái/giao dịch trước, **MeterValues cũ sau** (đến sau StopTransaction — sai thứ tự như EXP-01). Mặc định bỏ 25 % mẫu im lặng (EXP-01: 8 buffer, 6 phát lại).
- Điểm **khác** EXP-01 có chủ đích: mặc định `meterStop` khớp với chỉ số tại lúc dừng. EXP-01 thấy `meterStop` cũ trong khi MeterValues live vẫn tăng, nhiều khả năng là đặc thù SAP (đã ghi trong EXP-01). Muốn tái hiện lỗi đó (demo phiên `review`) thì bật `STALE_METERSTOP=1`: phiên nào đã sống qua một lần rớt mạng sẽ dừng với `meterStop` = chỉ số lúc rớt. Đây là **lựa chọn của chúng tôi để dựng tình huống**, không phải hành vi đã xác nhận của firmware Ruihua.

"Rớt kiểu half-open" ngừng đọc/ghi socket nhưng không đóng; trụ chỉ phát hiện nhờ **ping timeout** (`WebSocketPingInterval`, mặc định 30 s → phát hiện sau 30–60 s), trong thời gian đó bản tin gửi đi mất trong im lặng rồi vào hàng đợi khi call quá 15 s.

Thời gian mô phỏng (nút "Tăng tốc ×10") chỉ nhân đồng hồ sạc và timestamp OCPP; thời gian mạng (rớt mạng, thử lại 30 s) luôn là giây thật.

## Giả định chưa xác nhận hãng

| # | Điểm | Chúng tôi chọn | Cần xác nhận |
|---|---|---|---|
| 1 | Thẻ ví trừ tiền offline | Offline, trụ chấp nhận thẻ hợp lệ + thẻ ví theo danh sách cục bộ (`DEMO-CARD`, `DEMO-WALLET`), từ chối thẻ lạ; không mô phỏng việc trừ tiền | Firmware có danh sách cục bộ / ví offline không, trừ tiền ở đâu |
| 2 | `idTag` của free vend (mật khẩu HMI) | `HMI-FREEVEND`, gửi thẳng `StartTransaction`, không `Authorize` | idTag thật (hoặc rỗng/mặc định), có Authorize không |
| 3 | Measurand thật trong MeterValues | `Energy.Active.Import.Register` (Wh), `SoC` (Percent), `Power.Active.Import` (W), `Voltage` (V), `Current.Import` (A) | Trụ Ruihua thật gửi measurand nào, đơn vị nào |
| 4 | Config key hỗ trợ | `HeartbeatInterval`, `MeterValueSampleInterval` (=10), `AuthorizeRemoteTxRequests`, `WebSocketPingInterval`, `ConnectionTimeOut`, `NumberOfConnectors`, `SupportedFeatureProfiles` (`Core,RemoteTrigger`), `ConnectorPhaseRotation` | Tập key thật; có `TransactionMessageAttempts`/`RetryInterval` không (SAP không có) |
| 5 | Wh số nguyên hay thập phân | Số nguyên Wh cho `meterStart`, `meterStop`, Energy.Active.Import.Register (SAP gửi thập phân, ví dụ 48.46) | Firmware thật |
| 6 | Hành vi retry buffer | Mô hình EXP-01 như trên, gồm cả StatusNotification vào buffer (EXP-01 không quan sát) | Firmware thật; số mẫu mất, thứ tự, giới hạn buffer |
| 7 | Reason khi pin đầy | `Other` (`EVDisconnected` dành cho rút súng giữa phiên; `Local` cho nút Dừng tại trụ) | Reason firmware thật gửi |
| 8 | Chia công suất hai súng | Chia đều 120 kW cho súng đang sạc; đường công suất giữ 100 % tới SoC 80 % rồi giảm tuyến tính còn 5 % ở 100 %; pin 75 kWh | Cách chia thật, đường cong thật |
| 9 | RemoteStart khi chưa cắm súng | `Accepted`, chờ `ConnectionTimeOut` (120 s) rồi mới `StartTransaction` khi cắm | Trụ thật có Accepted không hay Rejected |
| 10 | Chế độ sạc theo thời gian/kWh/tiền | Trụ không tự dừng, chỉ hiển thị "đã đạt hạn mức" và chờ RemoteStop (ràng buộc phần cứng #5) | Giới hạn thật nằm ở đâu |
| 11 | Sau dừng sạc | `Finishing` cho tới khi rút súng rồi mới `Available` | Trình tự trạng thái thật |

## Chưa làm

- ReserveNow / CancelReservation (trạng thái `Reserved` có trong bảng 9 chip nhưng trụ không tự vào trạng thái đó); `SuspendedEV`/`SuspendedEVSE` cũng chưa có đường vào.
- Các bản tin FirmwareManagement, LocalAuthList, SmartCharging: trả CALLERROR `NotImplemented`.
- Đồng hồ mô phỏng ×10 có thể đẩy timestamp vượt giờ thật của CSMS; CSMS nên xử lý như dữ liệu trụ (đồng hồ trụ không tin được, ADR-0009).
