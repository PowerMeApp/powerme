# Kịch bản demo Review 2 — PowerMe CSMS

> **Phạm vi.** Tài liệu này phục vụ mục 9.2 hướng dẫn Review 2: mỗi main workflow có ≥ 1 kịch bản chính và 1 ngoại lệ; dữ liệu mẫu nạp bằng script; demo lặp lại được; Hội đồng có thể đổi dữ liệu đầu vào.
> **Workflow chính của bản demo: WF-03 "mất kết nối và đối soát"** (chủ: Trí). WF-01 chỉ có phần quẹt thẻ RFID.
> **Mọi kết quả dưới đây là kết quả quan sát thật ngày 23/10/2026** (CSMS + Postgres nhúng + HMI + console, Windows 11, Node 24, cả ba chạy cùng nhau lần đầu ở BE-10), cộng với trụ kịch bản và test tích hợp `apps/csms/test/wf03-exp01.integration.test.ts`. Chưa chạy được thì ghi rõ trong cột "Trạng thái". Lời thoại và từng giây của buổi trình diễn: [`docs/demo/KICH-BAN-TRINH-DIEN.md`](demo/KICH-BAN-TRINH-DIEN.md).

## 1. Chuẩn bị

### 1.1 Lệnh một dòng

```bash
npm install --ignore-scripts      # một lần, ở gốc repo (kéo binary Postgres nhúng, ~30 s–1 phút)
npm run demo -w @powerme/csms     # mọi lần demo
```

Khởi động đo được (máy dev, Windows 11; tính từ lúc gõ lệnh tới dòng `=== Demo PowerMe sẵn sàng sau N s ===`):

| Trạng thái | Thời gian |
| --- | --- |
| **Lạnh hoàn toàn** (không có `dist/`, không có `.demo-data/`; tsc + initdb + migration + seed + CSMS + HMI + console) | **23,1 s** theo script (24,6 s đồng hồ tường kể cả khởi động npm) |
| `demo:reset` khi `dist/` đã có | 19,8 s |
| Chạy lại, dữ liệu và `dist/` đã có (sau một lần dừng không sạch) | 15,6 s |

(Con số "~5 s khi chạy lại" từng có ở BE-09 **không đúng** với lần đo này; Postgres phải làm crash recovery nếu lần trước bị kill.)

Script **chỉ in URL**, không tự mở trình duyệt: console `http://localhost:3000/`, HMI `http://localhost:8100/`.

Dừng bằng **Ctrl+C** trong cửa sổ đang chạy (script kill cây tiến trình con và `pg_ctl stop`). Lưu ý trung thực: phiên làm việc của BE-10 không có console tương tác để bấm Ctrl+C thật, nên chưa kiểm phím đó; đã kiểm **đường dừng bên trong** (`shutdown()`) bằng cách kill tiến trình CSMS: script in `đã dừng sạch`, cổng 9000/3000/8100/54330 trống, không còn `postgres.exe`/`node` của repo này (3 lần).

Làm lại từ đầu (xoá mọi phiên đã sinh, về đúng dữ liệu seed, số giao dịch quay về #1): `npm run demo:reset -w @powerme/csms`. Chi tiết: [`apps/csms/demo/README.md`](../apps/csms/demo/README.md).

### 1.2 Ba cửa sổ

| Cửa sổ | Mở gì | Cổng |
| --- | --- | --- |
| 1. Terminal | `npm run demo -w @powerme/csms` — để nguyên, log `[csms]` `[hmi]` `[db]` chạy ở đây | — |
| 2. Console vận hành | `http://localhost:3000/` — thẻ trụ, bảng phiên, đối soát, nhật ký OCPP trực tiếp (SSE) | 3000 |
| 3. HMI trụ D1 | `http://localhost:8100/` — hai súng A/B, cắm/rút, quẹt thẻ, mật khẩu, "Rớt mạng", nhật ký OCPP phía trụ | 8100 |

Hai tab (2 và 3) đặt cạnh nhau trên một màn hình. Cần xem DB thô: `node apps/csms/demo/show.mjs` (không cần psql).

### 1.3 Checklist 5 phút trước giờ demo

- [ ] `git status` sạch, đang ở nhánh `main` mới nhất; `npm install --ignore-scripts` đã chạy.
- [ ] Không còn gì nghe cổng 9000/54330/8100/3000: `netstat -ano | findstr "9000 54330 8100 3000"` (nếu có, xem ai giữ rồi mới quyết; hoặc dùng `--port-offset`).
- [ ] `npm run demo:reset -w @powerme/csms` — dữ liệu sạch, thấy `=== Demo PowerMe sẵn sàng`, `seed xong: {"charge_points":"1","connectors":"2","rfid_cards":"3","tariff_periods":"7"}` và `HMI trụ D1 tại http://127.0.0.1:8100`.
- [ ] Console `/` hiện **1 online · 0 offline** và "Chưa có phiên sạc"; HMI hiện **Mạng: online**, hai súng `Available`. Dòng `PHÁT LẠI` lúc trụ vừa nối là bình thường (xem "Bất ngờ" #4).
- [ ] Đừng chạy `scripted-station.mjs` khi HMI đang bật (cùng identity `RH24D1-00001`).
- [ ] Mở sẵn `docs/WF-03-MAT-KET-NOI-VA-DOI-SOAT.md` (sequence diagram), trace `apps/csms/test/fixtures/exp1-disconnect-81s.jsonl` và ảnh dự phòng trong `docs/demo/`.
- [ ] Pin laptop, tắt thông báo, phóng to font; nút "Chữ lớn" trên HMI cho máy chiếu.
- [ ] Biết sẵn `node apps/csms/demo/show.mjs` và `docs/BAO-CAO-TIEN-DO-WP2-REVIEW-2.md`.

### 1.4 Chạy kịch bản bằng trụ kịch bản (kế hoạch B, không cần HMI)

**Trụ kịch bản và HMI dùng chung identity `RH24D1-00001`: chỉ chạy một trong hai.** Muốn dùng trụ kịch bản thì khởi động bằng `npm run demo -w @powerme/csms -- --no-hmi` (hoặc tắt tab HMI và dừng tiến trình HMI trước).

```bash
node apps/csms/demo/scripted-station.mjs <ds-01a|ds-01b|ds-03a|ds-03b|ds-03c|ds-03d> [--fast]
```

`--fast` rút nhịp MeterValues còn 3 s và đứt mạng còn 15 s (demo ngắn; `ds-03a --fast` chạy ~26 s). Không có `--fast`: nhịp 10 s, đứt mạng 60 s (DS-03a mất ~95 s). Tuỳ chọn khác (`--id`, `--url`, `--tag`, `--offline-s`) xem đầu file `apps/csms/demo/scripted-station.mjs`. **Hội đồng đổi dữ liệu đầu vào** bằng các tuỳ chọn này, ví dụ `--offline-s 120`, `--tag DEMO-WALLET-0001`, `--tag <thẻ khác>`.

> `lab/fake-station.mjs` **không** tạo được phiên một mình: nó chỉ bắt đầu sạc khi CSMS gửi `RemoteStartTransaction`, mà CSMS Iteration 1 chưa có đường gửi lệnh xuống trụ. Đã kiểm nó nối được (`Boot`, `StatusNotification`) với `ID=RH24D1-00001`; còn phiên sạc thì dùng trụ kịch bản hoặc HMI.

### 1.5 Lái HMI bằng HTTP API (kiểm thử lặp lại được, không cần bấm chuột)

HMI nghe `127.0.0.1:8100`; mọi nút bấm là `POST /api/<hành động>` với JSON (`server.mjs`, `hmi-actions.mjs`, `station.mjs`). Thẻ mẫu của HMI (`simulator/d1-hmi/model.mjs`): `valid` = `DEMO-CARD-0001`, `wallet` = `DEMO-WALLET-0001`, `unknown` = `DEMO-UNKNOWN-999`; mật khẩu HMI mẫu `123456` (free vend, idTag `HMI-FREEVEND`).

```bash
curl -X POST localhost:8100/api/plug   -d '{"connector":1}'                       # cắm súng A
curl -X POST localhost:8100/api/swipe  -d '{"connector":1,"card":"valid"}'        # quẹt thẻ (valid|wallet|unknown)
curl -X POST localhost:8100/api/password -d '{"connector":1,"password":"123456"}' # free vend
curl -X POST localhost:8100/api/drop   -d '{"seconds":60}'                        # rớt mạng cả trụ (1–180 s)
curl -X POST localhost:8100/api/stop   -d '{"connector":1}'                       # dừng sạc
curl -X POST localhost:8100/api/unplug -d '{"connector":1}'                       # rút súng
curl localhost:8100/api/state                                                     # trạng thái trụ (JSON)
```

Đọc console: `curl localhost:3000/api/admin/summary | /sessions | /reconciliation | /messages?limit=50 | /stations`. Dữ liệu seed khớp HMI: `DEMO-CARD-0001` (online, active), `DEMO-WALLET-0001` (wallet, active), `charge_points.free_vend_tag = 'HMI-FREEVEND'`; thẻ lạ của HMI **không** được seed; thẻ `DEMO-BLOCKED-01` (blocked) chỉ trụ kịch bản mới quẹt được (HMI không có nút).

### 1.6 Kế hoạch B

| Sự cố | Cách xử lý |
| --- | --- |
| HMI/console không lên | Chạy `npm run demo -w @powerme/csms -- --no-hmi`, dùng trụ kịch bản (1.4) và `show.mjs` |
| HMI chạy nhưng phiên ra `reconciled` thay vì `review` sau rớt mạng | `STALE_METERSTOP` đang tắt. Dùng trụ kịch bản `ds-03a` (cho đúng hiện tượng, xem WF-03) hoặc chạy lại demo mặc định (bật sẵn) |
| Postgres nhúng không lên (cổng bận, antivirus chặn `postgres.exe`) | `npm run demo:reset`, hoặc `--port-offset 10`; chưa được thì chuyển sang phát lại trace (dòng dưới) |
| CSMS không chạy được nhưng Postgres nhúng còn | **Phát lại trace EXP-01 bằng test tích hợp** (lệnh ngay dưới bảng) — test không mở socket, đưa 75 frame thật của EXP-01 qua đúng đường xử lý của gateway |
| Cả Postgres nhúng cũng hỏng | Trình bày bằng trace `apps/csms/test/fixtures/exp1-disconnect-81s.jsonl`, sequence diagram (`node apps/csms/lab/trace-to-mermaid.mjs`) và **ảnh chụp dự phòng ở mục 2.4 / `docs/demo/`** |
| Mạng/ổ cứng chậm | Chạy sẵn `npm run demo` từ trước, dùng `--fast` ở trụ kịch bản |
| Mọi thứ hỏng | Ảnh chụp trong `docs/demo/` và đầu ra `npm test` của test tích hợp |

Phát lại bằng test tích hợp (cần `npm run demo:db` ở cửa sổ khác; test dùng DB riêng `powerme_test`, **không** trỏ vào `powerme_demo` vì test DROP SCHEMA):

```bash
DATABASE_URL=postgresql://powerme:powerme@127.0.0.1:54330/powerme_test npm test -w @powerme/csms
```

Kết quả đã chạy ở BE-09: 7 suite / 115 test đạt, gồm 19 test tích hợp WF-03 (EXP-01) trên Postgres 17 nhúng. (Chưa chạy lại ở BE-10.)

## 2. Bảng kịch bản

Cột "Trạng thái": **đã kiểm (HMI+console)** = tôi lái HMI thật qua HTTP API của nó, đọc console (`/api/admin/*`, ảnh chụp trang) và DB (`show.mjs`) và thấy đúng như cột "thấy gì"; **đã kiểm (trụ kịch bản)** = chỉ chạy bằng `scripted-station.mjs` (HMI không tạo được tình huống đó, lý do ghi trong ô); **chưa làm** = chưa có đường chạy.

SQL kiểm chứng chạy bằng `node apps/csms/demo/show.mjs "<SQL>"` (hoặc không đối số để xem tóm tắt).

### 2.1 WF-03 — Mất kết nối và đối soát

Đường HMI: bật `STALE_METERSTOP=1` (mặc định của `npm run demo`) để `StopTransaction` sau một lần rớt mạng mang `meterStop` cũ — **chỉnh nhỏ ở HMI** do BE-10 thêm, mô phỏng hiện tượng 3 của EXP-01; không phải hành vi đã xác nhận của firmware (xem "Bất ngờ" #1).

| ID | Workflow | Loại | Tiền điều kiện & dữ liệu | Các bước chính | Kết quả mong đợi (đã sửa theo thực tế) | Thấy gì trên console (lần chạy thật 23/10/2026) | Trạng thái |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **DS-03a** | WF-03 | Chính | Seed mới (`demo:reset`). HMI: súng A thẻ `DEMO-CARD-0001`, súng B thẻ `DEMO-WALLET-0001`. Nhịp MeterValues 10 s | (1) Cắm A, quẹt thẻ hợp lệ; cắm B, quẹt thẻ ví; sạc ~50 s. (2) HMI "Rớt mạng" 60 s (ngắt đột ngột, **cả trụ**). (3) Trụ tự nối lại không Boot, phát bù hàng đợi, vẫn sạc. (4) Sau ~35 s bấm "Dừng sạc" súng A rồi B | Epoch 1 đóng `1006`, epoch 2 mở **không Boot**. Cả hai phiên `active → orphaned` (lúc rớt) `→ active` (MeterValues live đầu tiên sau nối lại). Các MeterValues phát bù → bản ghi `replay`. Khi dừng, `meterStop` cũ mâu thuẫn chuỗi đo → `meter_gap` `conflict` → phiên `review`, `energy_wh` sai (thấp hơn thật) | Lúc rớt (20:02:01): thẻ trụ đổi sang **mất kết nối** (chấm đỏ), 0 online · 1 offline, **2 phiên `orphaned`** (ảnh 3). Nối lại 20:03:01: **epoch 2**, 2 phiên về `active`, panel Đối soát có **9 bản ghi `replay`** (6 cho phiên #1, 3 cho #2), log OCPP có huy hiệu PHÁT LẠI (ảnh 4). HMI báo "phát bù 11 bản tin buffer", "mất 2/11 MeterValues". Dừng súng A lúc 20:03:37: phiên **#1 `review`**, `123000 → 123969`, **969 Wh**, dòng đỏ `conflict`: "meterStop 969 Wh mâu thuẫn chuỗi đo 125505 Wh — lệch 1536 Wh" (chuỗi đo cho thấy 125505 − 123000 = **2505 Wh** thật; HMI nội bộ 125570). Dừng B: phiên **#2 `review`**, `126000 → 126684` (684 Wh) vs chuỗi 128779, lệch **2095 Wh**. Tổng 11 bản ghi: 9 `replay` + 2 `meter_gap` conflict; 135 dòng `meter_values` (ảnh 5) | **đã kiểm (HMI+console)** |
| DS-03a' | WF-03 | Chính (đường trụ kịch bản) | Seed mới. Trụ `RH24D1-00001`, thẻ `DEMO-CARD-0001`, connector 1. Nhịp 10 s | (1) Trụ nối, quẹt thẻ, sạc, 3 MeterValues (170/340/510 Wh). (2) **Rớt mạng 60 s**. Trụ xếp hàng 5 MeterValues. (3) **Nối lại, KHÔNG Boot**: MeterValues live (1530 Wh), rồi `StopTransaction` phát lại `meterStop = 510`, rồi 5 MeterValues phát lại | Epoch 1 đóng `1006`, epoch 2 không Boot. `active → orphaned → active → review`. `meter_stop_wh = 510`, `delivered_offline = true`. 11 bản ghi: `replay` (Stop) + `meter_gap` `conflict` (diff **1020 Wh** = 1530 − 510), mỗi mẫu muộn thêm `replay` + `meter_gap` `conflict (late_sample)`. `meter_values` 45 dòng | Chưa nhìn qua console ở lần chạy gốc (BE-09). Chạy lại `--fast` ở BE-10: tx 40, `whAtDrop 510`, mẫu cuối 1360 Wh, `meter_stop_wh = 510`, `delivered_offline = true`, `review`; log CSMS `đối soát=conflict diff=850 → review (StopTransaction phát lại)`; 6 bản ghi (`replay` Stop, `meter_gap` diff 850, 4 `replay` MeterValues) | **đã kiểm (trụ kịch bản)**; khác DS-03a: StopTransaction đến **trước** MeterValues phát lại (bắt chước SAP) |
| **DS-03b** | WF-03 | Ngoại lệ | Như trên. Trụ gửi `StartTransaction` rồi mất kết nối trước khi chắc đã nhận trả lời | (1) `StartTransaction` → `transactionId`. (2) Ngắt kết nối. (3) Nối lại, gửi lại **y nguyên** `StartTransaction` (cùng `idTag`, `meterStart`, `timestamp`) | CSMS trả **lại đúng `transactionId` cũ**, không tạo phiên thứ hai (khoá tự nhiên `charge_point, connector, idTag, meterStart, cpStartedAt` — ADR-0010). Một dòng `reconciliation_records.record_type = 'duplicate'`. Số `transaction_no` kế tiếp nhảy 1 (sequence Postgres) | Chạy `--fast` ở BE-10: `{"first":36,"second":36}`, **một** dòng `duplicate` (`action=StartTransaction`), phiên cuối `reconciled` (meterStop 170 Wh); `transaction_no` tiếp theo là 38 (37 bị sequence nuốt). HMI **không** phát lại `StartTransaction` (nó chỉ phát lại hàng đợi bản tin chưa gửi được), nên không lái được bằng HMI | **đã kiểm (trụ kịch bản)**; HMI không làm được |
| **DS-03c** | WF-03 | Ngoại lệ | Thẻ lạ `UNKNOWN-TAG-99` (không có trong `rfid_cards`) | (1) Online: `Authorize` → `Invalid`. (2) Rớt mạng. (3) Offline trụ vẫn chấp nhận cục bộ và sạc (`--tag` đổi thẻ). (4) Nối lại: gửi `StartTransaction`, `MeterValues`, `StopTransaction` phát lại | Phiên **vẫn được ghi** (ADR-0012): `payment_mode = 'unattributed'` (từ migration 0001; trước đó tạm `station_wallet`), `origin = 'rfid'`, `delivered_offline = true`, `status = 'reconciled'`. Bản ghi: `unknown_id_tag` + 3 dòng `replay`. Không trừ tiền ví nào | Chạy `--fast` ở BE-10: tx 38 `UNKNOWN-TAG-99`, `rfid · station_wallet` (kết quả lúc đó, trước 0001; sau 0001 hiển thị `rfid · unattributed`), `reconciled`, `delivered_offline = true`; 4 bản ghi: `unknown_id_tag` + 3 `replay`. HMI **không** lái được: khi offline nó từ chối thẻ lạ (`Offline: thẻ không có trong danh sách cục bộ`, theo mã `hmi-actions.mjs`, chưa bấm thử) | **đã kiểm (trụ kịch bản)**; HMI không làm được |
| **DS-03d** | WF-03 | Ngoại lệ | `DEMO-CARD-0001`, đang sạc, đứt mạng ngắn (`--offline-s`, mặc định 15 s) | (1) Sạc, 2 MeterValues. (2) Ngắt kết nối. (3) Nối lại không Boot; CSMS gửi `TriggerMessage(StatusNotification)` c0/c1/c2, trụ trả `Charging`. (4) Thêm 2 MeterValues, dừng bình thường (`meterStop = 680`) | `active → orphaned` lúc rớt, **`orphaned → active`** (`LIVE_MESSAGE`, T13 #18), cuối cùng `reconciled`, đối soát `consistent` (diff 0), **không** có bản ghi đối soát nào | Trụ kịch bản (`--fast`, BE-10): tx 39 `reconciled`, `meterStop 680`, log `orphaned --LIVE_MESSAGE--> active`, `consistent diff=0`, 0 bản ghi. **Biến thể HMI** (rớt 60 s, `STALE_METERSTOP` **tắt**, lần chạy 1): cùng chuyển trạng thái, dừng → `reconciled` (4601/4671 Wh, `consistent`), **nhưng có 9 bản ghi `replay`** (HMI luôn phát bù MeterValues) — khác kỳ vọng "không có bản ghi nào" | **đã kiểm (trụ kịch bản)**; HMI chạy biến thể (khác kỳ vọng ở số bản ghi) |

SQL kiểm chứng WF-03 (dùng chung):

```sql
-- phiên mới nhất
SELECT transaction_no, id_tag, origin, payment_mode, status, meter_stop_wh, delivered_offline
FROM sessions ORDER BY id DESC LIMIT 3;
-- bản ghi đối soát của phiên mới nhất
SELECT record_no, record_type, energy_difference_wh, left(resolution, 70) AS resolution
FROM reconciliation_records WHERE session_id = (SELECT max(id) FROM sessions) ORDER BY record_no;
-- epoch kết nối (epoch tăng, 1006 lúc rớt)
SELECT epoch, opened_at, closed_at, close_reason FROM charge_point_connections ORDER BY epoch DESC LIMIT 3;
-- Boot chỉ có ở lần nối đầu (nối lại không Boot)
SELECT epoch, action, count(*) FROM ocpp_message_log WHERE action = 'BootNotification' GROUP BY 1, 2;
```

Log CSMS (cửa sổ 1) cho thấy từng chuyển trạng thái, ví dụ `tx 1: active --STATION_OFFLINE--> orphaned`, `tx 1: orphaned --LIVE_MESSAGE--> active`, `tx 1 dừng: meterStop=123969 reason=Local đối soát=conflict diff=1536 → review`.

#### Đường phụ: hai nút trên console (đã chạy thật)

Console có hai lệnh điều khiển (`apps/csms/src/console/console.commands.ts`); **không** có lệnh nào khởi tạo phiên (không có RemoteStart).

| Nút / API | Thử thế nào | Thấy gì (23/10/2026) |
| --- | --- | --- |
| **Ngắt kết nối trụ** (`POST /api/admin/stations/RH24D1-00001/disconnect`) | Súng A đang sạc ~15 s, bấm nút (đóng socket phía CSMS, mã 1001) | Phiên `active → orphaned` ngay; HMI báo `mất kết nối (CSMS/ping đóng socket)`, thử lại mỗi 30 s; **30 s sau** nối lại **epoch 2 không Boot**, phát bù 3 bản tin, phiên `orphaned → active`. Dùng được thay "Rớt mạng" của HMI khi muốn đứt ngắn hơn (30 s thay vì 60 s) và do **phía CSMS** gây ra |
| **Dừng từ xa** (`POST /api/admin/sessions/1/remote-stop`) | Phiên #1 `active` | Trả `{"status":"Accepted"}`; HMI dừng súng A, `stop_reason = Remote`. Vì phiên đã sống qua rớt mạng và `STALE_METERSTOP` bật nên kết thúc ở `review` (`meterStop` 123511 vs chỉ số thật 125244). Chỉ gọi API cùng đường với nút, chưa bấm nút trên trang |

### 2.2 WF-01 — Khởi tạo phiên từ trụ qua RFID (ba đường xác thực)

Chạy được ở Iteration 1: **đường RFID** và **mật khẩu HMI (free vend)** — cả hai chỉ cần trụ tự gửi `Authorize`/`StartTransaction`, CSMS không phải gửi lệnh xuống. **Đường QR từ app chưa có**: cần CSMS gửi `RemoteStartTransaction` và API app.

| ID | Workflow | Loại | Tiền điều kiện & dữ liệu | Các bước chính | Kết quả mong đợi | Thấy gì trên console (lần chạy thật 23/10/2026) | Trạng thái |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **DS-01a** | WF-01 | Chính | Seed mới. Thẻ `DEMO-CARD-0001` (online, active, gắn tài xế mẫu). Thẻ ví `DEMO-WALLET-0001` | HMI: cắm súng A, chọn "Thẻ hợp lệ", "Quẹt thẻ" (`Authorize` → `Accepted`, `StartTransaction`, `Charging`); sạc; "Dừng sạc" | `Authorize` = `Accepted`. Phiên `origin = 'rfid'`, `payment_mode = 'csms_billed'` (thẻ ví: `station_wallet`), cuối cùng `reconciled`, `delivered_offline = false`, không có bản ghi đối soát | Sau ~35 s: hàng **#1** `rfid · csms_billed` `active`, meter `123000 → —`, ~20 mẫu, số Wh in nghiêng có dấu `*` = phiên chưa dừng, suy từ chuỗi đo mới nhất. Sau dừng (~50 s sạc): `reconciled`, `123000 → 124670`, **1670 Wh**, 20 mẫu, panel Đối soát "Chưa có bản ghi". Log CSMS `đối soát=consistent`. Thẻ ví súng B: `rfid · station_wallet` | **đã kiểm (HMI+console)** |
| **DS-01b** | WF-01 | Ngoại lệ | Thẻ lạ của HMI (`DEMO-UNKNOWN-999`, không seed) và thẻ chặn `DEMO-BLOCKED-01` | HMI: cắm súng, chọn "thẻ lạ", "Quẹt thẻ". Thẻ chặn: trụ kịch bản `ds-01b` | `Authorize` ≠ `Accepted`, trụ không gửi `StartTransaction`, bảng `sessions` **không** có dòng mới | HMI báo `CSMS từ chối thẻ: Invalid` (HTTP 400); `sessions_total` giữ nguyên 1; log OCPP có `Authorize` nhưng không có `StartTransaction`. Thẻ chặn (trụ kịch bản): `Authorize DEMO-BLOCKED-01 → Blocked`, `sessions` vẫn 6 dòng trước/sau | **đã kiểm (HMI+console)** cho thẻ lạ (`Invalid`); thẻ blocked **chỉ trụ kịch bản** (HMI không có nút) |
| **DS-01d** | WF-01 | Chính (mật khẩu HMI) | `charge_points.free_vend_tag = 'HMI-FREEVEND'` (seed) | HMI: cắm súng, nhập `123456`, "Nhập" (HMI gửi thẳng `StartTransaction idTag=HMI-FREEVEND`, **không** `Authorize`); sạc ~12 s; dừng | CSMS nhận ra thẻ qua `free_vend_tag`: `origin = 'free_vend'`, `payment_mode = 'free'`, `reconciled` | Hàng **#2** `HMI-FREEVEND`, `free_vend · free`, `reconciled`, `124670 → 125085`, **415 Wh**, 5 mẫu | **đã kiểm (HMI+console)** |
| DS-01c | WF-01 | Chính | Đường QR/app | — | — | — | **chưa làm** (CSMS chưa gửi lệnh xuống trụ; chưa có API app) |

SQL kiểm chứng: câu "phiên mới nhất" ở trên; với DS-01b: `SELECT count(*) FROM sessions;` không tăng.

### 2.3 Cách lái từng kịch bản trên HMI (đã chạy thật)

| Kịch bản | Bấm gì |
| --- | --- |
| DS-01a | Súng A: **Cắm súng** → thẻ "Thẻ hợp lệ (đã đăng ký)" → **Quẹt thẻ**; sạc ≥ 30 s; **Dừng sạc** |
| Súng B ví | Súng B: **Cắm súng** → chọn thẻ "Thẻ ví" → **Quẹt thẻ** (trụ tự thu tiền; CSMS chỉ ghi `station_wallet`, **không** thu) |
| DS-01b | **Cắm súng** → chọn thẻ lạ → **Quẹt thẻ** → HMI báo từ chối |
| DS-01d | **Cắm súng** → ô "Mật khẩu HMI" `123456` → **Nhập** |
| DS-03a | Khi cả hai súng đang sạc: ô "Rớt mạng (s)" = 60 → **Rớt mạng**; chờ trụ tự nối lại (thử mỗi 30 s, nối thành công đúng 60 s sau); chờ ≥ 15 s; **Dừng sạc** súng A, rồi B |
| DS-03b, DS-03c | Không làm được trên HMI (xem bảng) — dùng trụ kịch bản |

### 2.4 Ảnh chụp thật (Edge headless, 1920×1080, lần chạy 23/10/2026)

Chụp bằng `msedge.exe --headless=new --window-size=1920,1080 --screenshot=...`; đã mở xem từng ảnh. Dùng làm ảnh dự phòng khi demo hỏng.

**1. Console sau khi bật, trụ online, chưa có phiên** (4 dòng `PHÁT LẠI` ở cuối log là StatusNotification trụ xếp hàng trước lúc nối — xem "Bất ngờ" #4):

![Console trống, trụ online](demo/console-1-trong-tru-online.png)

**2. Hai súng đang sạc** (A: thẻ hợp lệ `csms_billed`; B: thẻ ví `station_wallet`):

![Console hai súng đang sạc](demo/console-2-hai-sung-dang-sac.png)
![HMI hai súng đang sạc](demo/hmi-2-hai-sung-dang-sac.png)

**3. Rớt mạng 60 s giữa phiên** — HMI báo OFFLINE, hàng đợi buffer 5 MeterValues, đếm ngược thử lại; console: trụ mất kết nối, hai phiên `orphaned` (mồ côi):

![HMI rớt mạng](demo/hmi-3-rot-mang-60s.png)
![Console trụ mất kết nối](demo/console-3-tru-mat-ket-noi.png)

**4. Nối lại không Boot (epoch 2)** — hai phiên về `active`, 9 bản ghi `replay`:

![Console sau nối lại](demo/console-4-sau-noi-lai-co-phat-lai.png)

**5. Phiên `review` có bản ghi đối soát** — dòng `conflict`: "meterStop 969 Wh mâu thuẫn chuỗi đo 125505 Wh — lệch 1536 Wh":

![Console phiên review](demo/console-5-phien-review-co-doi-soat.png)

Hình trụ sạc minh hoạ trên HMI (QA-02, Edge headless 1500×1000): [`simulator/d1-hmi/docs/tru-*.png`](../simulator/d1-hmi/docs/) — sẵn sàng, hai súng đang sạc (kèm khung thứ hai để thấy chấm chạy), rớt mạng, phát bù, lỗi súng, finishing; mô tả và bảng màu đèn ở [`simulator/d1-hmi/README.md`](../simulator/d1-hmi/README.md).

Ảnh lưu ở [`docs/demo/`](demo/). Console đã khớp với DB: hàng `#1 review` và dòng `conflict` đều có trong `show.mjs`.

## Bất ngờ khi chạy

Những điều khác kỳ vọng hoặc kỳ vọng sai ở BE-09 — ghi nguyên văn để không ai gặp lại giữa buổi demo.

1. **HMI không tự tạo được phiên `review`.** Mặc định HMI gửi `meterStop` khớp chỉ số lúc dừng (chủ ý của QA-01, vì EXP-01 là đặc thù SAP). Chạy lần 1 (rớt 60 s, hai súng): phiên về `active`, 9 bản ghi `replay`, dừng → **`reconciled`**, 0 conflict. Không có `review` để demo. Xử lý: thêm tuỳ chọn **`STALE_METERSTOP=1`** vào HMI (`station.mjs`/`server.mjs`, mặc định tắt, smoke 34/34 vẫn đạt) và cho `npm run demo` bật sẵn; ghi rõ là lựa chọn dựng tình huống, không phải hành vi firmware đã xác nhận.
2. **"Rớt mạng" của HMI là cả trụ**, không riêng súng A: hai phiên cùng `orphaned`, cùng `active` lại, và cùng ra `review` (A và B) khi dừng. Kịch bản trình diễn nói đúng điều này thay vì kể "chỉ phiên A".
3. **Trụ nối lại đúng 60 s sau khi rớt 60 s**, không phải 90 s: thử mỗi 30 s, lần 1 (30 s) thất bại, lần 2 (60 s) thành công — cả ba lần đo (19:52:24→19:53:24, 19:55:56→19:56:56, 20:02:01→20:03:01).
4. **3–4 StatusNotification lúc HMI vừa nối bị gắn `PHÁT LẠI`** (`reason=before_epoch`, skew 0,2–0,3 s) trên log console ngay khi bật trụ: trụ gắn timestamp trước khi socket mở. Không tạo bản ghi đối soát (chưa có phiên) nên vô hại, nhưng nhìn như "cờ giả" nếu bị hỏi. Chưa sửa (nằm ở `apps/csms/src`, ngoài phạm vi BE-10); cần quyết định ngưỡng `REPLAY_SKEW_THRESHOLD_S` có áp cho `before_epoch` hay không.
5. **Chạy lại sau lần dừng không sạch thì số giao dịch nhảy**: sau khi kill, lần `npm run demo` kế tiếp sinh phiên `#34` chứ không phải `#3`; DS-03b cũng nuốt một số (36 → 38). Nhiều khả năng do sequence Postgres cache giá trị khi crash recovery (chưa tra cứu kỹ). Chạy `demo:reset` trước giờ demo để số phiên bắt đầu từ #1.
6. **Chạy lại không chỉ ~5 s** như BE-09 ghi: 15,6 s (có crash recovery). Cập nhật số đo ở mục 1.1.
7. **Chip súng trên console vẫn hiện `Charging` khi trụ đã mất kết nối** (ảnh 3): đó là trạng thái cuối CSMS nhận được; chỉ có chấm đỏ "mất kết nối" và hai phiên `orphaned` báo sự cố. Giải thích khi trình diễn.
8. **Giờ trên hai màn hình khác nhau**: console hiện giờ máy (UTC+7, ví dụ `20:03:37`), HMI hiển thị đồng hồ mô phỏng theo **UTC** (`13:02:27 UTC`). Cùng một thời điểm.
9. **`energy_wh` của phiên `review` là con số sai**: 969 Wh trong khi trụ thật đã giao ~2570 Wh. Đó chính là điều đối soát phải bắt; `meterStop` cũ nằm trong `sessions.meter_stop_wh` cho tới khi người xem xét xử lý (chưa có UI xử lý, chỉ có console đọc).
10. **Một vài ghi chú môi trường**: worktree mới thì `node_modules` có thể thiếu `embedded-postgres` → `npm install --ignore-scripts` (30 s). Chụp trang HMI bằng Edge headless với `--virtual-time-budget` bị treo vì SSE; dùng `--timeout` cho HMI, `--virtual-time-budget=6000` cho console (nếu không, console chụp ra trống vì chưa tải xong dữ liệu).

## 3. Những gì demo KHÔNG chứng minh

- **Mô phỏng, không phải firmware Ruihua.** Trụ kịch bản, HMI và `fake-station` nói OCPP 1.6J theo spec; hành vi thật của firmware (thứ tự phát lại, thời điểm ngắt) chưa kiểm. Simulator chính thức là SAP (QA-01, WP5).
- **EXP-01 chỉ một lần chạy.** Ngắt 81 s, 6 mẫu phát lại, trên một trụ. DS-03a *tái hiện* hiện tượng 3 (meterStop cũ) bằng cách cố ý gửi `meterStop` cũ; không phải bằng chứng firmware thật luôn làm vậy.
- **`STALE_METERSTOP` là cách chúng tôi dựng tình huống.** Phiên `review` qua HMI xuất hiện vì HMI được chỉnh để gửi `meterStop` cũ sau rớt mạng (BE-10); HMI mặc định không làm vậy. Đừng trình bày đó là hành vi đã quan sát ở firmware thật: EXP-01 chỉ thấy ở SAP.
- **Không có đường RemoteStart từ console.** Console chỉ có "Ngắt kết nối trụ" và dừng từ xa phiên; bấm nút trên console **không** khởi tạo phiên. Đường QR/app (DS-01c) chưa làm.
- **Một lần chạy, một máy, một người bấm.** Số liệu mục 2 là một lần chạy ngày 23/10/2026; chưa có lần lặp để tính phân phối.
- **Chưa có xác thực.** Gateway chưa kiểm Basic Auth (ADR-0011 Security Profile 2); chỉ cần `serialNumber` đã có trong `charge_points`. Chưa có đăng nhập người dùng.
- **Chưa có billing/API app.** Không trừ ví, không tính tiền, không hoá đơn (các bảng đã có trong schema, chưa có code); `total_cost_vnd` để trống.
- **Chưa có staging.** Defense 1.1 yêu cầu staging; chạy trên máy cá nhân chỉ là Review 2.
- **Postgres khác bản CI.** Demo chạy **Postgres 17 beta** (`embedded-postgres 17.10.0-beta.17`); CI và staging dùng Postgres 16 chuẩn. Migration `0000_init.sql` áp được trên cả hai nhưng chưa có đo hiệu năng nào trên PG 16 với dữ liệu demo.
- **Chưa đo tải.** `infra/k6/` mới có `.gitkeep`.
- Gateway nghe `0.0.0.0` (không chỉ loopback); chỉ Postgres bị khoá ở 127.0.0.1. Đừng demo trên mạng không tin cậy.

## 4. Câu hỏi Hội đồng có thể hỏi — chỉ vào đâu

Đường dẫn tính từ gốc repo.

### 4.1 "Thêm một trạng thái cho phiên (ví dụ `suspended_by_operator`) thì sửa gì?"

| Việc | Chỗ |
| --- | --- |
| Enum Postgres | `apps/csms/src/db/schema/enums.ts` (`sessionStatusEnum`) **và** một migration mới `ALTER TYPE session_status ADD VALUE ...` (không sửa `drizzle/0000_init.sql`; chú thích đầu `enums.ts` nói rõ) |
| Bảng chuyển trạng thái | `apps/csms/src/sessions/session-state-machine.ts`: `SESSION_STATUSES`, `SessionEvent`, `TRANSITIONS` (mỗi dòng mang số thứ tự của bảng T13) |
| Test chuyển | `apps/csms/src/sessions/session-state-machine.spec.ts` |
| Chỗ `SessionsService` liệt kê trạng thái | `apps/csms/src/sessions/sessions.service.ts`: `OPEN_STATUSES`, `OFFLINE_AFFECTED` |
| Tài liệu | `docs/XAC-NHAN-STATE-MACHINE-T13.md` (mục 1.2), `docs/WF-03-MAT-KET-NOI-VA-DOI-SOAT.md` (mục 5 bảng ánh xạ) |

Vì máy trạng thái là lớp thuần (không DB), thêm trạng thái không động tới gateway.

### 4.2 "Thêm một vai người dùng mới?"

Vai cấp cao: `userRoleEnum` trong `apps/csms/src/db/schema/enums.ts` + `users.role` trong `apps/csms/src/db/schema/users.ts`. Quy tắc T11 (đầu `users.ts`): chỉ thêm bảng mở rộng riêng (như `drivers`, `operator_staff`) khi vai có thuộc tính riêng. Vai con trong nhân viên vận hành (thêm "kế toán"): `staffRoleEnum` (`manager`, `technician`) + `operator_staff.staff_role`. Cả hai cần migration `ALTER TYPE ... ADD VALUE`. **Phân quyền chưa tồn tại trong code:** hiện chưa có module auth/guard; `JWT_SECRET` mới chỉ nằm trong `infra/.env.example`. Hội đồng sẽ hỏi "rồi ai chặn?" — câu trả lời trung thực là chưa có, kế hoạch ở WP sau.

### 4.3 "Nhà cung cấp ngoài (VNPay, nhà cung cấp hoá đơn điện tử) ngừng hoạt động?"

- Đường **sạc** không gọi nhà cung cấp ngoài nào: OCPP vào `apps/csms/src/ocpp-gateway/`, phiên ở `sessions/`, đối soát ở `reconciliation/` — chỉ cần Postgres.
- Ảnh hưởng thật nằm ở **nạp tiền và hoá đơn**: `apps/csms/src/db/schema/billing.ts` — `top_ups` (trạng thái `pending/credited/failed/expired/refunded`, `idempotency_key` chống nạp trùng khi app thử lại, `gateway_reference`), `e_invoices` (`failed`/`needs_review`, `attempt_count` cho thử lại). Ví tín dụng là sổ cái nội bộ (`credit_transactions`), nên tài xế đã có số dư vẫn sạc được khi cổng nạp ngừng.
- **Chưa có code gọi VNPay/hoá đơn**; mới có schema. `infra/.env.example` ghi sẵn phương án dự phòng "nếu không xin được sandbox thì chuyển sang mock service" (QA-04). Đừng khẳng định đã có retry/circuit breaker.

### 4.4 "Tải tăng 10 lần thì điểm nghẽn ở đâu?"

Chưa đo (xem mục 3). Chỗ nên chỉ, theo code:

- **Tuần tự theo trụ, song song giữa các trụ:** `apps/csms/src/ocpp-gateway/inbound-serializer.ts` (ADR-0004). Thêm trụ không làm chậm trụ khác; trụ phát lại dồn thì xếp hàng riêng.
- **Mỗi frame ghi một dòng `ocpp_message_log`** (`ocpp-message-logger.ts`, append-only, ADR-0005) và **mỗi SampledValue một dòng `meter_values`** (5 dòng / mẫu / 10 s / súng đang sạc). Cả hai là bảng **partition theo tháng** (`drizzle/0000_init.sql`, phần `meter_values_2026_10...` và `ocpp_message_log_2026_10...`, ADR-0007); job tạo partition tháng kế **chưa có**, dữ liệu ngoài các tháng đã khai báo rơi vào partition `*_default`.
- **Điểm nghẽn có thể thấy ngay trong code:** `ingestSamples` ở `apps/csms/src/sessions/sessions.service.ts` chạy một `SELECT` khử trùng cho **từng** SampledValue trước khi `INSERT` (partition không cho `UNIQUE`, ghi chú T11) — chi phí tăng tuyến tính theo số mẫu; và `createDb` (`apps/csms/src/db/db.module.ts`) dùng `pg.Pool` mặc định (tối đa 10 kết nối).
- Kịch bản tải còn thiếu: `infra/k6/` trống.
