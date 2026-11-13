# lab/nfr03 — dụng cụ đo NFR-03 / NFR-OCPP-01 (thời gian CSMS trả lời trụ)

Dụng cụ đo, không phải sản phẩm. Không sửa mã CSMS (`src/` không đổi trong PR này), không chỉnh ngưỡng để số đẹp.

| Trạng thái (12/11/2026) | |
|---|---|
| Dụng cụ (bộ sinh tải, server timings, phân tích, seed/cất dữ liệu) | Xong, có unit test |
| Chạy LOCAL (CSMS + Postgres nhúng + 50 trụ trên một máy dev) | **Đã chạy thật** 50 trụ × 600 s, xem [`results/2026-11-12-local/`](results/2026-11-12-local/summary.md) |
| Chạy STAGING (số chính thức của cam kết) | **Đã chạy 13/11/2026: ĐẠT.** Staging `review-14` (VM Azure 2 vCPU / 4 GB, Japan East), máy bắn tải ở Việt Nam: 50/50 trụ, 600 s, 4919 CALL, 0 không trả lời, 0 lỗi; p95 server 34 ms (p99 51, max 152), p95 client 134,9 ms (gồm mạng + TLS + Caddy). `docker stats` lấy mẫu mỗi ~45 s (14 mẫu): cao nhất `csms` 17,1% CPU / 91 MiB, `postgres` 6,7% CPU / 44 MiB. Kết quả: [`results/2026-11-13-staging/`](results/2026-11-13-staging/summary.md). 50 trụ tải đã cất (`disabled`) ngay sau khi đo |

## Đo cái gì

| Nguồn | Câu chữ |
|---|---|
| SRS `docs/requirements/report3-srs.md` §4.2.2, NFR-OCPP-01 | "CSMS response time to a CALL from a charge point" · "≤ 1 s at p95" · measured by "prom-client metrics under k6 load" |
| BM04, NFR-03 Performance (OCPP-01) | "CSMS reply time per charge point message, p95 ≤ 1 s with 50 simulated charge points" · "Simulator load 10 min, server timings (staging)" |

Dụng cụ này đo đúng đại lượng đó bằng hai cách, và báo cả hai:

| | Phía server ("server timings") | Phía client |
|---|---|---|
| Lấy từ đâu | Bảng `ocpp_message_log` của CSMS | Tiến trình bộ sinh tải |
| Mốc đầu | `received_at` của CALL chiều vào: `new Date()` lấy ngay khi ocpp-rpc trao CALL cho CSMS, trước hàng đợi theo trụ, trước khi ghi log, trước nghiệp vụ | Ngay sau `ws.send()` của CALL |
| Mốc cuối | `received_at` của CALLRESULT / CALLERROR chiều ra: `new Date()` ngay sau `ws.send()` của trả lời | Frame trả lời có cùng MessageId về tới tiến trình |
| Gồm | Chờ trong hàng đợi của trụ, INSERT nhật ký, handler, ghi DB | Mọi thứ của phía server + mạng hai chiều + TLS/Caddy + bộ đệm socket + độ trễ của chính bộ sinh tải |
| Không gồm | Mạng, TLS, proxy; thời gian frame nằm trong bộ đệm socket trước khi Node đọc | – |
| Độ phân giải | 1 ms | 0,01 ms |

**Không phải sửa CSMS.** `src/ocpp-gateway/ocpp-server.ts` đã ghi đủ hai đầu của mỗi bản tin với mốc thời gian của cùng một đồng hồ; ghép theo (trụ, epoch, `unique_id`) là ra thời gian xử lý. Vì thế không thêm `prom-client` và không dùng k6 (k6 không nói OCPP-J; trụ giả dùng lại `ocpp-rpc` đã có trong repo). Đây là khác biệt so với cột "Measured by" của SRS, xem "Chỗ phải đoán".

Kết luận ĐẠT / KHÔNG ĐẠT dùng **p95 gộp mọi bản tin**, ở cả hai phía, và tính bản tin không được trả lời là +∞ (quá 5% bản tin timeout thì p95 = ∞, không thể đạt). p95 từng loại bản tin được báo kèm.

## Các file

| File | Việc |
|---|---|
| `run.mjs` | Bộ sinh tải: dựng/nối một CSMS, chạy N trụ, ghi `client-rows.jsonl` + `meta.json`, đọc luôn số server nếu có DB |
| `load-station.mjs` | Một trụ giả OCPP 1.6J: hồ sơ tải + đo thời gian từng CALL |
| `profile.mjs` | Hồ sơ tải có seed của từng trụ (hàm thuần) và định danh `LOAD-0001…` |
| `server-timings.mjs` | Đọc `ocpp_message_log`, ghép CALL–CALLRESULT, ghi `server-rows.jsonl` |
| `analyze.mjs`, `report.mjs` | Tính lại `summary.md` + `summary.csv` từ dữ liệu thô, không cần CSMS |
| `stats.mjs` | Phân vị, ghép cặp, kết luận (hàm thuần) |
| `seed-load.mjs`, `teardown-load.mjs`, `load-data.mjs` | Tạo / cất 50 trụ tải trong một DB có sẵn (staging) |
| `stats.spec.mjs` | Unit test, chạy cùng `npm test -w @powerme/csms` |

Dùng lại của harness RQ1: `rq1/prng.mjs` (mulberry32 có seed), `rq1/local-csms.mjs` (Postgres nhúng + migration + CSMS; thêm tuỳ chọn `envOverrides`, mặc định không đổi), `demo/db-embedded.mjs`. Không dùng lại `rq1/station.mjs`: trụ đó tồn tại để gây lỗi có chủ ý và không đo thời gian.

## Hồ sơ tải

Mỗi trụ, sau khi nối (Basic Auth) và `BootNotification`:

1. `StatusNotification` cho hai súng, và trả lời `TriggerMessage` của CSMS (súng 0/1/2) bằng `StatusNotification`.
2. `Heartbeat` theo `interval` CSMS trả trong `BootNotification.conf` (staging và mặc định: 300 s).
3. Lặp tới hết thời gian: nghỉ 5–20 s → `Authorize` → `Preparing` → `StartTransaction` → `Charging` → 6–18 nhịp `MeterValues` (mỗi nhịp 10 s; hai giá trị: `Energy.Active.Import.Register` và `Power.Active.Import`) → `Finishing` → `StopTransaction` → `Available`.
4. Hết thời gian: phiên đang chạy được dừng bằng `StopTransaction`, rồi đóng socket (mã 1000). Không để lại phiên mở.

Nghỉ, súng (1 hoặc 2), công suất (30–120 kW) và số nhịp rút từ mulberry32 theo `(seed, số thứ tự trụ)`: chạy lại cho đúng kế hoạch cũ. Trụ không gây lỗi nào (không đứt kết nối, không phát lại); việc đó thuộc harness RQ1.

## Chạy local

Từ `apps/csms`, sau `npm ci`. Không cần Docker.

```bash
node lab/nfr03/run.mjs                      # 50 trụ, nối dần 25 s + tải 600 s
node lab/nfr03/run.mjs --stations 5 --duration-s 40 --meter-interval-s 2 --out /tmp/thu   # thử nhanh
node lab/nfr03/analyze.mjs lab/nfr03/results/2026-11-12-local                              # tính lại bảng
```

Lệnh tự dựng Postgres nhúng (cụm riêng, cổng 54500, DB `powerme_nfr03` bị xoá và tạo lại), build và chạy CSMS (cổng 9200) với **mặc định sản phẩm** (`OFFLINE_GRACE_S=120`, heartbeat 300 s) và `ALLOW_LEGACY_NO_CREDENTIAL=false` như staging, nạp 50 trụ tải với một mật khẩu sinh ngẫu nhiên trong bộ nhớ, chạy tải, đọc số server, ghi kết quả, rồi dừng CSMS và Postgres.

| Tham số | Mặc định | Ý nghĩa |
|---|---|---|
| `--url` | (tự dựng local) | `ws(s)://…/ocpp` của CSMS có sẵn |
| `--stations` | `50` | Số trụ (`LOAD-0001`…) |
| `--duration-s` | `600` | Thời gian tải sau giai đoạn nối dần |
| `--ramp-s` | 0,5 s mỗi trụ | Các trụ bắt đầu nối rải đều trong khoảng này |
| `--meter-interval-s` | `10` | Nhịp `MeterValues` (mặc định sản phẩm) |
| `--heartbeat-s` | theo `BootNotification.conf` | Nhịp `Heartbeat` |
| `--seed` | `20261112` | Seed của hồ sơ tải |
| `--call-timeout-s` | `30` | Quá hạn này thì bản tin tính là không được trả lời |
| `--out` | `results/<ngày>-<local\|staging\|external>` | Thư mục kết quả |
| `--db-url` / biến `NFR03_DB_URL` | – | Postgres của CSMS có sẵn (kiểm trụ tải, đọc số server) |
| `--pg-port`, `--pg-dir`, `--ocpp-port` | `54500`, thư mục tạm, `9200` | Khi tự dựng |
| biến `LOAD_CP_PASSWORD` | local: tự sinh | Mật khẩu Basic Auth chung của trụ tải. **Không có tham số dòng lệnh, không được ghi vào kết quả** |

## Dữ liệu ghi ra

| File | Nội dung |
|---|---|
| `client-rows.jsonl` | Mỗi CALL trụ gửi một dòng: `station`, `id` (MessageId), `action`, `sentAt`, `ms` (null = không được trả lời), `outcome` (`ok` / `callerror` / `timeout` / `disconnected`) |
| `server-rows.jsonl` | Mỗi CALL của lần chạy này mà CSMS đã ghi log: `station`, `id`, `action`, `receivedAt`, `ms` (null = log không có trả lời), `result` |
| `meta.json` | Tham số, hồ sơ tải, đích (URL đã bỏ user/mật khẩu), biến môi trường CSMS local, số liệu trụ (nối, rớt, phiên), commit, máy, thời gian, cửa sổ đọc log, số dòng tải để lại trong DB |
| `summary.md`, `summary.csv` | n, số không được trả lời, CALLERROR, p50/p95/p99/max theo loại bản tin và gộp, cho cả hai phía; chênh lệch client − server; kết luận |

Phân vị là nearest-rank (giá trị nhỏ nhất mà ít nhất p% mẫu ≤ nó), không nội suy.

## Kết quả lần chạy local 12/11/2026

**Số đo LOCAL, chưa phải staging**: CSMS (commit `1227be7`, `src/` không sửa), Postgres nhúng 17 beta và 50 trụ giả cùng chạy trên một máy dev (i5-10400F 12 luồng, 16 GB, Windows 11, Node 24.18.1) qua loopback, không TLS, không Caddy. Nối dần 25 s + tải 600 s = 625 s, seed 20261112. Dữ liệu thô và báo cáo đầy đủ: [`results/2026-11-12-local/`](results/2026-11-12-local/summary.md).

| Bản tin | n | Server p50 | Server p95 | Server p99 | Server max | Client p50 | Client p95 | Client p99 | Client max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **Tất cả** | 4963 | 5 | **9** | 16 | 176 | 4,9 | **9,2** | 16,3 | 176,8 |
| Authorize | 260 | 3 | 5 | 10 | 16 | 3,1 | 5,7 | 11,1 | 15,3 |
| BootNotification | 50 | 6 | 13 | 64 | 64 | 6,0 | 13,1 | 69,4 | 69,4 |
| Heartbeat | 100 | 2 | 3 | 4 | 6 | 1,8 | 3,6 | 5,3 | 6,2 |
| MeterValues | 2743 | 5 | 8 | 14 | 51 | 4,9 | 8,7 | 14,5 | 51,1 |
| StartTransaction | 260 | 5 | 11 | 21 | 52 | 5,3 | 10,6 | 20,8 | 51,3 |
| StatusNotification | 1290 | 5 | 8 | 16 | 176 | 5,0 | 8,3 | 16,4 | 176,8 |
| StopTransaction | 260 | 8 | 14 | 27 | 60 | 8,1 | 14,8 | 26,5 | 60,2 |

Đơn vị ms. Vài ô client nhỏ hơn ô server tương ứng vì số server làm tròn tới 1 ms.

- 50/50 trụ nối được, 0 lần bắt tay bị từ chối, 0 lần rớt kết nối, 0 timeout, 0 CALLERROR; 4963/4963 bản tin được trả lời và đều có đủ cặp trong `ocpp_message_log`.
- 260 phiên bắt đầu, 260 dừng xong, cả 260 kết thúc ở `reconciled`; 0 lần `Authorize` không `Accepted`. Trung bình 7,9 CALL/s.
- Chênh lệch client − server của cùng một bản tin: p50 0,2 ms, p95 0,9 ms, max 11,5 ms (loopback).
- **So ngưỡng p95 ≤ 1000 ms: đạt ở cả hai phía (9 ms và 9,2 ms), cách ngưỡng hơn hai bậc độ lớn.** Con số này chỉ nói rằng với tải cam kết, trên một máy dev 12 luồng, CSMS không phải là chỗ nghẽn; nó không thay cho lần đo staging (VM 2 vCPU, TLS, mạng thật).

Lần chạy này dùng mã trước khi thêm bước "thử một trụ trước khi chạy tải" và quy tắc không thử lại khi gặp 401 (hai thay đổi chỉ ở giai đoạn bắt tay, không đụng cách đo). Mã cuối cùng đã được chạy lại ở chế độ `--url` với 6 trụ trên CSMS local, gồm cả ca sai mật khẩu, seed, đọc server timings rời và cất dữ liệu. Sau khi `main` có migration 0019 (#132), lệnh local 5 trụ × 30 s đã chạy lại được trên `main` mới (13/11); lần đo 50 trụ × 600 s không chạy lại, nên số ở bảng trên là của commit `1227be7`.

## Bộ giới hạn đăng nhập có chặn 50 trụ từ một IP không

Không, với điều kiện mật khẩu đúng và các trụ nối dần. Đọc từ `src/stations/charge-point-login-limiter.ts` và `charge-point-auth.service.ts`:

- Bộ đếm chỉ đếm lần **sai mật khẩu (401)**: 5 lần / 60 s cho một cặp (serial, IP), 20 lần / 60 s cho một IP; chạm ngưỡng thì khoá 15 phút, trong lúc khoá mọi lần bắt tay từ khoá đó nhận 429 kể cả đúng mật khẩu. Đăng nhập đúng không được đếm, nên 50 trụ đúng mật khẩu từ một IP không chạm ngưỡng nào.
- Có một giới hạn thứ hai áp cho cả đăng nhập đúng: một IP có tối đa **20 lần bắt tay đang được kiểm cùng lúc** (đang tra DB + băm scrypt); lần thứ 21 nhận 429 "retry in 1 s" và không bị tính là sai. 50 trụ nối trong cùng một khoảnh khắc sẽ có khoảng 30 trụ bị 429 ở lượt đầu. Vì vậy `run.mjs` nối dần (mặc định 0,5 s mỗi trụ, tức 25 s cho 50 trụ) và thử lại khi gặp 429 hoặc lỗi mạng (tối đa 5 lần, nghỉ 1–5 s).
- Trên staging `OCPP_TRUST_PROXY=true` (`infra/staging/docker-compose.yml`): IP là giá trị cuối của `X-Forwarded-For` do Caddy thêm, tức IP công khai của máy bắn tải. Cả 50 trụ chung một khoá IP. Hệ quả: **sai mật khẩu là khoá IP đó 15 phút** (20 lần 401), kể cả mọi trụ khác đi từ cùng IP. `run.mjs` chặn việc này bằng cách thử một trụ (`LOAD-0001`) trước khi chạy tải, và không thử lại khi gặp 401/403/404. Bộ đếm nằm trong bộ nhớ của CSMS: deploy lại là hết khoá.

Lần chạy local 12/11: 0 lần bắt tay bị từ chối trên 50 trụ.

## Chuẩn bị và cất dữ liệu 50 trụ tải

`seed-load.mjs` tạo, trong một transaction và chạy lại được:

| Thứ | Định danh | Ghi chú |
|---|---|---|
| Operator | `tax_code = LOADTEST01` | `status = suspended` |
| Site | `LOAD-TEST-01` | toạ độ Point Nemo (giữa Thái Bình Dương) |
| 50 trụ | `LOAD-0001` … `LOAD-0050`, `PM-LOAD-00NN` | `awaiting_connection` (CSMS tự chuyển `in_service` khi nối lần đầu, STM-3 #3), 2 súng CCS2, credential scrypt băm bằng đúng hàm của CSMS từ `LOAD_CP_PASSWORD` |
| 50 tài xế + ví + thẻ | `load-00NN@load.powerme.test`, thẻ `LOADCARD00NN` | thẻ `online` + `active`, ví 5 000 000 VND (qua một dòng `top_ups` + `credit_transactions` như seed demo) → `Authorize` trả `Accepted` |

**Ẩn khỏi app.** Tìm trạm (`sessions/station-search.ts`), gợi ý dọc đường (`driver/road-discovery.ts`) và bắt đầu sạc từ app (`sessions/driver-charging.service.ts`) đều lọc `operators.status = 'active'`, nên trụ của operator `suspended` không hiện với tài xế. Đường OCPP không xét trạng thái operator nên trụ vẫn nối và sạc bằng thẻ được (đã chạy local). Toạ độ xa là lớp thứ hai. Dữ liệu này KHÔNG ẩn với màn hình quản trị: màn nào liệt kê mọi operator / mọi trụ (Admin, console vận hành) vẫn thấy `LOADTEST01` và 50 trụ `LOAD-*`.

**Không xoá được, và script không cố xoá.** `teardown-load.mjs` chỉ **cất**: gỡ credential (staging chạy `ALLOW_LEGACY_NO_CREDENTIAL=false` nên trụ không nối lại được), `in_service → disabled` (STM-3 #4; trụ `disabled` không bị `OfflineAlertService` mở sự cố `Offline` sau 900 s), khoá thẻ, `suspended` tài khoản tài xế. Chạy `seed-load.mjs` lại là dùng lại được (`disabled → in_service`, STM-3 #5). Lý do không xoá:

| Bảng | Vì sao dòng của tải ở lại |
|---|---|
| `ocpp_message_log` | Trigger append-only chặn DELETE (ADR-0005) |
| `session_status_history` | Trigger append-only chặn DELETE; FK tới `sessions` là RESTRICT |
| `sessions`, `meter_values`, `reconciliation_records` | `sessions` bị `session_status_history` giữ; hai bảng kia tham chiếu `sessions` |
| `charge_points`, `connectors`, `connector_status_events`, `charge_point_connections` | `sessions` và `ocpp_message_log` tham chiếu `charge_points` |
| `users`, `drivers`, `credit_accounts`, `top_ups`, `credit_transactions`, `rfid_cards` | `sessions` tham chiếu tài xế và thẻ; sổ cái credit là append-only theo nghiệp vụ |

Gỡ trigger cần quyền chủ bảng (`app_dev` không có) và phá đúng thứ làm nhật ký đáng tin, nên đây là lựa chọn có chủ ý: dữ liệu tải ở lại, nhận diện bằng serial `LOAD-%` / site `LOAD-TEST-01`. Muốn sạch hẳn chỉ có `./seed.sh --reset` (xoá cả DB staging).

**Dung lượng mỗi lần chạy 50 trụ × 10 phút** (đo ở lần chạy local, xem bảng "Dữ liệu trụ tải để lại" trong summary):

| Bảng | Số dòng mỗi lần chạy | Từ đâu |
|---|---:|---|
| `ocpp_message_log` | 10 226 | 2 dòng mỗi CALL của trụ (4963) + `TriggerMessage` lúc nối (3 CALL + 3 trả lời mỗi trụ) |
| `meter_values` | 5 486 | 2 giá trị đo × 2743 `MeterValues` |
| `connector_status_events` | 1 290 | mỗi `StatusNotification` một dòng |
| `session_status_history` | 780 | 3 dòng mỗi phiên |
| `sessions` | 260 | khoảng 5 phiên mỗi trụ |
| `charge_point_connections` | 50 | mỗi lần nối một dòng. Với mã hiện tại là 51: thêm lần thử của `LOAD-0001` (kèm khoảng 6–8 dòng `ocpp_message_log`) |
| `reconciliation_records`, `remote_commands`, `fault_events`, `credit_transactions` (session_debit) | 0 | |

Tổng khoảng **18 000 dòng mỗi lần chạy**, cộng dồn qua các lần chạy; phần cố định tạo một lần là 1 operator, 1 site, 50 trụ, 100 súng, 50 tài xế / ví / top-up / dòng sổ cái / thẻ. Dung lượng theo byte chưa đo; ước lượng thô là vài MB mỗi lần chạy, chủ yếu ở cột `raw` (jsonb) của `ocpp_message_log`. Hai bảng lớn nhất được partition theo tháng, nên về sau có thể bỏ cả partition theo chính sách lưu trữ, nhưng việc đó bỏ luôn dữ liệu demo của tháng đó.

Phiên của tải là phiên thẻ RFID: kết thúc ở `reconciled`, **không trừ tiền** (quyết toán thẻ RFID chưa có, G5), nên không có dòng `session_debit` nào và số dư ví tải không đổi.

## Chạy trên staging (Trí)

Điều kiện: máy bắn tải có repo ở đúng commit đang chạy trên staging, đã `npm ci` và `npm run build -w @powerme/csms`; có khoá SSH `devtunnel` và mật khẩu role `app_dev` (`infra/staging/DEV-ACCESS.md`). Image CSMS trên VM **không chứa `lab/`** (`.dockerignore`), nên seed chạy từ máy Trí qua tunnel DB, không chạy bằng `docker compose run … csms` trên VM. Quyền của `app_dev` (SELECT/INSERT/UPDATE/DELETE, không DDL, tối đa 5 kết nối, câu lệnh ≤ 60 s) là đủ: seed chỉ INSERT/UPDATE, server timings chỉ SELECT, mỗi lệnh dùng một kết nối.

Chọn lúc không ai demo. Các lệnh dưới đây là Git Bash; PowerShell thì đặt biến bằng `$env:TÊN = '…'`.

```bash
# 0. Tunnel DB (cửa sổ riêng, để mở suốt)
ssh -N -o ServerAliveInterval=30 -L 5433:127.0.0.1:5432 devtunnel@powerme-staging.japaneast.cloudapp.azure.com

# 1. Bí mật chỉ nằm trong biến môi trường của phiên shell này
cd apps/csms
read -rs APP_DEV_PW                         # gõ mật khẩu app_dev, không hiện, không vào lịch sử
export NFR03_DB_URL="postgres://app_dev:${APP_DEV_PW}@127.0.0.1:5433/powerme"
export LOAD_CP_PASSWORD="$(openssl rand -base64 24)"

# 2. Tạo 50 trụ tải (idempotent)
node lab/nfr03/seed-load.mjs --stations 50

# 3. Thử 2 trụ trong 1 phút: kiểm wss + Basic Auth + tunnel trước khi chạy thật
node lab/nfr03/run.mjs --url wss://powerme-staging.japaneast.cloudapp.azure.com/ocpp \
     --stations 2 --duration-s 60 --out /tmp/nfr03-thu

# 4. Lần đo chính thức: 50 trụ, nối dần 25 s + tải 600 s. Có NFR03_DB_URL thì đọc luôn số server.
node lab/nfr03/run.mjs --url wss://powerme-staging.japaneast.cloudapp.azure.com/ocpp \
     --out lab/nfr03/results/$(date +%F)-staging

# 5. (Chỉ khi bước 4 báo không đọc được server timings, vd tunnel rớt) đọc lại sau
node lab/nfr03/server-timings.mjs --dir lab/nfr03/results/$(date +%F)-staging

# 6. Cất trụ tải NGAY sau khi đo (trong vòng 15 phút, trước khi cảnh báo offline 900 s bật)
node lab/nfr03/teardown-load.mjs

# 7. Commit kết quả (CI chạy prettier trên cả meta.json)
npx prettier --check lab/nfr03/results
```

Lưu ý khi chạy:

1. **Bộ giới hạn đăng nhập theo IP**: xem mục trên. Đừng đổi `LOAD_CP_PASSWORD` giữa bước 2 và bước 4; nếu `run.mjs` báo "trụ thử không nối được … 401" thì seed lại rồi chạy lại, đừng chạy lại nhiều lần liên tiếp (mỗi lần là một lần sai trong bộ đếm).
2. **VM 2 vCPU / 4 GB** chạy cả Caddy, CSMS và Postgres. Mỗi lần bắt tay là một lần scrypt (N = 16384, 16 MB, vài chục ms CPU): nối dần 25 s giữ cho không quá vài lần cùng lúc. Trong lúc đo nên mở `docker stats` trên VM và ghi lại CPU/RAM cao nhất của `csms` và `postgres` vào PR kết quả; nếu CPU của `csms` chạm 100% một nhân thì số server sẽ thấp hơn thực tế (xem mối đe doạ 2).
3. **Không chạy hai bộ sinh tải cùng lúc** với cùng 50 serial: socket mới thay socket cũ (mã 1012), số đo hỏng.
4. **Cất muộn hơn 15 phút** sau khi tải dừng thì `OfflineAlertService` mở một sự cố `Offline` cho mỗi trụ tải còn `in_service` (G10). Các sự cố đó thuộc operator `LOADTEST01`, không hiện với nhân viên operator demo, nhưng Admin sẽ thấy; cất xong thì không sinh thêm.
5. Trụ demo `RH24D1-00001` và dữ liệu `HCM-*` không bị đụng: mọi câu lệnh lọc theo site `LOAD-TEST-01` + serial `LOAD-%`, email `load-%@load.powerme.test`, thẻ `LOADCARD%`.
6. Lần chạy chỉ được gọi là số chính thức khi `summary.md` không còn dòng "Chưa dùng được làm số chính thức…": đủ 50 trụ nối được, đủ 600 s, có số server.

## Mối đe doạ tính hợp lệ

1. **Client và server ở hai nơi.** Máy bắn tải ở Việt Nam, VM ở Japan East: số client của staging gồm trễ mạng hai chiều, TLS và Caddy. Vì vậy báo **cả hai** số và bảng chênh lệch client − server; số server là thứ cam kết gọi là "server timings", số client là thứ trụ thật cảm nhận.
2. **Số server có điểm mù.** Mốc đầu được lấy khi Node đã đọc và parse frame. Nếu vòng lặp sự kiện của CSMS nghẽn, frame nằm chờ trong bộ đệm socket và thời gian chờ đó không vào số server. Số client thì thấy. Kết luận vì thế đòi cả hai phía dưới ngưỡng; chênh lệch client − server lớn bất thường (so với trễ mạng) là dấu hiệu nghẽn.
3. **Độ phân giải 1 ms phía server**, và mốc cuối là lúc `ws.send()` trả về chứ chưa phải lúc byte rời máy.
4. **Trụ là trụ kịch bản Node**, không phải SAP simulator (`lab/README.md`, QA-01) và không phải firmware Ruihua. Tỉ lệ các loại bản tin là đề xuất của dụng cụ: phiên dài 1–3 phút (ngắn hơn phiên thật) để 10 phút có đủ mẫu `StartTransaction` / `StopTransaction`; `MeterValues` chỉ mang 2 giá trị đo.
5. **Trụ khoẻ mạnh.** Không có đứt kết nối, không có trụ nối lại phát bù hàng đợi (thứ gây dồn bản tin, EXP-01), không có lệnh từ CSMS ngoài `TriggerMessage` lúc nối. Không có tải từ app tài xế hay dashboard chạy song song.
6. **Mẫu nhỏ ở vài loại bản tin.** 10 phút cho khoảng 50 `BootNotification` và 100 `Heartbeat` (nhịp 300 s): p95/p99 của hai loại này thô. p95 gộp bị chi phối bởi `MeterValues` và `StatusNotification`.
7. **Một lần chạy**, chưa lặp để có khoảng tin cậy; DB gần như trống (thời gian ghi có thể tăng khi bảng lớn).
8. **Riêng lần chạy local**: bộ sinh tải, CSMS và Postgres giành nhau CPU của một máy; loopback không có trễ mạng; Postgres nhúng 17 beta (staging: 16.4); Windows. Con số local không nói gì về VM 2 vCPU.

## Chỗ phải đoán

| Chỗ tài liệu không nói | Lựa chọn của dụng cụ |
|---|---|
| SRS ghi "prom-client metrics under k6 load", BM04 ghi "Simulator load 10 min, server timings" | Theo BM04. "Server timings" = ghép CALL–CALLRESULT trong `ocpp_message_log` (đã có, không cần sửa CSMS); tải = trụ giả Node dùng `ocpp-rpc`. Cột "Measured by" của SRS cần sửa cho khớp, hoặc thêm `prom-client` sau |
| "Reply time" tính từ đâu tới đâu | Server: từ lúc CSMS nhận CALL tới lúc gửi trả lời. Client: từ lúc trụ gửi tới lúc trụ nhận. Báo cả hai |
| p95 trên tập nào | Gộp mọi bản tin trụ gửi trong cả lần chạy (kể cả giai đoạn nối dần và lúc dừng phiên cuối). Từng loại bản tin báo kèm, không quyết định |
| Bản tin không được trả lời | Tính là +∞ khi kết luận |
| Cách tính phân vị | Nearest-rank |
| "50 simulated charge points" làm gì trong 10 phút | Hồ sơ ở mục "Hồ sơ tải"; nhịp `MeterValues` 10 s và `Heartbeat` 300 s là mặc định của sản phẩm |
| Văn bản BM04 không có trong repo | Câu chữ NFR-03 lấy từ đề bài của task BE-37; ai có BM04 nên đối chiếu lại |
