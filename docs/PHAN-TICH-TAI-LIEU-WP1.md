# Phân tích tài liệu WP1 — góc nhìn WP2 và Team Leader

**Người đọc:** Ngô Văn Minh Trí — WP2 (CSMS) kiêm Team Leader
**Tài liệu phân tích:** PowerMe Doc (Google Docs, 169 trang) của Trần Đức Ân — WP1
**Ngày:** 12/09/2026

---

## 0. Đánh giá chung

Khối tài liệu này tốt hơn mức thường thấy ở đồ án capstone rất nhiều. Đáng ghi nhận cụ thể:

- **Nó tự đánh dấu chỗ nó không chắc.** Gần như mọi bảng đều ghi rõ đâu là trích từ nguồn, đâu là đề xuất của WP1 chưa ai duyệt. Đó là thói quen tài liệu tốt và sẽ bảo vệ được trước hội đồng.
- **Nó phát hiện ba thay đổi pháp lý mà phiếu đăng ký bỏ sót:** Nghị định 70/2025/NĐ-CP (hiệu lực 01/6/2025, sửa NĐ 123/2020), và **Luật Bảo vệ Dữ liệu Cá nhân (PDPL) có hiệu lực 01/01/2026** thay phần lớn Nghị định 13/2023. Đây là phát hiện thật, ảnh hưởng trực tiếp tới WP2 và WP5.
- **Nó sửa một nhầm lẫn trong chính phiếu đăng ký và charter:** "SteVe-compatible simulator" là sai — SteVe là CSMS tham chiếu, không phải simulator. Khớp với kết luận nghiên cứu nền của chúng ta.
- **Lịch được neo vào lộ trình SWP490 15 tuần chính thức của trường**, thay vì một Gantt tự vẽ. Đây là thứ giá trị nhất trong toàn bộ tập tài liệu.

Nhưng có **bốn xung đột trực diện** với những gì đã commit vào repo và với kế hoạch WP2. Bốn việc này cần xử lý trước, vì để lâu thì mỗi tuần trôi qua là mỗi tuần code đi sai hướng.

---

## 1. 🚨 Xung đột lớn nhất: ngăn xếp backend — Python hay Node

### Tình trạng

| Nguồn | Kết luận |
|---|---|
| **Tech Stack Recommendation của WP1** §1, §1.2, §6 | **Python + FastAPI + `mobilityhouse/ocpp`** — "Recommendation stands" |
| **Repo đã commit** (`ec00190`, 03/09) | **NestJS + TypeScript**, monorepo npm workspaces, ba đầu ra chung một ngôn ngữ |
| **Tài liệu kiến trúc WP2** (ADR-0003, ADR-0004) | **Node.js 24 + NestJS + `ocpp-rpc`** |

Hai hướng này không thể cùng đúng. Và tình trạng hiện tại là repo đang đi một đường, tài liệu chính thức của dự án đang ghi một đường khác.

### Lập luận của WP1 — và chỗ nó hổng

WP1 kết luận Node không khả thi dựa trên khảo sát hệ sinh thái thư viện OCPP cho Node (§1.2). Ba thư viện được xét:

| Thư viện WP1 xét | Tín hiệu cộng đồng WP1 ghi nhận |
|---|---|
| `ocpp-ws-io` | 2 sao GitHub |
| `@extrawest/node-ts-ocpp` | không công bố số liệu |
| `@node-ocpp/core` | v0.6.1-beta, ~8 lượt tải/tuần |

Từ đó WP1 kết luận: *"không có thư viện OCPP Node nào có track record gần bằng mobilityhouse/ocpp hoặc ocpp-go"*, nên chọn Node đồng nghĩa với phải **tự viết tầng bản tin OCPP 1.6J từ đầu**.

**Kết luận đó dựa trên một khảo sát thiếu.** Cả ba gói trên đều không phải gói Node được dùng nhiều nhất cho OCPP-J. Số liệu kiểm chứng ngày 12/09/2026:

| Thư viện | Sao GitHub | Fork | Tải/tháng trên npm | Giấy phép | Hoạt động |
|---|---|---|---|---|---|
| **`ocpp-rpc` (mikuso)** | **135** | **43** | **26.355** | MIT | push 21/08/2026 |
| `ocpp-ws-io` | 2 | 2 | **493** | — | — |
| `mobilityhouse/ocpp` (Python) | ~1.000 | 384 | — | MIT | release 07/2025 |

**`ocpp-rpc` được tải nhiều gấp khoảng 53 lần thư viện Node tốt nhất mà WP1 tìm được.** Nó tồn tại từ 2022, vẫn đang được bảo trì, và tôi đã đọc trực tiếp mã nguồn để xác minh nó làm đúng những thứ OCPP-J đòi hỏi:

- `callConcurrency` mặc định **1**, chú thích trong mã ghi nguyên văn *"OCPP requires this to be set to 1"*
- Lấy định danh trụ từ đoạn cuối URL
- Tự phân tích Basic Auth với username = identity → hỗ trợ Security Profile 1 và 2
- Thoả thuận subprotocol qua tuỳ chọn `protocols`
- `strictMode` validate theo **schema OCA có sẵn** cho `ocpp1.6`, `2.0.1`, `2.1`
- `callTimeoutMs` 60s, `pingIntervalMs` 30s

Nói cách khác: **tiền đề "chọn Node = phải tự viết tầng OCPP" không đúng.** Nó đúng với ba thư viện WP1 xét, nhưng không đúng với hệ sinh thái Node nói chung.

### Điều này KHÔNG có nghĩa WP1 sai hoàn toàn

Hai luận điểm khác của WP1 vẫn đứng vững và cần ghi nhận:

1. **Cùng một thư viện ở cả hai đầu.** `mobilityhouse/ocpp` làm được cả vai trò Charge Point lẫn Central System, nên simulator và CSMS dùng chung một cách hiểu spec. Đây là lợi ích thật. `ocpp-rpc` cũng có cả client lẫn server nên lợi ích này vẫn giữ được nếu simulator viết bằng Node — nhưng nếu WP5 dùng SAP simulator thì hai bên là hai codebase khác nhau.
2. **Python không chậm ở bài toán này.** Phân tích §1.1 của WP1 hoàn toàn đúng: công việc của CSMS là I/O-bound, độ trễ bị chi phối bởi round-trip tới trụ, DB và VNPay, không phải bởi ngôn ngữ. Đừng dùng lý do "Node nhanh hơn" để chọn Node — lý do đó sai và sẽ bị hội đồng bắt.

### Lý do thật để giữ Node

Không phải hiệu năng. Là ba điều này:

- **ADR-0001 đã chốt monorepo với `packages/shared`** để ba đầu ra định nghĩa hợp đồng API **một lần**. Với backend Python, `packages/shared` mất tác dụng cho phía CSMS — phải sinh client hai lần, hoặc đồng bộ kiểu dữ liệu thủ công giữa Python và TypeScript. Chính WP1 viết trong ADR-0001 rằng lệch hợp đồng API là rủi ro trực tiếp lên cột mốc M3/E2E.
- **Repo, CI, docker compose, CODEOWNERS đã dựng quanh npm workspaces** và đã commit. Đổi sang Python là làm lại `ec00190`.
- **Theo chính RACI Matrix của WP1**, hàng "Tech stack recommendation": WP1 là *Responsible (đề xuất)*, **WP2 là Accountable cho lựa chọn backend/DB**. Nghĩa là quyền quyết định backend là của bạn, không phải của WP1. WP1 cũng tự viết trong mục Escalation: *"WP1 không có thẩm quyền quyết định cách tiếp cận kỹ thuật của WP khác — mọi tài liệu 'recommendation' là đầu vào để WP sở hữu chấp nhận, sửa, hoặc bác bỏ."*

### Khuyến nghị

**Giữ NestJS + TypeScript + `ocpp-rpc`. Nhưng phải làm ba việc, không được im lặng ghi đè.**

1. Gửi WP1 số liệu `ocpp-rpc` ở trên để họ cập nhật Tech Stack §1.2 — đây là sửa một khảo sát thiếu, không phải phủ quyết quan điểm.
2. Ghi thành ADR chính thức trong `docs/adr/` (ADR-0003 và ADR-0004 trong tài liệu kiến trúc WP2 đã viết sẵn), nêu rõ **lý do là ADR-0001 và `packages/shared`, không phải hiệu năng**.
3. Ghi nhận công bằng trong ADR: Python + `mobilityhouse/ocpp` là lựa chọn hợp lệ, bị loại vì phá vỡ việc dùng chung kiểu dữ liệu của monorepo, không phải vì kém hơn về kỹ thuật.

> ⚠️ **Trước khi chốt, tự trả lời thật lòng một câu:** bạn thạo TypeScript hay Python hơn? Rủi ro R-A02 trong sổ rủi ro của WP1 — *"nhóm dựa vào code AI sinh ra mà không hiểu, rồi hỏng khi hội đồng hỏi vì sao nó chạy"* — là rủi ro có thật, và nó áp vào WP2 nặng nhất vì CSMS là phần hội đồng sẽ đào sâu. Chọn ngôn ngữ bạn tự bảo vệ được, không phải ngôn ngữ đẹp trên giấy.

---

## 2. 🚨 Lịch: kế hoạch 13 tuần của chúng ta lệch với lộ trình chính thức

Đây là chỗ tài liệu WP1 **đúng hơn kế hoạch tôi đã lập cho bạn**, và cần sửa lại kế hoạch.

WP1 lấy lộ trình SWP490 15 tuần chính thức của trường, giả định **Tuần 1 bắt đầu thứ Hai 07/09/2026**:

| Tuần | Mốc | Ngày theo giả định của WP1 | Hạn nộp hồ sơ |
|---|---|---|---|
| 1–3 | Làm việc với GVHD | 07/09 – 27/09 | Report 1, Report 2, SRS tổng quan |
| **4–5** | **Review 1** | **28/09 – 11/10** | **hồ sơ hạn cuối Tuần 3 = ~27/09** |
| **6** | **Khoá phiếu đăng ký** | **12/10 – 18/10** | Sau mốc này không sửa phạm vi được nữa |
| 8–9 | Review 2 | 26/10 – 08/11 | hồ sơ hạn cuối Tuần 7 |
| 10–13 | Phát triển & kiểm thử | 09/11 – 06/12 | Report 5 & 6 |
| **14** | **Hội đồng 1.1** | **07/12 – 13/12** | hồ sơ hạn cuối Tuần 13 |
| **15** | **Hội đồng 1.2 — Bảo vệ** | **14/12 – 20/12** | Report 7 + slide |

**Hệ quả cho bạn, ngay hôm nay:**

- Nếu giả định Tuần 1 đúng, **hôm nay 12/09 là cuối Tuần 1**. Hồ sơ Review 1 đến hạn khoảng **27/09 — còn hơn hai tuần**.
- **Khoá phiếu đăng ký cuối Tuần 6 (~18/10)** là hạn thật cho mọi thay đổi phạm vi. Hội đồng 1.1 chấm sản phẩm đối chiếu với phiếu đã khoá. Nghĩa là: danh sách cắt tính năng, phân tầng Core/Target/Stretch, và cả **ADR-0012 về thẻ ví** — nếu có ảnh hưởng phạm vi thì phải chốt trước 18/10.
- Kế hoạch 13 tuần tôi lập cho bạn (S1 bắt đầu 24/08, bảo vệ 22/11) **neo sai gốc**. Nó dựa trên giả định của tôi về ngày bắt đầu, không dựa trên lộ trình trường. **Lộ trình của WP1 thắng.** Cần neo lại toàn bộ mốc WP2 vào Tuần 1–15, không phải vào lịch riêng.
- **Nhịp build phải nhắm Hội đồng 1.1 (Tuần 14), không phải buổi bảo vệ (Tuần 15).** WP1 nói đúng: Tuần 15 chỉ còn để làm Report 7 và slide.

**Việc còn treo:** cả WP1 lẫn tôi đều đang giả định Tuần 1 = 07/09. **Chưa ai xác nhận với thầy Phương.** Đây là câu hỏi W4 trong gói họp nhóm của WP1 và là việc quan trọng nhất cần hỏi. Mọi ngày ở trên dịch theo cùng độ lệch nếu sai.

---

## 3. 🚨 Danh sách cắt tính năng của tôi mâu thuẫn với mục tiêu điểm 8–9

Cái này là lỗi của tôi và cần nói thẳng.

Charter §3.3 của WP1 định nghĩa ba tầng. Nhóm tuyên bố nhắm **8–9, stretch 10**. Theo charter, tầng **Target chính là thanh 8–9**, và Target đòi:

- Loyalty **chạy thật, không phải stub**
- Analytics doanh thu/sử dụng thật, không chỉ log thô
- **Toàn bộ** taxonomy lỗi triển khai xuyên suốt trụ → CSMS → dashboard
- Thí nghiệm đối soát làm **đúng phương pháp trong phiếu đăng ký**: nhiều kịch bản ngắt kết nối, đo tỉ lệ mất dữ liệu, độ đầy đủ bản ghi, độ trễ đối soát
- Tài liệu bóng bẩy, nhất quán

Còn kế hoạch 13 tuần tôi lập **đã cắt**: loyalty, đặt chỗ, bảo trì định kỳ, admin console đầy đủ, analytics sâu, MoMo/ZaloPay.

**Đối chiếu thì danh sách cắt đó đưa nhóm về đúng tầng Core — tức là mức qua môn, không phải 8–9.** Tôi cắt dựa trên quỹ 132 ngày công mà không biết nhóm đã tuyên bố mục tiêu điểm số.

Hai đường đi, phải chọn một:

| | Giữ mục tiêu 8–9 | Chấp nhận Core |
|---|---|---|
| Hệ quả | Phải khôi phục loyalty, analytics, taxonomy lỗi đầy đủ, thí nghiệm nhiều kịch bản | Sản phẩm gọn, chắc, nhưng khó vượt mức qua môn |
| Điều kiện | Quỹ công sức phải lớn hơn 132 ngày công — tức mỗi người làm hơn 20 giờ/tuần, hoặc kéo dài tới Tuần 14 thay vì 13 tuần | Không đổi gì |

Lộ trình 15 tuần thực ra **cho nhiều thời gian hơn** kế hoạch 13 tuần của tôi, nên hướng giữ 8–9 là khả thi — nhưng phải neo lại lịch trước (mục 2) rồi mới tính lại quỹ công sức.

**Đây là quyết định của cả nhóm, không phải của riêng WP2.** Đưa vào buổi sync đầu tiên.

---

## 4. Simulator: hai đề xuất khác nhau, cần chốt

| | WP1 đề xuất | Nghiên cứu của chúng ta đề xuất |
|---|---|---|
| Chính | `mobilityhouse/ocpp` (thư viện Python) | **SAP e-mobility-charging-stations-simulator** (Apache-2.0, TypeScript) |
| Phụ | `mockpoint` (YAML, giấy phép chưa rõ) | `ocpp-virtual-charge-point` (Apache-2.0, Node) |
| Bản chất | **Thư viện** — WP5 tự viết simulator bằng Python | **Ứng dụng sẵn** — có template trạm, chỉ cấu hình |

Điểm mấu chốt WP1 chưa biết: **SAP simulator có sẵn template trụ DC hai súng 50 kW với MeterValues gồm SoC, điện áp, dòng, công suất, năng lượng** — đúng cấu hình D1/YJ-EU, và có sẵn cơ chế buffer bản tin khi mất WebSocket cùng thủ tục chủ động cắt kết nối. Đó chính là hai thứ thí nghiệm đối soát cần, có sẵn không phải viết.

Nhưng SAP simulator cũng có điểm yếu mà nghiên cứu của ta đã xác minh: **nhánh 1.6 không hỗ trợ `LocalAuthorizeOffline`, `LocalPreAuthorize`, `TransactionMessageAttempts`, `TransactionMessageRetryInterval`** — phải tự patch, ước tính 4 ngày công.

**Khuyến nghị:** SAP simulator làm chính, vì phần khó (hàng đợi offline + phát lại) đã có sẵn. Nếu backend là TypeScript thì WP5 cũng patch được bằng ngôn ngữ đã biết. `mobilityhouse/ocpp` vẫn giữ lại làm tài liệu tra cứu schema — gói `.whl` đã nằm trong `ocppdl/` của repo.

Việc này thuộc WP5 (Khang) quyết, WP2 tư vấn.

---

## 5. Những gì WP1 đang chờ ở bạn — và bạn đã trả lời được bao nhiêu

Gói "First Team Sync" §1 liệt kê chính xác những gì WP1 cần Trí xác nhận. Tin tốt: **tài liệu kiến trúc WP2 đã trả lời phần lớn.**

| WP1 hỏi | Trạng thái |
|---|---|
| Mở rộng nhánh WP2 trong WBS xuống mức task | ✅ Có rồi — mục 6 tài liệu kiến trúc WP2 (BE-01…BE-08) |
| Quy ước `connectorId` ↔ Gun A/B | ✅ **Trùng khớp hoàn toàn** — cả hai đều chốt 0 = toàn trụ, 1 = Gun A, 2 = Gun B |
| Auth nào đi qua `Authorize` (trụ khởi xướng) vs `RemoteStartTransaction` (app khởi xướng) | ✅ ADR-0012 trả lời: QR qua app → RemoteStart; RFID và mật khẩu là trụ khởi xướng |
| MeterValues measurand nào trụ thật gửi | 🔶 Đã liệt kê `SoC`, `Voltage`, `Current.Import`, `Power.Active.Import`, `Energy.Active.Import.Register` — nhưng vẫn cần trụ thật xác nhận |
| ChangeConfiguration key nào firmware hỗ trợ | 🔴 Chưa — cần hỏi hãng Ruihua |
| W9: endpoint IPN của VNPay nằm ở WP2 hay WP3 | ✅ Kiến trúc WP2 trả lời: module `payments` chạy trong `apps/csms` → **IPN thuộc WP2** |
| W8: WP5 có API riêng hay đi qua WP2 | ✅ Kiến trúc WP2 trả lời: module WP5 chạy chung tiến trình, đọc dữ liệu qua repository của `metering` → **đi qua WP2** |
| W10: ai sở hữu dataset trạm | 🔶 Kiến trúc WP2 đặt bảng `charge_points` trong CSMS → **WP2 sở hữu**, WP4 chỉ onboard qua API |
| Thiết kế đối soát/kết nối lại | ✅ ADR-0005, ADR-0010, bảng `reconciliation_records` |

**Nghĩa là bạn có thể đóng 6 trong 9 câu hỏi đang chặn WP1 ngay trong buổi sync đầu tiên,** chỉ bằng cách đưa tài liệu kiến trúc WP2 ra. Đó là đòn bẩy lớn cho vai trò Team Leader.

---

## 6. Ba thứ WP1 có mà tài liệu WP2 của bạn còn thiếu

Đây là chiều ngược lại — chỗ WP1 làm tốt hơn và WP2 phải bổ sung.

**1. Nghĩa vụ bảo vệ dữ liệu cá nhân theo PDPL (hiệu lực 01/01/2026).**
Ghi chú DPIA của WP1 kết luận: bản ghi phiên sạc **một khi gắn với driver ID và dữ liệu chi phí thì nhiều khả năng là dữ liệu cá nhân nhạy cảm**, không phải dữ liệu ứng dụng thông thường. Hệ quả trực tiếp cho WP2:
- Bảng `transactions` và `meter_values` cần **kiểm soát truy cập riêng**, không để mọi vai trò đọc như nhau.
- **Chính sách lưu trữ chưa ai định nghĩa** — WP1 ghi rõ "không WP nào sở hữu việc này". Tài liệu kiến trúc WP2 cũng thiếu. Cần bổ sung một ADR về retention.

**2. Quyết định vùng hosting.**
Tech Stack §5 của WP1 nêu: hosting ở AWS Singapore **về mặt pháp lý là chuyển dữ liệu xuyên biên giới** theo PDPL và NĐ 13/2023. Có tuỳ chọn AWS Hanoi Local Zone (GA 19/06/2026) nếu muốn dữ liệu nằm trong nước, nhưng đắt hơn. Kiến trúc WP2 hiện chỉ ghi "Docker Compose trên một VPS" mà chưa nói vùng. Cần một dòng quyết định có ý thức, kể cả khi quyết định là "chấp nhận đơn giản hoá cho phạm vi capstone".

**3. FCM cho thông báo đẩy.**
WP1 §7.1 chỉ ra WebSocket không đánh thức được app đang chạy nền — cần Firebase Cloud Messaging cho sự kiện phiên kết thúc và cảnh báo lỗi. Kiến trúc WP2 đã cắt thông báo đẩy khỏi phạm vi. Nếu giữ mục tiêu 8–9 thì phải khôi phục, và nó là việc của WP2 (gửi) + WP3 (nhận).

---

## 7. Bốn điểm cần báo lại cho WP1

Không phải để bắt lỗi — để tài liệu chung đúng, vì Hội đồng 1.1 chấm sản phẩm đối chiếu tài liệu.

1. **Khảo sát thư viện Node thiếu `ocpp-rpc`** (mục 1). Cần cập nhật Tech Stack §1.2, vì kết luận hiện tại dựa trên tiền đề không đầy đủ.
2. **Thẻ ví trả trước là phát hiện mới, chưa có trong tài liệu WP1.** Primer §5 của WP1 chỉ ghi "Offline mode also supports Plug & Play". Nhưng manual D1 mục 3.4 còn có chế độ **"Wallet ID card"** — thẻ có số dư, **trụ tự trừ tiền ngay tại chỗ, kể cả khi offline**, phân biệt với "Online IDcard" là thẻ chỉ xác thực. Manual YJ-EU cũng có bước "Check IC Card Balance".
   Hệ quả: **có phiên sạc mà tiền đã được thu tại trụ, không qua CSMS.** Nếu billing của WP5 thu tiếp qua VNPay thì khách bị trừ hai lần. Điều này chạm vào Requirements Analysis §3.2 (thiếu trường "ai thu tiền") và toàn bộ mục 4 của tài liệu DPIA. Xem ADR-0012 trong tài liệu kiến trúc WP2.
3. **"plug-and-charge" trong manual Ruihua ≠ Plug & Charge theo ISO 15118.** WP1 đã cảnh báo đúng điều này ở Tech Stack §7.3, nhưng Primer §5 lại viết "Offline mode also supports Plug & Play" mà không kèm cảnh báo. Nên thống nhất gọi là **free vend** trong mọi tài liệu.
4. **Vấn đề tên hãng đã được WP1 giải quyết rồi** — Charter §3.1 ghi rõ D1/YJ-EU của Jiangxi Ruihua là "technical stand-in" cho hardware gọi là "ChargeLink" trong phiếu đăng ký. Vậy "ChargeLink" là **tên thay thế có chủ ý**, không phải nhầm lẫn. Tôi từng đưa việc này vào agenda gặp GVHD như một điểm vênh — **rút lại, nó không phải vấn đề.**

---

## 8. Việc cần làm, theo thứ tự

| # | Việc | Ai | Khi nào |
|---|---|---|---|
| 1 | **Hỏi thầy xác nhận ngày bắt đầu Tuần 1.** Mọi mốc phụ thuộc vào nó | Trí hoặc Ân | Ngay tuần này |
| 2 | **Ấn định nhịp họp (mục 1.1.6 của WP1).** Đây là nút thắt đang chặn ít nhất 6 việc khác, và theo RACI thì Team Leader là Accountable — tức là bạn | **Trí** | Ngay |
| 3 | Chốt ngăn xếp backend, ghi ADR, gửi số liệu `ocpp-rpc` cho WP1 | Trí quyết, WP1 cập nhật tài liệu | Trước Review 1 |
| 4 | Neo lại kế hoạch WP2 vào lộ trình 15 tuần thay vì lịch 13 tuần | Trí | Trước Review 1 |
| 5 | Cả nhóm quyết: giữ mục tiêu 8–9 hay chấp nhận Core, rồi tính lại quỹ công sức | Cả nhóm | Trước khoá phiếu Tuần 6 |
| 6 | Đưa ADR-0012 (thẻ ví) cho WP1 và WP5 — ảnh hưởng phạm vi nên phải vào trước khi khoá phiếu | Trí | Trước Tuần 6 |
| 7 | Bổ sung chính sách lưu trữ và kiểm soát truy cập dữ liệu nhạy cảm vào kiến trúc WP2 | Trí | Trước Review 2 |
| 8 | Dựng bàn thí nghiệm OCPP, chạy phiên đầu tiên qua simulator | Trí | Song song, càng sớm càng tốt |

---

## 9. Một lời thẳng

Tài liệu của WP1 rất dày, và phần lớn do AI hỗ trợ tạo ra — chính WP1 ghi nhận điều đó trong Charter §4 và rủi ro R-A02. Tài liệu kiến trúc WP2 của bạn cũng vậy.

Rủi ro R-A02 mà WP1 tự viết ra đáng được đọc lại nghiêm túc: *"nhóm dựa vào code và tài liệu do AI sinh mà không thực sự hiểu, rồi hỏng ở phần hỏi đáp khi hội đồng truy vì sao nó hoạt động."*

Với WP2 điều này gấp đôi, vì CSMS là phần hội đồng đào sâu nhất và là nơi đặt câu hỏi nghiên cứu. Một tài liệu kiến trúc đẹp mà không tự giải thích được từng quyết định thì tệ hơn một tài liệu mỏng mà bạn nắm chắc.

Cách kiểm tra rẻ nhất: bàn thí nghiệm OCPP ở mục 8. Dựng SteVe với SAP simulator, bắt gói WebSocket, **tự tay vẽ lại sequence diagram từ log thật**. Một buổi làm việc đó sẽ cho bạn biết ngay bạn thực sự hiểu bao nhiêu trong những gì đã viết ra.

---

*Phân tích dựa trên: PowerMe Doc (Google Docs, 169 trang) đọc ngày 12/09/2026; đối chiếu với repo tại commit `b3f2faf`, [WP2-KIEN-TRUC-TECHSTACK.md](WP2-KIEN-TRUC-TECHSTACK.md), [NGHIEN-CUU-NEN-TANG.md](NGHIEN-CUU-NEN-TANG.md), [NGHIEN-CUU-BO-SUNG-WP2.md](NGHIEN-CUU-BO-SUNG-WP2.md). Số liệu `ocpp-rpc`, `ocpp-ws-io` kiểm chứng trực tiếp qua GitHub API và npm registry ngày 12/09/2026.*
