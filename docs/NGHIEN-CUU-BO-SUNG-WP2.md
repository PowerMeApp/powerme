# Nghiên cứu bổ sung WP2 — Năm công cụ chưa kiểm chứng

**Ngày:** 03/09/2026
**Mục đích:** trả lời câu hỏi mà nghiên cứu nền ngày 18/08 bỏ trống — có công cụ nào hỗ trợ sẵn `LocalAuthorizeOffline` và `LocalPreAuthorize` để nhóm khỏi phải patch SAP simulator không?

---

## Kết luận ngắn

**Không có đường tắt. Giữ nguyên kế hoạch patch SAP simulator, QA-02 vẫn 4 ngày công.**

Đây là kết quả âm tính, và nó có giá trị: nhóm không mất thêm thời gian đi tìm nữa.

Nhưng nghiên cứu tìm được **ba thứ khác đáng giá hơn cả câu hỏi ban đầu**:

1. **`ocpp-rpc` (MIT)** — thư viện tầng vận chuyển OCPP-J cho Node, giải quyết đúng phần khó nhất của BE-02
2. **Bug #496 của EVerest** — bằng chứng rằng ngay cả stack mã nguồn mở trưởng thành cũng làm sai ngữ nghĩa offline authorization
3. **Xác nhận hai quy tắc OCPP-J** mà toàn bộ tầng vận chuyển của CSMS phụ thuộc vào

---

## 1. Vì sao không có đường tắt

Cần tách rõ simulator phải làm được **hai việc** cho thí nghiệm:

| Việc | Độ khó | SAP simulator |
|---|---|---|
| **(a)** Xếp hàng đợi transaction message khi offline, phát lại đúng thứ tự khi nối lại | Khó hơn | ✅ **Đã có** — `bufferMessage()`, `flushMessageBuffer()`, `sendMessageBuffer()` |
| **(b)** Bắt đầu phiên sạc khi đang offline bằng local authorization | Dễ hơn | ❌ Không hỗ trợ `LocalAuthorizeOffline`, `LocalPreAuthorize` |

**Phần (a) là phần khó, và SAP đã làm rồi.** Mọi công cụ thay thế mà nghiên cứu tìm được đều giải quyết (b) nhưng thiếu (a) — tức là đổi một bài toán dễ lấy một bài toán khó. Không đáng.

---

## 2. Năm công cụ — kết quả từng cái

### 2.1. EVerest — cần nói cho đúng, đây là chỗ dễ viết sai

| Repo | Trạng thái |
|---|---|
| `EVerest/libocpp` — thư viện OCPP C++ | 🔴 **ĐÃ ARCHIVE 27/04/2026**, read-only · Apache-2.0 · 151 sao |
| `EVerest/everest-core` — stack chính | 🟢 **Đang hoạt động** · Apache-2.0 · push 02/09/2026 · 259 sao · 306 issue mở |

**⚠️ Không được viết "EVerest đã chết" trong báo cáo.** Dự án chính vẫn sống rất khoẻ; chỉ repo thư viện OCPP tách riêng bị archive (nhiều khả năng đã gộp vào everest-core).

**Về câu hỏi chính:** libocpp **có** implement `LocalAuthorizeOffline` và `LocalPreAuthorize` — issue #496 cho thấy người dùng cấu hình được cả hai key. Nhưng:

> Có một **bug đã biết và chưa được sửa**: khi trụ offline, việc authorize một token nằm sẵn trong Local Authorization List lại **đòi hỏi `LocalPreAuthorize = true`**, trái với ý định của spec — vì `LocalAuthorizeOffline` lẽ ra là đủ. Log cho thấy `Message timeout for: Authorize` rồi `Result for token: DEADBEEF: REJECTED`.
>
> Issue không có ai nhận, không có PR, và repo đã archive nên sẽ không bao giờ được sửa upstream.

**Kết luận:** C++, nặng, và đúng cái chức năng nhóm cần thì đang lỗi trong một repo read-only. Không dùng.

**Nhưng bug này là vàng cho báo cáo.** Nó là bằng chứng cụ thể rằng ngữ nghĩa offline authorization của OCPP 1.6 đủ mơ hồ để một stack mã nguồn mở trưởng thành, có hậu thuẫn công nghiệp, cũng cài sai. Trích nó vào phần đặt vấn đề của chương nghiên cứu.

**Nguồn:** [EVerest/libocpp#496](https://github.com/EVerest/libocpp/issues/496) · [api.github.com/repos/EVerest/libocpp](https://github.com/EVerest/libocpp) · [EVerest/everest-core](https://github.com/EVerest/everest-core)

### 2.2. ocpp-rpc (mikuso) — 🎯 phát hiện hữu ích nhất, nhưng không phải cho simulator

**MIT · Node.js · thư viện tầng vận chuyển**

Không phải simulator, không phải CSMS. Nó là **implementation của hệ thống RPC-over-WebSocket mà OCPP-J định nghĩa** — đúng phần mà bạn định tự viết ở BE-02.

Nó lo giúp bạn:
- Khung `CALL` / `CALLRESULT` / `CALLERROR` và ghép cặp request–response theo `uniqueId`
- Thoả thuận subprotocol, phục vụ được nhiều subprotocol cùng lúc
- Tương thích OCPP security profile 1, 2, 3

**Đây là thứ nên cân nhắc dùng cho CSMS của bạn**, thay vì viết tay tầng RPC. Kỷ luật "mỗi chiều chỉ một CALL đang chờ" — cái bẫy số 4 trong lộ trình — là thứ thư viện này sinh ra để xử lý.

> ⚠️ **Bẫy giấy phép:** thư viện là MIT, **nhưng các JSON schema của OCA đi kèm là CC BY-ND 4.0** (No Derivatives). Nếu dùng schema đó, không được sửa đổi chúng. Ghi nhận trong tài liệu, đừng để tới lúc bảo vệ mới phát hiện.

**Nguồn:** [mikuso/ocpp-rpc](https://github.com/mikuso/ocpp-rpc)

### 2.3. solidstudiosh/ocpp-virtual-charge-point — phương án dự phòng tốt nhất

**Apache-2.0 · Node.js + TypeScript · OCPP 1.6, 2.0.1, 2.1 · push 28/08/2026 · 118 sao**

- Cùng ngôn ngữ với ngăn xếp của nhóm → dễ patch nhất trong tất cả các lựa chọn
- Có validate theo JSON schema
- Có giao diện lệnh admin để kích hoạt từng loại bản tin cụ thể (Authorize, transaction…)
- Đa connector qua biến môi trường — hợp với cấu hình dual gun
- Trả lời được `GetConfiguration`

**Không thấy tài liệu nhắc tới:** mô phỏng ngắt kết nối, hàng đợi offline, kịch bản bản tin tuỳ ý.

**Vai trò:** phương án dự phòng nếu patch SAP simulator sa lầy. Nhưng nhớ là nó thiếu phần (a) — hàng đợi offline — nên chuyển sang nó là đổi việc dễ lấy việc khó.

**Nguồn:** [solidstudiosh/ocpp-virtual-charge-point](https://github.com/solidstudiosh/ocpp-virtual-charge-point)

### 2.4. docile-charge-point (Shell Recharge Solutions) — mạnh nhưng sai ngôn ngữ

**GPL-3.0 · Scala trên JVM · OCPP 1.5, 1.6, 2.0**

- **Kịch bản hoá được chuỗi bản tin tuỳ ý** bằng DSL Scala với `send()` và `expectIncoming()`, có cả logic điều kiện
- **Mô phỏng được rất nhiều trụ cùng lúc** theo kịch bản cho trước — hợp cho load test
- Chạy được qua dòng lệnh, REPL tương tác, Docker, hoặc nhúng làm thư viện

**Vấn đề:**
- Scala/JVM — chi phí học không nhỏ cho một nhóm làm TypeScript trong 13 tuần
- Tài liệu **không nói rõ có kịch bản hoá được thao tác ngắt kết nối** hay không — đúng thứ nhóm cần nhất
- GPL-3.0: chạy như một công cụ riêng thì không sao, nhưng tuyệt đối không nhúng vào sản phẩm

**Đáng ghi nhận trong báo cáo** như một công cụ kiểm thử OCPP đáng chú ý do một nhà vận hành trạm sạc thật xây dựng.

**Nguồn:** [ShellRechargeSolutionsEU/docile-charge-point](https://github.com/ShellRechargeSolutionsEU/docile-charge-point)

### 2.5. ocpp-go (lorenzodonini) — không phù hợp

Hỗ trợ cả vai trò Central System lẫn Charge Point cho OCPP 1.6. Nhưng README **không hề nhắc** tới hành vi offline, hàng đợi transaction message, hay các configuration key liên quan. Ngôn ngữ Go, không thuộc ngăn xếp của nhóm.

**Kết luận:** bỏ qua.

**Nguồn:** [lorenzodonini/ocpp-go](https://github.com/lorenzodonini/ocpp-go)

---

## 3. Hai quy tắc OCPP-J đã được xác nhận

Cả hai đều là điều tầng vận chuyển của CSMS phải tuân thủ, và cả hai đã được kiểm chứng lại:

### 3.1. Thoả thuận subprotocol — chi tiết còn khắt khe hơn tưởng

Server **phải** trả lời `Sec-WebSocket-Protocol: ocpp1.6`.

Và phần thường bị bỏ sót: **nếu CSMS không chấp nhận subprotocol nào mà client đề nghị, nó phải hoàn tất bắt tay WebSocket với response KHÔNG có header `Sec-WebSocket-Protocol`, rồi đóng kết nối ngay lập tức.** Không phải từ chối bắt tay — mà là bắt tay xong rồi đóng.

Cài sai chỗ này, trụ thật sẽ hành xử khó đoán và bạn sẽ mất nửa ngày tưởng là lỗi mạng.

### 3.2. Mỗi chiều chỉ một CALL đang chờ

Xác nhận: **chỉ được có một CALL chưa hoàn tất tại một thời điểm, tính riêng cho mỗi chiều** (trụ→CSMS và CSMS→trụ). Hai chiều độc lập với nhau vì kết nối là hai chiều.

Nghĩa là CSMS cần **hai hàng đợi cho mỗi kết nối**, không phải một. Thiết kế điều này vào từ đầu.

---

## 4. Tài liệu học nên dùng

**[ocpp.md](https://ocpp.md/ocpp-1.6j/)** — tài liệu tham chiếu miễn phí có cấu trúc cho OCPP 1.6J. Bao phủ trọn vòng đời giao dịch, quy tắc xếp hàng đợi khi offline, cấu hình retry, dự phòng local authorization, trình tự khi nối lại kèm quy tắc rút hàng đợi theo FIFO, và các chuyển đổi trạng thái `StatusNotification` kèm quy tắc ưu tiên. Có sơ đồ tuần tự cho boot, authorization và khôi phục sau offline.

Điểm đáng tin: tài liệu **tự đánh dấu ba chỗ nó không chắc** (context của meter value, hành vi `MinimumStatusDuration`, và chính sách token lạ khi offline) và ghi rõ đó là chỗ cần người phát triển quyết định.

> ⚠️ **Dùng làm bản đồ, không dùng làm nguồn trích dẫn.** Nó được dựng từ mô hình đối chiếu lại với spec PDF, không phải văn bản gốc. Trong báo cáo luôn trích spec OCPP 1.6 edition 2, không bao giờ trích ocpp.md.

---

## 5. Kế hoạch thay đổi thế nào

| Mục | Trước | Sau |
|---|---|---|
| QA-02 patch SAP simulator | 4 ngày công | **Giữ nguyên 4 ngày công** — không tìm được đường tắt |
| BE-02 máy chủ WebSocket OCPP-J | 3 ngày công, viết tay tầng RPC | **Cân nhắc dùng `ocpp-rpc` (MIT)** — có thể giảm còn 2 ngày, và tránh được bẫy one-outstanding-call |
| Rủi ro "patch simulator sa lầy" | Dự phòng: kiểm tra 5 công cụ | **Dự phòng đã xác định: `ocpp-virtual-charge-point`** (Apache-2.0, Node/TS) — nhưng phải tự thêm hàng đợi offline |
| Chương nghiên cứu, phần đặt vấn đề | Chỉ có khoảng trống ở spec | **Thêm bug EVerest #496** làm bằng chứng thực nghiệm rằng ngữ nghĩa offline đủ mơ hồ để stack trưởng thành cài sai |

---

## 6. Việc còn để ngỏ

- **Kiểm tra `docile-charge-point` có kịch bản hoá được thao tác ngắt kết nối không.** Nếu có, nó là công cụ tốt nhất cho ma trận thí nghiệm — đáng nửa ngày đọc mã nguồn dù phải chạm vào Scala.
- **Đọc mã `ocpp-rpc`** để xác nhận nó thật sự cưỡng chế kỷ luật one-outstanding-call, hay chỉ cung cấp khung RPC và để người dùng tự lo.
- **Khảo sát tài liệu học thuật** (PM-08) vẫn chưa làm — vẫn chưa biết đã có ai công bố về data loss/reconciliation trong OCPP hay chưa.

---

*Bổ sung cho [NGHIEN-CUU-NEN-TANG.md](NGHIEN-CUU-NEN-TANG.md). Mọi thông tin repo kiểm tra ngày 03/09/2026 qua GitHub API.*
