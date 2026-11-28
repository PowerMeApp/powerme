# lab/rq2 — harness thí nghiệm RQ2 (T142)

So sánh **Station Suggestion** (`sort=smart`, Vietmap thật) với **nearest compatible station** (`sort=distance`) trên 50 trạm mô phỏng, ba kịch bản tải **quiet / peak / faulty station**. Mỗi kịch bản ≥ 200 request. Báo **Time until charging starts** và **Time until charged** (thuật ngữ theo `GLOSSARY.md`).

Dụng cụ đo, không phải sản phẩm. Không sửa mã CSMS, không chỉnh ngưỡng để số đẹp (`../README.md`).

| Nguồn | Nội dung |
|---|---|
| Phiếu đăng ký v1.3 (`docs/requirements/registration-form-v1.3.md`), ADR-0015 | RQ2, O3; "50 simulated stations, same scenarios and seeds for both rankings; thresholds fixed before evaluation" |
| SRS NFR-RES-04 | ≥ 200 request mỗi kịch bản quiet / peak / faulty station; báo thời gian tới lúc bắt đầu sạc và tới mức pin đích; cam kết là chạy và báo cáo, không cam kết phải cải thiện |
| `docs/demo/DIEN-TAP-BM04.md` (F-03 và RQ2) | Đối chứng là trạm tương thích gần nhất; ghi `ranking_source` và `road_estimate` |
| Tracker T142 (D-Y), BM04 RF-11 | Mỗi tối 1 kịch bản, tối đa 1 request/phút, tối đa 900 Route/ngày; harness chạy được trước 21/11 |

| Trạng thái (19/11/2026) | |
|---|---|
| Harness, unit test, chạy khô | Xong |
| Chạy thử thật 4 request (Q18) | Chưa |
| quiet / peak / faulty (200 request mỗi kịch bản) | Chưa (dự kiến các tối 20, 21, 22/11) |
| Tham số kịch bản | **Đề xuất, chờ Ân duyệt**; đã đóng băng trong `meta.json` của mỗi lượt |

## Các file

| File | Việc |
|---|---|
| `run.mjs` | Dựng Postgres nhúng (cổng 55437, DB `powerme_rq2`) + migration + 50 trạm, rồi Driver API thật trong tiến trình. Chạy vòng request, ghi `rows.jsonl`, `meta.json`, `summary.md` |
| `scenarios.mjs` | Tham số ba kịch bản; rút điểm đi, SoC và tải theo seed (hàm thuần) |
| `score.mjs` | Chấm Time until charging starts / Time until charged theo sự thật nền (hàm thuần) |
| `analyze.mjs` | Gộp một hoặc nhiều `rows.jsonl` thành `summary.md` / `summary.csv` (không cần CSMS) |
| `*.spec.mjs` | Unit test, chạy cùng `npm test -w @powerme/csms` |

Tái dùng:
- `../nfr-res-01/road-points.json`: 50 điểm đường thật ở Thủ Đức, ODbL.
- Hàm `seed` và `observeProvider` chép từ `../nfr-res-01/local.mjs`.
- `../rq1/prng.mjs` cho seed; `wilson` từ `../rq1/metrics.mjs`.
- `ensureBuilt` / `portOpen` từ `../rq1/local-csms.mjs`; `../../demo/db-embedded.mjs`.

## Chạy mỗi tối

Từ `apps/csms`, sau `npm ci`. Lệnh tự build CSMS nếu `dist/` cũ.

```bash
# 0. Kiểm luồng, không gọi Vietmap (ranking_source = brief, 0 Route)
node lab/rq2/run.mjs --scenario quiet --dry-run --requests 10 --interval-ms 1000 --out /tmp/rq2-dry

# 1. Trước mỗi lượt thật (Q15): xem Vietmap Console, ghi số Route còn lại hôm nay,
#    nhắn Sơn "tối nay RQ2 dùng tối đa 850 Route".

# 2. Chạy thử thật 4 request (Q18): kiểm số Route của request thứ hai mỗi cặp
node lab/rq2/run.mjs --scenario quiet --requests 4 --route-remaining <số trên Console> --out /tmp/rq2-trial

# 3. Một kịch bản mỗi tối (~3,5 giờ với 1 request/phút)
node lab/rq2/run.mjs --scenario quiet  --route-remaining <số trên Console>   # tối 20/11
node lab/rq2/run.mjs --scenario peak   --route-remaining <số trên Console>   # tối 21/11
node lab/rq2/run.mjs --scenario faulty --route-remaining <số trên Console>   # tối 22/11
```

Key Vietmap đọc từ `VIETMAP_SEARCH_API_KEY` trong `infra/.env`; không bao giờ ghi ra file kết quả.

| Tham số | Mặc định | Ý nghĩa |
|---|---|---|
| `--scenario` | (bắt buộc) | `quiet` \| `peak` \| `faulty` |
| `--requests` | `200` | Số request của kịch bản |
| `--seed` | `20261120` | Seed gốc, **dùng chung cho ba kịch bản** (Q17) |
| `--start-index` | `0` | Chạy tiếp từ request k (sau khi dừng vì hạn mức) |
| `--interval-ms` | `60000` | Khoảng cách giữa hai request; chạy thật tối thiểu 60000 |
| `--route-budget` | `850` | Dừng khi số Route đã gọi + 6 vượt ngân sách |
| `--route-remaining` | — | **Bắt buộc khi chạy thật.** Số Route còn lại trên Console; từ chối nếu `budget > remaining − 500` (phần của NFR-RES-01) |
| `--pg-port` | `55437` | Cổng Postgres nhúng riêng; không đụng DB test 55432 hay demo |
| `--out` | `lab/rq2/results/<ngày>-<kịch bản>` | Thư mục kết quả |
| `--dry-run` | tắt | Không đọc key Vietmap, cho phép interval nhỏ |

**Dừng sớm và chạy tiếp (Q14, Q19).** Harness dừng khi chạm ngân sách Route, khi gặp 10 request `brief` liên tiếp (gần như chắc hết quota hoặc key lỗi), hoặc khi bấm Ctrl-C. Dòng `end` ghi `stopped` và `next_start_index`; lệnh chạy tiếp được in ra. Tối sau **chạy nốt kịch bản dở trước**, rồi gộp các phần:

```bash
node lab/rq2/analyze.mjs lab/rq2/results/2026-11-20-quiet/rows.jsonl \
     lab/rq2/results/2026-11-21-quiet/rows.jsonl --out lab/rq2/results/quiet
```

## Một request

1. **Tải.** Rút trạng thái 50 trạm theo `(seed, kịch bản, k)` rồi ghi vào DB:
   - trạng thái súng;
   - độ tươi: mọi trụ có `last_message_at = now()`; trạm cũ có `status_changed_at < online_changed_at`, nên Status Quality = stale;
   - FaultEvent OCPP đang mở cho trạm sự cố (bị ẩn khỏi cả hai cách xếp).
2. **Điểm đi + SoC** rút theo **cặp** (k = 2p, 2p + 1 dùng chung, Q3) trong vùng của `road-points.json`; SoC 15–45 %, mức pin đích 80 %. Request thứ hai cách 1 phút, nằm trong TTL 120 s của cache Route, nên chỉ tốn Route cho những trạm mới lọt vào top 6.
3. **Hai lần gọi** cùng tài xế, cùng xe CCS2 (60 kWh, 320 km, 100 kW):
   - `sort=smart&location_consent=true&soc_percent=…&target_soc_percent=80`: trạm đầu tiên là lựa chọn của smart;
   - `sort=distance`: trạm đầu tiên là **nearest compatible station**, không xét trạng thái (Q1).
4. **Chấm** bằng sự thật nền (`score.mjs`):
   - lái xe theo đường thẳng BR-P41 (× 1,3 ở 30 km/h) cho cả hai bên (Q10);
   - cộng thời gian chờ thật;
   - trạm hỏng thì đi vòng một lần sang trạm dùng được gần nhất (Q12);
   - sạc `60 × (0,8 − SoC) ÷ min(kW súng, 100)` (Q6).

## Tham số kịch bản (đề xuất, chờ Ân duyệt)

| | quiet | peak | faulty station |
|---|---|---|---|
| Súng rảnh | 80 % | 25 % | 80 % (trên các trạm còn lại) |
| Đang sạc, chờ thật | 20 %, 5–40 phút | 55 %, 10–60 phút | 20 %, 5–40 phút |
| Sắp xong, chờ thật | 0 % | 20 %, 0–10 phút | 0 % |
| Có sự cố mở (CSMS ẩn) | 0 | 0 | 8 trạm (15 %) |
| Báo rảnh, trạng thái cũ, thực tế hỏng | 0 | 0 | 5 trạm (10 %) |

Thời gian chờ thật được rút ngẫu nhiên, **độc lập** với ước lượng hằng 30 / 5 phút của CSMS (Q4). Nếu dùng chính hằng số đó làm sự thật, smart luôn đoán đúng và kết quả bị thổi phồng.

## Đầu ra

`results/<ngày>-<kịch bản>/`:
- `meta.json`: tham số, seed, commit, tọa độ và công suất trạm, cấu hình smart search;
- `rows.jsonl`: mỗi request một dòng `phase: request`, cuối file một dòng `phase: end`;
- `summary.md` / `summary.csv`.

Một dòng request gồm:
- `ranking_source`;
- `route_calls`: số Route Vietmap phát sinh ở request này;
- `smart` / `baseline`: trạm, trạng thái thật, `start_min`, `target_min`, có đi vòng không;
- `delta_*`: baseline − smart; **dương nghĩa là smart nhanh hơn**;
- `road`: chỉ số phụ, khi cả hai trạm có `road_estimate`;
- `load`: sự thật nền của 50 trạm;
- `ranking`: toàn bộ thứ hạng smart, kèm `est_*` và `road_estimate`.

Báo cáo (Q11, Q13):
- trung bình, trung vị, p90 cho mỗi bên và cho delta;
- thắng / hoà (± 1 phút) / thua, kèm Wilson 95 % cho tỉ lệ thắng;
- tách riêng nhóm `vietmap_route`, và cảnh báo khi `brief` vượt 20 %;
- không làm kiểm định giả thuyết.

## Chỗ lệch tài liệu và chỗ phải đoán

| Chỗ | Cách harness làm |
|---|---|
| Phiếu v1.3 gọi ba kịch bản là idle / mixed / busy; SRS NFR-RES-04 gọi là quiet / peak / faulty station | Theo SRS (quyết định của Nghĩa, 18/11) |
| `DIEN-TAP-BM04.md` ghi hạn mức Console 1500 Route/ngày; D-Y chia cho RQ2 tối đa 900 | Ngân sách mặc định 850, chừa 500 cho NFR-RES-01 |
| Design Brief D3 / BR-P41 có "reliability penalty"; code chưa có | Đo **bản đang chạy**, không có penalty |
| Tài liệu không cho tỉ lệ tải, khoảng chờ hay vùng | Bảng trên; vùng Thủ Đức 4,7 × 3,5 km (Q20) |
| "Nearest" tính theo gì | Khoảng cách đường thẳng của `sort=distance` |

## Hạn chế

- **Lái xe ngắn.** Kịch bản trong một quận, quãng lái vài phút, nên phần chờ chiếm phần lớn thời gian.
- **Chỉ số chính chấm lái xe bằng đường thẳng.** Không có đường thật cho trạm của đối chứng mà không tốn thêm Route; chỉ số phụ dùng Vietmap khi có cho cả hai trạm.
- **Không mô hình hoá giảm công suất** khi pin gần đầy, cũng không tính hàng đợi giữa các tài xế.
- **Trạm "cũ" luôn hỏng thật** trong kịch bản faulty. Đây là ca xấu nhất cho đối chứng, vì trạm cũ nhưng vẫn chạy được thì không bị phạt.
- **Các request độc lập**: tải không phụ thuộc lựa chọn của request trước.
- **Mỗi trạm một trụ, một súng**, giống fixture của NFR-RES-01.
