# lab/rq1 — harness thí nghiệm RQ1 / NFR-02

Chạy lặp lại 3 kịch bản đứt kết nối × 30 lần × 3 cấu hình (PowerMe; PowerMe tắt đối soát `RECONCILIATION_ENABLED=false`; SteVe), ghi **mỗi phiên một dòng** và tính chỉ số theo định nghĩa đã chốt ở [`docs/NFR-02-CHI-SO-DOI-SOAT.md`](../../../../docs/NFR-02-CHI-SO-DOI-SOAT.md). Harness **không** đổi định nghĩa nào trong tài liệu đó; chỗ tài liệu im lặng được liệt kê ở mục "Chỗ phải đoán".

Dụng cụ đo, không phải sản phẩm. Không sửa mã CSMS, không chỉnh ngưỡng để số đẹp.

| Trạng thái (12/11/2026) | |
|---|---|
| PowerMe, PowerMe tắt đối soát | **Đã chạy thật** 30 × 3 mỗi cấu hình trên máy dev — xem `results/2026-11-12/` |
| SteVe | **Chưa chạy** (máy dev không có Docker). Đã viết adapter + compose + hướng dẫn; test bằng dữ liệu giả. Xem [`infra/lab/steve/README.md`](../../../../infra/lab/steve/README.md) |
| Ba kịch bản | Tiêu đề **chính thức** (phiếu đăng ký v1.3); tham số hoá chi tiết là **đề xuất, chờ Ân duyệt** |

## Các file

| File | Việc |
|---|---|
| `run.mjs` | Bộ chạy: dựng/nối một cấu hình, chạy song song các lần chạy, đọc kết quả, ghi dữ liệu + báo cáo |
| `analyze.mjs` | Tính lại mọi chỉ số từ `rows.jsonl`/`rows.csv` (không cần CSMS), gộp nhiều cấu hình |
| `plan.mjs`, `prng.mjs` | Kế hoạch có seed của từng lần chạy (hàm thuần): công suất, số mẫu, lúc đứt, độ dài đứt, lỗi gây ra |
| `station.mjs`, `scenarios.mjs` | Trụ giả OCPP 1.6J có bộ đếm năng lượng nội bộ (`E_true`) và ba kịch bản |
| `metrics.mjs`, `report.mjs` | Phân loại 5 nhóm, Wilson, precision/recall, sai số Wh; định dạng JSONL/CSV/Markdown |
| `adapters/powerme.mjs` | Nạp định danh và đọc kết quả từ Postgres của PowerMe |
| `adapters/steve.mjs` | Cùng giao diện cho SteVe (MariaDB qua `docker compose exec`) |
| `local-csms.mjs` | Postgres nhúng (cụm riêng) + migration + seed + `node dist/main.js` |
| `*.spec.mjs` | Unit test, chạy cùng `npm test -w @powerme/csms` |

`demo/scripted-station.mjs` được giữ nguyên. Trụ ở đây nói giao thức theo cùng cách (ds-03a/b/d) nhưng là một lớp chạy song song được và có sự thật nền; tách phần dùng chung khỏi script demo sẽ phải viết lại một file CLI đang dùng cho Review, nên không làm trong PR này. Phần dùng chung thật sự là `demo/db-embedded.mjs` (thêm tuỳ chọn `dataDir`/`port`/`database`, mặc định không đổi).

## Chạy

Từ `apps/csms`, sau `npm ci`. Không cần Docker cho hai cấu hình PowerMe.

```bash
# PowerMe (đối soát bật) và PowerMe tắt đối soát: tự dựng Postgres nhúng (cổng 54490) + CSMS (cổng 9190)
node lab/rq1/run.mjs --config powerme     --scenario all --runs 30 --seed 20261112
node lab/rq1/run.mjs --config powerme-off --scenario all --runs 30 --seed 20261112

# SteVe (trên VM có Docker, xem infra/lab/steve/README.md)
node lab/rq1/run.mjs --config steve --scenario all --runs 30 --seed 20261112

# Gộp các cấu hình đã chạy thành một báo cáo
node lab/rq1/analyze.mjs lab/rq1/results/<ngày>/powerme/rows.jsonl \
     lab/rq1/results/<ngày>/powerme-off/rows.jsonl --out lab/rq1/results/<ngày>
```

Mỗi lệnh `run.mjs` chạy **một** cấu hình trên DB sạch (DB `powerme_rq1` bị xoá và tạo lại), rồi tự dừng CSMS và Postgres. Ba cấu hình dùng **cùng seed** nên nhận cùng kế hoạch và cùng `E_true`.

| Tham số | Mặc định | Ý nghĩa |
|---|---|---|
| `--config` | (bắt buộc) | `powerme` \| `powerme-off` \| `steve` |
| `--scenario` | `all` | `s1` \| `s2` \| `s3` \| `all` (hoặc danh sách cách nhau bằng dấu phẩy) |
| `--runs` | `30` | Số lần chạy mỗi kịch bản |
| `--seed` | `20261112` | Seed gốc. Seed con của lần chạy = FNV-1a(`seed\|kịch bản\|số thứ tự`) |
| `--out` | `lab/rq1/results/<ngày>` | Ghi vào `<out>/<config>/` |
| `--concurrency` | `10` | Số trụ chạy song song (mỗi lần chạy một trụ + một thẻ + một tài xế riêng) |
| `--interval-s`, `--grace-s` | `2`, `5` | Nhịp MeterValues và `OFFLINE_GRACE_S` của thí nghiệm (đã rút ngắn, xem dưới) |
| `--url` (+ `--db-url`) | — | Trỏ vào CSMS có sẵn thay vì tự dựng; PowerMe cần thêm chuỗi kết nối Postgres để nạp định danh và đọc kết quả. `CP_PASSWORD` nếu trụ cần Basic Auth. **Chưa thử với staging** |
| `--pg-port`, `--pg-dir`, `--ocpp-port` | `54490`, thư mục tạm, `9190` | Cụm Postgres nhúng và cổng OCPP khi tự dựng |
| `--batch` | theo seed | Tiền tố định danh trụ/thẻ; đổi khi chạy lại trên CSMS không xoá dữ liệu |
| `--steve-compose`, `--steve-schema` | `infra/lab/steve/docker-compose.yml`, `evse` | Cách truy vấn MariaDB của SteVe; `connector` cho bản SteVe cũ |
| `--register-only`, `--print-sql` | — | (SteVe) chỉ đăng ký trụ + thẻ / chỉ in SQL đăng ký |
| `--s2-queue-lost-p` | `0` | **Thăm dò, ngoài 3 kịch bản**: xác suất S2 làm mất hẳn hàng đợi MeterValues. Khác 0 thì không dùng cho NFR-02 |

## Ba kịch bản

**Chính thức** là ba tiêu đề trong phiếu đăng ký v1.3 §RQ1 (`docs/requirements/registration-form-v1.3.md`): *"disconnects during meter reporting, just before StopTransaction, and during an offline-started session"*. `docs/WP2-LO-TRINH-KY-THUAT.md` (tuần 1) có cùng ba ý. NFR-02 mục 6 nói thêm: một kịch bản là "phát lại `meterStop` cũ", hai kịch bản còn lại có `meterStop` hợp lệ. Không tài liệu nào (Report 4, BM04, ADR, WF-03) định nghĩa chi tiết hơn.

Phần **tham số hoá dưới đây là đề xuất của harness, chờ Ân duyệt**. Nó ghép ba tiêu đề chính thức với các ca đã kiểm ở `docs/DEMO-REVIEW-2.md` (DS-03a, DS-03b, DS-03d) và hiện tượng của EXP-01:

| | Tiêu đề chính thức | Trụ làm gì (đề xuất) | Dữ liệu trụ | Kết quả đúng theo NFR-02 |
|---|---|---|---|---|
| **S1** | Đứt giữa chuỗi MeterValues | Sạc 2–5 nhịp → đứt (dài hơn ân hạn) trong khi vẫn sạc và xếp hàng mẫu → nối lại **không Boot** → **nửa số lần** phát bù hàng đợi, nửa còn lại làm mất hàng đợi (EXP-01 hiện tượng 4) → sạc tiếp 2–4 nhịp → dừng bình thường. Như DS-03d | Đúng | Tính tiền đúng |
| **S2** | Đứt ngay trước StopTransaction | Sạc 2–5 nhịp → đứt → xe sạc thêm 1–4 nhịp rồi tài xế dừng khi trụ còn offline → nối lại không Boot → `StopTransaction` phát lại mang **`meterStop` cũ** (số lúc đứt, EXP-01 hiện tượng 3) → MeterValues phát bù đến **sau** (thứ tự của EXP-01). Như DS-03a | **Sai** | Giữ lại đúng |
| **S3** | Phiên bắt đầu khi offline | Đứt → phiên bắt đầu và sạc khi offline → nối lại, gửi `StartTransaction` (mốc thời gian cũ) → "mất phản hồi": đứt 1 s, nối lại, gửi lại **y nguyên** (DS-03b) → phát bù MeterValues → sạc tiếp → dừng bình thường → **nửa số lần** gửi lại `StopTransaction` y nguyên | Đúng | Tính tiền đúng; không ghi trùng |

Điểm cần Ân quyết: (a) S1 có nên gồm cả biến thể mất hàng đợi không (cần nó để có khe hở thật cho precision/recall của `meter_gap`); (b) S2 luôn phát lại `meterStop` cũ, hay chỉ một phần số lần; (c) S3 ghép "bắt đầu khi offline" với "gửi lại bản tin" trong một kịch bản, hay tách gửi lại thành kịch bản thứ tư.

Mọi số ngẫu nhiên (công suất 30–120 kW, dao động ±10% mỗi nhịp, `meterStart` 0–500 000 Wh, số nhịp, độ dài đứt, biến thể) rút từ mulberry32 theo seed con, nên chạy lại cho đúng kế hoạch cũ. `E_true` là tổng các lượng Wh đã rút, không phụ thuộc đồng hồ máy.

## Dữ liệu ghi ra

`<out>/<config>/`:

| File | Nội dung |
|---|---|
| `rows.jsonl`, `rows.csv` | Một dòng mỗi lần chạy (= một phiên theo sự thật nền) |
| `meta.json` | Seed, lô định danh, tham số thời gian, biến môi trường CSMS (trừ `DATABASE_URL`), commit git, Node, thời gian chạy |
| `summary.md`, `summary.csv` | Bảng tổng hợp của riêng cấu hình đó |

Các trường bắt buộc theo NFR-02 mục 5: `run_id`, `scenario`, `config`, `seed`, `session_id`, `transaction_id`, `E_true`, `E_stop`, `E_bill` (trống nếu không tính tiền), `status`, `injected_fault` (JSON), `class`.

| Trường thêm | Ý nghĩa |
|---|---|
| `run_index`, `run_seed`, `charge_point`, `id_tag` | Định danh lần chạy và trụ/thẻ riêng của nó |
| `session_count` | Số phiên hệ thống ghi cho trụ này: 0 = mất, > 1 = trùng |
| `class_subtype` | `lost` / `duplicate` / `station_error` |
| `station_data_wrong` | `abs(E_stop − E_true) > 1` |
| `gap_true`, `max_delivered_gap_s` | Khe hở thật: khoảng trống lớn nhất trong chuỗi mẫu trụ **đã giao** (tính cả mốc bắt đầu và mốc dừng) có vượt ngưỡng `RECONCILE_GAP_FACTOR × nhịp` không |
| `meter_gap_records`, `conflict_records`, `late_sample_records`, `replay_records`, `duplicate_records`, `orphan_stop_records` | Số dòng `reconciliation_records` theo loại |
| `status_path` | Chuỗi chuyển trạng thái từ `session_status_history` |
| `payment_mode`, `debit_vnd` | `debit_vnd` trống = chưa có dòng `session_debit` (xem G5 bên dưới) |
| `meter_start_wh`, `meter_stop_sent_wh`, `meter_stop_true_wh`, `db_meter_stop_wh` | Số chỉ bộ đếm: trụ gửi, sự thật, và CSMS lưu |
| `station_transaction_ids` | `transactionId` trụ nhận ở mỗi lần gửi `StartTransaction` |
| `started_at`, `duration_s`, `error` | |

Nhóm (`class`): `billed_correct`, `held_correct`, `held_unnecessary`, `billed_wrong_silent`, `lost_or_duplicate` là 5 nhóm của NFR-02 mục 3; `unresolved` và `harness_error` là hai nhóm thêm (xem "Chỗ phải đoán").

`E_bill` lấy từ đâu: PowerMe (bật và tắt đối soát) đọc `sessions.energy_wh` khi phiên `reconciled`; phiên `review` không có `E_bill`. SteVe: `stop_value − start_value` của view `transaction`.

## Kết quả lần chạy 12/11/2026

Dữ liệu thô và báo cáo: [`results/2026-11-12/`](results/2026-11-12/) (`summary.md` gộp hai cấu hình). CSMS ở commit `885b38e` (= `origin/main`, không sửa `src/`), seed 20261112, 30 lần × 3 kịch bản × 2 cấu hình = **180 lần chạy**, 10 trụ song song, mỗi cấu hình mất **~189 s** (189,6 s và 188,6 s), Node 24.18.1, Windows, Postgres nhúng 17 beta. Không lần chạy nào bị lỗi harness.

| Cấu hình | Kịch bản | n | Tính tiền đúng | Giữ lại đúng | Giữ lại thừa | Sai im lặng | Mất/trùng | Tỉ lệ đúng | CI Wilson 95% |
|---|---|---|---|---|---|---|---|---|---|
| PowerMe | S1 | 30 | 30 | 0 | 0 | 0 | 0 | 100% | 88,6 – 100% |
| PowerMe | S2 | 30 | 0 | 30 | 0 | 0 | 0 | 100% | 88,6 – 100% |
| PowerMe | S3 | 30 | 30 | 0 | 0 | 0 | 0 | 100% | 88,6 – 100% |
| PowerMe | gộp | 90 | 60 | 30 | 0 | **0** | 0 | 100% | **95,9** – 100% |
| Tắt đối soát | S1 | 30 | 30 | 0 | 0 | 0 | 0 | 100% | 88,6 – 100% |
| Tắt đối soát | S2 | 30 | 0 | 0 | 0 | **30** | 0 | 0% | 0 – 11,4% |
| Tắt đối soát | S3 | 30 | 30 | 0 | 0 | 0 | 0 | 100% | 88,6 – 100% |
| Tắt đối soát | gộp | 90 | 60 | 0 | 0 | **30** | 0 | 66,7% | 56,4 – 75,5% |

- **Giữ phiên lại** (PowerMe): precision 30/30, recall 30/30. Tắt đối soát: recall 0/30.
- **Sai số Wh** trên phiên đã tính tiền: PowerMe 0 Wh (60 phiên). Tắt đối soát, S2: trung bình thiếu **117,3 Wh** mỗi phiên (CI 95%: 91,4 – 143,2), tức tính thiếu trung bình 47% năng lượng thật của 30 phiên đó.
- **Mất / trùng**: 0 ở cả hai cấu hình. Ở S3, `StartTransaction` gửi lại nhận lại đúng `transactionId` cũ trong 60/60 lần.
- **Khe hở** (`meter_gap`, chỉ PowerMe ghi): 11 lần S1 có khe hở thật, bắt được 11/11. Thêm 12 bản ghi `meter_gap` ở S2 là báo thừa theo định nghĩa sự thật nền của harness (sinh lúc `StopTransaction` đến trước các mẫu phát bù) → precision gộp 11/23.

**So với ngưỡng NFR-02:** "tính tiền sai im lặng = 0 trên 90 lần" **đạt**; PowerMe tốt hơn cấu hình tắt đối soát **đạt** (chỉ khác nhau ở S2). "Cận dưới ≥ 95% ở **cả 3** kịch bản" **không đạt và không thể đạt** với n = 30 (xem mối đe doạ 7); trên mẫu gộp 90 lần thì đạt (95,9%). So với SteVe: chưa có số.

### Phát hiện về CSMS (chỉ ghi nhận, không sửa trong PR này)

1. **Phiên S2 đi qua `reconciled` trước khi vào `review`.** Cả 30/30 lần có đường đi `orphaned → reconciled (RECONCILE_OK) → review (LATE_SAMPLE_CONFLICT)`: lúc `StopTransaction` phát lại tới, mẫu cuối CSMS có bằng đúng `meterStop` cũ nên đối soát cho qua; chỉ khi MeterValues phát bù tới sau đó phiên mới bị giữ. Trong khoảng đó phiên là `reconciled` với số Wh sai. Hiện vô hại vì phiên thẻ RFID chưa được quyết toán (G5); khi G5 làm xong, nếu quyết toán chạy trong khoảng này thì T13 #19 giữ nguyên `reconciled` ("đã trừ tiền") và đó sẽ là tính tiền sai im lặng. Đề xuất: không quyết toán phiên `delivered_offline` trước khi hết một khoảng chờ mẫu phát bù, hoặc đo lại S2 sau khi G5 merge.
2. **Việc bắt `meterStop` cũ phụ thuộc hoàn toàn vào MeterValues phát bù.** Lần chạy thăm dò ngoài 3 kịch bản (`results/2026-11-12/tham-do-s2-mat-hang-doi/`, 10 lần, `--s2-queue-lost-p 1`: S2 nhưng hàng đợi MeterValues mất hẳn) cho **10/10 tính tiền sai im lặng với đối soát BẬT**. Không có mẫu nào sau lúc đứt thì CSMS không có gì để so. EXP-01 từng mất 2/8 mẫu phát bù; mất cả hàng đợi là ca xấu hơn nhưng không phải không thể. Đề xuất: hỏi Ân có đưa biến thể này vào S2 không; nếu có, cần một tín hiệu khác (ví dụ khoảng trống từ mẫu cuối tới `cp_stopped_at` của một `StopTransaction` phát lại).
3. **`meter_gap` ở S2 là tạm thời.** 12/30 phiên S2 nhận bản ghi `meter_gap` lúc dừng dù chuỗi mẫu cuối cùng không có khe hở; bản ghi là append-only nên vẫn nằm trong hàng đợi của operator.
4. Khử trùng `StartTransaction` (ADR-0010) đúng trong 30/30 lần S3 ở cả hai cấu hình (không phiên thứ hai). Với đối soát bật, 17/17 lần gửi lại `StopTransaction` được ghi `orphan_stop` và không đổi số liệu phiên.

## Mối đe doạ tính hợp lệ

1. **Thời gian đã rút ngắn.** Nhịp MeterValues 2 s (sản phẩm: 10 s), `OFFLINE_GRACE_S` = 5 s (sản phẩm: 120 s), độ dài đứt 6–15 s (EXP-01: 81 s), nghỉ giữa hai lần gửi lại 1 s. Tỉ lệ giữa các mốc được giữ (đứt dài hơn ân hạn; ngưỡng khe hở = 3 nhịp), nhưng hành vi ở thang thời gian thật chưa được đo. `REPLAY_SKEW_THRESHOLD_S` giữ 5 s nên một phần mẫu phát bù (trễ dưới 5 s) không bị gắn cờ phát lại; cờ này không ảnh hưởng quyết định giữ phiên. Mọi giá trị nằm trong `meta.json` và đầu `summary.md`.
2. **Trụ là trụ kịch bản Node, không phải SAP simulator.** `lab/README.md` (QA-01) quy định số liệu báo cáo phải chạy trên SAP; SAP còn thiếu 4 config key (G4) nên PR này dùng trụ kịch bản. Trụ gây lỗi **có chủ ý** theo hiện tượng EXP-01; nó không chứng minh firmware Ruihua hay SAP làm đúng như vậy, và nó cố tình không có các lỗi khác (mất một phần hàng đợi, lệch đồng hồ, Boot sau khi nối lại).
3. **Lỗi được gây ra có cùng dạng với thứ engine được thiết kế để bắt.** S2 phát lại `meterStop` cũ **và** luôn phát bù MeterValues sau đó; đó chính là ca DS-03a engine đã được viết để xử lý. Kết quả S2 không nói gì về các dạng dữ liệu sai khác (xem "Phát hiện").
4. **"Đã tính tiền" chưa phải tiền thật.** Phiên bắt đầu bằng thẻ RFID chưa được quyết toán (G5: `charge-settlement.service.ts` chỉ xử lý `app_qr`), nên không có dòng `session_debit` nào (`debit_vnd` trống ở mọi dòng). `E_bill` là `sessions.energy_wh` của phiên `reconciled`, đúng theo NFR-02 mục 2, tức số Wh **sẽ** dùng để tính tiền.
5. **Postgres nhúng 17 beta, một máy, một tiến trình CSMS.** Staging và CI dùng Postgres 16. Trụ và CSMS chạy trên cùng máy qua loopback: không có trễ mạng, không mất gói, đồng hồ trụ và CSMS trùng nhau.
6. **Chạy song song 10 trụ.** Mỗi lần chạy có trụ, thẻ, tài xế riêng nên không đụng dữ liệu của nhau, nhưng CSMS chịu tải của 10 trụ cùng lúc; chưa đo lại với `--concurrency 1` để so.
7. **Cỡ mẫu.** Với n = 30, kể cả 30/30 đúng thì cận dưới Wilson 95% là 88,6%: ngưỡng "cận dưới ≥ 95% ở cả 3 kịch bản" của NFR-02 **không thể đạt** với 30 lần mỗi kịch bản. Gộp 90 lần thì 90/90 cho 95,9%. Cần Ân xác nhận ngưỡng áp cho từng kịch bản hay cho mẫu gộp (hoặc tăng số lần chạy lên ≥ 73 mỗi kịch bản).
8. **SteVe chưa chạy**, nên chưa có so sánh ba cấu hình; "tài nguyên máy như nhau" (phiếu đăng ký) cũng chưa bảo đảm được vì PowerMe đo trên máy dev còn SteVe sẽ đo trên VM.

## Chỗ phải đoán

| Chỗ tài liệu không nói | Lựa chọn tối thiểu của harness |
|---|---|
| Phiên có trong hệ thống nhưng không tính tiền cũng không ở `review` (kẹt `orphaned`/`active`; SteVe chưa có stop) | Nhóm `unresolved`, tính là sai |
| Lần chạy mà trụ giả lỗi giữa chừng | Nhóm `harness_error`, vẫn trong mẫu số, tính là sai |
| "Đã tính tiền" ở PowerMe khi chưa có quyết toán thẻ RFID (G5) | Phiên `reconciled` có `energy_wh` (đúng câu chữ NFR-02 mục 2) |
| Sự thật nền của "khe hở" cho precision/recall `meter_gap` | Chuỗi mẫu trụ đã giao có khoảng trống > `RECONCILE_GAP_FACTOR × nhịp` (cùng ngưỡng CSMS dùng). Bản ghi `meter_gap` sinh lúc StopTransaction đến trước các mẫu phát bù vì thế tính là báo thừa |
| CI của sai số Wh | Khoảng tin cậy t 95% của trung bình `abs(E_bill − E_true)` trên các phiên đã tính tiền |
| Giữ lại khi không xác định được dữ liệu trụ đúng/sai (trụ chưa gửi Stop) | Tính là giữ lại thừa |
| Mất/trùng | Đếm phiên theo trụ: mỗi lần chạy một trụ riêng, đúng một phiên là đúng |
