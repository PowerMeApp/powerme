# Lộ trình PowerMe — Kế hoạch thực thi 13 tuần

**Đồ án Capstone SE · FPT University · 24/08/2026 – 22/11/2026**

Nền tảng phần mềm cho dòng trạm sạc DC **D1 Series** và **YJ-EU Series** — 60–160 kW, OCPP 1.6J, súng đôi. **Phần cứng mô phỏng hoàn toàn bằng simulator.**

| | |
|---|---|
| Thời lượng | 13 tuần (24/08/2026 – 22/11/2026) |
| Nhịp sprint | 6 sprint × 2 tuần + 1 tuần bảo vệ |
| Đội | 5 người / 5 work package |
| Quỹ công sức | ~132 ngày công thực làm |
| Cột mốc | M1 → M6 |
| Bảo vệ | 22/11/2026 |

> **Phiên bản này thay thế bản kế hoạch 26 tuần.** Thời lượng rút từ 6 tháng xuống 3 tháng, quỹ công sức giảm hơn một nửa (290 → 132 ngày công), nên khoảng một nửa phạm vi đã bị cắt có chủ ý. Danh sách cắt ở mục 8.
>
> Kế hoạch này đã tích hợp kết quả nghiên cứu nền — xem [NGHIEN-CUU-NEN-TANG.md](NGHIEN-CUU-NEN-TANG.md) để biết cơ sở và nguồn dẫn của các quyết định công cụ.

---

## 1. Sáu ràng buộc từ SRS phần cứng

Tài liệu SRS D1 & YJ-EU là đặc tả **thiết bị**, không phải đặc tả phần mềm. Nó chốt sẵn sáu điều mà nếu phát hiện muộn thì phải làm lại kiến trúc.

### 1.1. Một trụ là hai connector, không phải một
Cả D1 và YJ-EU đều là *dual gun*, module công suất đánh địa chỉ lẻ cho súng A, chẵn cho súng B.
**Chốt:** khoá nghiệp vụ là `(chargePointId, connectorId)`. `connectorId = 0` dành riêng cho trạng thái toàn trụ theo đúng OCPP 1.6.

### 1.2. Chỉ OCPP 1.6J — bỏ 2.0.1 khỏi phạm vi
Phần cứng chỉ khai báo 1.6J. Làm 2.0.1 là làm một thứ không có thiết bị nào để kiểm chứng.
**Chốt:** làm 1.6J Core + Remote Trigger. ISO 15118 và DIN 70121 nằm ở tầng xe–trụ, **ngoài phạm vi phần mềm**.

### 1.3. Trụ có pricing engine riêng — CSMS là nguồn sự thật
Trụ tự tính tiền theo khung giờ Sharp / Peak / Shoulder / Off-peak và tự hiện màn Settlement. OCPP 1.6J **không có** lệnh chuẩn để đẩy biểu giá xuống trụ.
**Chốt:** CSMS tính tiền từ `MeterValues` và là nguồn sự thật cho hoá đơn. Giá trên trụ chỉ để hiển thị. Mọi lệch so với Settlement của trụ phải sinh bản ghi đối soát.

### 1.4. Ba đường xác thực, chỉ một đường đi qua app
Quét QR trên màn hình trụ, quẹt RFID, hoặc nhập mật khẩu trên HMI. Hai đường sau bắt đầu phiên mà app không biết.
**Chốt:** CSMS phải nhận `StartTransaction` với `idTag` lạ và ghi nhận thành phiên vãng lai.
**Cơ sở kỹ thuật:** OCPP 1.6 §9.1.12 `LocalAuthorizeOffline`, §9.1.13 `LocalPreAuthorize`, §9.1.1 `AllowOfflineTxForUnknownId` — đây là hành vi spec quy định, không phải suy đoán.

### 1.5. Bốn chế độ sạc, hai chế độ app không điều khiển trực tiếp được
Qua OCPP 1.6J, app không có lệnh chuẩn để đặt hạn mức kWh hay hạn mức tiền khi remote start.
**Chốt trong bản 3 tháng:** chỉ làm chế độ sạc đầy tự động. Hạn mức mềm phía CSMS chuyển sang mục "hướng phát triển".

### 1.6. Onboarding luôn có người ở hiện trường
Server URL, Port và SN gõ tay trên HMI, bắt buộc reboot mới có hiệu lực.
**Chốt:** dashboard cần vòng đời thiết bị `Đã đăng ký → Chờ kết nối → Trực tuyến`. Mật khẩu admin mặc định `115200` là một phát hiện bảo mật đáng đưa vào báo cáo.

---

## 2. Bộ công cụ đã chốt

Dựa trên nghiên cứu nền ngày 18/08/2026. Chi tiết và nguồn dẫn ở [NGHIEN-CUU-NEN-TANG.md](NGHIEN-CUU-NEN-TANG.md).

| Vai trò | Công cụ | Giấy phép | Ghi chú |
|---|---|---|---|
| Charge point mô phỏng | **SAP e-mobility-charging-stations-simulator** | Apache-2.0 | Mặc định OCPP 1.6J. Có sẵn template DC 2 súng 50kW với MeterValues SoC/V/A/Power/Energy. Scale nhiều trạm bằng worker pool. Có buffer message khi mất WebSocket. |
| CSMS đối chứng | **SteVe**, chạy tiến trình riêng | ⚠️ phải tự kiểm | **Không fork, không copy code** — chạy riêng để so hành vi thì câu hỏi giấy phép không phát sinh |
| Load test | Mẫu **k6** của MaEVe | Apache-2.0 | 1 virtual user = 1 trạm sạc, khung OCPP 1.6J thật. MaEVe đã archived nhưng mẫu load test còn dùng được |
| Checklist tuân thủ | **76 ca `TC_*_CSMS`** trong tài liệu OCTT của OCA | công khai | Bản 2026-03 là mới nhất đã xác nhận |
| Backend | NestJS + TypeScript, PostgreSQL, Redis | | Một ngôn ngữ cho cả ba đầu ra |
| Dashboard | React + Vite + TypeScript | | |
| App | React Native / Expo | | |

### ⚠️ Việc bắt buộc: patch simulator

SAP simulator **không hỗ trợ** các key sau ở nhánh 1.6: `LocalAuthorizeOffline`, `LocalPreAuthorize`, `TransactionMessageAttempts`, `TransactionMessageRetryInterval`, `StopTxnAlignedData`, `ClockAlignedDataInterval`.

Đây chính xác là những key mà thí nghiệm nghiên cứu cần. **Nhóm phải patch nhánh 1.6 để thêm chúng** (task QA-02, 4 ngày công).

Patch một dự án Apache-2.0 rẻ hơn nhiều so với tự viết simulator từ đầu. Nếu đóng góp ngược lên upstream, đó là một điểm rất mạnh khi nói chuyện với doanh nghiệp.

### 🚨 Ba câu không được viết sai trong báo cáo

1. **"Chạy qua kịch bản OCTT" ≠ "được chứng nhận OCPP".** Chứng nhận cần test lab độc lập của OCA cộng form PICS.
2. **Chứng chỉ OCA của Powerfill không lan sang SteVe open-source.**
3. **"CitrineOS compliant OCPP 1.6" là tự khai**, không phải chứng nhận.

Sai một trong ba điều này trước hội đồng có người trong ngành là mất điểm nặng.

---

## 3. Năm work package

Quỹ mỗi người khoảng 26 ngày công thực làm trong 13 tuần, giả định 20 giờ mỗi tuần và trừ 20% cho họp, tài liệu, làm lại.

| WP | Vai trò | Sở hữu | Mốc chịu trách nhiệm |
|---|---|---|---|
| WP1 | Project Manager / BA | Đặc tả, kiến trúc, tài liệu, điều phối, khảo sát tài liệu học thuật | M1, M6 |
| WP2 | Backend / IoT Engineer | CSMS OCPP, state machine, engine đối soát | M2, M5 |
| WP3 | Mobile Developer | App tài xế, quét QR, màn hình sạc realtime | M3 |
| WP4 | Full-stack Developer | Dashboard giám sát, cảnh báo, biểu giá | M3, M4 |
| WP5 | Backend / QA Engineer | Simulator, tính tiền, thanh toán, thí nghiệm nghiên cứu | M4, M5 |

**Việc cả năm người cùng chịu:** review code lẫn nhau (mỗi PR một approve), tự viết test cho phần mình, cập nhật tài liệu trong sprint, có mặt đủ ở M3 và M6.

---

## 4. Sáu cột mốc

Mốc chỉ tính là đạt khi **toàn bộ** tiêu chí nghiệm thu đã xong. Trong 13 tuần không có chỗ cho "gần xong".

### M1 — 06/09/2026 (cuối S1) · **CỔNG CỨNG** · Đặc tả chốt, simulator chạy

Trong 3 tháng không có thời gian làm đặc tả đầy đủ như một đồ án 6 tháng. Mục tiêu là *đủ để bốn WP code song song mà không giẫm chân nhau*.

- SRS phần mềm rút gọn: use case chính, danh sách yêu cầu chức năng, NFR có ngưỡng đo được
- SDD: sơ đồ kiến trúc, ERD, đặc tả OpenAPI đã sinh mock server
- Wireframe cho luồng chính của app và dashboard (không cần prototype bấm được)
- **SAP simulator đã dựng, chạy được template trụ D1/YJ-EU hai súng, gửi MeterValues DC**
- Đã đọc file `LICENSE` của SteVe và ghi lại kết luận bằng văn bản
- Đã gọi hỏi VNPay và ít nhất một nhà cung cấp hoá đơn điện tử về điều kiện sandbox
- **GVHD duyệt bằng văn bản: bỏ 2.0.1, chấp nhận simulator, đổi đường đối chứng nghiên cứu sang ablation**

### M2 — 04/10/2026 (cuối S3) · **CỔNG KỸ THUẬT** · OCPP Core chạy thông

Trái tim kỹ thuật. Mốc này chứng minh CSMS thực sự nói được OCPP chứ không phải một CRUD gắn mác OCPP.

- Trọn bộ Core Profile hai chiều: `BootNotification`, `Heartbeat`, `StatusNotification`, `Authorize`, `StartTransaction`, `MeterValues`, `StopTransaction`
- Lệnh xuống trụ: `RemoteStartTransaction`, `RemoteStopTransaction`, `Reset`, `UnlockConnector`, `GetConfiguration`, `ChangeConfiguration`, `TriggerMessage`
- State machine giữ đúng trạng thái độc lập cho từng súng của một trụ dual gun
- MeterValues DC lưu được SoC, điện áp, dòng, kWh cộng dồn
- **Simulator đã patch xong, mô phỏng được `LocalAuthorizeOffline` và `LocalPreAuthorize`**
- Khảo sát tài liệu học thuật về OCPP reconciliation đã xong — biết đóng góp của nhóm đứng ở đâu

### M3 — 18/10/2026 (cuối S4) · Demo xuyên suốt một phiên sạc

Một mạch liền: mở app, tìm trụ, quét QR, bắt đầu sạc, xem số liệu chạy, dừng, ra chi phí.

- Kịch bản E2E chạy từ đầu đến cuối trên staging, không phải trên máy cá nhân
- App hiển thị SoC và kWh cập nhật trong vòng vài giây kể từ khi simulator gửi `MeterValues`
- Dashboard hiện đúng trạng thái hai súng của cùng một trụ theo thời gian thực
- Trình xem bản tin OCPP thô hoạt động — đây là thứ người trong ngành nhìn vào đầu tiên

### M4 — 01/11/2026 (cuối S5) · Tính tiền và vận hành thông

- Tính tiền theo bốn khung giờ Sharp / Peak / Shoulder / Off-peak, cấu hình được từ dashboard
- Đối chiếu được bản tính của CSMS với Settlement mà trụ báo
- Thanh toán VNPay sandbox chạy trọn vòng, hoặc mock service nếu không xin được sandbox
- Sinh được XML hoá đơn đúng cấu trúc NĐ 123/2020 và TT 78/2021
- Trung tâm cảnh báo bắt được bốn mã lỗi trong SRS và hiện đúng hướng xử lý
- Trụ mất kết nối quá ngưỡng heartbeat tự sinh cảnh báo

### M5 — 15/11/2026 (cuối S6) · **ĐÓNG BĂNG TÍNH NĂNG** · Đối soát và nghiên cứu xong

- Engine đối soát chạy: phát lại hàng đợi offline, phát hiện replay theo timestamp, chống trùng giao dịch, phát hiện lỗ hổng chuỗi meter
- **Thí nghiệm ablation đã chạy đủ ma trận, tối thiểu 30 phiên mỗi kịch bản**
- Có số liệu cho bốn chỉ số: tỉ lệ mất dữ liệu, độ đầy đủ bản ghi phiên, độ trễ đối soát, sai lệch kWh và tiền
- Load test k6 đã chạy, có số liệu về số trụ đồng thời CSMS chịu được
- **Đã tự chấm theo 76 ca `TC_*_CSMS` của OCTT, báo cáo đạt bao nhiêu và các ca chưa làm kèm lý do**
- Sau mốc này không nhận thêm tính năng mới

### M6 — 22/11/2026 (tuần 13) · **BẢO VỆ** · Gói bảo vệ hoàn chỉnh

- Báo cáo đầy đủ: SRS, SDD, báo cáo kiểm thử, hướng dẫn sử dụng, chương nghiên cứu kèm phân tích số liệu
- Môi trường demo dựng sẵn, có phương án dự phòng khi mạng hội đồng hỏng
- Slide xong, đã tập ít nhất hai lượt đủ 5 người
- Chuẩn bị sẵn câu trả lời: vì sao bỏ 2.0.1, vì sao CSMS tính tiền chứ không phải trụ, simulator có đủ tin cậy không, ba ca offline mandatory của OCA là gì

---

## 5. Sáu sprint

| Sprint | Ngày | Mục tiêu | Việc chính | Mốc |
|---|---|---|---|---|
| S1 | 24/08 – 06/09 | Khởi động và đặc tả | Dựng repo, CI, docker compose · SRS rút gọn · SDD và OpenAPI · dựng SAP simulator · gọi hỏi sandbox · chốt với GVHD | **M1** |
| S2 | 07/09 – 20/09 | Nền móng | Auth và RBAC · sổ đăng ký thiết bị · khung WebSocket OCPP · khung app và dashboard · patch simulator | |
| S3 | 21/09 – 04/10 | OCPP Core Profile | Trọn bộ bản tin vào và ra · state machine dual gun · lưu MeterValues DC · khảo sát tài liệu học thuật | **M2** |
| S4 | 05/10 – 18/10 | Phiên sạc E2E | Fanout realtime · quét QR ghép phiên · màn hình sạc · giám sát dashboard · trình xem bản tin OCPP | **M3** |
| S5 | 19/10 – 01/11 | Tiền và vận hành | Engine tính tiền khung giờ · VNPay sandbox · XML hoá đơn · trung tâm cảnh báo · biểu giá | **M4** |
| S6 | 02/11 – 15/11 | Đối soát và nghiên cứu | Engine đối soát · chạy thí nghiệm ablation · load test k6 · tự chấm theo OCTT | **M5** |
| W13 | 16/11 – 22/11 | Bảo vệ | Hoàn thiện báo cáo · chương nghiên cứu · slide · dựng môi trường demo · tập hai lượt | **M6** |

Không vướng Tết. Không có sprint đệm — đây là hệ quả trực tiếp của việc rút xuống 3 tháng, và là lý do phải bám sát danh sách cắt ở mục 8.

---

## 6. Bảng phân rã công việc

Ước lượng bằng ngày công của một người. Tổng 132 ngày công.

### WP1 — Quản lý dự án & Phân tích nghiệp vụ (26 ngày công)

| Mã | Công việc | Ngày | Sprint |
|---|---|---|---|
| PM-01 | Quy ước nhóm, công cụ, quy trình git, định nghĩa hoàn thành | 1 | S1 |
| PM-02 | Nghiên cứu OCPP 1.6J: bộ bản tin, §3.7 hành vi offline, mã lỗi, configuration key | 3 | S1 |
| PM-03 | Bóc tách SRS phần cứng D1/YJ-EU thành ràng buộc phần mềm | 2 | S1 |
| PM-04 | SRS phần mềm rút gọn: use case, yêu cầu chức năng, NFR có ngưỡng đo được | 5 | S1 |
| PM-05 | SDD: sơ đồ kiến trúc, ERD, OpenAPI sinh mock server | 5 | S1–S2 |
| PM-06 | Wireframe cho luồng chính của app và dashboard | 3 | S1–S2 |
| PM-07 | Điều hành sprint, biên bản GVHD, sổ rủi ro | 3 | S1–S6 |
| PM-08 | Khảo sát tài liệu học thuật về OCPP data loss / reconciliation | 2 | S2–S3 |
| PM-09 | Chủ biên báo cáo và slide | 2 | W13 |

### WP2 — CSMS OCPP & Đối soát (27 ngày công)

| Mã | Công việc | Ngày | Sprint |
|---|---|---|---|
| BE-01 | Khung backend, CI, docker compose, WSS/TLS trên staging | 2 | S2 |
| BE-02 | Máy chủ WebSocket OCPP-J 1.6, định danh trụ theo SN trên đường dẫn | 3 | S2 |
| BE-03 | Bản tin từ trụ lên: Boot, Heartbeat, StatusNotification, Authorize, Start, MeterValues, Stop | 6 | S3 |
| BE-04 | Lệnh xuống trụ: RemoteStart, RemoteStop, Reset, UnlockConnector, Get/ChangeConfiguration, TriggerMessage | 3 | S3 |
| BE-05 | State machine trụ và connector cho cấu hình súng đôi, lưu bền và khôi phục | 3 | S3 |
| BE-06 | Lưu trữ MeterValues DC: SoC, điện áp, dòng, kWh | 2 | S3 |
| BE-07 | **Engine đối soát: phát lại hàng đợi offline, phát hiện replay theo timestamp, chống trùng giao dịch, phát hiện lỗ hổng chuỗi meter** | 6 | S4, S6 |
| BE-08 | Fanout realtime qua Redis pub/sub tới app và dashboard | 2 | S4 |

### WP3 — App tài xế (26 ngày công)

| Mã | Công việc | Ngày | Sprint |
|---|---|---|---|
| MB-01 | Khởi tạo app, hệ thống thiết kế, đa ngôn ngữ Việt và Anh | 3 | S2 |
| MB-02 | Đăng ký và đăng nhập OTP, hồ sơ người dùng, quản lý xe | 4 | S2 |
| MB-03 | Bản đồ tìm trụ, bộ lọc, trạng thái realtime tới từng súng | 6 | S3–S4 |
| MB-04 | Quét QR trên màn hình trụ để ghép phiên, remote start và stop | 4 | S4 |
| MB-05 | Màn hình sạc realtime: SoC, kWh, điện áp, dòng, thời gian, chi phí | 5 | S4 |
| MB-06 | Lịch sử phiên, xem hoá đơn, báo lỗi trụ | 4 | S5 |

### WP4 — Dashboard vận hành (26 ngày công)

| Mã | Công việc | Ngày | Sprint |
|---|---|---|---|
| FE-01 | Khởi tạo web, đăng nhập, phân quyền theo vai trò | 3 | S2 |
| FE-02 | Onboarding trụ: SN, connector, site, vòng đời Đã đăng ký → Chờ kết nối → Trực tuyến | 3 | S2 |
| FE-03 | Giám sát realtime: trạng thái từng súng, danh sách phiên đang chạy | 6 | S4 |
| FE-04 | Trung tâm cảnh báo: ánh xạ mã lỗi OCPP sang hướng xử lý lấy từ SRS phần cứng | 4 | S5 |
| FE-05 | Điều khiển từ xa: start, stop, reset, mở khoá súng | 2 | S5 |
| FE-06 | Biểu giá bốn khung giờ Sharp, Peak, Shoulder, Off-peak | 4 | S5 |
| FE-07 | Analytics cơ bản: doanh thu và tỉ lệ sử dụng | 2 | S5 |
| FE-08 | **Trình xem bản tin OCPP thô** — thứ người trong ngành nhìn vào đầu tiên | 2 | S4 |

### WP5 — Simulator, Tính tiền & Nghiên cứu (27 ngày công)

| Mã | Công việc | Ngày | Sprint |
|---|---|---|---|
| QA-01 | Dựng SAP simulator, viết template trụ D1/YJ-EU hai súng DC theo đúng SRS phần cứng | 3 | S1 |
| QA-02 | **Patch nhánh 1.6 của simulator: thêm `LocalAuthorizeOffline`, `LocalPreAuthorize`, `TransactionMessageAttempts`, `TransactionMessageRetryInterval`** | 4 | S2 |
| QA-03 | Engine tính tiền theo khung giờ, làm tròn, thuế, đối chiếu Settlement của trụ | 4 | S5 |
| QA-04 | Thanh toán VNPay sandbox, hoặc mock service nếu không xin được | 4 | S5 |
| QA-05 | Sinh XML hoá đơn theo NĐ 123/2020 và TT 78/2021, mô phỏng khâu phát hành | 3 | S5 |
| QA-06 | Tự chấm theo 76 ca `TC_*_CSMS` của OCTT, lập báo cáo đạt/chưa đạt kèm lý do | 2 | S6 |
| QA-07 | Load test k6 theo mẫu MaEVe, 1 VU = 1 trạm, đo số trụ đồng thời chịu được | 2 | S6 |
| QA-08 | **Chạy thí nghiệm ablation: ma trận kịch bản, thu số liệu, phân tích** | 5 | S6 |

---

## 7. Nhánh nghiên cứu

### 7.1. Định vị — vì sao đề tài này đáng nghiên cứu

Nghiên cứu nền đã xác minh hai điều từ chính spec và tài liệu của Open Charge Alliance:

**Thứ nhất — khoảng trống có thật ở tầng giao thức.**

> OCPP 1.6 thừa nhận Central System **không có bất kỳ dấu hiệu nào ở tầng giao thức** để phân biệt message replay từ hàng đợi offline với message thời gian thực. CSMS chỉ suy đoán được qua timestamp quá khứ.
>
> Chính OCA đã vá lỗ hổng này ở **OCPP 2.0.1** bằng trường boolean `offline` và trường `seqNo` bắt buộc trong `TransactionEventRequest`.

**Thứ hai — đây là yêu cầu mức chứng nhận, không phải tính năng tùy chọn.**

> Trong OCA "Test Procedure & Test Plans" v2.4.1, ba ca **`TC_037_1`, `TC_037_3`, `TC_039`** được đánh dấu **M (Mandatory)** ở cột **Central System** — trong khi chỉ là C (Conditional) cho Charging Station.

Câu chuyện của đồ án: *chúng em xây engine đối soát lấp khoảng trống mà bản thân OCPP 1.6 thừa nhận là có, và OCA phải đợi tới 2.0.1 mới vá được ở tầng giao thức. Ba ca kiểm thử liên quan được OCA đánh dấu bắt buộc cho Central System.*

**⚠️ Nhưng khoảng trống ở spec không đồng nghĩa với tính mới học thuật.** Nhóm vẫn phải tự khảo sát IEEE Xplore, ScienceDirect, Google Scholar trước khi tuyên bố chưa ai nghiên cứu vấn đề này. Đó là task PM-08.

### 7.2. Thiết kế thí nghiệm — ablation

**Câu hỏi nghiên cứu giữ nguyên:** một CSMS tự xây đối soát dữ liệu giao dịch và đo đếm chính xác tới đâu khi đường truyền tới trụ chập chờn?

**Đường đối chứng đã đổi:** so chính CSMS khi **bật** engine đối soát với khi **tắt** engine, thay vì so với cloud của hãng.

**Lập luận bảo vệ trước hội đồng:** ablation là thiết kế sạch hơn. So với cloud của hãng thì có quá nhiều biến nhiễu cùng lúc — khác hạ tầng mạng, khác vị trí máy chủ, khác cách lưu trữ — nên nếu ra khác biệt cũng không quy được cho engine đối soát. Ablation cô lập đúng một biến, cho kết luận nhân quả thay vì tương quan. Đổi lại mất khả năng khẳng định "tốt hơn nền tảng thương mại", và nhóm ghi rõ đó là giới hạn ngay trong phần phương pháp.

| Thành phần | Thiết kế |
|---|---|
| **Biến độc lập** | Thời điểm ngắt: trước `StartTransaction`, giữa chuỗi `MeterValues`, ngay trước `StopTransaction` · Thời lượng ngắt: 10s, 60s, 5 phút, 30 phút · Số trụ đồng thời: 1, 5, 20, 50 |
| **Biến phụ thuộc** | Tỉ lệ mất dữ liệu (%) · Độ đầy đủ bản ghi phiên (%) · Độ trễ đối soát (giây) · Sai lệch kWh và tiền (%) so với giá trị thật của simulator |
| **Điều kiện đối chứng** | Cùng CSMS, cùng kịch bản, engine đối soát **tắt** |
| **Cỡ mẫu** | Tối thiểu 30 phiên mỗi tổ hợp, sinh tự động bằng simulator để tái lập được |
| **Kịch bản riêng của phần cứng này** | Phiên mở bằng RFID hoặc mật khẩu HMI trong lúc trụ đang offline — cần simulator đã patch `LocalAuthorizeOffline` và `LocalPreAuthorize` |
| **Đầu ra** | Bộ dữ liệu thô, script phân tích, biểu đồ so sánh, mô tả phương pháp đối soát đủ chi tiết để tái lập |

---

## 8. Danh sách cắt

Rút từ 6 tháng xuống 3 tháng nghĩa là mất hơn một nửa quỹ công sức. Những phần sau **đã cắt có chủ ý** và chuyển sang chương "hướng phát triển" của báo cáo:

| Phần bị cắt | Lý do |
|---|---|
| Loyalty và membership | Không phụ thuộc OCPP, không thể hiện năng lực kỹ thuật lõi |
| Đặt chỗ trước | Nghiệp vụ độc lập, thêm nhiều trạng thái phải test |
| Bảo trì định kỳ và phiếu ticket | Giữ cảnh báo sự cố — đó mới là phần gắn với OCPP |
| Admin console đầy đủ | Chỉ giữ quản lý người dùng và sổ thiết bị |
| Chọn chế độ sạc theo kWh và theo tiền | Cần hạn mức mềm phía CSMS, tốn 4 ngày công cho một tính năng khó demo |
| Thông báo đẩy | Thay bằng thông báo trong app |
| MoMo và ZaloPay | Làm sâu VNPay có giá trị hơn làm nông ba cổng |
| Smart charging profile | Ngoài phạm vi Core |
| Nhật ký kiểm toán | Giữ trình xem bản tin OCPP thô là đủ cho demo |
| Analytics sâu | Còn hai biểu đồ cơ bản |

**Nguyên tắc khi chậm tiếp:** cắt tiếp theo thứ tự analytics → onboarding nâng cao → điều khiển từ xa. **Không bao giờ cắt** OCPP Core, engine đối soát, hoặc thí nghiệm nghiên cứu — đó là ba thứ làm nên đồ án này.

---

## 9. Rủi ro

### Cao · WP5 — Patch simulator khó hơn dự kiến
Thí nghiệm nghiên cứu phụ thuộc vào việc simulator mô phỏng được `LocalAuthorizeOffline` và `LocalPreAuthorize`, mà nhánh 1.6 của SAP simulator không có sẵn.
**Đối phó:** làm patch ở S2, không để tới S6. Đã kiểm tra năm công cụ thay thế ngày 03/09/2026 — **không có đường tắt**, xem [NGHIEN-CUU-BO-SUNG-WP2.md](NGHIEN-CUU-BO-SUNG-WP2.md). Dự phòng đã xác định: `solidstudiosh/ocpp-virtual-charge-point` (Apache-2.0, Node/TS, cùng ngôn ngữ nên dễ patch nhất) — nhưng nó thiếu hàng đợi offline mà SAP đã có sẵn, nên chuyển sang là đổi việc dễ lấy việc khó.

### Cao · WP5 — Không xin được sandbox thanh toán và hoá đơn điện tử
Nghiên cứu nền **không tìm được dữ liệu nào** về điều kiện sandbox cho nhóm sinh viên không pháp nhân. Đây là không có dữ liệu, không phải không khả thi.
**Đối phó:** gọi trực tiếp trong tuần 1, song song ít nhất hai nhà cung cấp, xin giấy giới thiệu của trường. Dự phòng: mock service cho thanh toán, và tự sinh XML đúng chuẩn NĐ 123/2020 cho hoá đơn.

### Cao · Cả nhóm — 13 tuần không có sprint đệm
Một sprint trượt là trượt cả mốc kế tiếp, không có chỗ bù.
**Đối phó:** buổi ghép nối chung cuối mỗi sprint từ S3 trở đi, chạy trên staging. Chậm quá hai ngày phải báo ngay, không đợi tới review.

### Trung bình · WP1 — Giấy phép SteVe chưa chốt
Một claim nói GPL-3.0 kèm nghĩa vụ copyleft đã bị bác, một verifier khác lại ghi nhận "upstream SteVe remains GPL".
**Đối phó:** đọc file `LICENSE` ở master trong tuần 1. Và chạy SteVe như tiến trình riêng, không fork không copy code — khi đó câu hỏi giấy phép không phát sinh.

### Trung bình · WP1 — Khoảng trống spec không tự động là tính mới
Đã xác minh OCPP 1.6 thiếu marker phân biệt replay, nhưng chưa chứng minh được chưa ai công bố về vấn đề này.
**Đối phó:** task PM-08 khảo sát tài liệu học thuật, xong trước M2. Nếu phát hiện đã có người làm, điều chỉnh cách phát biểu đóng góp thay vì giấu.

### Trung bình · Công cụ — Hai dự án biến động nhanh
SteVe release 3.14.1 ngày 12/08/2026, SAP simulator push ngày 17/08/2026.
**Đối phó:** ghim version cụ thể trong `package.json` và docker compose ngay từ S1. Kiểm lại thông tin công cụ trước khi nộp báo cáo.

---

## 10. Quy tắc làm việc

**Nhịp họp** — cập nhật ngắn trên chat mỗi ngày · lập kế hoạch sprint sáng thứ Hai tuần lẻ · review và rút kinh nghiệm chiều thứ Sáu tuần chẵn · họp GVHD hằng tuần có biên bản trong 24 giờ.

**Quy trình mã nguồn** — nhánh tính năng, gộp qua pull request, không đẩy thẳng vào main · mỗi PR cần một approve và CI xanh · PR nhỏ dưới 400 dòng · main luôn triển khai được lên staging.

**Định nghĩa hoàn thành** — code đã gộp, CI xanh, có unit test cho nhánh logic chính · tài liệu API cập nhật cùng lúc · demo được trên staging · không còn lỗi mức chặn.

**Khi chậm** — cắt theo danh sách ở mục 8, không cắt OCPP Core / engine đối soát / thí nghiệm · không dời mốc, cắt phạm vi thay vì dời ngày · chậm quá hai ngày phải báo ngay.

---

*Kế hoạch xây dựng từ Phiếu đăng ký đề tài Capstone PowerMe, tài liệu SRS hợp nhất dòng trạm sạc D1 & YJ-EU, và nghiên cứu nền ngày 18/08/2026.*
