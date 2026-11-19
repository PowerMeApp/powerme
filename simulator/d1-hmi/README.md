# Trụ giả lập D1 có màn hình HMI bấm được (QA-01)

Trụ sạc DC 120 kW hai súng chạy bằng Node thuần, có giao diện HMI trên trình duyệt để **tương tác trực tiếp** khi demo: cắm/rút súng, quẹt thẻ, nhập mật khẩu, chọn chế độ sạc, rớt mạng, gây lỗi, khởi động lại — và xem nhật ký OCPP chạy trực tiếp. Mục đích: cho CSMS một "trụ" có thể bấm được trước hội đồng, với hành vi bám quan sát thật (EXP-01) thay vì kịch bản cố định.

> **Mô phỏng — hành vi chưa xác nhận bằng firmware Ruihua.** Mọi chỗ trụ "làm gì khi..." mà manual hãng im lặng đều là lựa chọn của chúng tôi, liệt kê ở bảng giả định bên dưới.

## Chạy

Chỉ cần Node 24 và `ocpp-rpc` (+ `three` cho hình 3D) đã có trong `node_modules` (`npm ci` ở gốc repo). Không Docker, không build, không CDN.

```bash
node simulator/d1-hmi/server.mjs
# mở http://127.0.0.1:8100  → trang tổng; bấm "Mở trang trụ" → http://127.0.0.1:8100/tru/RH24D1-00001
```

**Nhiều trụ trong một tiến trình (QA-03):** mỗi trụ có client OCPP, đồng hồ, hàng đợi và tốc độ riêng.

```bash
CP_IDS=RH24D1-00001,RH24D1-00002 CP_PASSWORDS=pw1,pw2 node simulator/d1-hmi/server.mjs
```

`CP_PASSWORDS` theo đúng thứ tự `CP_IDS`; để trống một vị trí (`,pw2`) thì trụ đó không gửi Basic Auth. Có `CP_IDS` thì `CP_ID`/`CP_PASSWORD` bị bỏ qua; không có thì chạy một trụ như trước (`npm run demo` của CSMS, Dockerfile và staging vẫn dùng `CP_ID`). Identity chỉ được chứa chữ, số, `.`, `_`, `-` (nằm trong URL). Trụ phải được khai báo ở CSMS mới được nhận: seed demo chỉ có `RH24D1-00001`, nên trụ thứ hai sẽ hiện **OFFLINE** (CSMS từ chối bắt tay) cho tới khi được onboard.

| Biến môi trường | Mặc định | Ý nghĩa |
|---|---|---|
| `CSMS_URL` | `ws://localhost:9000/ocpp` | Endpoint CSMS (identity được nối vào cuối đường dẫn) |
| `CP_ID` | `RH24D1-00001` | Identity của trụ (chế độ một trụ) |
| `CP_IDS` / `CP_PASSWORDS` | (không) | Nhiều trụ: danh sách identity / mật khẩu Basic Auth cùng thứ tự, phân tách bằng dấu phẩy |
| `CP_PASSWORD` | (không gửi) | Mật khẩu Basic Auth gửi CSMS khi nối (username = `CP_ID`). Cần khi CSMS chạy `ALLOW_LEGACY_NO_CREDENTIAL=false` (staging). Khác mật khẩu HMI `123456` |
| `HMI_PORT` | `8100` | Cổng HMI |
| `HMI_HOST` | `127.0.0.1` | Địa chỉ bind. HMI chưa có xác thực — chỉ đặt `0.0.0.0` trong container khi cổng chỉ được publish ra loopback của máy chủ (staging) |
| `STALE_METERSTOP` | tắt | `1` = sau một lần rớt mạng, `StopTransaction` mang `meterStop` **cũ** (chỉ số lúc rớt) dù trụ vẫn sạc tiếp — tái hiện hiện tượng 3 của EXP-01 để CSMS ra phiên `review`. `npm run demo` của CSMS bật sẵn (`STALE_METERSTOP=0` để tắt) |
| `RETRY_MS` `REPLAY_LOSS` `METER_INTERVAL` `PING_SEC` `REBOOT_MS` `SPEED` | 30000 / 0.25 / 10 / 30 / 3000 / 1 | Chủ yếu cho kiểm thử, áp cho mọi trụ; xem đầu `server.mjs` |

### Trang và API

| Đường | Việc |
|---|---|
| `GET /` | Trang tổng: mọi trụ, online/offline, tốc độ, hàng đợi, trạng thái + kW/kWh/SoC từng súng, link sang trang trụ (SSE `/tong/events`, JSON `/api/tong`) |
| `GET /tru/<cpId>` | Trang từng trụ: "Phiên sạc trên trụ này" + hình trụ 3D/2D + HMI bấm được + nhật ký OCPP của riêng trụ đó (SSE `/events/<cpId>`) |
| `GET /api/<cpId>/state`, `POST /api/<cpId>/<hành động>` | Snapshot / hành động HMI của một trụ (`plug`, `unplug`, `swipe`, `password`, `mode`, `stop`, `fault`, `clearfault`, `speed`, `syncclock`, `drop`, `halfopen`, `reboot`) |
| `GET /events`, `GET /api/state`, `POST /api/<hành động>` | Đường cũ, trỏ vào **trụ đầu tiên** (healthcheck Dockerfile, script cũ) |
| `GET /vendor/three/three.module.js`, `.../three.core.js` | Đúng hai file build của `three` trong `node_modules`; tên khác hoặc có `..` → 404 |

cpId lạ, đoạn đường dẫn có `..`/gạch chéo (kể cả dạng `%2e`, `%2f`, `%5c`) → 404. Mọi chữ đến từ OCPP/CSMS được escape trước khi chèn vào HTML.


Để CSMS chấp nhận, cần có sẵn trụ `RH24D1-00001` và các `idTag` mẫu: `DEMO-CARD-0001` (thẻ hợp lệ), `DEMO-CARD-0002` (thẻ hợp lệ 2, tài xế mẫu 2; thay thẻ ví `DEMO-WALLET-0001` đã bỏ ở T110 — PowerMe không hỗ trợ thẻ RFID ví). `DEMO-UNKNOWN-999` cố tình không đăng ký. Mật khẩu HMI mẫu: `123456` (giả).

## Kiểm thử

```bash
node simulator/d1-hmi/smoke.mjs
```

Dựng một CSMS ocpp-rpc tối thiểu trong chính script, chạy `server.mjs` trỏ vào đó, điều khiển qua HTTP như HMI thật và khẳng định chuỗi bản tin OCPP (Boot → Status ×3 → Authorize → Start → MeterValues → rớt mạng → nối lại không Boot → phát bù với timestamp cũ → RemoteStop/Stop → lỗi → half-open → reboot). Phần 10 (QA-03) chạy thêm một tiến trình `CP_IDS=SMOKE-M1,SMOKE-M2`: mỗi trụ boot riêng bằng mật khẩu riêng, `/api/tong`, trang/API/SSE theo cpId (cpId lạ → 404), RemoteStart vào trụ 2 không làm trụ 1 gửi gì, ×20 làm timestamp MeterValues chạy ≈ 20 lần giờ thật chỉ ở trụ 2, hành trình phiên đủ bước, "Về giờ thật". In PASS/FAIL từng dòng, exit code ≠ 0 nếu có FAIL. Không nằm trong CI (~1,5 phút).

## Cấu trúc

| File | Việc |
|---|---|
| `station.mjs` | Trạng thái súng, mô hình điện, client OCPP, hàng đợi buffer, kết nối lại, snapshot cho HMI |
| `ocpp-commands.mjs` | Lệnh CSMS → trụ (RemoteStart/Stop, Trigger, Reset, Config, ...) |
| `hmi-actions.mjs` | Lệnh người dùng bấm trên HMI |
| `model.mjs` | Hằng số, 9 trạng thái OCPP, thẻ mẫu, đường công suất, rút gọn payload |
| `server.mjs` | HTTP + SSE cho một hoặc nhiều trụ; bảng đường ở mục "Trang và API" |
| `public/tong.html` | Trang tổng (danh sách trụ) |
| `public/tru.html` | Trang từng trụ: hành trình phiên + biểu đồ, bộ chọn tốc độ, HMI (CSS/JS inline, sáng/tối theo hệ thống, nút "Chữ lớn" cho máy chiếu) + khung SVG của hình trụ. Trước QA-03 là `index.html` |
| `public/tru-3d.js` | Hình trụ 3D (three.js, ES module), fallback về SVG |
| `public/tru-sac.css`, `public/tru-sac.js` | Hình trụ sạc minh hoạ có hoạt ảnh (QA-02); phục vụ qua `GET /static/<tên>.css\|js` (chỉ tên file đơn trong `public/`, `..` và gạch chéo bị 404) |
| `smoke.mjs` | Kiểm thử chuỗi bản tin |
| `docs/` | Ảnh chụp HMI và trang tổng/trang trụ |

## Trang từng trụ — cho người test app tài xế (QA-03)

Khối đầu trang **"Phiên sạc trên trụ này"** có một thẻ cho mỗi súng:

- **Dòng "đang làm gì / đang chờ gì"**: trụ OFFLINE (lệnh từ app không tới được, thử lại sau N s), đã nhận RemoteStart và **đang chờ cắm súng** (đếm ngược `ConnectionTimeOut`), đã gửi StartTransaction và chờ CSMS cấp `transactionId` (hoặc đang nằm trong hàng đợi), đang sạc (tx, idTag, nguồn), xong phiên chờ rút súng, súng lỗi/Unavailable (RemoteStart sẽ bị Rejected), chưa có phiên.
- **Dòng thời gian OCPP của phiên** theo giờ thật: `← RemoteStartTransaction (idTag) → Accepted/Rejected (lý do)` → `→ StartTransaction (idTag, meterStart)` → `← transactionId + idTagInfo.status` → `Charging` → `← RemoteStopTransaction` → `→ StopTransaction (meterStart → meterStop = kWh, reason)` → `← CSMS xác nhận`. Có cả Authorize (quẹt thẻ), hết hạn ConnectionTimeOut, bản tin vào hàng đợi khi offline và kết quả đến sau phát bù. Trụ giữ hai hành trình gần nhất mỗi súng (phiên hiện tại + phiên trước); đây chỉ là sổ ghi để hiển thị, không đổi bản tin OCPP nào.
- **Số liệu**: kWh đã sạc cho xe, kW hiện tại, SoC, thời gian sạc (đồng hồ mô phỏng) và thời gian thật đã trôi qua; khi không còn phiên thì hiện "Phiên vừa xong". Một dòng tóm tắt phiên trước.
- **Biểu đồ** kWh (nét liền) và kW (nét đứt) theo thời gian mô phỏng, một điểm mỗi giây thật (sự kiện SSE `point`, tối đa 400 điểm, thưa dần khi dài).

Phía dưới là hình trụ, rồi HMI bấm được (hai súng, mạng/hàng đợi) và nhật ký OCPP của riêng trụ đó. Ảnh chụp thật (Edge headless, nối CSMS thật `npm run demo` cục bộ, 2 trụ, trụ 2 chưa onboard nên OFFLINE): [`docs/tru-trang-tong.png`](docs/tru-trang-tong.png), [`docs/tru-trang-dang-sac-3d.png`](docs/tru-trang-dang-sac-3d.png) (súng A vừa xong phiên, súng B đang sạc ×10, hình 3D), [`docs/tru-trang-2d.png`](docs/tru-trang-2d.png) (cùng trang với `?3d=off`, hình SVG 2D).

## Tốc độ mô phỏng ×1 / ×10 / ×20 và CSMS (QA-03)

Bộ chọn trên thanh trên cùng của trang trụ; tốc độ là **của từng trụ** (`POST /api/<cpId>/speed {"value":1|10|20}`). Tốc độ nhân đồng hồ mô phỏng của trụ: năng lượng nạp, thời gian sạc hiển thị và **mọi timestamp OCPP** (StatusNotification, StartTransaction, MeterValues, StopTransaction). `MeterValueSampleInterval` tính theo giây mô phỏng, nên ở ×20 trụ gửi MeterValues dày hơn (bị chặn bởi nhịp tick 250 ms: tối đa 4 bản/giây/súng). Thời gian mạng (rớt mạng, thử lại 30 s, `ConnectionTimeOut`) luôn là giây thật. Trang hiện cả hai: đồng hồ trụ + "đi trước giờ thật X", thời gian sạc mô phỏng và thời gian thật.

Đồng hồ mô phỏng **không tự quay về giờ thật** khi về ×1: nút **"Về giờ thật"** (`syncclock`) đặt lại, chỉ khi không súng nào đang sạc (để timestamp trong một phiên không nhảy lùi). Trụ thật đồng bộ giờ qua Boot/Heartbeat; trụ giả lập này không làm vậy (chưa làm).

CSMS xử lý thế nào (T101/T134, [`docs/T101-TARIFF-CLOCK.md`](../../docs/T101-TARIFF-CLOCK.md), `apps/csms/src/reconciliation/tariff-clock.ts`), **đã kiểm** bằng CSMS thật chạy `npm run demo` cục bộ rồi gọi `resolveTariffClock` (bản build `dist/`) trên phiên vừa sinh, dung sai mặc định 300 s:

| Phiên thử | Đồng hồ trụ lúc Stop so với giờ CSMS nhận | `resolveTariffClock` |
|---|---|---|
| ×20, sạc 105 s thật (34:55 mô phỏng), 37,73 kWh | đi trước +1990 s | `{"issue":"tariff_clock_future_timestamp"}` → quyết toán ghi `tariff_clock_fallback` và tính **cả phiên theo một khung giá** (khung lúc CSMS nhận StartTransaction, `priced_clock = csms`) |
| ×10, sạc 22 s thật (03:44 mô phỏng), 7,46 kWh | đi trước +201 s | `{"offsetMs":0,"epoch":null,"liveFrames":0}` → dùng nguyên giờ trụ (đã bị kéo dài ×10) để chia khung giá |

Kết luận: CSMS **không từ chối** bản tin nào; phiên vẫn `reconciled` với `energy_wh` đúng (37726 Wh = meterStop − meterStart). Cái sai là **chia khung giá theo giờ**: lệch quá 300 s (×10 sau ~33 s thật, ×20 sau ~16 s thật) thì cả phiên một giá; dưới 300 s thì khung giá chia theo đồng hồ đã bị kéo dài. Không đo được độ lệch (`liveFrames: 0`) vì ở ×10/×20 hai bản tin live liên tiếp lệch nhau > 5 s (`REPLAY_SKEW_THRESHOLD_S`), không tạo được "cụm live" — tức CSMS không cộng bù được. Thêm nữa, phiên RFID trong seed demo là `csms_billed` nhưng không thuộc phạm vi quyết toán tự động (chỉ app QR có intent hoặc phiên BE-24), nên lần kiểm trên dừng ở `resolveTariffClock`, chưa đi tới bản ghi `charging_statements`. **Kiểm tiền theo khung giờ (giờ cao/thấp điểm) thì dùng ×1 và bấm "Về giờ thật" trước phiên.** Trang trụ hiện cảnh báo này ngay dưới thanh trên cùng (đỏ khi đồng hồ đã lệch quá 300 s).

## Hình trụ 3D (QA-03)

Trên trang trụ, khối "Trụ sạc PowerMe" vẽ bằng three.js (`public/tru-3d.js`): thân trụ, màn hình (chữ vẽ lên canvas: kW, kWh, SoC, thời gian; "Mất kết nối — thử lại sau N s"), hai khay súng A/B với **vòng đèn** theo bảng màu và kiểu nháy ở mục dưới, cáp có **chấm chạy** khi `Charging` (nhanh theo kW, ×10/×20 nhanh gấp đôi), xe trượt đến khi cắm súng với thanh pin trên nóc theo SoC, ăng-ten xanh/vàng/đỏ theo mạng; nhãn súng, mạng và số bản tin chờ phát bù là chữ HTML phủ lên. **Kéo chuột để xoay**, nhấp đúp để về góc ban đầu. Cùng snapshot SSE với hình 2D, không điều khiển gì; dòng *"Hình minh hoạ — không phải ảnh sản phẩm thật"* giữ nguyên. Khối hộp tự dựng, không logo, không kiểu dáng của hãng nào.

`three@0.187.0` là devDependency ở gốc repo; server phục vụ đúng hai file build từ `node_modules` (không CDN, chạy offline). **Fallback về SVG 2D** khi: không có WebGL, `prefers-reduced-motion: reduce`, nút "Tắt hoạt ảnh", nút "Hình 2D" (nhớ trong `localStorage`), `?3d=off`, hoặc không nạp được three.js — ví dụ image Docker staging cài `--omit=dev` nên **staging chỉ có hình 2D**. WebGL vẽ lại mỗi khung (rAF) khi khối đang mở và tab đang hiện; máy yếu thì bấm "Hình 2D".

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

Chấm chạy trên cáp có tốc độ tỉ lệ công suất (`6 + 0,5·kW` đơn vị/giây); khi chọn ×10 hoặc ×20 nhanh gấp đôi (không gấp 10 để mắt còn theo được). Hiện HMI chưa có đường vào `SuspendedEV`, `SuspendedEVSE`, `Reserved` (xem "Chưa làm") nên ba kiểu đèn đó chỉ kiểm bằng dữ liệu giả đưa thẳng vào hàm vẽ, chưa kiểm bằng HMI thật.

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

Thời gian mô phỏng (bộ chọn ×1/×10/×20, mục "Tốc độ mô phỏng") chỉ nhân đồng hồ sạc và timestamp OCPP; thời gian mạng (rớt mạng, thử lại 30 s) luôn là giây thật.

## Giả định chưa xác nhận hãng

| # | Điểm | Chúng tôi chọn | Cần xác nhận |
|---|---|---|---|
| 1 | Danh sách thẻ cục bộ khi offline | Offline, trụ chấp nhận hai thẻ hợp lệ theo danh sách cục bộ (`DEMO-CARD-0001`, `DEMO-CARD-0002`), từ chối thẻ lạ. Thẻ ví (trụ tự trừ tiền) ngoài phạm vi từ T109 | Firmware có danh sách cục bộ không |
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
- Đồng hồ mô phỏng ×10/×20 đẩy timestamp vượt giờ thật của CSMS; đã kiểm hệ quả với tính tiền (mục "Tốc độ mô phỏng"). Trụ không đồng bộ giờ theo `currentTime` của Boot/Heartbeat — chỉ có nút "Về giờ thật".
- Trang trụ chưa gửi được RemoteStart (đó là việc của app/CSMS); chưa có ảnh chụp dòng thời gian của một phiên RemoteStart từ app thật (smoke kiểm chuỗi đó bằng CSMS giả).
- Hình 3D chưa có hoạt ảnh "phát bù" (gói tin bay) như hình 2D; chỉ có số bản tin chờ trong nhãn mạng.
