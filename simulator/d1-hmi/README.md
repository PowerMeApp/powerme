# Trụ giả lập D1 có màn hình HMI bấm được (QA-01)

Trụ sạc DC 120 kW hai súng chạy bằng Node thuần, có giao diện HMI trên trình duyệt để **tương tác trực tiếp** khi demo: cắm/rút súng, quẹt thẻ, nhập mật khẩu, chọn chế độ sạc, rớt mạng, gây lỗi, khởi động lại — và xem nhật ký OCPP chạy trực tiếp. Mục đích: cho CSMS một "trụ" có thể bấm được trước hội đồng, với hành vi bám quan sát thật (EXP-01) thay vì kịch bản cố định.

> **Mô phỏng — hành vi chưa xác nhận bằng firmware Ruihua.** Mọi chỗ trụ "làm gì khi..." mà manual hãng im lặng đều là lựa chọn của chúng tôi, liệt kê ở bảng giả định bên dưới.

## Chạy

Chỉ cần Node 24 và `ocpp-rpc` đã có trong `node_modules` (`npm ci` ở gốc repo). Không Docker, không CDN. HMI chạy **không cần build**; riêng hình trụ 3D cần build một lần (`npm run sim:tru3d:build`, mục "Hình trụ 3D"), chưa build thì trang dùng hình SVG 2D.

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
| `OFFLINE_AUTH` | `normal` | T150 / BR-P52. `normal`: ba key `LocalAuthorizeOffline` (true), `LocalPreAuthorize`, `AllowOfflineTxForUnknownId` (false) ghi được, CSMS tắt được authorize offline sau Boot; khi đó thẻ quẹt lúc offline bị từ chối. `rejected`: ba key readonly = true → `ChangeConfiguration` Rejected, trụ nhận MỌI thẻ khi offline (dashboard bật cờ "Rủi ro thẻ offline"). `notsupported`: trụ không có ba key (unknownKey / NotSupported), cũng nhận mọi thẻ offline |
| `RETRY_MS` `REPLAY_LOSS` `METER_INTERVAL` `PING_SEC` `REBOOT_MS` `SPEED` | 30000 / 0.25 / 10 / 30 / 3000 / 1 | Chủ yếu cho kiểm thử, áp cho mọi trụ; xem đầu `server.mjs` |

### Trang và API

| Đường | Việc |
|---|---|
| `GET /` | Trang tổng: mọi trụ, online/offline, tốc độ, hàng đợi, trạng thái + kW/kWh/SoC từng súng, link sang trang trụ (SSE `/tong/events`, JSON `/api/tong`) |
| `GET /tru/<cpId>` | Trang từng trụ: "Phiên sạc trên trụ này" + hình trụ 3D/2D + HMI bấm được + nhật ký OCPP của riêng trụ đó (SSE `/events/<cpId>`) |
| `GET /api/<cpId>/state`, `POST /api/<cpId>/<hành động>` | Snapshot / hành động HMI của một trụ (`plug`, `unplug`, `swipe`, `password`, `mode`, `stop`, `fault`, `clearfault`, `speed`, `syncclock`, `drop`, `halfopen`, `reboot`) |
| `POST /api/<cpId>/swipeReader` | Đầu đọc RFID USB của một trụ (T146): chỉ loopback (peer + Host đúng cổng), cùng origin, `Sec-Fetch-Site` same-origin/none, `application/json`, thân ≤ 512 B, đúng `{connector, idTag}`. Không đi qua route hành động chung |
| `GET /events`, `GET /api/state`, `POST /api/<hành động>`, `POST /api/swipeReader` | Đường cũ, trỏ vào **trụ đầu tiên** (healthcheck Dockerfile, script cũ) |
| `GET /vendor/three/three.module.js`, `.../three.core.js` | Đúng hai file build của `three` trong `node_modules`; tên khác hoặc có `..` → 404 |
| `GET /tru3d/tru3d.js` | Bundle hình 3D (React + react-three-fiber) trong `tru3d/dist/`; đúng một tên file cố định, chưa build → 404 |

cpId lạ, đoạn đường dẫn có `..`/gạch chéo (kể cả dạng `%2e`, `%2f`, `%5c`) → 404. Mọi chữ đến từ OCPP/CSMS được escape trước khi chèn vào HTML.


Để CSMS chấp nhận, cần có sẵn trụ `RH24D1-00001` và các `idTag` mẫu: `DEMO-CARD-0001` (thẻ hợp lệ), `DEMO-CARD-0002` (thẻ hợp lệ 2, tài xế mẫu 2; thay thẻ ví `DEMO-WALLET-0001` đã bỏ ở T110 — PowerMe không hỗ trợ thẻ RFID ví). `DEMO-UNKNOWN-999` cố tình không đăng ký. Mật khẩu HMI mẫu: `123456` (giả).

## Đầu đọc RFID USB (T146, phase 1)

Đầu đọc USB dạng bàn phím đã được người dùng xác nhận xuất 10 chữ số + Enter trong Notepad. Cắm súng, chờ online, bấm ô **Đầu đọc RFID USB** của đúng súng rồi quẹt. HMI giữ nguyên chuỗi (kể cả số 0 đầu), gửi OCPP Authorize thật và chỉ yêu cầu Start khi được Accepted và súng/kết nối vẫn hợp lệ. Thẻ lạ/offline không dùng danh sách thẻ mẫu. Thẻ mẫu vẫn có lối riêng.

**Trên trang từng trụ (QA-03):** mỗi súng của `/tru/<cpId>` có ô **"Đầu đọc RFID USB · súng X"**, gửi tới `POST /api/<cpId>/swipeReader` của đúng trụ đó (cùng kiểm tra bảo mật như route cũ; cpId lạ → 404). `POST /api/swipeReader` cũ vẫn chạy, trỏ vào trụ đầu tiên. Khối "Phiên sạc trên trụ này" ghi bước `Quẹt thẻ ở đầu đọc RFID USB → Authorize` và `StartTransaction … nguồn thẻ RFID (đầu đọc USB)`; mã thẻ 10 số luôn hiện `[reader identifier]` ở hành trình, snapshot, nhật ký và trang tổng (server che trước khi gửi SSE). Ảnh: [`docs/tru-trang-rfid.png`](docs/tru-trang-rfid.png) (2 trụ, quẹt đầu đọc ở súng A trụ 2 qua bàn phím giả lập trong Edge headless, CSMS giả trong máy).

**Chưa retest capture bằng đầu đọc vật lý trên HMI/điện thoại.** Các phase tiếp theo đã thêm API 0.15 và nối Flutter local để tìm/theo dõi phiên RFID chỉ đọc và hiển thị Lịch sử mọi nguồn; kiểm chứng hiện là transport/widget, không là staging hay đầu đọc thật. Backend 0.15 chưa triển khai staging, cấu hình app không đổi; cần liên kết thẻ đúng chủ qua quy trình Admin được cho phép và retest HMI/điện thoại sau khi API sẵn sàng. Không tự đăng ký thẻ và chưa hoàn tất tính tiền RFID (T148 hoãn). Xem [nghiên cứu, kiểm thử và giới hạn đầu đọc](docs/t146-rfid-usb.md) và [handoff API/Flutter](../../docs/tasks/t146-driver-session-discovery.md).

## Kiểm thử

```bash
node simulator/d1-hmi/smoke.mjs
node --test simulator/d1-hmi/rfid-reader.test.mjs simulator/d1-hmi/rfid-loopback.test.mjs simulator/d1-hmi/rfid-ui.test.mjs
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
| `public/tru-3d.js` | Bộ nạp hình 3D: kiểm WebGL/giảm chuyển động/`?3d=off`, nạp `/tru3d/tru3d.js`, bật/tắt theo nút; mọi lỗi nạp → SVG 2D |
| `tru3d/` | Mã nguồn hình 3D (QA-04): `src/Scene.jsx` (cảnh r3f), `src/Overlay.jsx` (nhãn HTML), `src/screen.js` (màn hình trụ), `src/motion.js` (bảng màu, kiểu nháy, spring), `src/tru3d.css`; `vite.config.mjs` build ra `tru3d/dist/tru3d.js` (không commit) |
| `public/tru-sac.css`, `public/tru-sac.js` | Hình trụ sạc minh hoạ có hoạt ảnh (QA-02); phục vụ qua `GET /static/<tên>.css\|js` (chỉ tên file đơn trong `public/`, `..` và gạch chéo bị 404) |
| `rfid-reader.mjs`, `public/rfid-reader.js` | Đầu đọc RFID USB (T146): kiểm khung 10 chữ số, che mã; ô nhập theo súng trên trang trụ |
| `smoke.mjs` | Kiểm thử chuỗi bản tin |
| `rfid-*.test.mjs` | Test đầu đọc: hành động, loopback OCPP + route HTTP (cả `/api/<cpId>/swipeReader` nhiều trụ), giao diện |
| `docs/` | Ảnh chụp HMI và trang tổng/trang trụ |

## Trang từng trụ — cho người test app tài xế (QA-03)

Khối đầu trang **"Phiên sạc trên trụ này"** có một thẻ cho mỗi súng:

- **Dòng "đang làm gì / đang chờ gì"**: trụ OFFLINE (lệnh từ app không tới được, thử lại sau N s), đã nhận RemoteStart và **đang chờ cắm súng** (đếm ngược `ConnectionTimeOut`), đã gửi StartTransaction và chờ CSMS cấp `transactionId` (hoặc đang nằm trong hàng đợi), đang sạc (tx, idTag, nguồn), xong phiên chờ rút súng, súng lỗi/Unavailable (RemoteStart sẽ bị Rejected), chưa có phiên.
- **Dòng thời gian OCPP của phiên** theo giờ thật: `← RemoteStartTransaction (idTag) → Accepted/Rejected (lý do)` → `→ StartTransaction (idTag, meterStart)` → `← transactionId + idTagInfo.status` → `Charging` → `← RemoteStopTransaction` → `→ StopTransaction (meterStart → meterStop = kWh, reason)` → `← CSMS xác nhận`. Có cả Authorize (quẹt thẻ), hết hạn ConnectionTimeOut, bản tin vào hàng đợi khi offline và kết quả đến sau phát bù. Trụ giữ hai hành trình gần nhất mỗi súng (phiên hiện tại + phiên trước); đây chỉ là sổ ghi để hiển thị, không đổi bản tin OCPP nào.
- **Số liệu**: kWh đã sạc cho xe, kW hiện tại, SoC, thời gian sạc (đồng hồ mô phỏng) và thời gian thật đã trôi qua; khi không còn phiên thì hiện "Phiên vừa xong". Một dòng tóm tắt phiên trước.
- **Biểu đồ** kWh (nét liền) và kW (nét đứt) theo thời gian mô phỏng, một điểm mỗi giây thật (sự kiện SSE `point`, tối đa 400 điểm, thưa dần khi dài).

Từ QA-06 khối này nằm ngay dưới hình trụ (hero); phía dưới nữa là HMI bấm được (hai súng, mạng/hàng đợi) và nhật ký OCPP của riêng trụ đó. Ảnh chụp QA-03/QA-04 (giao diện cũ; `tru-trang-tong.png` và `tru-3d-trang-rong.png` nay là ảnh QA-06, xem mục "Giao diện"): [`docs/tru-trang-2d.png`](docs/tru-trang-2d.png) (cùng trang với `?3d=off`, hình SVG 2D).

## Giao diện (QA-06, style "Bevel")

Trang tổng `/` và trang từng trụ `/tru/<cpId>` theo style tham chiếu "Bevel" ("morning metrics in cloudlight"): nền trắng, tiêu đề chữ đậm 600 tracking âm, thẻ xanh mây không viền không bóng, nhiều khoảng trắng. Chỉ đổi trình bày: không đổi id/class/`data-f` mà JS và test dùng, không đổi hành vi hay API.

- **Token chung** ở [`public/bevel-tokens.css`](public/bevel-tokens.css) (phục vụ qua `/static/bevel-tokens.css`, route tĩnh sẵn có, không sửa `server.mjs`): màu (Paper White `#ffffff`, Charcoal `#1f2025`, Ink `#222326`, Cloud Card `#ebf0f8`, Body Gray `#747679`, Hero Sky `#d2e5ff → #fff9ee`), màu dữ liệu, chữ (chỉ font hệ thống `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui`, không tải font/CDN), khoảng cách 8 px, bo góc (thẻ 24/32 px, nút 128 px, nav 32 px), bóng. Biến cũ (`--bg`, `--panel`, `--ok`, `--st-*`, `--lt-*`…) vẫn còn, trỏ vào token mới.
- **Thanh trên**: capsule trắng nổi (bo 32 px, `backdrop-filter: blur`) — về trang tổng, viên mạng, tốc độ ×1/×10/×20 dạng pill, "Về giờ thật", "Chữ lớn".
- **Hero** (`#tru`): nền Hero Sky bo 32 px, tên trụ cỡ lớn ở trên, hình trụ ở giữa (xem "Hình trụ 3D" bên dưới về cảnh sáng).
- **Thẻ Cloud** (`#ebf0f8`, bo 24 px, padding 32 px, không viền, không bóng): hai thẻ "Phiên sạc trên trụ này", hai bảng HMI súng A/B, mạng và hàng đợi, nhật ký OCPP. Số lớn (kWh, kW, SoC…) chữ 600 tracking âm; nhãn Body Gray.
- **Nút**: chính = pill Charcoal (Cắm súng, Mở trang trụ); phụ = pill trắng trên thẻ Cloud; nguy hiểm (Dừng sạc, Gây lỗi, Rớt mạng) = pill viền/chữ đỏ nhạt, không nền đỏ đặc.
- **Viên trạng thái**: nền trắng, **chấm màu** + chữ Ink (màu không mang chữ nên luôn đọc rõ). Dòng "đang làm gì", dòng thời gian OCPP và nhật ký dùng chấm màu thay viền màu.
- **Biểu đồ**: kWh nét liền Metric Blue, kW nét đứt Recovery Green, lưới ngang rất nhạt, không viền. **Nhật ký OCPP**: thẻ trắng trong thẻ Cloud, mono nhỏ, chữ Body Gray; chấm xanh dương = trụ gửi CSMS, chấm xanh lá = CSMS gửi trụ, dòng lỗi chữ đỏ.
- **Bố cục**: ≥ 1280 px ba cột (súng A, súng B, mạng + nhật ký); 768–1279 px hai cột; < 768 px một cột, capsule không dính, chân trang "Mô phỏng" nằm cuối trang thay vì nổi (đã đo: 390 px không cuộn ngang). `prefers-reduced-motion` tắt chuyển động. Giao diện tối tối giản (đảo token) theo `prefers-color-scheme` hoặc `?theme=dark`; sáng là mặc định.

**Bảng màu trạng thái** (dùng chung cho chấm trạng thái, đèn hình 2D/3D, trang tổng; biến `--st-*` và `--lt-*`):

| Trạng thái | Token | Màu |
|---|---|---|
| `Available` | Metric Blue | `#415eee` |
| `Preparing` | Sleep Lilac | `#b9a6ff` (nhấp nháy chậm) |
| `Charging` | Recovery Green | `#31ce01` ("thở") |
| `SuspendedEV` / `SuspendedEVSE` | Signal Gold | `#ffca00` (phân biệt bằng kiểu nháy + nhãn) |
| `Finishing` | Coral Signal | `#ffab94` |
| `Faulted` | Đỏ cảnh báo (style không có token đỏ) | `#e5484d` (nháy nhanh) |
| `Unavailable` | xám | `#a5a7ab` |
| `Reserved` | lục lam | `#2cc3b8` |
| Mạng online / đang nối / offline | Green / Gold / đỏ cảnh báo | `--net-online` / `--net-connecting` / `--net-offline` |

Màu dữ liệu chỉ dùng cho chấm, vòng, thanh SoC, biểu đồ, huy hiệu nhỏ — không làm nền trang hay nút chính.

Ảnh chụp thật QA-06 (Edge headless, bộ demo `run-demo.mjs --port-offset 90`, kịch bản `plug {"connector":2}` → `swipe {"connector":2,"card":"valid"}` → `speed {"value":10}` → `plug {"connector":1}`; ảnh lỗi: `fault {"connector":1,"errorCode":"GroundFailure"}` + `drop {"seconds":90}`): [`docs/tru-3d-trang-rong.png`](docs/tru-3d-trang-rong.png) (1600×1000, súng B đang sạc, cảnh 3D sáng), [`docs/tru-3d-loi-mat-mang.png`](docs/tru-3d-loi-mat-mang.png) (súng A lỗi + mất mạng, 14 bản tin chờ phát bù), [`docs/tru-phien-loi-mat-mang.png`](docs/tru-phien-loi-mat-mang.png) (khối "Phiên sạc trên trụ này" lúc OFFLINE), [`docs/tru-3d-di-dong.png`](docs/tru-3d-di-dong.png) (390 px), [`docs/tru-trang-tong.png`](docs/tru-trang-tong.png) (trang tổng 1600×1000), [`docs/tru-3d-off-2d.png`](docs/tru-3d-off-2d.png) (`?3d=off`, hình SVG 2D trên nền Hero Sky).

## Tốc độ mô phỏng ×1 / ×10 / ×20 và CSMS (QA-03)

Bộ chọn trên thanh trên cùng của trang trụ; tốc độ là **của từng trụ** (`POST /api/<cpId>/speed {"value":1|10|20}`). Tốc độ nhân đồng hồ mô phỏng của trụ: năng lượng nạp, thời gian sạc hiển thị và **mọi timestamp OCPP** (StatusNotification, StartTransaction, MeterValues, StopTransaction). `MeterValueSampleInterval` tính theo giây mô phỏng, nên ở ×20 trụ gửi MeterValues dày hơn (bị chặn bởi nhịp tick 250 ms: tối đa 4 bản/giây/súng). Thời gian mạng (rớt mạng, thử lại 30 s, `ConnectionTimeOut`) luôn là giây thật. Trang hiện cả hai: đồng hồ trụ + "đi trước giờ thật X", thời gian sạc mô phỏng và thời gian thật.

Đồng hồ mô phỏng **không tự quay về giờ thật** khi về ×1: nút **"Về giờ thật"** (`syncclock`) đặt lại, chỉ khi không súng nào đang sạc (để timestamp trong một phiên không nhảy lùi). Trụ thật đồng bộ giờ qua Boot/Heartbeat; trụ giả lập này không làm vậy (chưa làm).

CSMS xử lý thế nào (T101/T134, [`docs/T101-TARIFF-CLOCK.md`](../../docs/T101-TARIFF-CLOCK.md), `apps/csms/src/reconciliation/tariff-clock.ts`), **đã kiểm** bằng CSMS thật chạy `npm run demo` cục bộ rồi gọi `resolveTariffClock` (bản build `dist/`) trên phiên vừa sinh, dung sai mặc định 300 s:

| Phiên thử | Đồng hồ trụ lúc Stop so với giờ CSMS nhận | `resolveTariffClock` |
|---|---|---|
| ×20, sạc 105 s thật (34:55 mô phỏng), 37,73 kWh | đi trước +1990 s | `{"issue":"tariff_clock_future_timestamp"}` → quyết toán ghi `tariff_clock_fallback` và tính **cả phiên theo một khung giá** (khung lúc CSMS nhận StartTransaction, `priced_clock = csms`) |
| ×10, sạc 22 s thật (03:44 mô phỏng), 7,46 kWh | đi trước +201 s | `{"offsetMs":0,"epoch":null,"liveFrames":0}` → dùng nguyên giờ trụ (đã bị kéo dài ×10) để chia khung giá |

Kết luận: CSMS **không từ chối** bản tin nào; phiên vẫn `reconciled` với `energy_wh` đúng (37726 Wh = meterStop − meterStart). Cái sai là **chia khung giá theo giờ**: lệch quá 300 s (×10 sau ~33 s thật, ×20 sau ~16 s thật) thì cả phiên một giá; dưới 300 s thì khung giá chia theo đồng hồ đã bị kéo dài. Không đo được độ lệch (`liveFrames: 0`) vì ở ×10/×20 hai bản tin live liên tiếp lệch nhau > 5 s (`REPLAY_SKEW_THRESHOLD_S`), không tạo được "cụm live" — tức CSMS không cộng bù được. Thêm nữa, phiên RFID trong seed demo là `csms_billed` nhưng không thuộc phạm vi quyết toán tự động (chỉ app QR có intent hoặc phiên BE-24), nên lần kiểm trên dừng ở `resolveTariffClock`, chưa đi tới bản ghi `charging_statements`. **Kiểm tiền theo khung giờ (giờ cao/thấp điểm) thì dùng ×1 và bấm "Về giờ thật" trước phiên.** Trang trụ hiện cảnh báo này ngay dưới thanh trên cùng (đỏ khi đồng hồ đã lệch quá 300 s).

## Hình trụ 3D (QA-03 → QA-04 → QA-05: React + react-three-fiber)

Trên trang trụ, khối "Trụ sạc PowerMe" là cảnh 3D dựng bằng React + [react-three-fiber](https://r3f.docs.pmnd.rs/) (mã trong `tru3d/`, QA-04 thay bản three.js thuần của QA-03, QA-05 nâng cấp ánh sáng, hậu kỳ, sàn và xe). Dùng để xem kWh/kW/SoC, xem phiên từ app đã tới trụ chưa và đầu đọc RFID ngay trên hình khi demo:

- **Thân trụ** bo góc nhôm anodized xám, mặt trước kính đen bóng, nắp nhôm có dải đèn hắt; **màn hình phát sáng** (canvas 2048×1280 → chữ sắc ở dpr 2) sau viền đen và lớp kính phủ chỉ phản chiếu env (không dùng transmission → không có lượt vẽ phụ): mỗi súng một nửa — kW, kWh, thời gian, SoC; "Sẵn sàng", "Cắm súng vào xe", "Lệnh từ app · chờ N s", "Rút súng", mã lỗi; dải trên: trực tuyến / mất kết nối — thử lại N s / đang nối lại, giờ mô phỏng, ×10/×20.
- **Đèn viền khay súng** (vòng LED quanh lòng khay + đường LED dọc mép mặt kính) theo bảng màu `--lt-*` và kiểu nháy ở mục dưới; màu đổi mượt khi đổi trạng thái.
- **Cáp dày** (tube Ø 8 cm theo CatmullRom, buông võng thành vòng gần sàn khi nằm trên khay) nối gốc cáp → đầu súng (mũi cắm nhôm, thân + tay cầm bọc cao su, đèn trạng thái); khi cắm, súng bay theo cung từ khay sang cổng sạc của xe. **Hạt năng lượng** chạy dọc cáp khi `Charging`: tốc độ tỉ lệ kW, ×10 nhanh gấp 2, ×20 gấp 2,6 (không gấp 10/20 để mắt còn theo được).
- **Xe minh hoạ** (QA-05): thân bo cong từ biên dạng hông (ExtrudeGeometry có bevel, hốc bánh), cabin kính tối liền khối, mâm 5 chấu đôi, lốp tiện tròn, thanh đèn pha / đèn hậu phát sáng nhẹ, cổng sạc phát sáng theo trạng thái súng; bánh lăn theo quãng đường. Xe chung chung, không giống mẫu của hãng nào, không logo. Xe trượt vào bằng lò xo khi cắm súng (xe vào trước, súng cắm sau; rút súng xong xe mới đi), **thanh pin** nổi trên nóc theo SoC (đỏ < 20 %, hổ phách < 50 %, xanh).
- **Ăng-ten** + ba vạch sóng: online = sóng toả đều; đang nối = vàng, quét từng vạch; half-open = vàng, chập chờn; offline = đỏ, tắt vạch.
- **Đầu đọc RFID** (ký hiệu không tiếp xúc dưới màn hình) sáng nhịp khi một lần quẹt đang chờ CSMS (`readerPending`).
- **Quầng sáng** mờ sau trụ và trên sàn: emerald khi có súng `Charging`, hổ phách khi `Preparing`/`SuspendedEV`/`SuspendedEVSE`, đỏ khi `Faulted`, xám rất mờ khi rảnh. Ánh sáng studio (RoomEnvironment + PMREMGenerator của three, sinh tại chỗ, không tải HDR), fog bám khoảng cách camera.
- **Cảnh sáng (QA-06, mặc định):** canvas trong suốt (`alpha`) đặt thẳng trên gradient Hero Sky của khung CSS; đèn studio sáng hơn, sàn trắng phản chiếu nhạt (vật tối in bóng mờ lên sàn thay vì cộng sáng) rồi trong suốt dần theo bán kính, bóng tiếp xúc nhẹ hơn, mép canvas tan vào nền bằng `mask-image`. Quầng màu trạng thái (xanh lá khi sạc, đỏ khi lỗi, vàng khi chờ) vẽ bằng trộn alpha thường thay vì cộng sáng (cộng sáng không thấy trên nền sáng). Bloom nâng ngưỡng lên 1,15 và giảm cường độ để chỉ vật phát sáng HDR loé. Nhãn quanh canvas là capsule trắng mờ, chữ Ink, chấm màu. **Giao diện tối** (`prefers-color-scheme: dark` hoặc `?theme=dark`): giữ cảnh tối cũ (nền gần OLED `#040506`) trong một thẻ Charcoal nổi. Chọn một lần lúc nạp theo biến CSS `--t3-scene`.
- **Hậu kỳ (QA-05):** EffectComposer → UnrealBloomPass → OutputPass (ACES, sRGB), render target half float MSAA 4. Bloom theo **ngưỡng luminance** (0,62, đầu gối mềm 0,45): vật phát sáng có màu HDR ×3 (LED, vòng khay, hạt năng lượng, đèn xe, ăng-ten) vượt ngưỡng; màn hình giữ dưới ngưỡng để chữ không nhoè.
- **Sàn (QA-05):** Reflector (three/examples) phản chiếu mờ ở ~1/3 độ phân giải, lấy mẫu mipmap 9 điểm, tắt dần theo bán kính + fog. **Bóng tiếp xúc** thật: camera trực giao ở mặt sàn nhìn lên vẽ độ sâu vào texture rồi làm nhoè ngang/dọc hai lượt (bánh xe, đế trụ, cáp đổ bóng theo hình học).
- **Lớp chữ HTML** quanh canvas: viên nhãn súng A/B (trạng thái, nguồn phiên *Từ app / Thẻ RFID / Đầu đọc RFID / Mật khẩu HMI*, kW · kWh · SoC bằng `tabular-nums`, "Lệnh từ app đã tới trụ · chờ cắm súng N s", "Đầu đọc RFID · đang chờ CSMS"), viên mạng (trạng thái, số bản tin chờ phát bù, ×N). Font hệ thống có sẵn, không tải font.
- **Camera:** khi tải, camera dolly vào từ xa bằng lò xo (~2 s); kéo chuột để xoay (giới hạn góc, không zoom để không chiếm cuộn trang); để yên 2,5 s thì tự xoay rất chậm (±0,28 rad, chu kỳ 80 s); **nhấp đúp** để về góc ban đầu (lò xo). Khung hẹp/dọc (điện thoại) tự lùi camera.

Cùng snapshot SSE với hình 2D (`tru.html` gọi `window.renderTru3d(state)`), **không điều khiển gì**, không có nguồn dữ liệu thứ hai; dòng *"Hình minh hoạ — không phải ảnh sản phẩm thật"* giữ nguyên. Hình tự dựng: không logo, không kiểu dáng của hãng nào.

**Build** (một lần, ở gốc repo, sau `npm ci`):

```bash
npm run sim:tru3d:build      # = vite build --config simulator/d1-hmi/tru3d/vite.config.mjs → tru3d/dist/tru3d.js
node simulator/d1-hmi/server.mjs
```

Không cần khởi động lại server sau khi build (file đọc lúc có yêu cầu). `tru3d/dist/` không commit (`.gitignore` có `dist/`). Bundle là một ES module duy nhất (~490 KB, gồm React 19 + r3f + addon OrbitControls/RoundedBoxGeometry/RoomEnvironment/Reflector/EffectComposer/UnrealBloomPass/OutputPass/shader làm nhoè — mọi addon import `three` nên cũng dùng chung bản ở `/vendor/three/`); `three` để ngoài bundle và nạp từ `/vendor/three/three.module.js` như QA-03. Dependency build: `@react-three/fiber@9.8.2`, `react@19.3.1`, `react-dom@19.3.1`, `vite@7.3.7`, `three@0.187.0` — đều là devDependencies ở gốc repo, ghim đúng phiên bản. CI chạy `npm run sim:tru3d:build` để bắt lỗi build.

**Fallback về SVG 2D** (không báo lỗi lên trang) khi: không có WebGL, `prefers-reduced-motion: reduce`, nút "Tắt hoạt ảnh", nút "Hình 2D" (nhớ trong `localStorage`), `?3d=off`, **chưa build** (`/tru3d/tru3d.js` → 404), không nạp được three.js (`/vendor/three/` → 404 — image Docker staging cài `--omit=dev` và không build nên **staging chỉ có hình 2D**), hoặc cảnh 3D ném lỗi khi chạy. **Hiệu năng:** khi khối đang tắt 3D, thu gọn, tắt hoạt ảnh hoặc tab ẩn, r3f chuyển `frameloop="never"` — không vẽ khung nào (đã đo: 0 lệnh vẽ WebGL); `dpr` tối đa 2; lớp chữ HTML chỉ animate `transform`/`opacity`.

**Chất lượng (QA-05):** mặc định tự hạ — sau 4 s khởi động, nếu FPS trung bình < 30 trong một cửa sổ 2 s thì chuyển hẳn sang **chế độ nhẹ**: tắt bloom và phản chiếu sàn, `dpr` 1, bóng tiếp xúc cập nhật mỗi 3 khung; góc phải dưới ghi thêm "· chế độ nhẹ". `?3d=lite` ép chế độ nhẹ ngay; `?3d=hq` giữ chất lượng cao, không tự hạ (dùng khi chụp ảnh hoặc máy chiếu demo đã thử trước). Máy yếu hơn nữa thì bấm "Hình 2D".

Ảnh chụp thật QA-05 (giao diện tối cũ; `tru-3d-trang-rong`, `tru-3d-loi-mat-mang`, `tru-3d-di-dong`, `tru-3d-off-2d` đã thay bằng ảnh QA-06 — xem mục "Giao diện") (Edge headless `?3d=hq`, viewport 1600×1000, bộ demo `run-demo.mjs --port-offset 70`, kịch bản `plug {"connector":2}` → `swipe {"connector":2,…}` → `speed {"value":10}`): [`docs/tru-3d-dang-sac.png`](docs/tru-3d-dang-sac.png) (khung 3D, súng B đang sạc), [`docs/tru-3d-trang-rong.png`](docs/tru-3d-trang-rong.png) (viewport 1600×1000 cuộn tới khung 3D, súng A cắm chờ + súng B sạc, hai xe), [`docs/tru-3d-loi-mat-mang.png`](docs/tru-3d-loi-mat-mang.png) (súng A `Faulted` GroundFailure + rớt mạng: quầng đỏ, ăng-ten đỏ, bản tin chờ phát bù), [`docs/tru-3d-di-dong.png`](docs/tru-3d-di-dong.png) (390 px, giao diện sáng, không còn cuộn ngang), [`docs/tru-3d-off-2d.png`](docs/tru-3d-off-2d.png) (`?3d=off` → SVG 2D). Ảnh tĩnh không chứng minh được chuyển động; xem trực tiếp trên trình duyệt.

## Hình trụ sạc minh hoạ (QA-02)

Đầu trang HMI có khối **"Trụ sạc PowerMe"**: hình SVG tự vẽ (không logo/ảnh/kiểu dáng của hãng nào) để người xem hội đồng thấy trạng thái trụ mà không phải đọc số. Dòng chú thích cố định dưới hình: *"Hình minh hoạ — không phải ảnh sản phẩm thật"*. Hình **chỉ phản ánh** — dùng đúng snapshot SSE mà hai panel súng đang dùng (`connectors[]`, `net`, `queue`, `speed`, `cpId`), không có nguồn dữ liệu thứ hai và không điều khiển gì.

Hình có: thân trụ + màn hình LCD (mỗi súng một nửa: kW, SoC, thời gian, tiền tạm tính khi sạc; "Sẵn sàng — quẹt thẻ hoặc quét QR"; "Cắm súng vào xe"; "Rút súng"; mã lỗi; dải trên cùng báo "Mất kết nối — thử lại sau N s"), hai khay súng A/B có **đèn viền**, dây cáp, xe điện trượt vào khi súng được cắm với **thanh pin đổ theo SoC thật**, ăng-ten (xanh = online, vàng = đang nối, xám gạch chéo đỏ = mất kết nối), bong bóng số bản tin chờ phát bù khi hàng đợi buffer > 0, và nhịp "Phát bù N bản tin → CSMS" (gói nhỏ bay đi) khi hàng đợi về 0 sau khi nối lại.

Màu đèn từ QA-06 theo bảng ở mục "Giao diện" (trước QA-06: Available xanh lá, Preparing xanh dương, Finishing tím).

| Trạng thái OCPP | Đèn viền | Kiểu | Nhãn trên hình |
|---|---|---|---|
| `Available` | xanh dương (Metric Blue) | tĩnh | Sẵn sàng |
| `Preparing` | tím nhạt (Sleep Lilac) | nhấp nháy chậm (2 s) | Chuẩn bị |
| `Charging` | xanh lá (Recovery Green) | "thở" (3 s); chấm chạy dọc cáp | Đang sạc |
| `SuspendedEV` | vàng (Signal Gold) | nháy đều 1,6 s | Tạm dừng · **xe tạm dừng** |
| `SuspendedEVSE` | vàng (Signal Gold) | xung đôi rồi nghỉ (2 s) | Tạm dừng · **trụ tạm dừng** |
| `Finishing` | san hô (Coral) | tĩnh | Kết thúc |
| `Faulted` | đỏ | nháy nhanh (0,5 s) | Lỗi (+ mã lỗi trên LCD) |
| `Unavailable` | xám | tĩnh | Ngừng |
| `Reserved` | lục lam | tĩnh | Đặt trước |

Chấm chạy trên cáp có tốc độ tỉ lệ công suất (`6 + 0,5·kW` đơn vị/giây); khi chọn ×10 hoặc ×20 nhanh gấp đôi (không gấp 10 để mắt còn theo được). Hiện HMI chưa có đường vào `SuspendedEV`, `SuspendedEVSE`, `Reserved` (xem "Chưa làm") nên ba kiểu đèn đó chỉ kiểm bằng dữ liệu giả đưa thẳng vào hàm vẽ, chưa kiểm bằng HMI thật.

**Tắt hoạt ảnh:** nút **"Tắt hoạt ảnh"** ở góc khối (nhớ trong `localStorage`; thêm `?anim=off` vào URL để tắt riêng lần mở đó); hoặc đặt "giảm chuyển động" trong hệ điều hành (`prefers-reduced-motion: reduce` — hình tự tắt hoạt ảnh và khoá nút). Khi tắt, màu đèn và chữ vẫn giữ, chỉ mất chuyển động (xe hiện ngay, đèn sáng liên tục; hai kiểu "tạm dừng" chỉ còn phân biệt bằng nhãn chữ). Nút **"Thu gọn"** gập khối lại (cũng được nhớ). Nút "Chữ lớn" phóng to cả hình. Dưới 768 px bố cục về một cột (QA-06).

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
| 1 | Danh sách thẻ cục bộ khi offline | Offline, trụ chấp nhận hai thẻ hợp lệ theo danh sách cục bộ (`DEMO-CARD-0001`, `DEMO-CARD-0002`), từ chối thẻ lạ — chỉ khi `LocalAuthorizeOffline=true`; CSMS T150 đặt `false` sau Boot nên thẻ offline bị từ chối (xem `OFFLINE_AUTH`). Thẻ ví (trụ tự trừ tiền) ngoài phạm vi từ T109 | Firmware có danh sách cục bộ không |
| 2 | `idTag` của free vend (mật khẩu HMI) | `HMI-FREEVEND`, gửi thẳng `StartTransaction`, không `Authorize` | idTag thật (hoặc rỗng/mặc định), có Authorize không |
| 3 | Measurand thật trong MeterValues | `Energy.Active.Import.Register` (Wh), `SoC` (Percent), `Power.Active.Import` (W), `Voltage` (V), `Current.Import` (A) | Trụ Ruihua thật gửi measurand nào, đơn vị nào |
| 4 | Config key hỗ trợ | `HeartbeatInterval`, `MeterValueSampleInterval` (=10), `AuthorizeRemoteTxRequests`, `WebSocketPingInterval`, `ConnectionTimeOut`, `NumberOfConnectors`, `SupportedFeatureProfiles` (`Core,RemoteTrigger,SmartCharging` từ T150), `ConnectorPhaseRotation`, `AuthorizationCacheEnabled`, `LocalAuthListEnabled`, ba key authorize offline (T150). `SetChargingProfile` nhận `TxDefaultProfile` / `TxProfile` (W hoặc A, kiểu Relative tính từ đầu phiên) và giới hạn công suất mô phỏng; `ClearChargingProfile` | Tập key thật; có `TransactionMessageAttempts`/`RetryInterval` không (SAP không có) |
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
- Bloom của hình 3D chọn vùng theo ngưỡng luminance, không theo layer: điểm phản chiếu studio rất sáng trên kính/sơn xe đôi khi cũng loé nhẹ. Phản chiếu sàn là gương làm nhoè (mipmap), không phải phản chiếu nhám vật lý theo độ cao vật.
