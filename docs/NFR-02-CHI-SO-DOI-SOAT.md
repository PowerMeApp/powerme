# NFR-02: chỉ số và dung sai cho thí nghiệm đối soát (RQ1)

> Task T121 (Trí). **Đã chốt** theo quyết định của Ân (PM) ngày 12/11/2026. Thay bản đề xuất 10/11.

## 1. Quyết định

- **Giữ nguyên BM04:** một ngưỡng chung cho cả 3 kịch bản đứt kết nối. Tỉ lệ phiên **đúng** của PowerMe phải có cận dưới khoảng tin cậy 95% **≥ 95%**, và tốt hơn cấu hình tắt đối soát và SteVe.
- **`review` chỉ được tính là đúng khi dữ liệu của trụ thật sự sai** so với sự thật nền. Giữ phiên lại trong khi lẽ ra tính tiền được thì tính là **sai**. Nhờ vậy, đẩy mọi phiên vào `review` không còn là cách "ăn gian" chỉ số.
- **Tính tiền sai im lặng phải bằng 0.**
- Báo thêm **precision** và **recall** của việc giữ phiên lại.

## 2. Định nghĩa

Đơn vị đo là **một phiên trong một lần chạy**: 3 kịch bản × 30 lần × 3 cấu hình (PowerMe, PowerMe với `RECONCILIATION_ENABLED=false`, SteVe).

| Ký hiệu | Ý nghĩa | Lấy từ đâu |
|---|---|---|
| `E_true` | Năng lượng trụ giả lập thật sự đã cấp | Bộ đếm nội bộ của simulator lúc dừng (sự thật nền; CSMS không thấy) |
| `E_stop` | Năng lượng theo dữ liệu trụ báo | `meterStop − meterStart` của `StopTransaction` |
| `E_bill` | Năng lượng hệ thống dùng để tính tiền | PowerMe: `sessions.energy_wh` khi phiên `reconciled`; tắt đối soát và SteVe: `meterStop − meterStart`; phiên không tính tiền: không có |
| `tol` | Dung sai | **1 Wh** (bộ đếm OCPP là số nguyên Wh; trùng `RECONCILE_ENERGY_TOLERANCE_WH=1`) |

**Dữ liệu trụ sai** khi `abs(E_stop − E_true) > tol`.

## 3. Phân loại mỗi phiên

| Nhóm | Điều kiện | Tính là |
|---|---|---|
| **Tính tiền đúng** | Đã tính tiền và `abs(E_bill − E_true) ≤ tol` | Đúng |
| **Giữ lại đúng** | Ở `review`, không tính tiền, và dữ liệu trụ sai | Đúng |
| **Giữ lại thừa** | Ở `review` trong khi dữ liệu trụ đúng (lẽ ra tính tiền được) | **Sai** |
| **Tính tiền sai im lặng** | Đã tính tiền và `abs(E_bill − E_true) > tol` | **Sai, phải bằng 0** |
| **Mất / trùng** | Phiên không được ghi, hoặc ghi hai lần | Sai (đo riêng theo SRS NFR-REC-01) |

**Chỉ số chính NFR-02** = (Tính tiền đúng + Giữ lại đúng) ÷ tổng phiên, báo theo từng kịch bản và từng cấu hình, kèm khoảng tin cậy 95% (Wilson). Đạt khi cận dưới ≥ 95% ở cả 3 kịch bản.

**Ràng buộc đi kèm:** Tính tiền sai im lặng = 0 ở PowerMe trên toàn bộ 90 lần chạy.

## 4. Precision và recall của việc giữ phiên lại

Coi "giữ lại" (`review`) là một bộ phát hiện dữ liệu trụ sai:

- **Precision** = Giữ lại đúng ÷ (Giữ lại đúng + Giữ lại thừa): trong các phiên bị giữ, bao nhiêu phần đáng giữ.
- **Recall** = Giữ lại đúng ÷ (số phiên có dữ liệu trụ sai): trong các phiên có dữ liệu sai, bao nhiêu phần bị bắt.

Recall thấp nghĩa là có phiên dữ liệu sai đã lọt qua. Phiên đó sẽ rơi vào "tính tiền sai im lặng" nếu đã bị tính tiền. Cấu hình tắt đối soát và SteVe không bao giờ giữ phiên lại, nên recall của chúng bằng 0 theo định nghĩa. Điểm so sánh với hai cấu hình này nằm ở số phiên tính tiền sai im lặng.

Báo cáo vẫn kèm các số đo của SRS NFR-REC-01: sai số Wh (trung bình và CI), giao dịch trùng/mất, precision/recall phát hiện khe hở theo bản ghi `meter_gap`.

## 5. Harness phải ghi cho mỗi lần chạy

Một dòng cho mỗi phiên, đủ để tính lại mọi chỉ số mà không chạy lại:

| Trường | Ghi chú |
|---|---|
| `run_id`, `scenario`, `config`, `seed` | Định danh lần chạy (30 lần/kịch bản, seed cố định) |
| `session_id`, `transaction_id` | Liên kết sang DB |
| `E_true`, `E_stop`, `E_bill` | Wh, số nguyên; `E_bill` để trống nếu không tính tiền |
| `status` | Trạng thái cuối của phiên (`reconciled`, `review`, …) |
| `injected_fault` | Lỗi đã gây ra trong lần chạy (đứt kết nối bao lâu, phát lại `meterStop` cũ, gửi lại `StartTransaction`, …) |
| `class` | Một trong các nhóm ở mục 3 |

## 6. Hệ quả cần biết trước khi chạy

- Ở kịch bản phát lại `meterStop` cũ, dữ liệu trụ sai, nên phiên ở `review` là **Giữ lại đúng**. Đã kiểm trên staging 09/11 (DS-06, phiên #2: `review`, `diff=2550`).
- Ở hai kịch bản còn lại, nếu `meterStop` hợp lệ mà phiên vẫn bị giữ (ví dụ do ngưỡng khe hở quá chặt) thì đó là **Giữ lại thừa** và kéo chỉ số xuống. Cần đo trước vài lần để chỉnh ngưỡng trước khi chạy đủ 90 lần.
- Liên quan PR #120 (đồng hồ trụ): nếu quyết toán giữ phiên chờ vô thời hạn khi đồng hồ trụ lệch, phiên đó không bao giờ có `E_bill`. Cần chốt hướng xử lý ở #120 trước khi chạy, để phân loại không mơ hồ.
