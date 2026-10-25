# ADR-0009 — Quy ước dữ liệu

| | |
|---|---|
| Trạng thái | Đề xuất |
| Ngày | 11/09/2026 |
| Người đề xuất | Ngô Văn Minh Trí (WP2) |
| Người quyết định | WP1, WP2, WP5 |
| Liên quan | BE-07, ADR-0010, ADR-0012 |

## Bối cảnh

Ba đầu ra (CSMS, dashboard, app) và billing của WP5 cùng đọc một mô hình dữ liệu. Những chỗ dễ sai lệch nhất — múi giờ, đơn vị điện năng, đơn vị tiền, cách đánh số connector, định danh trụ — phải chốt một lần và đưa vào SDD, trước khi WP1 vẽ ERD.

## Quyết định

| Loại dữ liệu | Quy ước | Vì sao |
|---|---|---|
| **Thời gian** | `timestamptz`, lưu UTC, chuyển sang `Asia/Ho_Chi_Minh` chỉ khi hiển thị | Tránh lỗi lệch múi giờ khi so sánh timestamp của trụ |
| **Hai thời điểm mỗi bản tin** | `cp_timestamp` — lấy từ payload, **không tin cậy**<br>`received_at` — đồng hồ CSMS, **tin cậy** | Đồng hồ trụ có thể sai. **Chênh lệch giữa hai giá trị là tín hiệu chính để phát hiện replay** |
| **Điện năng** | Wh, `bigint` | `meterStart`/`meterStop` trong OCPP là Wh. Nhầm sang kWh là sai hoá đơn 1000 lần |
| **Tiền** | VND, `bigint` | Không có lỗi làm tròn số thực |
| **Connector** | `1` súng A · `2` súng B · `0` toàn trụ | Khớp SRS phần cứng và OCPP 1.6 |
| **Định danh kỹ thuật của trụ** | **Số serial (SN)** của trụ, xuất hiện ở đoạn cuối URL `/ocpp/{serialNumber}` | SRS phần cứng §6: kỹ thuật viên gõ Server URL, Port **và SN** trên HMI. Khớp `CSMS_OCPP_PATH_PREFIX` trong `infra/.env.example` |
| **Mã hiển thị của trụ** | Cột riêng `display_code` dạng `PM-{model}-{tỉnh}-{số thứ tự}`, ví dụ `PM-D1-HCM-0001` | Người vận hành đọc mã này, không đọc SN. **Tách khỏi định danh kỹ thuật** để đổi tên site mà không phải cấu hình lại trụ |
| **Phiên bắt đầu bằng cách nào** | `origin`: `app` · `rfid_online` · `rfid_wallet` · `hmi_password` · `free_vend` | Manual gốc có năm cách khởi động phiên — ADR-0012 |
| **Ai thu tiền** | `payment_mode`: `csms_billed` · `station_wallet` · `unattributed` | Tách khỏi `origin`: cùng là quẹt thẻ, nhưng thẻ xác thực và thẻ ví trả tiền ở hai nơi khác nhau |
| **Đến trễ do offline** | `delivered_offline` kiểu boolean, do engine đối soát gán | **Không phải một loại nguồn gốc** — phiên nào cũng có thể bị trụ gửi bù sau khi nối lại |

Năm quy ước đầu là **bắt buộc ghi vào SDD**.

## Hệ quả

**Được:**

- (chưa ghi tách bạch trong tài liệu nguồn — lý lẽ từng dòng ở cột "Vì sao")

**Mất:**

- (chưa ghi trong tài liệu nguồn)

## Các phương án đã cân nhắc và loại bỏ

| Phương án | Vì sao loại |
|---|---|
| (chưa ghi trong tài liệu nguồn) | |

## Cập nhật 25/10/2026

Trạng thái giữ nguyên. Mục này ghi **giá trị thực tế trong schema** sau migration 0001 (BE-11, `apps/csms/drizzle/`), vì bảng quyết định ở trên viết ngày 11/09 và lệch một số tên đã chốt ở T11–T13. Nội dung cũ không bị xoá.

| Quy ước ở trên | Thực tế trong DB (0000 + 0001) |
|---|---|
| `cp_timestamp` + `received_at` | Đúng cho mọi bảng nhận dữ liệu từ trụ. `connector_status_events` trước đây đặt tên `pillar_timestamp`; **đã đổi thành `cp_timestamp`** ở 0001 (`ALTER TABLE … RENAME COLUMN`) |
| `origin`: `app` · `rfid_online` · `rfid_wallet` · `hmi_password` · `free_vend` | `session_origin` = **`app_qr` · `rfid` · `hmi_password` · `free_vend`** (T12/T13). Thẻ online hay thẻ ví **không** nằm ở `origin` mà ở `rfid_cards.card_kind` (`online` · `wallet` · `free_vend`) và `sessions.payment_mode` |
| `payment_mode`: `csms_billed` · `station_wallet` · `unattributed` | `payment_mode` = **`csms_billed` · `station_wallet` · `free` · `unattributed`**. `free` có từ 0000 (phiên free vend nhận diện qua `charge_points.free_vend_tag`); `unattributed` thêm ở 0001 và dùng cho phiên mở bằng idTag không có trong sổ thẻ |
| sổ thẻ `id_tags` (ADR-0012) | bảng **`rfid_cards`** (cột `card_identifier`, T11) |

Duyệt: giá trị enum do nhóm tự đặt ở 0000 (11 enum, liệt kê ở `docs/THIET-KE-CSDL-VAT-LY.md` mục 7) **giữ nguyên, đã duyệt bởi Trí 25/10/2026, chưa có Khang/Nghĩa duyệt riêng**.
