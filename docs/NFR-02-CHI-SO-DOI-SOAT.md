# NFR-02: chốt chỉ số và dung sai cho thí nghiệm đối soát (RQ1)

> Task T121 (Trí). Trạng thái: **đề xuất, chờ Ân (chủ NFR-02) duyệt**. Viết 10/11/2026.

## 1. Vấn đề

Commitment BM04 ghi NFR-02 là "Reconciled rate, cận dưới CI 95% ≥ 95%, tốt hơn khi tắt đối soát và SteVe". Có ba chỗ hở:

1. **Đếm `review` là đúng thì chỉ số vô nghĩa.** Một CSMS đẩy mọi phiên vào `review` sẽ đạt 100% mà không đối soát gì.
2. **Không so được với SteVe và bản tắt đối soát.** Hai hệ đó không có trạng thái `reconciled` hay `review`; chúng luôn tính tiền theo `meterStop − meterStart`.
3. **Lệch SRS.** NFR-REC-01 (RQ1) đo sai số năng lượng (Wh), giao dịch trùng/mất, precision/recall phát hiện khe hở. Commitment chỉ có "reconciled rate".

## 2. Đề xuất định nghĩa

Đơn vị đo là **một phiên trong một lần chạy** (3 kịch bản × 30 lần × 3 cấu hình: PowerMe, PowerMe tắt đối soát `RECONCILIATION_ENABLED=false`, SteVe).

- `truth_wh`: năng lượng thật trụ giả lập đã cấp, lấy từ bộ đếm nội bộ của simulator lúc dừng (sự thật nền, CSMS không thấy).
- `billed_wh`: năng lượng hệ thống dùng để tính tiền. PowerMe: `sessions.energy_wh` khi phiên `reconciled`. Tắt đối soát và SteVe: `meterStop − meterStart`.
- `tol`: dung sai, xem mục 3.

Mỗi phiên rơi vào đúng một nhóm:

| Nhóm | Điều kiện | Ý nghĩa |
|---|---|---|
| **Đúng** | Đã tính tiền và `abs(billed_wh − truth_wh) ≤ tol` | Thành công |
| **Giữ lại** | Không tính tiền, đưa vào `review` cho operator | An toàn nhưng chưa tự động |
| **Sai im lặng** | Đã tính tiền và `abs(billed_wh − truth_wh) > tol` | Nguy hiểm nhất: tính sai mà không ai biết |
| **Mất / trùng** | Phiên không được ghi, hoặc ghi hai lần | Đo riêng theo SRS |

**Chỉ số chính NFR-02 = tỉ lệ Đúng** (Đúng ÷ tổng phiên), báo kèm khoảng tin cậy 95% (Wilson) theo từng kịch bản. **`review` không tính là Đúng.**

Ràng buộc đi kèm để chặn "đẩy hết vào review":

- **Sai im lặng = 0** ở PowerMe trong cả 90 lần chạy (đây mới là lời hứa cốt lõi: không bao giờ tính sai tiền mà không báo).
- **Tỉ lệ Giữ lại** báo cáo riêng, không ẩn vào chỉ số chính.

Các số đo của SRS (sai số Wh trung bình và CI, mất/trùng, precision/recall phát hiện khe hở) vẫn báo cáo đủ trong Report 7; chỉ số chính chỉ là cách tóm gọn.

## 3. Dung sai `tol`

Bộ đếm năng lượng OCPP là số nguyên Wh. Khi `meterStop` hợp lệ, CSMS biết chính xác năng lượng, nên dung sai **1 Wh** (trùng `RECONCILE_ENERGY_TOLERANCE_WH=1` đang cấu hình).

Khi `meterStop` bị hỏng (kịch bản phát lại `meterStop` cũ), CSMS chỉ biết tới mẫu `MeterValues` cuối cùng; phần năng lượng giữa mẫu cuối và lúc dừng không có bằng chứng. Phương án: dung sai cho kịch bản đó bằng **năng lượng của một chu kỳ lấy mẫu** ở công suất kịch bản (ví dụ 60 kW, 10 s ≈ 167 Wh), ghi rõ trong bảng kết quả. Ngoài dung sai này không nới thêm.

## 4. Hệ quả cần quyết trước khi chạy 90 lần

Với code hiện tại, kịch bản phát lại `meterStop` cũ kết thúc ở `review` (đã kiểm trên staging 09/11: phiên #2, `diff=2550`). Theo định nghĩa trên, kịch bản đó cho **tỉ lệ Đúng ≈ 0%**, nên ngưỡng "≥ 95%" không đạt nếu áp chung cho cả ba kịch bản. Hai lựa chọn:

| Phương án | Làm gì | Đánh đổi |
|---|---|---|
| **A. Đặt ngưỡng theo kịch bản** (đề xuất) | Ngưỡng ≥ 95% Đúng cho hai kịch bản `meterStop` hợp lệ; kịch bản `meterStop` hỏng thì ngưỡng là **Sai im lặng = 0 và Giữ lại = 100%**, và so sánh với SteVe/tắt đối soát ở chỉ số Sai im lặng (hai hệ đó sẽ tính sai im lặng gần 100%). | Trung thực với thiết kế hiện tại (không đoán tiền khi bằng chứng mâu thuẫn); cần sửa câu chữ NFR-02 trong BM04 ở lần cập nhật tới. |
| B. Tự giải quyết bằng chuỗi đo | Khi `meterStop` < mẫu cuối và chuỗi đơn điệu, tính tiền theo mẫu cuối thay vì giữ lại | Thêm logic quyết toán (Trí), có rủi ro tính thiếu phần sau mẫu cuối; đổi hành vi đã trình bày ở DS-06 ("billing held"). |

Đề xuất chọn **A**: giữ đúng lời hứa "không tính sai im lặng", và cho thấy rõ ưu thế so với SteVe ở đúng chỗ SteVe tính sai.

## 5. Việc tiếp theo

1. Ân duyệt định nghĩa và chọn A hoặc B.
2. Ghi `truth_wh` từ simulator vào log của mỗi lần chạy (script thí nghiệm, Trí).
3. Cập nhật câu chữ NFR-02 trong BM04 và Report 7 theo định nghĩa đã duyệt.
