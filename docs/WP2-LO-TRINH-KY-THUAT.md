# WP2 — Lộ trình kỹ thuật cho Backend / IoT Integration Engineer

**Vai trò:** CSMS OCPP, state machine trụ và connector, engine đối soát, fanout realtime
**Quỹ:** 27 ngày công · **Cổng phải qua:** M2 ngày 04/10/2026
**Giai đoạn học:** 18/08 – 06/09/2026 (trước khi code thật bắt đầu ở S2)

> Bạn giữ phần rủi ro cao nhất của đồ án. Nếu M2 trượt thì M3, M4, M5 trượt theo, vì cả app lẫn dashboard đều chờ dữ liệu từ CSMS. Đổi lại, đây cũng là phần duy nhất mà doanh nghiệp thực sự nhìn vào khi đánh giá năng lực.

---

## Nguyên tắc: chạy trước, đọc sau

Đừng bắt đầu bằng việc đọc 200 trang spec. Bắt đầu bằng việc **nhìn thấy OCPP thật chạy trên dây**.

Lý do: OCPP là giao thức đơn giản đến mức nhàm chán, nhưng cực kỳ nhiều chi tiết ngầm. Đọc spec trước, bạn sẽ nhớ được khoảng 20%. Xem traffic thật trước rồi mới đọc spec, bạn sẽ đọc với câu hỏi trong đầu và nhớ được phần lớn.

---

## Tuần 1 (18/08 – 23/08) — Nhìn thấy giao thức chạy

### Ngày 1–2: Dựng bàn thí nghiệm

Mục tiêu: một trụ ảo nói chuyện được với một CSMS có sẵn, và bạn đọc được từng bản tin.

```
SAP simulator  ──WebSocket──>  SteVe  (CSMS tham chiếu)
        │                         │
        └──────> proxy/log <──────┘
```

**Việc cụ thể:**

1. Clone và chạy **SteVe** bằng Docker. Đây là CSMS tham chiếu, bạn không viết gì cả, chỉ để nó làm đối tượng cho trụ ảo kết nối vào.
2. Clone **SAP e-mobility-charging-stations-simulator**, dùng template `abb.station-template.json` (đã có sẵn `numberOfConnectors: 2` — đúng cấu hình dual gun của D1/YJ-EU).
3. Trỏ simulator vào SteVe, đăng ký chargeBoxId trong SteVe, bật kết nối.
4. **Bắt và đọc traffic.** Cách đơn giản nhất: viết một WebSocket proxy ~50 dòng đứng giữa, log mọi frame ra file JSON. Đừng dùng Wireshark cho việc này — proxy tự viết cho bạn log đọc được ngay và tái dùng được suốt đồ án.

> ⚠️ Ghim version cụ thể ngay từ đầu. SteVe release 3.14.1 ngày 12/08/2026, SAP simulator push 17/08/2026 — hai dự án biến động nhanh, để `latest` là tự chuốc rắc rối vào tháng 10.

### Ngày 3: Đọc một phiên sạc hoàn chỉnh trên log

Chạy một phiên từ đầu đến cuối, rồi ngồi đọc log và tự vẽ lại sequence diagram **bằng tay**. Không copy từ Internet.

Bạn phải trả lời được, chỉ bằng cách nhìn log:

- Bản tin đầu tiên trụ gửi là gì, CSMS trả về những trường nào
- `Heartbeat` xuất hiện bao lâu một lần, ai quyết định khoảng đó
- Trước khi sạc, trụ đi qua mấy trạng thái, mỗi trạng thái báo bằng bản tin nào
- `transactionId` do ai sinh ra và xuất hiện lần đầu ở đâu
- `MeterValues` gửi bao lâu một lần, chứa những measurand nào, đơn vị gì
- Khi kết thúc, những số nào được chốt và ở bản tin nào

Khi bạn tự vẽ được sequence diagram này mà không cần nhìn tài liệu, coi như đã nắm được 60% những gì cần cho M2.

### Ngày 4–5: Ngắt kết nối giữa phiên — phần cốt lõi của đồ án

Đây là nơi đề tài của nhóm sống hoặc chết. Làm thí nghiệm thủ công trước khi viết bất cứ dòng code đối soát nào.

Simulator có thủ tục **Open Connection / Close Connection** trong UI để chủ động cắt kết nối. Chạy ba kịch bản:

| Kịch bản | Câu hỏi cần trả lời từ log |
|---|---|
| Cắt kết nối **giữa chuỗi MeterValues**, nối lại sau 60 giây | Trụ có gửi bù các MeterValues bị lỡ không? Timestamp của chúng là lúc đo hay lúc gửi? |
| Cắt kết nối **ngay trước StopTransaction**, nối lại sau 5 phút | StopTransaction về sau có đầy đủ không? `transactionData` chứa gì? |
| Cắt kết nối, **bắt đầu phiên mới khi đang offline**, rồi nối lại | StartTransaction đến muộn được xử lý thế nào? CSMS có phân biệt được nó là replay không? |

**Ghi lại kết quả thô vào file.** Đây chính là dữ liệu nền cho chương nghiên cứu, và cũng là thứ chứng minh với thầy rằng bạn đã hiểu vấn đề trước khi bắt tay xây.

---

## Tuần 2 (24/08 – 30/08) — Đọc spec, nhưng chỉ những phần cần

Spec OCPP 1.6 edition 2 có bản sao trong repo `mobilityhouse/ocpp` tại `docs/v16/`. **Đừng đọc tuần tự.** Đọc theo thứ tự ưu tiên dưới đây.

### Ưu tiên 1 — Phải thuộc

| Phần | Nội dung | Vì sao |
|---|---|---|
| **§3.7 và §3.7.1** | Hành vi offline: trụ **MUST** xếp hàng đợi mọi transaction-related message khi mất kết nối, gửi lại đúng thứ tự thời gian. Retry là **TUYẾN TÍNH** qua `TransactionMessageAttempts` và `TransactionMessageRetryInterval` | Nền tảng của toàn bộ phần nghiên cứu. Đây là mục normative, không phải khuyến nghị |
| **§9.1** configuration keys | Đặc biệt: `LocalAuthorizeOffline` (§9.1.12), `LocalPreAuthorize` (§9.1.13), `AllowOfflineTxForUnknownId` (§9.1.1), `MeterValueSampleInterval`, `HeartbeatInterval` | Đây là các nút vặn của thí nghiệm. Không hiểu chúng thì không thiết kế được ma trận kịch bản |
| **§3.5.4** | Unknown Offline Authorization | Khớp trực tiếp với ràng buộc từ SRS phần cứng: phiên mở bằng RFID hoặc mật khẩu HMI khi trụ đang offline |
| Core Profile operations | 7 bản tin phải làm: `BootNotification`, `Heartbeat`, `StatusNotification`, `Authorize`, `StartTransaction`, `MeterValues`, `StopTransaction` | Đây là toàn bộ M2 |

> ⚠️ **Lỗi phổ biến:** backoff ở §3.7.1 là **tuyến tính**, không phải exponential. Nhiều blog và bài báo thứ cấp viết nhầm. Và cơ chế retry này áp cho đường CallError khi đang **online**, không phải là thuật toán đối soát offline — đừng nhầm hai thứ.

### Ưu tiên 2 — Phải tra được khi cần

- Enum `ChargePointStatus`: Available, Preparing, Charging, SuspendedEV, SuspendedEVSE, Finishing, Reserved, Unavailable, Faulted
- Enum `ChargePointErrorCode` — ánh xạ sang bốn mã lỗi trong SRS phần cứng D1/YJ-EU
- Cấu trúc `MeterValue`: measurand, unit, phase, location, context — đặc biệt các measurand DC mà trụ gửi: `SoC`, `Voltage`, `Current.Import`, `Power.Active.Import`, `Energy.Active.Import.Register`
- Enum `Reason` trong `StopTransaction`, đặc biệt `DeAuthorized`
- Enum `AuthorizationStatus`: Accepted, Blocked, Expired, Invalid, ConcurrentTx

### Ưu tiên 3 — Bỏ qua hoàn toàn

Firmware Management, Diagnostics, Reservation, Smart Charging, Local Auth List. Ngoài phạm vi 3 tháng. Chỉ cần biết chúng tồn tại để trả lời hội đồng.

### Mẹo: đọc JSON schema thay vì đọc văn bản

Repo `mobilityhouse/ocpp` có sẵn **78 JSON schema v1.6** của OCA. Đọc schema nhanh hơn đọc văn bản spec rất nhiều, vì nó cho bạn chính xác trường nào bắt buộc, kiểu gì, enum gồm những giá trị nào. Dùng schema làm tài liệu chính, dùng văn bản spec để hiểu *tại sao*.

---

## Tuần 2–3 — OCPP-J: tầng vận chuyển, nơi nhiều người sập

Spec OCPP-J là **tài liệu riêng**, tách khỏi spec OCPP 1.6. Ngắn hơn nhiều và bạn phải đọc hết.

### Sáu chi tiết làm hỏng implementation của người mới

**1. Khung bản tin.** Mọi thứ là JSON array, không phải object:
```
CALL        [2, "<uniqueId>", "<Action>", {payload}]
CALLRESULT  [3, "<uniqueId>", {payload}]
CALLERROR   [4, "<uniqueId>", "<errorCode>", "<description>", {details}]
```

**2. Subprotocol negotiation.** Client gửi header `Sec-WebSocket-Protocol: ocpp1.6`. Server **phải echo lại** đúng giá trị đó trong response. Nếu không, nhiều trụ thật sẽ ngắt kết nối ngay — và bạn sẽ mất nửa ngày tưởng là lỗi mạng.

**3. Định danh trụ nằm trên URL, không nằm trong payload.** Đường dẫn kiểu `/ocpp/{chargeBoxId}`. Đây là điều duy nhất cho bạn biết trụ nào đang gọi, trước cả `BootNotification`. Thiết kế routing quanh chi tiết này.

**4. Mỗi chiều chỉ được có một CALL đang chờ tại một thời điểm.** Không được pipeline nhiều request. Đây là ràng buộc của OCPP-J mà rất nhiều implementation tự viết vi phạm, vì WebSocket thì cho phép. Vi phạm nó, trụ thật sẽ hành xử khó đoán. Hãy dựng một hàng đợi per-connection ngay từ đầu, đừng chữa sau.

**5. Heartbeat của OCPP ≠ ping/pong của WebSocket.** Hai cơ chế keepalive hoàn toàn khác nhau, phục vụ hai mục đích khác nhau. WebSocket ping/pong phát hiện kết nối chết ở tầng TCP. OCPP `Heartbeat` là bản tin ứng dụng, đồng thời để trụ đồng bộ thời gian với CSMS. **Bạn cần cả hai.** Thiếu ping/pong, bạn sẽ giữ hàng nghìn kết nối zombie mà không biết.

**6. Timeout và trường hợp mất CallResult.** Nếu trụ gửi `StartTransaction` mà không nhận được `StartTransaction.conf`, nó sẽ gửi lại. Nếu CSMS của bạn không idempotent, bạn vừa tạo **hai giao dịch cho một phiên sạc**. Đây là bug kinh điển nhất của CSMS tự xây — và nó cũng chính là một trong những thứ engine đối soát phải xử lý.

---

## Bốn cái bẫy phải thiết kế để tránh, không phải sửa sau

Ghi bốn điều này lên tường. Chúng quyết định kiến trúc, sửa sau rất đắt.

### 1. Idempotency của StartTransaction và StopTransaction
Trụ có thể gửi lại cùng một bản tin nhiều lần: mất CallResult, replay từ hàng đợi offline, hoặc trụ reboot giữa phiên. CSMS phải nhận diện được "tôi đã xử lý bản tin này rồi" mà không dựa vào `transactionId` — vì lúc trụ gửi `StartTransaction` thì `transactionId` chưa tồn tại.
**Gợi ý:** khoá tự nhiên là `(chargeBoxId, connectorId, idTag, meterStart, timestamp)`. Suy nghĩ kỹ về nó ở S2, đừng để tới S6.

### 2. Lệch đồng hồ giữa trụ và server
Timestamp trong `StartTransaction` là đồng hồ **của trụ**, và đồng hồ đó có thể sai. SRS phần cứng nói trụ đồng bộ qua NTP để pricing engine chạy đúng — nhưng nếu NTP hỏng thì sao? Bạn không được tin timestamp của trụ một cách vô điều kiện, nhưng cũng không được vứt nó đi, vì đó là bằng chứng duy nhất về thứ tự thời gian khi replay.
**Cần quyết định:** lưu cả hai — timestamp của trụ và thời điểm CSMS nhận được. Chênh lệch giữa chúng chính là tín hiệu để phát hiện replay.

### 3. Đơn vị đo
`meterStart` và `meterStop` tính bằng **Wh**, không phải kWh. Nhầm đơn vị ở đây là sai hóa đơn gấp 1000 lần. Đặt kiểu dữ liệu rõ ràng trong code và viết test cho nó.

### 4. Dual gun là hai giao dịch độc lập trên một kết nối WebSocket
Một trụ D1/YJ-EU có hai súng, nhưng chỉ một kết nối WebSocket tới CSMS. Hai phiên sạc có thể chạy song song, mỗi phiên trên một `connectorId`. State machine phải giữ trạng thái riêng cho từng connector, và `connectorId = 0` là trạng thái của toàn trụ chứ không phải của súng nào.

---

## Phần nghiên cứu — hiểu chính xác đóng góp của bạn nằm ở đâu

Đây là phần thuộc về bạn nhiều nhất, vì engine đối soát là BE-07.

**Khoảng trống đã được xác minh từ chính spec:**

> OCPP 1.6 thừa nhận Central System **không có bất kỳ dấu hiệu nào ở tầng giao thức** để phân biệt message replay từ hàng đợi offline với message thời gian thực. CSMS chỉ suy đoán được qua timestamp quá khứ, và spec khuyến nghị xử lý "như mọi message khác".
>
> Chính OCA đã vá lỗ hổng này ở **OCPP 2.0.1** bằng trường boolean `offline` và trường `seqNo` bắt buộc trong `TransactionEventRequest`.

Nói cách khác: **engine đối soát của bạn đang làm bằng heuristic thứ mà 2.0.1 làm được bằng một trường dữ liệu.** Đó chính xác là đóng góp — và cũng là lý do nó khó.

**Và đây không phải tính năng nice-to-have:** trong tài liệu test của OCA, ba ca `TC_037_1`, `TC_037_3`, `TC_039` về xử lý giao dịch offline replay được đánh dấu **M (Mandatory)** cho Central System, chỉ là Conditional cho Charging Station. Đọc ba ca này sớm — chúng cho bạn đặc tả gần như hoàn chỉnh của engine đối soát, miễn phí.

**Các heuristic bạn sẽ phải cân nhắc và đo đạc:**

- Timestamp lệch xa so với hiện tại → nghi ngờ replay
- Chuỗi `MeterValues` có lỗ hổng thời gian → có dữ liệu bị mất, hoặc sắp có replay bù vào
- `StartTransaction` đến sau khi đã có phiên khác kết thúc trên cùng connector → thứ tự bị đảo
- Trùng khoá tự nhiên → duplicate, bỏ qua nhưng phải ghi log
- `StopTransaction` cho một `transactionId` chưa từng thấy `StartTransaction` → phiên mồ côi, cần chính sách xử lý

Mỗi heuristic là một biến trong thí nghiệm ablation. Đó là lý do engine phải **bật tắt được**, không phải viết cứng.

---

## Chuẩn bị kỹ thuật ngoài OCPP

Ba thứ bạn cần vững, không liên quan đến giao thức nhưng quyết định chất lượng:

**WebSocket server chịu tải trong Node.** Thư viện `ws`. Cần nắm: backpressure khi client chậm, phát hiện kết nối chết bằng ping/pong kèm `terminate()`, và giới hạn bộ nhớ khi giữ hàng nghìn kết nối. Đây là thứ load test k6 ở S6 sẽ phơi bày.

**PostgreSQL cho dữ liệu chuỗi thời gian.** `MeterValues` là bảng lớn nhất hệ thống. Cần nắm: partition theo tháng, chỉ mục phù hợp cho truy vấn theo `(transactionId, timestamp)`, và insert theo lô thay vì từng dòng.

**Mô hình hóa state machine.** Trạng thái connector là một máy trạng thái thật với các chuyển đổi hợp lệ và không hợp lệ. Viết nó thành bảng chuyển trạng thái tường minh, đừng để rải rác trong các câu `if`. Khi trụ báo một chuyển đổi không hợp lệ, đó là dữ liệu quý — ghi log lại, đừng nuốt.

---

## Tự kiểm: bạn đã sẵn sàng cho S2 chưa

Trả lời được hết những câu sau mà không tra tài liệu, nghĩa là bạn sẵn sàng viết code:

- [ ] Vẽ được sequence diagram đầy đủ của một phiên sạc, từ BootNotification tới StopTransaction
- [ ] Giải thích được `transactionId` do ai sinh, khi nào, và tại sao trụ không tự sinh được
- [ ] Nói được ba cách một phiên sạc có thể bắt đầu, và cách nào CSMS không biết trước
- [ ] Giải thích được vì sao CSMS không phân biệt được replay với message thời gian thực trong OCPP 1.6
- [ ] Chỉ ra được ít nhất ba cách một CSMS ngây thơ sẽ tạo trùng giao dịch
- [ ] Biết `meterStart` đơn vị gì
- [ ] Giải thích được khác nhau giữa WebSocket ping/pong và OCPP Heartbeat
- [ ] Đã tự tay ngắt kết nối giữa phiên và đọc được log của cái xảy ra sau đó

---

## Việc làm ngay hôm nay

1. **Dựng SteVe + SAP simulator, cho chúng nói chuyện với nhau.** Trước mọi thứ khác.
2. **Viết WebSocket proxy log traffic** — 50 dòng, dùng suốt đồ án.
3. **Tải spec OCPP 1.6 edition 2 và 78 JSON schema** từ repo `mobilityhouse/ocpp`, lưu vào `docs/reference/`.
4. ~~Kiểm tra năm công cụ chưa được kiểm chứng~~ — **đã làm xong ngày 03/09/2026**, kết quả ở [NGHIEN-CUU-BO-SUNG-WP2.md](NGHIEN-CUU-BO-SUNG-WP2.md). Tóm tắt: không có đường tắt, vẫn phải patch SAP simulator. Nhưng tìm được **`ocpp-rpc` (MIT)** — thư viện tầng vận chuyển OCPP-J cho Node, nên cân nhắc dùng cho BE-02 thay vì viết tay tầng RPC.
5. **Đọc ba ca `TC_037_1`, `TC_037_3`, `TC_039`** trong tài liệu OCTT bản 2026-03. Chúng là đặc tả miễn phí cho engine đối soát của bạn.

---

*Tài liệu này thuộc kế hoạch PowerMe 13 tuần. Xem [KE-HOACH-POWERME.md](KE-HOACH-POWERME.md) cho bối cảnh và [NGHIEN-CUU-NEN-TANG.md](NGHIEN-CUU-NEN-TANG.md) cho nguồn dẫn của các phát hiện được trích ở trên.*
