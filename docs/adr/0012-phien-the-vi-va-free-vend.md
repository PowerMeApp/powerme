# ADR-0012 — Phiên sạc bằng thẻ ví và free vend

| | |
|---|---|
| Trạng thái | Đề xuất — cần cả nhóm chốt |
| Ngày | 11/09/2026 |
| Người đề xuất | Ngô Văn Minh Trí (WP2) |
| Người quyết định | WP2 + WP5, WP1 ghi nhận |
| Liên quan | BE-07, ADR-0009, ADR-0010 |

## Bối cảnh

Bản SRS tóm tắt đã bỏ sót, chỉ manual gốc của hãng mới có:

| Nguồn | Nội dung |
|---|---|
| Manual D1, bản 02/2025, nhà sản xuất **Jiangxi Ruihua Intelligent Technology Co., Ltd.** — mục 3.4 *Offline model charging process* | Bật **"Wallet ID card"** thì dùng được thẻ tính tiền. Bật **"Online IDcard"** thì dùng thẻ xác thực. Chế độ **mật khẩu** lấy mật khẩu từ cài đặt nền của trụ. Nếu cài đặt nền bật **"plug-and-charge"**, phiên sạc bắt đầu ngay khi cắm súng |
| Manual D1 — quy trình quẹt thẻ | Màn hình *"Billing Interface & RFID Card Balance"* — trụ hiển thị số dư trên thẻ |
| Manual YJ-EU — quy trình sạc bằng thẻ | Bước *"Check IC Card Balance"* |
| Manual D1 — bảng thông số | Kết nối *"Ethernet / 4G router (option)"* · Cloud platform *"OCPP1.6J"* |

**Bẫy thuật ngữ:** "plug-and-charge" trong manual Ruihua là một cài đặt của hãng — cắm súng là sạc, không xác thực. **Nó không phải Plug & Charge theo ISO 15118**, vốn là xác thực tự động bằng chứng thư số giữa xe và trụ. Trong code và báo cáo, gọi chế độ này là **free vend** để không bị hội đồng bắt lỗi.

**Vấn đề:**

- `StartTransaction` của OCPP 1.6 chỉ có `idTag`. **Không có trường nào cho biết phiên được trả bằng thẻ ví.** Manual cũng không mô tả trụ có gửi số dư hay số tiền đã trừ lên CSMS hay không.
- Nếu CSMS coi mọi phiên là phiên mình thu tiền, **khách dùng thẻ ví bị trừ tiền hai lần**: một lần trên thẻ, một lần qua VNPay.

**Ba câu hỏi mở — chỉ hãng hoặc trụ thật trả lời được, simulator thì không:**

1. Khi dùng thẻ ví, trụ có gửi số tiền đã trừ hoặc số dư thẻ lên CSMS không — qua `DataTransfer` hay trường nào?
2. Phiên free vend gửi `idTag` giá trị gì?
3. Mật khẩu của chế độ mật khẩu đặt ở đâu, và có đồng bộ lên CSMS không?

## Quyết định

1. Mỗi giao dịch mang hai thuộc tính tách biệt: `origin` (bắt đầu bằng cách nào) và `payment_mode` (ai thu tiền) — ADR-0009.
2. CSMS phân loại thẻ bằng **sổ đăng ký thẻ** `id_tags`. Người vận hành là bên phát hành thẻ, nên biết thẻ nào là thẻ ví, thẻ nào là thẻ xác thực.
3. Phiên free vend nhận diện qua `free_vend_id_tag` cấu hình riêng cho từng trụ → `payment_mode = unattributed`.
4. Phiên `station_wallet`: CSMS **vẫn tính giá** từ `MeterValues` để đối soát, nhưng **không bao giờ** tạo lệnh thu qua cổng thanh toán.
5. `StartTransaction` mang `idTag` không có trong sổ — thường là phiên đã diễn ra khi trụ offline — vẫn được ghi nhận với `payment_mode = unattributed`, kèm một `reconciliation_records` loại `unknown_id_tag` cho người vận hành xử lý. **Không xoá, không bỏ qua phiên đã diễn ra.**

**Ngoài phạm vi 13 tuần** — ghi vào hướng phát triển: phát hành thẻ, nạp tiền thẻ ví, quản lý số dư thẻ phía CSMS.

## Hệ quả

**Được:**

- Không thu tiền hai lần.
- Báo cáo doanh thu tách được theo hình thức thanh toán.
- Thí nghiệm có thêm một kịch bản offline có thật, dẫn nguồn được: phiên thẻ ví bắt đầu khi router 4G của trụ mất sóng.

**Mất:**

- Nguyên tắc "CSMS là nguồn sự thật cho hoá đơn" phải **thu hẹp** thành "nguồn sự thật cho bản ghi phiên và bản tính giá". Tiền của phiên thẻ ví do trụ thu.
- Nếu câu hỏi mở 1 có câu trả lời "không", CSMS **không đối chiếu được** số tiền trừ trên thẻ — chỉ đối chiếu được bản tính của mình với dữ liệu đo của trụ. Ghi thành giới hạn nghiên cứu.
- Hoá đơn VAT của phiên thẻ ví xuất lúc nạp thẻ hay lúc sạc là câu hỏi pháp lý — chuyển cho WP5.

## Các phương án đã cân nhắc và loại bỏ

| Phương án | Vì sao loại |
|---|---|
| Coi mọi phiên là CSMS thu tiền | Khách dùng thẻ ví bị trừ tiền hai lần |
| Tắt Wallet ID card và free vend trong cấu hình trụ | Đơn giản nhất, nhưng bỏ đi đúng tình huống offline mà đề tài nghiên cứu, trong khi người vận hành thật cần thẻ ví khi mạng 4G yếu. **Giữ làm phương án dự phòng** nếu S5 trễ tiến độ |
| Nhận diện thẻ ví qua `DataTransfer` riêng của hãng | Chưa biết hãng có gửi hay không — phụ thuộc câu hỏi mở 1. Có thể bổ sung sau, không dùng làm nền |
