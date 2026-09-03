# Agenda buổi gặp GVHD — thầy Lâm Hữu Khánh Phương

**Đồ án:** PowerMe — Nền tảng quản lý mạng lưới sạc xe điện thông minh
**Mục tiêu buổi gặp:** chốt 6 thay đổi so với phiếu đăng ký, và lấy 5 thông tin chỉ thầy mới có.

Mang theo: phiếu đăng ký đã duyệt, tài liệu SRS phần cứng D1/YJ-EU, và bản kế hoạch của nhóm.

---

## Phần 0 — Câu hỏi phải hỏi đầu tiên

### Kỳ capstone thật sự kéo dài bao lâu?

Phiếu đăng ký ghi 09/2026 – 03/2027, tức 6 tháng. Nhóm đang tính làm trong 3 tháng.

**Cần làm rõ:** 3 tháng là quy định của trường, hay là lựa chọn của nhóm?

| Nếu trường cho 6 tháng | Đề xuất |
|---|---|
| | Giữ nguyên 6 tháng trên giấy tờ, nhưng đặt mốc nội bộ ở tháng thứ 3: một bản demo chạy được đủ để mang đi gặp doanh nghiệp. Ba tháng sau làm billing, hóa đơn VAT, phần nghiên cứu và tài liệu. Doanh nghiệp xem demo tháng 3, hội đồng chấm sản phẩm tháng 6. Không phải cắt tính năng nào khỏi đề tài đã duyệt. |

| Nếu bắt buộc 3 tháng | Hệ quả |
|---|---|
| | Quỹ công sức còn khoảng 130 ngày công, tức khoảng một nửa. Phải cắt loyalty, đặt chỗ, bảo trì định kỳ, và hạ cấp phần hóa đơn VAT. Cần thầy xác nhận việc cắt này không bị coi là làm thiếu so với đề tài đã ký. |

**Đây là câu quyết định toàn bộ những phần còn lại của agenda này. Hỏi trước.**

---

## Phần 1 — Sáu thay đổi cần thầy duyệt bằng văn bản

Ghi biên bản và xin thầy xác nhận qua email, vì tất cả đều lệch so với phiếu đăng ký.

### 1.1. Không có phần cứng thật — toàn bộ chạy trên simulator

**Hiện trạng:** nhóm không tiếp cận được trụ D1 hoặc YJ-EU thật.

**Đề xuất:** xây một charge point simulator mô phỏng trung thực theo tài liệu SRS phần cứng — súng đôi, đo lường DC (SoC, điện áp, dòng), bốn mã lỗi trong tài liệu, và cả ba đường mở phiên gồm QR qua app, RFID, mật khẩu trên HMI. Simulator trở thành một sản phẩm bàn giao, không chỉ là công cụ test.

**Hỏi thầy:**
- Thầy có chấp nhận toàn bộ kết quả dựa trên simulator không?
- Thầy có kênh nào mượn được trụ thật, dù chỉ một buổi, để đối chiếu hành vi không? Một buổi thôi cũng đủ để kiểm chứng simulator và làm mạnh hẳn phần kết luận.

### 1.2. Bỏ OCPP 2.0.1, chỉ làm 1.6J

**Lý do:** phiếu đăng ký để ngỏ "1.6J và/hoặc 2.0.1". Tài liệu phần cứng D1/YJ-EU chỉ khai báo 1.6J. Làm 2.0.1 là làm một thứ không có thiết bị nào để kiểm chứng.

**Hỏi thầy:** thầy đồng ý ghi rõ trong báo cáo là phạm vi giới hạn ở 1.6J, kèm lý do kỹ thuật chứ không phải lý do thiếu thời gian?

### 1.3. Đổi đường đối chứng của phần nghiên cứu

**Câu hỏi nghiên cứu đã đăng ký:** so sánh CSMS tự xây với nền tảng cloud mặc định của hãng, dưới điều kiện mạng không ổn định.

**Vấn đề:** không có trụ thật thì không truy cập được cloud của hãng. Đường đối chứng này không thực hiện được.

**Đề xuất:** giữ nguyên câu hỏi nghiên cứu, đổi sang thiết kế ablation — so chính CSMS khi **bật** engine đối soát với khi **tắt** engine đối soát, dưới cùng bộ kịch bản ngắt kết nối.

**Hai bằng chứng đã xác minh để mang theo** (chi tiết và nguồn dẫn ở [NGHIEN-CUU-NEN-TANG.md](NGHIEN-CUU-NEN-TANG.md)):

1. **OCPP 1.6 tự thừa nhận khoảng trống.** Spec ghi rõ Central System không có bất kỳ dấu hiệu nào ở tầng giao thức để phân biệt message replay từ hàng đợi offline với message thời gian thực — chỉ suy đoán được qua timestamp quá khứ. Chính OCA đã vá lỗ hổng này ở OCPP 2.0.1 bằng trường `offline` và `seqNo` trong `TransactionEventRequest`.

2. **OCA coi đây là yêu cầu bắt buộc.** Trong "Test Procedure & Test Plans" v2.4.1, ba ca `TC_037_1`, `TC_037_3` và `TC_039` về xử lý giao dịch offline replay được đánh dấu **M (Mandatory)** ở cột Central System — chỉ là C (Conditional) cho Charging Station.

Nghĩa là đề tài không nghiên cứu một vấn đề nhóm tự nghĩ ra, mà nghiên cứu một khoảng trống mà tổ chức chuẩn hóa đã công nhận và phải đợi tới phiên bản sau mới vá được.

**Lập luận để trình bày với thầy:**

> Về mặt phương pháp, ablation thực ra là thiết kế sạch hơn. So với cloud của hãng thì có quá nhiều biến nhiễu cùng lúc — khác hạ tầng mạng, khác vị trí máy chủ, khác cách lưu trữ — nên nếu ra kết quả khác biệt cũng không quy được cho engine đối soát. Ablation cô lập đúng một biến là thứ nhóm đóng góp, và kết luận rút ra được là kết luận nhân quả chứ không phải tương quan.
>
> Đổi lại, mất khả năng khẳng định "tốt hơn nền tảng thương mại". Nhóm sẽ ghi rõ đây là giới hạn của nghiên cứu ngay trong phần phương pháp, không giấu.

**Hỏi thầy:** thầy duyệt hướng này, hay muốn đổi hẳn sang câu hỏi khác phù hợp với simulator hơn?

### 1.4. Hóa đơn VAT — nhiều khả năng không xin được sandbox

**Vấn đề:** các nhà cung cấp hóa đơn điện tử (Viettel, VNPT, MISA) thường yêu cầu pháp nhân doanh nghiệp và mã số thuế. Nhóm sinh viên không có.

**Đề xuất dự phòng:** tự sinh XML hóa đơn đúng cấu trúc theo Nghị định 123/2020 và Thông tư 78/2021, ký số bằng chứng thư thử nghiệm, và trình bày rõ khâu phát hành lên cơ quan thuế là mô phỏng.

**Hỏi thầy:**
- Phương án mô phỏng này có được hội đồng chấp nhận không?
- **Trường có thể cấp giấy giới thiệu để nhóm xin sandbox không?** Đây là chỗ thầy giúp được nhiều nhất — một công văn của trường thường mở được cánh cửa mà đơn cá nhân thì không.

### 1.5. Cổng thanh toán — làm sâu một cổng thay vì làm nông ba cổng

**Phiếu đăng ký ghi:** VNPay, MoMo, ZaloPay.

**Đề xuất:** làm trọn vòng với VNPay — tạm giữ tiền, quyết toán theo lượng điện thực tế, hoàn phần dư, xử lý webhook, đối soát. Hai cổng còn lại chỉ làm nếu dư thời gian.

**Lý do:** một cổng chạy đúng cả đường lỗi có giá trị kỹ thuật cao hơn ba cổng chỉ chạy được đường thành công. Đây cũng là điều doanh nghiệp nhìn vào.

### 1.6. Danh sách tính năng đề nghị cắt hoặc hạ cấp

Nếu chốt phương án 3 tháng, đây là những phần đề nghị cắt:

| Tính năng | Đề xuất | Lý do |
|---|---|---|
| Loyalty và membership | Cắt, giữ lại thiết kế trên giấy | Không phụ thuộc OCPP, không thể hiện năng lực kỹ thuật lõi |
| Đặt chỗ trước | Cắt | Nghiệp vụ độc lập, thêm nhiều trạng thái phải test |
| Bảo trì định kỳ | Cắt, giữ cảnh báo sự cố | Cảnh báo sự cố mới là phần gắn với OCPP |
| Analytics | Hạ cấp còn 2–3 biểu đồ cơ bản | Đủ để demo, không cần BI đầy đủ |
| Admin console | Chỉ giữ quản lý người dùng và sổ thiết bị | Phần còn lại là CRUD, ít điểm bảo vệ |

**Hỏi thầy:** thầy có coi việc cắt này là làm thiếu so với đề tài đã duyệt không? Nếu có, phần nào bắt buộc phải giữ?

---

## Phần 2 — Năm thông tin chỉ thầy mới có

### 2.1. Hội đồng chấm nặng phần nào?

Phần nghiên cứu hay phần sản phẩm chạy được? Trọng số cụ thể ra sao? Câu trả lời quyết định nhóm dồn công sức vào đâu trong 3 tháng — và đây là thứ không tra được ở đâu ngoài thầy.

### 2.2. Có báo cáo mẫu của nhóm khóa trước làm về IoT hoặc giao thức thiết bị không?

Xem một báo cáo đã đạt điểm cao giúp nhóm hiệu chỉnh độ sâu tài liệu nhanh hơn nhiều so với đoán.

### 2.3. Thầy có mối quan hệ với doanh nghiệp vận hành trạm sạc không?

Mục tiêu của nhóm là được nhận vào làm sau đồ án. Nếu thầy giới thiệu được, nhóm sẽ điều chỉnh phần demo theo đúng thứ doanh nghiệp đó quan tâm, thay vì làm chung chung.

### 2.4. Nhịp làm việc thầy muốn

Mấy buổi mỗi tuần, gặp trực tiếp hay online, thầy muốn nhận báo cáo tiến độ dưới dạng nào? Chốt luôn ở buổi đầu để không mất thời gian điều chỉnh sau.

### 2.5. Trường có hỗ trợ hạ tầng không?

Máy chủ hoặc credit cloud cho môi trường staging. Nhóm cần một môi trường demo chạy 24/7 để hội đồng và doanh nghiệp truy cập được, không thể chạy trên laptop cá nhân.

---

## Phần 3 — Việc cần chốt ngay trong buổi gặp

Ba việc này nếu để trôi thêm một tuần sẽ chặn cả nhóm:

1. **Thời lượng thật của đồ án** — 3 tháng hay 6 tháng (Phần 0)
2. **Duyệt hướng đối chứng ablation** cho phần nghiên cứu (mục 1.3) — vì toàn bộ thiết kế thí nghiệm phụ thuộc vào nó
3. **Giấy giới thiệu của trường** để xin sandbox thanh toán và hóa đơn điện tử (mục 1.4) — thủ tục duyệt mất 2–4 tuần, nộp muộn là không kịp

---

## Ghi chú sau buổi gặp

Ghi lại quyết định của thầy cho từng mục, gửi email xác nhận trong vòng 24 giờ, và lưu vào thư mục tài liệu của nhóm. Mọi thay đổi so với phiếu đăng ký đều cần dấu vết bằng văn bản để bảo vệ nhóm khi ra hội đồng.

| Mục | Quyết định của thầy | Ngày |
|---|---|---|
| 0 · Thời lượng đồ án | | |
| 1.1 · Chấp nhận simulator | | |
| 1.2 · Bỏ OCPP 2.0.1 | | |
| 1.3 · Đổi đường đối chứng | | |
| 1.4 · Mô phỏng hóa đơn VAT | | |
| 1.5 · Một cổng thanh toán | | |
| 1.6 · Danh sách cắt | | |
