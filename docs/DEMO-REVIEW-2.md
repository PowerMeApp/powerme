# Kịch bản demo Review 2 — PowerMe CSMS

> **Phạm vi.** Tài liệu này phục vụ mục 9.2 hướng dẫn Review 2: mỗi main workflow có ≥ 1 kịch bản chính và 1 ngoại lệ; dữ liệu mẫu nạp bằng script; demo lặp lại được; Hội đồng có thể đổi dữ liệu đầu vào.
> **Workflow chính của bản demo: WF-03 "mất kết nối và đối soát"** (chủ: Trí). WF-01 chỉ có phần quẹt thẻ RFID.
> **Mọi kết quả mong đợi dưới đây lấy từ lần chạy thật ngày 23/10/2026** (CSMS + Postgres nhúng trên Windows 11, Node 24) và từ test tích hợp `apps/csms/test/wf03-exp01.integration.test.ts`. Chưa chạy được thì ghi rõ trong cột "Trạng thái".

## 1. Chuẩn bị

### 1.1 Lệnh một dòng

```bash
npm install --ignore-scripts      # một lần, ở gốc repo (kéo binary Postgres nhúng, ~1 phút)
npm run demo -w @powerme/csms     # mọi lần demo
```

Khởi động đo được: **~22 s từ trạng thái lạnh** (chưa có `dist/` và `.demo-data/`: tsc + initdb + migration + seed + CSMS), **~5 s khi chạy lại** (dữ liệu và `dist/` đã có). Cuối cùng script in bảng tóm tắt URL. Dừng bằng **Ctrl+C** (kill sạch mọi tiến trình con, đã kiểm: không còn `postgres.exe`/`node` nghe cổng 54330/9000).

Làm lại từ đầu (xoá mọi phiên đã sinh, về đúng dữ liệu seed): `npm run demo:reset -w @powerme/csms`. Chi tiết: [`apps/csms/demo/README.md`](../apps/csms/demo/README.md).

### 1.2 Ba cửa sổ

| Cửa sổ | Mở gì | Cổng |
| --- | --- | --- |
| 1. Terminal | `npm run demo -w @powerme/csms` — để nguyên, log `[csms]` `[hmi]` `[db]` chạy ở đây | — |
| 2. Console vận hành | `http://localhost:3000/` — **chờ PR console merge** (hiện chưa có; script cảnh báo và bỏ qua) | 3000 |
| 3. HMI trụ D1 | `http://localhost:8100/` — **chờ PR HMI merge** | 8100 |

Cho tới khi hai PR đó merge, thay cửa sổ 2–3 bằng terminal thứ hai chạy trụ kịch bản (xem 1.4) và `node apps/csms/demo/show.mjs` để xem DB.

### 1.3 Checklist 5 phút trước giờ demo

- [ ] `git status` sạch, đang ở nhánh `main` mới nhất; `npm install --ignore-scripts` đã chạy.
- [ ] Không còn gì nghe cổng 9000/54330/8100/3000: `netstat -ano | findstr "9000 54330 8100 3000"` (nếu có, dùng `--port-offset` hoặc tắt tiến trình đó).
- [ ] `npm run demo:reset -w @powerme/csms` — dữ liệu sạch, thấy dòng `=== Demo PowerMe sẵn sàng` và `seed xong: {"charge_points":"1","connectors":"2","rfid_cards":"3","tariff_periods":"7"}`.
- [ ] Trụ kịch bản chạy thử một lần `ds-01b` (3 giây, không để lại phiên): xem `Authorize ... → Blocked`.
- [ ] Mở sẵn `docs/WF-03-MAT-KET-NOI-VA-DOI-SOAT.md` (sequence diagram) và trace `apps/csms/test/fixtures/exp1-disconnect-81s.jsonl`.
- [ ] Pin laptop, tắt thông báo, phóng to font terminal.
- [ ] Biết sẵn `node apps/csms/demo/show.mjs` (không cần psql) và `docs/BAO-CAO-TIEN-DO-WP2-REVIEW-2.md`.

### 1.4 Chạy kịch bản bằng trụ kịch bản (không cần HMI)

```bash
node apps/csms/demo/scripted-station.mjs <ds-01a|ds-01b|ds-03a|ds-03b|ds-03c|ds-03d> [--fast]
```

`--fast` rút nhịp MeterValues còn 3 s và đứt mạng còn 15 s (demo ngắn). Không có `--fast`: nhịp 10 s, đứt mạng 60 s (DS-03a mất ~95 s). Tuỳ chọn khác (`--id`, `--url`, `--tag`, `--offline-s`) xem đầu file `apps/csms/demo/scripted-station.mjs`. **Hội đồng đổi dữ liệu đầu vào** bằng các tuỳ chọn này, ví dụ `--offline-s 120`, `--tag DEMO-WALLET-01`, `--tag <thẻ khác>`.

> `lab/fake-station.mjs` **không** tạo được phiên một mình: nó chỉ bắt đầu sạc khi CSMS gửi `RemoteStartTransaction`, mà CSMS Iteration 1 chưa có đường gửi lệnh xuống trụ. Đã kiểm nó nối được (`Boot`, `StatusNotification`) với `ID=RH24D1-00001`; còn phiên sạc thì dùng trụ kịch bản hoặc HMI.

### 1.5 Kế hoạch B

| Sự cố | Cách xử lý |
| --- | --- |
| HMI/console không lên | Chạy `npm run demo -w @powerme/csms -- --no-hmi`, dùng trụ kịch bản (1.4) và `show.mjs` |
| Postgres nhúng không lên (cổng bận, antivirus chặn `postgres.exe`) | `npm run demo:reset`, hoặc `--port-offset 10`; chưa được thì chuyển sang phát lại trace (dòng dưới) |
| CSMS không chạy được nhưng Postgres nhúng còn | **Phát lại trace EXP-01 bằng test tích hợp** (lệnh ngay dưới bảng) — test không mở socket, đưa 75 frame thật của EXP-01 qua đúng đường xử lý của gateway |
| Cả Postgres nhúng cũng hỏng | Trình bày bằng trace `apps/csms/test/fixtures/exp1-disconnect-81s.jsonl` và sequence diagram (`node apps/csms/lab/trace-to-mermaid.mjs`), cùng ảnh chụp kết quả test đã lưu |
| Mạng/ổ cứng chậm | Chạy sẵn `npm run demo` từ trước, dùng `--fast` |
| Mọi thứ hỏng | Ảnh chụp màn hình dự phòng: chụp trước giờ demo ở trạng thái sau DS-03a (bảng `sessions` = `review`, các dòng `reconciliation_records`) và đầu ra `npm test` 19/19 của test tích hợp |

Phát lại bằng test tích hợp (cần `npm run demo:db` ở cửa sổ khác; test dùng DB riêng `powerme_test`, **không** trỏ vào `powerme_demo` vì test DROP SCHEMA):

```bash
DATABASE_URL=postgresql://powerme:powerme@127.0.0.1:54330/powerme_test npm test -w @powerme/csms
```

Kết quả đã chạy: 7 suite / 115 test đạt, gồm 19 test tích hợp WF-03 (EXP-01) trên Postgres 17 nhúng — đây là lần đầu 19 test này chạy tại chỗ.

## 2. Bảng kịch bản

Cột "Trạng thái": **đã kiểm** = tôi chạy thật bằng trụ kịch bản (`scripted-station.mjs`) và đối chiếu DB/log CSMS; bước **HMI/console** của cùng dòng vẫn **chờ HMI/console** (chưa merge nên chưa thử); **chưa làm** = chưa có đường chạy.

SQL kiểm chứng chạy bằng `node apps/csms/demo/show.mjs "<SQL>"` (hoặc không đối số để xem tóm tắt).

### WF-03 — Mất kết nối và đối soát

| ID | Workflow | Loại | Tiền điều kiện & dữ liệu | Các bước chính | Kết quả mong đợi | Trạng thái |
| --- | --- | --- | --- | --- | --- | --- |
| **DS-03a** | WF-03 | Chính | Seed mới. Trụ `RH24D1-00001`, thẻ `DEMO-ONLINE-01`, connector 1. Nhịp MeterValues 10 s | (1) Trụ nối, quẹt thẻ, sạc, 3 MeterValues (170/340/510 Wh). (2) **Rớt mạng 60 s** (ngắt đột ngột). Trụ vẫn sạc, xếp hàng 5 MeterValues. (3) **Nối lại, KHÔNG Boot**: gửi MeterValues live (1530 Wh), rồi `StopTransaction` phát lại mang `meterStop = 510` (số cũ), rồi 5 MeterValues phát lại. | Epoch 1 đóng với `1006`, epoch 2 mở không có Boot. Phiên: `active → orphaned` (lúc rớt) `→ active` (MeterValues live đầu tiên) `→ review`. `sessions.meter_stop_wh = 510`, `delivered_offline = true`. `reconciliation_records` có **11 dòng**: `replay` (StopTransaction) + `meter_gap` mở đầu `conflict` (diff **1020 Wh** = 1530 − 510), rồi mỗi mẫu muộn thêm một cặp `replay` + `meter_gap` `conflict (late_sample)`. `meter_values` 45 dòng (9 mẫu × 5 measurand). Console: phiên `review`, bản ghi conflict, mẫu phát lại được đánh dấu. | **đã kiểm** (trụ kịch bản); HMI/console: chờ HMI/console |
| **DS-03b** | WF-03 | Ngoại lệ | Như trên. Trụ gửi `StartTransaction` rồi mất kết nối trước khi chắc đã nhận trả lời | (1) `StartTransaction` → `transactionId` 2. (2) Ngắt kết nối. (3) Nối lại, gửi lại **y nguyên** `StartTransaction` (cùng `idTag`, `meterStart`, `timestamp`). | CSMS trả **lại đúng `transactionId` cũ**, không tạo phiên thứ hai (khoá tự nhiên `charge_point, connector, idTag, meterStart, cpStartedAt` — ADR-0010). Một dòng `reconciliation_records.record_type = 'duplicate'`. Lưu ý: số `transaction_no` tiếp theo bị nhảy 1 (sequence đã cấp cho lần chèn bị từ chối) — bình thường với sequence Postgres. | **đã kiểm**; HMI/console: chờ HMI/console |
| **DS-03c** | WF-03 | Ngoại lệ | Thẻ lạ `UNKNOWN-TAG-99` (không có trong `rfid_cards`) | (1) Online: `Authorize` → `Invalid`. (2) Rớt mạng. (3) Offline trụ vẫn chấp nhận cục bộ và sạc (`--tag` đổi thẻ). (4) Nối lại: gửi `StartTransaction`, `MeterValues`, `StopTransaction` phát lại. | Phiên **vẫn được ghi** (ADR-0012: phiên đã diễn ra thì luôn ghi): `payment_mode = 'station_wallet'` (tạm), `origin = 'rfid'`, `delivered_offline = true`, `status = 'reconciled'`. Bản ghi: `unknown_id_tag` + 3 dòng `replay` (Start, MeterValues, Stop). Không trừ tiền ví nào. | **đã kiểm**; HMI/console: chờ HMI/console |
| **DS-03d** | WF-03 | Ngoại lệ | `DEMO-ONLINE-01`, đang sạc, đứt mạng ngắn (`--offline-s`, mặc định 15 s) | (1) Sạc, 2 MeterValues. (2) Ngắt kết nối. (3) Nối lại không Boot; CSMS gửi `TriggerMessage(StatusNotification)` c0/c1/c2, trụ trả `Charging`. (4) Thêm 2 MeterValues, dừng bình thường (`meterStop = 680`). | `active → orphaned` lúc rớt, **`orphaned → active`** (`LIVE_MESSAGE`, T13 #18) khi trụ báo `Charging`, cuối cùng `reconciled`, đối soát `consistent` (diff 0), **không** có bản ghi đối soát nào. | **đã kiểm**; HMI/console: chờ HMI/console |

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

Log CSMS (cửa sổ 1) cho thấy từng chuyển trạng thái, ví dụ `tx 1: active --STATION_OFFLINE--> orphaned`, `tx 1: orphaned --LIVE_MESSAGE--> active`, `tx 1 dừng: ... đối soát=conflict diff=1020 → review`.

### WF-01 — Khởi tạo phiên từ trụ qua RFID (ba đường xác thực)

Chỉ có **đường RFID** chạy được ở Iteration 1. Hai đường còn lại (QR từ app, mật khẩu HMI) cần CSMS gửi `RemoteStartTransaction` hoặc xác thực phía app — chưa có.

| ID | Workflow | Loại | Tiền điều kiện & dữ liệu | Các bước chính | Kết quả mong đợi | Trạng thái |
| --- | --- | --- | --- | --- | --- | --- |
| **DS-01a** | WF-01 | Chính | Seed mới. Thẻ `DEMO-ONLINE-01` (online, active, gắn tài xế mẫu). `--tag DEMO-WALLET-01` cho thẻ ví | (1) Trụ: `Authorize` → `Accepted`. (2) Cắm súng (`Preparing`), `StartTransaction`, `Charging`. (3) 3 MeterValues, `StopTransaction` (510 Wh). | `Authorize` = `Accepted`. Phiên `origin = 'rfid'`, `payment_mode = 'csms_billed'` (thẻ ví: `station_wallet`), cuối cùng `reconciled`, `energy_wh = 510`, `delivered_offline = false`, không có bản ghi đối soát. | **đã kiểm** (trụ kịch bản); HMI/console: chờ HMI/console |
| **DS-01b** | WF-01 | Ngoại lệ | Thẻ `DEMO-BLOCKED-01` (status `blocked`) | Trụ: `Authorize` với thẻ bị chặn; trụ không gửi `StartTransaction`. | `Authorize` = **`Blocked`**, bảng `sessions` **không** có dòng mới. | **đã kiểm**; HMI/console: chờ HMI/console |
| DS-01c | WF-01 | Chính | Đường QR/app hoặc mật khẩu HMI | — | — | **chưa làm** (CSMS chưa gửi lệnh xuống trụ; chưa có API app) |

SQL kiểm chứng: câu "phiên mới nhất" ở trên; với DS-01b: `SELECT count(*) FROM sessions;` không tăng.

### Các bước trên HMI / console (khi hai PR merge)

Điền khi PR HMI + console merge và đã chạy thật; **không** điền trước. Ánh xạ dự kiến (chưa kiểm): DS-01a = quẹt thẻ `DEMO-ONLINE-01` trên HMI; DS-03a = bấm nút ngắt mạng trên HMI 60 s rồi nối lại; DS-03c = quẹt thẻ lạ khi đang ngắt mạng. Cột "thấy gì trên console" cũng để trống cho tới lúc đó.

## 3. Những gì demo KHÔNG chứng minh

- **Mô phỏng, không phải firmware Ruihua.** Trụ kịch bản, HMI và `fake-station` nói OCPP 1.6J theo spec; hành vi thật của firmware (thứ tự phát lại, thời điểm ngắt) chưa kiểm. Simulator chính thức là SAP (QA-01, WP5).
- **EXP-01 chỉ một lần chạy.** Ngắt 81 s, 6 mẫu phát lại, trên một trụ. DS-03a *tái hiện* hiện tượng 3 (meterStop cũ) bằng cách cố ý gửi `meterStop` cũ; không phải bằng chứng firmware thật luôn làm vậy.
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
