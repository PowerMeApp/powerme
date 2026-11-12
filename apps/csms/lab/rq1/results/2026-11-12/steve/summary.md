# Kết quả RQ1 / NFR-02 — steve

## Lần chạy

| Cấu hình | Số dòng | Seed | Commit CSMS | Bắt đầu (UTC) | Thời gian chạy | Song song |
| --- | --- | --- | --- | --- | --- | --- |
| steve | 90 | 20261112 | `c7b18bd` | 2026-11-12T09:43:04.773Z | 1869.6 s | 1 |

Tham số thời gian ĐÃ RÚT NGẮN (mối đe doạ tính hợp lệ, xem README): nhịp MeterValues 2 s (sản phẩm 10 s), `OFFLINE_GRACE_S` = 5 s (sản phẩm 120 s), độ dài đứt 6–15 s, ngưỡng khe hở 6 s. Dung sai tol = 1 Wh.

## Chỉ số chính NFR-02 (tỉ lệ phiên đúng, CI Wilson 95%)

| Cấu hình | Kịch bản | n | Tính tiền đúng | Giữ lại đúng | Giữ lại thừa | Sai im lặng | Mất/trùng | Khác | Tỉ lệ đúng | CI 95% Wilson | Cận dưới ≥ 95% |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steve | S1 | 30 | 30 | 0 | 0 | 0 | 0 | 0 | 100.0% | 88.6% – 100.0% | KHÔNG |
| steve | S2 | 30 | 0 | 0 | 0 | 30 | 0 | 0 | 0.0% | 0.0% – 11.4% | KHÔNG |
| steve | S3 | 30 | 30 | 0 | 0 | 0 | 0 | 0 | 100.0% | 88.6% – 100.0% | KHÔNG |
| steve | **gộp** | 90 | 60 | 0 | 0 | 30 | 0 | 0 | 66.7% | 56.4% – 75.5% | KHÔNG |

"Khác" = `unresolved` + `harness_error` (ngoài 5 nhóm của NFR-02, tính là sai). Với n = 30, kể cả 30/30 đúng thì cận dưới Wilson chỉ là 88,6%: ngưỡng 95% chỉ đạt được trên mẫu gộp lớn hơn (90/90 → 95,9%).

## Giữ phiên lại như một bộ phát hiện dữ liệu trụ sai

| Cấu hình | Kịch bản | Phiên dữ liệu sai | Phiên bị giữ | Precision | Recall |
| --- | --- | --- | --- | --- | --- |
| steve | S1 | 0 | 0 | — | — |
| steve | S2 | 30 | 0 | — | 0.0% (0/30) |
| steve | S3 | 0 | 0 | — | — |
| steve | **gộp** | 30 | 0 | — | 0.0% (0/30) |

## Số đo SRS NFR-REC-01

| Cấu hình | Kịch bản | Phiên đã tính tiền | abs(E_bill − E_true) TB (Wh) | CI 95% (t) | Sai số có dấu TB (Wh) | Mất | Trùng | Khe hở thật | meter_gap P | meter_gap R |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steve | S1 | 30 | 0.0 | 0.0 – 0.0 | 0.0 | 0 | 0 | 11 | — | 0.0% (0/11) |
| steve | S2 | 30 | 117.3 | 91.4 – 143.2 | -117.3 | 0 | 0 | 0 | — | — |
| steve | S3 | 30 | 0.0 | 0.0 – 0.0 | 0.0 | 0 | 0 | 0 | — | — |
| steve | **gộp** | 90 | 39.1 | 25.0 – 53.2 | -39.1 | 0 | 0 | 11 | — | 0.0% (0/11) |

Sai số Wh chỉ tính trên phiên đã tính tiền (phiên bị giữ không có `E_bill`). "Khe hở thật" = chuỗi mẫu trụ ĐÃ GIAO (kể cả mốc bắt đầu và mốc dừng) có khoảng trống lớn hơn ngưỡng khe hở.

## Chú giải nhóm

- `billed_correct`: Tính tiền đúng
- `held_correct`: Giữ lại đúng
- `held_unnecessary`: Giữ lại thừa
- `billed_wrong_silent`: Tính tiền sai im lặng
- `lost_or_duplicate`: Mất / trùng
- `unresolved`: Chưa kết thúc (ngoài 5 nhóm)
- `harness_error`: Lỗi harness (ngoài 5 nhóm)
