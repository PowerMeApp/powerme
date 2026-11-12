# THĂM DÒ (ngoài 3 kịch bản): S2 mất hẳn hàng đợi MeterValues — powerme

## Lần chạy

| Cấu hình | Số dòng | Seed | Commit CSMS | Bắt đầu (UTC) | Thời gian chạy | Song song |
| --- | --- | --- | --- | --- | --- | --- |
| powerme | 10 | 20261112 | `885b38e` | 2026-11-12T08:53:40.206Z | 23.1 s | 10 |

Tham số thời gian ĐÃ RÚT NGẮN (mối đe doạ tính hợp lệ, xem README): nhịp MeterValues 2 s (sản phẩm 10 s), `OFFLINE_GRACE_S` = 5 s (sản phẩm 120 s), độ dài đứt 6–15 s, ngưỡng khe hở 6 s. Dung sai tol = 1 Wh.

## Chỉ số chính NFR-02 (tỉ lệ phiên đúng, CI Wilson 95%)

| Cấu hình | Kịch bản | n | Tính tiền đúng | Giữ lại đúng | Giữ lại thừa | Sai im lặng | Mất/trùng | Khác | Tỉ lệ đúng | CI 95% Wilson | Cận dưới ≥ 95% |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| powerme | S2 | 10 | 0 | 0 | 0 | 10 | 0 | 0 | 0.0% | 0.0% – 27.8% | KHÔNG |
| powerme | **gộp** | 10 | 0 | 0 | 0 | 10 | 0 | 0 | 0.0% | 0.0% – 27.8% | KHÔNG |

"Khác" = `unresolved` + `harness_error` (ngoài 5 nhóm của NFR-02, tính là sai). Với n = 30, kể cả 30/30 đúng thì cận dưới Wilson chỉ là 88,6%: ngưỡng 95% chỉ đạt được trên mẫu gộp lớn hơn (90/90 → 95,9%).

## Giữ phiên lại như một bộ phát hiện dữ liệu trụ sai

| Cấu hình | Kịch bản | Phiên dữ liệu sai | Phiên bị giữ | Precision | Recall |
| --- | --- | --- | --- | --- | --- |
| powerme | S2 | 10 | 0 | — | 0.0% (0/10) |
| powerme | **gộp** | 10 | 0 | — | 0.0% (0/10) |

## Số đo SRS NFR-REC-01

| Cấu hình | Kịch bản | Phiên đã tính tiền | abs(E_bill − E_true) TB (Wh) | CI 95% (t) | Sai số có dấu TB (Wh) | Mất | Trùng | Khe hở thật | meter_gap P | meter_gap R |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| powerme | S2 | 10 | 101.3 | 60.2 – 142.4 | -101.3 | 0 | 0 | 3 | 100.0% (3/3) | 100.0% (3/3) |
| powerme | **gộp** | 10 | 101.3 | 60.2 – 142.4 | -101.3 | 0 | 0 | 3 | 100.0% (3/3) | 100.0% (3/3) |

Sai số Wh chỉ tính trên phiên đã tính tiền (phiên bị giữ không có `E_bill`). "Khe hở thật" = chuỗi mẫu trụ ĐÃ GIAO (kể cả mốc bắt đầu và mốc dừng) có khoảng trống lớn hơn ngưỡng khe hở.

## Chú giải nhóm

- `billed_correct`: Tính tiền đúng
- `held_correct`: Giữ lại đúng
- `held_unnecessary`: Giữ lại thừa
- `billed_wrong_silent`: Tính tiền sai im lặng
- `lost_or_duplicate`: Mất / trùng
- `unresolved`: Chưa kết thúc (ngoài 5 nhóm)
- `harness_error`: Lỗi harness (ngoài 5 nhóm)
