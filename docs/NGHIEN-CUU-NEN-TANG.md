# Nghiên cứu nền — Công cụ, giao thức và định vị nghiên cứu cho PowerMe

**Ngày thực hiện:** 18/08/2026
**Phương pháp:** 5 hướng tìm kiếm song song → 23 nguồn được fetch → 115 claim trích xuất → 25 claim đưa vào kiểm chứng đối kháng 3 phiếu → **21 claim được xác nhận, 4 claim bị bác**.

---

## ⚠️ Đọc phần này trước

**Hai trong năm hướng nghiên cứu không có claim nào sống sót vòng kiểm chứng:**

| Hướng | Trạng thái |
|---|---|
| Hướng 3 — Sandbox VNPay/MoMo/ZaloPay và hóa đơn điện tử cho nhóm sinh viên không pháp nhân | **KHÔNG CÓ DỮ LIỆU** |
| Hướng 4 — Phạm vi khả thi trong 3 tháng, ước lượng công sức từ dự án tương tự | **KHÔNG CÓ DỮ LIỆU** |
| Hướng 5 — nửa về tiêu chí đánh giá của doanh nghiệp và cạm bẫy kỹ thuật khi tự xây CSMS | **KHÔNG CÓ DỮ LIỆU** |

Đây là *không tìm được bằng chứng*, tuyệt đối không được đọc thành *không khả thi* hoặc *đã bị bác bỏ*. Hai hướng này phải giải quyết bằng cách khác: gọi điện trực tiếp cho nhà cung cấp, và hỏi kinh nghiệm của GVHD.

Ba hướng còn lại (công cụ, hành vi offline của OCPP 1.6J, ý nghĩa của OCPP compliance testing) có nền bằng chứng vững và là nội dung chính của báo cáo này.

---

## 1. Công cụ: dùng gì, không dùng gì

### 1.1. Simulator — SAP e-mobility-charging-stations-simulator ✅ *khuyến nghị*

**Độ tin cậy: cao (3-0)**

| Tiêu chí | Kết quả |
|---|---|
| Giấy phép | **Apache-2.0** — OSI, dùng thương mại được, chỉ ràng buộc attribution/NOTICE |
| Giao thức | OCPP 1.6 là **mặc định** (`ocppVersion` default `1.6`, `ocppProtocol: json`) |
| Bộ bản tin | Đủ 16 message Core 1.6, cộng Firmware, LocalAuthList, Reservation, SmartCharging, RemoteTrigger. Validate PDU theo JSON schema của OCA ở strict mode |
| Trụ DC hai súng | Có sẵn template `abb.station-template.json`: `numberOfConnectors: 2`, mỗi súng `maximumPower: 50000` kèm MeterValues **SoC / Voltage / Power / Current / Energy** |
| Nhiều trụ đồng thời | `stationTemplateUrls: [{file, numberOfStations}]` + ba mô hình worker (`workerSet` / `fixedPool` / `dynamicPool`). Bên thứ ba báo cáo chạy >1000 trạm trên một instance Node.js |
| Mô phỏng mất kết nối | `autoReconnectMaxRetries`, `reconnectExponentialDelay` có jitter; UI có thủ tục **Open Connection / Close Connection** để chủ động cắt kết nối |
| Hàng đợi khi offline | Có `messageQueue`, `bufferMessage()` ("Buffers an OCPP message for deferred sending when connection is unavailable"), `flushMessageBuffer()`, `sendMessageBuffer()` gate theo trạng thái WebSocket |
| Còn sống | `archived: false`, push gần nhất **17/08/2026** (một ngày trước khi kiểm), 222 sao / 96 fork, copyright "2020–2026 SAP SE" |

**⚠️ Hạn chế quan trọng — đây là việc phải làm, không phải lý do loại bỏ:**

README mục "OCPP-J standard parameters supported → Version 1.6" đánh dấu **KHÔNG hỗ trợ** các key sau ở nhánh 1.6:

`LocalAuthorizeOffline` · `LocalPreAuthorize` · `TransactionMessageAttempts` · `TransactionMessageRetryInterval` · `StopTransactionOnEVSideDisconnect` · `StopTxnAlignedData` · `StopTxnSampledData` · `ClockAlignedDataInterval`

Các key `QueueAllMessages` / `OfflineThreshold` / `OfflineQueuingSeverity` chỉ có ở nhánh 2.0.1.

**Đây chính xác là những key mà thí nghiệm nghiên cứu cần.** Nghĩa là nhóm phải **patch simulator** để thêm chúng vào nhánh 1.6. Tin tốt: patch một dự án Apache-2.0 rẻ hơn nhiều so với tự viết simulator từ đầu, và nếu đóng góp ngược lên upstream thì đó là một điểm rất mạnh khi nói chuyện với doanh nghiệp.

**Nguồn:**
- https://github.com/SAP/e-mobility-charging-stations-simulator
- `src/types/ChargingStationTemplate.ts` · `src/assets/station-templates/abb.station-template.json` · `src/charging-station/Helpers.ts`

### 1.2. SteVe — dùng làm CSMS đối chứng, **KHÔNG copy code**

**Độ tin cậy: cao (3-0) về mặt kỹ thuật · giấy phép CHƯA CHỐT**

SteVe (`steve-community/steve`) là CSMS 1.6J-native tốt nhất để đối chiếu hành vi: hỗ trợ OCPP 1.2/1.5/1.6 cả SOAP lẫn JSON kèm Security Extensions.

Implementation OCPP của nó đã được xác thực **gián tiếp** qua chứng nhận OCA của sản phẩm thương mại phái sinh Powerfill (OCPP 1.6 Core + C + S).

**🚨 Hai cảnh báo phải nhớ:**

1. **Chứng chỉ OCA của Powerfill KHÔNG lan sang bản open-source của SteVe.** Không được viết trong báo cáo rằng SteVe đã được chứng nhận.

2. **Giấy phép của SteVe chưa chốt.** Một claim nói GPL-3.0 kèm nghĩa vụ copyleft đã **bị bác (1-2)**, nhưng một verifier khác lại ghi nhận "upstream SteVe remains GPL". **Nhóm phải tự mở file `LICENSE` ở nhánh master và đọc trước khi chạm vào bất kỳ dòng code nào.**

   **Cách tránh rủi ro hoàn toàn:** chạy SteVe như một *tiến trình riêng biệt* để so sánh hành vi, không fork, không copy code. Khi đó câu hỏi giấy phép không phát sinh.

**Nguồn:** https://github.com/steve-community/steve · https://openchargealliance.org/participants/powerfill-technologies-ltd/ · https://powerfill.io/certification

### 1.3. CitrineOS — nặng hơn nhu cầu

**Độ tin cậy: cao (3-0)**

Kiến trúc gốc theo **OCPP 2.0.1** (module chia theo Functional Block của 2.0.1, ghép nối qua message broker). Hỗ trợ 1.6 chỉ được thêm từ **v1.6.0 công bố 07/04/2025**.

Với đồ án chỉ nhắm 1.6J trong 3 tháng, đây là lựa chọn nặng hơn cần thiết.

**⚠️ Sắc thái dễ viết sai:** "CitrineOS compliant OCPP 1.6" là **marketing tự khai**, không phải chứng nhận OCA.

### 1.4. MaEVe (Thoughtworks) — đã chết, nhưng bộ load test còn dùng được

**Độ tin cậy: cao (3-0)**

Repo đã **ARCHIVE và read-only từ 02/06/2025**, tự nhận là experimental/work-in-progress. **Không xây PowerMe trên nó.**

Nhưng **bộ load test k6 của nó tái sử dụng trực tiếp được**: 1 virtual user = 1 trạm sạc, gửi khung OCPP 1.6J thật, kèm Prometheus + Grafana. Đây là cách chứng minh CSMS chịu được tải nhiều trụ mà không cần một mảnh phần cứng nào — rất thuyết phục khi demo cho doanh nghiệp.

**Nguồn:** `loadtests/ws_load_test.js` trong https://github.com/thoughtworks/maeve-csms

### 1.5. mobilityhouse/ocpp — chỉ là thư viện, không phải CSMS

**Độ tin cậy: cao (3-0)**

Python, **MIT**, cài bằng một lệnh pip. Cho sẵn tầng message OCPP 1.6J: Call / CallResult / CallError + 78 JSON schema v1.6 + routing.

**Nó KHÔNG có:** WebSocket server, persistence, state machine giao dịch, offline reconciliation, billing. Toàn bộ phần đó là công việc của nhóm — tức là phần lõi của đồ án vẫn nguyên vẹn, thư viện chỉ tiết kiệm khâu parse và validate.

**⚠️ Bẫy đặt tên:** PyPI có package `ocpp` version 2.1.0 — đó là version của **package**, không phải version của **giao thức**. Rất dễ nhầm và viết sai trong báo cáo.

### 1.6. Năm công cụ chưa được kiểm chứng

Không có claim nào được xác minh về: **EVerest · ocpp-rpc (mikuso) · OCPP-CP-simulator · ocpp-go · CitrineOS dùng làm simulator**.

Đặc biệt đáng tiếc: một trong số này có thể mô phỏng sẵn `LocalAuthorizeOffline` / `LocalPreAuthorize` — thứ mà SAP simulator xác nhận không hỗ trợ. Nếu có, nhóm sẽ đỡ phải tự patch. Đây là việc đáng bỏ nửa ngày kiểm tra thủ công.

**⚠️ Một claim bị bác mạnh nhất (0-3):** "MaEVe dùng EVerest làm charge station simulator trong bộ e2e". **Không được viết điều này trong báo cáo.**

---

## 2. Hành vi offline trong OCPP 1.6J — nền tảng cho phần nghiên cứu

### 2.1. Spec quy định gì (§3.7, mục NORMATIVE)

**Độ tin cậy: cao (3-0)**

- Charge point **MUST** xếp hàng đợi mọi transaction-related message khi mất kết nối: `StartTransaction.req`, `StopTransaction.req`, `MeterValues.req` định kỳ và clock-aligned
- Message không thuộc giao dịch (ví dụ `Authorize`) **MAY** vượt hàng
- Message giao dịch mới **SHALL** đợi tới khi hàng đợi rỗng, để đảm bảo đúng thứ tự thời gian
- §3.7.1 định nghĩa retry **TUYẾN TÍNH** qua `TransactionMessageAttempts` và `TransactionMessageRetryInterval`
- Chỉ được **BỎ** message khi Central System liên tục báo "failure to process"

**⚠️ Lỗi phổ biến cần tránh:** backoff ở §3.7.1 là **tuyến tính**, không phải exponential — nhiều nguồn thứ cấp viết nhầm. Và cơ chế retry này áp cho đường CallError khi đang **online**, không phải là thuật toán đối soát offline.

### 2.2. Ba chế độ local authorization

**Độ tin cậy: cao (3-0)**

OCPP 1.6 định nghĩa ba hành vi riêng biệt, điều khiển bằng ba configuration key độc lập:

| Key | Mục | Ý nghĩa |
|---|---|---|
| `LocalAuthorizeOffline` | §9.1.12 | Authorize khi offline bằng Authorization Cache / Local Authorization List |
| `LocalPreAuthorize` | §9.1.13 | Khởi tạo giao dịch không chờ `Authorize.conf` |
| `AllowOfflineTxForUnknownId` | §9.1.1, §3.5.4 | Unknown Offline Authorization |

Khi khôi phục kết nối, charge point **SHALL** gửi `StartTransaction` cho mọi giao dịch đã authorize offline, kèm xử lý `StopTransactionOnInvalidId` / reason `DeAuthorized` nếu CSMS từ chối idTag.

**Liên hệ với PowerMe:** đây chính là cơ sở kỹ thuật cho ràng buộc đã phát hiện từ SRS phần cứng — phiên mở bằng RFID hoặc mật khẩu HMI khi trụ đang offline. Không phải nhóm tự nghĩ ra, mà là hành vi spec quy định.

### 2.3. 🎯 Khoảng trống để định vị đóng góp nghiên cứu

**Độ tin cậy: cao (3-0) — đây là phát hiện giá trị nhất của toàn bộ nghiên cứu này**

> **OCPP 1.6 thừa nhận Central System KHÔNG có bất kỳ dấu hiệu nào ở tầng giao thức để phân biệt message replay từ hàng đợi offline với message thời gian thực.** CSMS chỉ có thể suy đoán qua timestamp quá khứ, và spec khuyến nghị xử lý "như mọi message khác".
>
> **Chính OCA đã vá lỗ hổng này ở OCPP 2.0.1** bằng trường boolean `offline` và trường `seqNo` bắt buộc trong `TransactionEventRequest`.

Đây là một khoảng trống **có thật, đã xác minh từ chính spec**, và có bằng chứng rằng tổ chức chuẩn hóa cũng công nhận nó là vấn đề — vì họ đã sửa ở phiên bản sau.

Câu chuyện của đồ án trở thành: *"Chúng em xây engine đối soát lấp khoảng trống mà bản thân OCPP 1.6 thừa nhận là có, và OCA phải đợi tới 2.0.1 mới vá được ở tầng giao thức."*

**⚠️ Nhưng khoảng trống ở spec ≠ tính mới học thuật.** Đã xác minh chắc chắn là spec thiếu marker, **nhưng chưa có khảo sát tài liệu nào chứng minh chưa ai công bố về vấn đề này**. Nhóm vẫn phải tự khảo sát IEEE Xplore / ScienceDirect / Google Scholar trước khi tuyên bố tính mới. Nguồn học thuật duy nhất chạm chủ đề (bài IIETA về công cụ kiểm tra tuân thủ OCPP 1.6) lại bị phát hiện **đếm sai số test case** so với tài liệu gốc — chất lượng nguồn thứ cấp trong lĩnh vực này thấp.

---

## 3. OCPP compliance testing — thước đo để tự chấm

### 3.1. CSMS là System Under Test hạng nhất

**Độ tin cậy: cao (3-0)**

Tài liệu test case OCPP 1.6 của OCA có hẳn **Section 3 "System Under Test (SUT) Central System"** với **đúng 76 test case ID dạng `TC_*_CSMS`** (so với 102 ID `TC_*_CS` phía Charge Point, tổng 178). Trải khắp Core, Cache, Local Authorization List, FirmwareManagement, Diagnostics, Reservation, RemoteTrigger, SmartCharging, DataTransfer và Security.

**Đây là bề mặt tuân thủ công khai, đếm được, mà một CSMS tự xây có thể tự đo mình theo.** Với 3 tháng, nhóm không làm hết 76 ca — nhưng tự chấm và báo cáo "đạt X/76, đây là danh sách các ca chưa làm và lý do" mạnh hơn nhiều so với không có thước đo nào.

### 3.2. 🎯 Luận điểm mạnh nhất về độ nghiêm túc công nghiệp

**Độ tin cậy: cao (3-0)**

> Trong OCA **"Test Procedure & Test Plans" v2.4.1**, ba ca **`TC_037_1`, `TC_037_3` và `TC_039`** được đánh dấu **M (Mandatory)** ở cột **Central System** — trong khi chỉ là **C (Conditional)** cho Charging Station.
>
> Ba ca này là về xử lý giao dịch offline replay.

Nghĩa là: **xử lý đúng giao dịch offline replay là yêu cầu ở mức chứng nhận cho một Central System, không phải tính năng nice-to-have.**

Song song, `TC_036_CS` quy định luật thứ tự và khoảng cách timestamp chính xác cho MeterValues bị dồn hàng khi mất kết nối.

Đây là câu trả lời trực tiếp cho câu hỏi "tại sao nhóm chọn nghiên cứu đối soát dữ liệu offline": vì OCA bắt buộc, không phải vì nhóm thấy hay.

### 3.3. ⚠️ Ba sắc thái tuyệt đối không được viết sai

1. **"Chạy qua kịch bản OCTT" ≠ "được chứng nhận OCPP".** Chứng nhận cần test lab độc lập của OCA cộng form PICS. OCTT là công cụ trả phí, sinh viên khó tiếp cận.
2. **Chứng chỉ OCA của Powerfill không lan sang SteVe open-source.**
3. **"CitrineOS compliant OCPP 1.6" là tự khai**, không phải chứng nhận.

Viết sai một trong ba điều này trước hội đồng có người trong ngành là mất điểm nặng.

### 3.4. Nguồn tài liệu OCTT

URL đổi theo tháng phát hành (2024-04, 2024-11, 2025-02, 2025-04, 2025-09, 2026-03). **Nên trích bản 2026-03** — mới nhất đã xác nhận còn giữ nguyên ba ca offline mandatory:

`https://openchargealliance.org/wp-content/uploads/2026/03/CompliancyTestTool-TestCaseDocument.pdf`

---

## 4. Tổ hợp công cụ khuyến nghị

**Độ tin cậy: trung bình — đây là suy luận tổng hợp từ các claim nền, không phải trích dẫn trực tiếp**

| Vai trò | Công cụ | Giấy phép |
|---|---|---|
| Charge point mô phỏng + máy phát tải | **SAP e-mobility-charging-stations-simulator** (patch thêm key offline cho nhánh 1.6) | Apache-2.0 |
| CSMS đối chứng để so hành vi | **SteVe**, chạy tiến trình riêng, không copy code | ⚠️ phải tự kiểm |
| Chứng minh chịu tải | Mẫu **k6** của MaEVe (1 VU = 1 trạm) | Apache-2.0 |
| Checklist kỹ thuật để tự chấm | **76 ca `TC_*_CSMS`** trong tài liệu OCTT | công khai |
| Tham chiếu tầng message (nếu dùng Python) | **mobilityhouse/ocpp** | MIT |

Trong đó **ba ca offline mandatory là hạng mục demo trọng tâm** trước cả hội đồng lẫn doanh nghiệp.

---

## 5. Bốn claim đã bị bác — loại khỏi báo cáo

| Claim | Phiếu |
|---|---|
| SteVe là GPL-3.0 nên sản phẩm phái sinh phải mở nguồn theo GPL | 1-2 |
| Danh sách phiên bản mobilityhouse/ocpp hỗ trợ, và "OCPP 2.1 không được hỗ trợ" | 1-2 |
| MaEVe phục vụ cả 1.6j lẫn 2.0.1 trên cùng một gateway | 1-2 |
| MaEVe dùng EVerest làm charge station/EV simulator trong bộ e2e | **0-3** |

---

## 6. Hạn chế của chính nghiên cứu này

1. **Truy cập nguồn:** PDF spec trên `downloads.regulations.gov` trả HTTP 403 với fetcher tự động. Nội dung §3.7 được xác minh qua bản sao độc lập trong repo mobilityhouse/ocpp (cùng tiêu đề và ngày "edition 2 FINAL, 2017-09-28"). **Không đọc được OCPP 1.6 Errata sheet v4.0 (2019)** để chắc chắn §3.7/§3.7.1 không bị sửa — rủi ro tồn dư nhỏ. Lập luận gián tiếp: schema 1.6 của OCA tới nay vẫn không có trường `offline`/`seqNo`.

2. **Tính thời sự:** mọi kiểm chứng thực hiện ngày 18/08/2026. SteVe release 3.14.1 ngày 12/08/2026, SAP simulator push ngày 17/08/2026 — **hai dự án biến động nhanh, phải kiểm lại trước khi nộp báo cáo.**

3. **Ba mảng trắng** đã nêu ở đầu tài liệu.

---

## 7. Việc cần làm tiếp

| Việc | Ai | Khi nào |
|---|---|---|
| Mở file `LICENSE` của SteVe ở master, đọc và ghi lại kết luận | WP1 | Trước khi chạm code |
| Gọi trực tiếp VNPay / MoMo hỏi điều kiện sandbox cho nhóm sinh viên | WP5 | Tuần 1 |
| Gọi Viettel Invoice / VNPT / MISA hỏi sandbox hóa đơn điện tử | WP5 | Tuần 1 |
| Xin giấy giới thiệu của trường để hỗ trợ hai việc trên | WP1 + GVHD | Tuần 1 |
| Kiểm tra thủ công ocpp-rpc, OCPP-CP-simulator, EVerest xem có sẵn `LocalAuthorizeOffline` không | WP5 | Tuần 1, nửa ngày |
| Khảo sát tài liệu học thuật (IEEE, ScienceDirect, Scholar) về OCPP data loss / reconciliation | WP1 | Trước M2 |
| Hỏi GVHD về ước lượng công sức từ các nhóm khóa trước | WP1 | Buổi gặp đầu |
