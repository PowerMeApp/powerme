# Iteration 1 — WF-03 "mất kết nối và đối soát" (T33 / BE-07)

**Ngày:** 23/10/2026 · **Người chịu trách nhiệm:** Ngô Văn Minh Trí (WP2) · **Nhánh:** `wp2/be-07-iteration-1-wf03` (xếp tầng lên #18 `wp2/be-06-csdl-vat-ly`)

**Nguồn:** `docs/XAC-NHAN-STATE-MACHINE-T13.md` (STM-1 22 chuyển, STM-2, STM-3, timeout) · `docs/WF-03-MAT-KET-NOI-VA-DOI-SOAT.md` (sequence + class diagram nháp) · `apps/csms/lab/EXP-01-ngat-ket-noi-81s.md` và trace `exp1-disconnect-81s.jsonl` · ADR-0004, 0005, 0006, 0008, 0009, 0010, 0012 · `docs/THIET-KE-CSDL-VAT-LY.md` (T11).

---

## 1. Mục tiêu Iteration 1

Mã sản phẩm **đầu tiên** của `apps/csms`, đúng ba module và một app NestJS:

| Có | Không (để Iteration sau) |
|---|---|
| **Gateway OCPP-J 1.6** trên ocpp-rpc 2.2.1 (strictMode): registry kết nối theo serial, epoch khởi tạo từ DB, ghi mọi frame vào `ocpp_message_log` trước khi xử lý, tuần tự hoá chiều vào theo trụ, handler cho 8 action từ trụ lên | HTTP/REST API, xác thực Basic Auth (ADR-0011), lệnh xuống trụ ngoài TriggerMessage |
| **State machine phiên** STM-1: 9 trạng thái, 22 chuyển của T13, lớp thuần có test từng chuyển | RemoteStart/RemoteStop → `pending`/`stopping` chưa có đường kích hoạt thật (chỉ có trong máy trạng thái) |
| **Engine đối soát**: phát hiện phát lại theo epoch + skew, so `meterStop − meterStart` với chuỗi MeterValues, lỗ hổng chuỗi, idempotency StartTransaction, ghi `reconciliation_records`, đưa phiên vào `review` | Realtime (BE-08), billing/tính tiền, job nền (hard cap, start timeout, 900 s im lặng), operator giải quyết review |

Thứ được chấm là **test**: 96 unit test không cần DB và 19 test tích hợp **phát lại 75 frame CALL thật của EXP-01** qua đúng đường xử lý của gateway.

---

## 2. Sơ đồ thư mục

```
apps/csms/
├── package.json                 build / start / typecheck / test
├── tsconfig.json                typecheck (src + test), decorators cho Nest
├── tsconfig.build.json          emit CommonJS vào dist/, bỏ *.spec.ts
├── tsconfig.jest.json           ts-jest: module CommonJS
├── jest.config.js
├── scripts/run-jest.cjs         chạy jest với --experimental-vm-modules (Nest 12 là ESM-only)
├── drizzle/0000_init.sql        (T11, không đổi)
├── src/
│   ├── main.ts                  NestFactory.createApplicationContext (chưa có HTTP)
│   ├── app.module.ts
│   ├── config.ts                CsmsConfig từ env + ConfigModule (token CONFIG)
│   ├── db/
│   │   ├── db.module.ts         Drizzle db từ pg Pool (token DB); kiểu Db / Tx / DbExecutor
│   │   └── schema/              (T11, không đổi)
│   ├── ocpp-gateway/
│   │   ├── ocpp-server.ts       RPCServer + vòng đời socket + processCall (đường test gọi thẳng)
│   │   ├── connection-registry.ts  identity → client, epoch (MAX+1 từ DB), in_service/offline
│   │   ├── ocpp-message-logger.ts  INSERT ocpp_message_log
│   │   ├── inbound-serializer.ts   hàng đợi promise theo trụ
│   │   ├── ocpp-handlers.ts        action → SessionsService → payload .conf
│   │   ├── ocpp-types.ts           kiểu payload OCPP 1.6 tối thiểu, cpTimestampOf, parseFrame
│   │   ├── inbound-context.ts      ngữ cảnh gắn vào mỗi CALL (epoch, received_at, replay, log id)
│   │   └── ocpp-gateway.module.ts
│   ├── sessions/
│   │   ├── session-state-machine.ts   STM-1 thuần, bảng TRANSITIONS đánh số theo T13
│   │   ├── sessions.service.ts        cửa duy nhất ghi sessions / meter_values / connector_status_events
│   │   ├── connectors/valid-transitions.ts  bảng chuyển connector OCPP 1.6 để gắn cờ
│   │   └── sessions.module.ts
│   └── reconciliation/
│       ├── replay-detector.ts         thuần: before_epoch / skew
│       ├── reconciliation.service.ts  evaluateSeries (thuần) + ghi reconciliation_records
│       └── reconciliation.module.ts
└── test/
    ├── fixtures/exp1-disconnect-81s.jsonl   150 frame thật (chép từ lab/ocpp-traces)
    └── wf03-exp01.integration.test.ts
```

Unit test đặt cạnh mã nguồn (`*.spec.ts`): `session-state-machine.spec.ts`, `connectors/valid-transitions.spec.ts`, `replay-detector.spec.ts`, `reconciliation.service.spec.ts`, `inbound-serializer.spec.ts`, `ocpp-types.spec.ts`.

---

## 3. Mô tả từng module

### 3.1 `ocpp-gateway`

- **OcppServer** — tạo `RPCServer({ protocols: ['ocpp1.6'], strictMode: true })` ở `onApplicationBootstrap`, auth chỉ nhận serial đã có trong `charge_points`. Với mỗi CALL chiều vào: ghi `received_at` → xếp vào InboundSerializer → ReplayDetector phân loại → INSERT `ocpp_message_log` → handler. Frame chiều ra và CALLRESULT chiều vào ghi từ sự kiện `message` của ocpp-rpc. Socket mở → `registry.open` rồi gửi `TriggerMessage(StatusNotification)` c0/c1/c2 best-effort; socket đóng → `registry.close` rồi `SessionsService.onStationOffline`.
- **ConnectionRegistry** — Map identity → {client, epoch, epochOpenedAt}. `open()` đóng socket cũ cùng identity (1012), lấy `MAX(epoch)+1` từ `charge_point_connections` trong transaction, ghi dòng mới, đặt `charge_points.lifecycle = in_service`, `current_epoch`. `close()` ghi `closed_at`/`close_reason`, lifecycle `offline`; bỏ qua socket cũ đã bị thay thế.
- **OcppMessageLogger** — một INSERT trả id; `raw` là frame đã parse.
- **InboundSerializer** — `run(key, task)`: nối task vào đuôi chuỗi promise của key, tác vụ lỗi không chặn tác vụ sau.
- **OcppHandlers** — BootNotification (Accepted, interval), Heartbeat, StatusNotification, Authorize (tra `rfid_cards`: không có → Invalid), StartTransaction (luôn Accepted, transactionId từ SessionsService), MeterValues, StopTransaction (Accepted), DataTransfer (Accepted, chỉ log); khác → NotImplemented.

### 3.2 `sessions`

- **SessionStateMachine** — `apply(from, event)` tra bảng `TRANSITIONS` (23 dòng = 22 chuyển, 16a hai trigger); không có → `InvalidTransitionError`. Không đọc DB; guard của #19 (chưa trừ tiền) do service kiểm.
- **SessionsService** —
  - `onStartTransaction`: INSERT … ON CONFLICT (khoá ADR-0010) DO NOTHING; trùng → SELECT lại, ghi `duplicate`, trả `transaction_no` cũ. idTag tra `rfid_cards` → origin/payment_mode; lạ → vẫn tạo phiên, `payment_mode = station_wallet` tạm (enum base chưa có `unattributed`), ghi `unknown_id_tag`. Phát lại → `delivered_offline = true` + record `replay`.
  - `onMeterValues`: mỗi SampledValue một dòng; dedup (session, cp_timestamp, measurand) bằng SELECT trước INSERT trong cùng transaction (bảng partition không UNIQUE được). Live tới phiên `orphaned` → #18 `active`. Mẫu muộn khi đã có `meter_stop` → đối soát lại; `reconciled` + conflict + chưa có `session_debit` → #19 `review`.
  - `onStopTransaction`: ghi meter_stop/cp_stopped_at/received_stopped_at/energy_wh; `active|paused|stopping` → #9/#10/#11 `closed`; đối soát → #12/#12a (từ closed) hoặc #16/#16a (từ orphaned). Phiên đã dừng mà Stop tới nữa → `orphan_stop`.
  - `onStatusNotification`: phản chiếu, `unexpected_transition` theo bảng; SuspendedEV/EVSE → #5 + `session_pauses`; Charging → #6 (hoặc #18 nếu orphaned và live).
  - `onStationOffline`: #13–#15.
- **connectors/valid-transitions.ts** — bảng from → [to] dựng theo hiểu biết về bảng chuyển trạng thái mục 4.9 OCPP 1.6 edition 2 (**cần đối chiếu spec**); cùng trạng thái không coi là bất thường.

### 3.3 `reconciliation`

- **ReplayDetector.classify({cpTimestamp, receivedAt, epochOpenedAt})** → `{replayed, reason: 'before_epoch' | 'skew' | null, skewS}`. Luật chính `cp_timestamp < epoch_opened_at`; phụ `received_at − cp_timestamp > REPLAY_SKEW_THRESHOLD_S` (5 s). Không có timestamp → live.
- **evaluateSeries** (thuần) → `conflict` (chuỗi không đơn điệu, hoặc meterStop < round(mẫu cuối) − 1 Wh, hoặc không có meterStop) · `gap_detected` (khoảng cách > 3 × 10 s giữa hai mốc liên tiếp, kể cả cp_started_at → mẫu đầu và mẫu cuối → cp_stopped_at) · `consistent`. `energy_difference_wh = round(mẫu cuối) − meterStop`.
- **ReconciliationService** — ghi `reconciliation_records` append-only với `record_no` tăng trong phiên: `meter_gap` (gap_detected hoặc conflict, phân biệt bằng tiền tố của `resolution`), `replay`, `duplicate`, `orphan_stop`, `unknown_id_tag`; `hasSessionDebit` cho guard #19. Không đổi `sessions.status`.

---

## 4. Bảng 22 chuyển STM-1 → tên test

File: `apps/csms/src/sessions/session-state-machine.spec.ts`, mỗi dòng là một `it` sinh từ bảng `T13` (`it.each`), tên có dạng `T13 #<số>: <from> --<event>--> <to>`.

| # T13 | Từ → Đến | Sự kiện trong code | Có đường kích hoạt thật ở Iteration 1? |
|---|---|---|---|
| 1 | ● → pending | `REMOTE_START_ACCEPTED` | Chưa (RemoteStart) |
| 2 | ● → active | `START_TRANSACTION` | Có — `onStartTransaction` |
| 3 | pending → active | `START_TRANSACTION` | Chưa |
| 4 | pending → failed | `START_TIMEOUT` | Chưa (timer) |
| 5 | active → paused | `STATUS_SUSPENDED` | Có — StatusNotification SuspendedEV/EVSE |
| 6 | paused → active | `STATUS_CHARGING` | Có — StatusNotification Charging |
| 7 | active → stopping | `STOP_REQUESTED` | Chưa (RemoteStop) |
| 8 | paused → stopping | `STOP_REQUESTED` | Chưa |
| 9a | stopping → active | `REMOTE_STOP_REJECTED` | Chưa |
| 9 | stopping → closed | `STOP_TRANSACTION` | Có (nếu phiên ở stopping) |
| 10 | active → closed | `STOP_TRANSACTION` | Có — tx1, tx2, tx3 trong EXP-01 |
| 11 | paused → closed | `STOP_TRANSACTION` | Có |
| 12 | closed → reconciled | `RECONCILE_OK` | Có — tx1, tx2 |
| 12a | closed → review | `RECONCILE_CONFLICT` | Có — tx3 |
| 13 | active → orphaned | `STATION_OFFLINE` | Có — tx3 lúc socket đóng |
| 14 | paused → orphaned | `STATION_OFFLINE` | Có |
| 15 | stopping → orphaned | `STATION_OFFLINE` | Có |
| 16 | orphaned → reconciled | `RECONCILE_OK` | Có (Stop phát lại tới khi còn orphaned) |
| 16a | orphaned → review | `RECONCILE_CONFLICT` / `HARD_CAP_EXCEEDED` | Có / Chưa (timer) |
| 17 | review → reconciled | `OPERATOR_RESOLVED` | Chưa (UC-OPS-05) |
| 18 | orphaned → active | `LIVE_MESSAGE` | Có — tx3 lúc MeterValues live 796 Wh |
| 19 | reconciled → review | `LATE_SAMPLE_CONFLICT` | Có — `reconcileLateSample` |

Chuyển không hợp lệ: 14 cặp liệt kê (`reconciled → active`, `failed → *`, `pending → paused`, …) + một test quét **toàn bộ** 10 × 15 cặp (trạng thái, sự kiện) và khẳng định đúng 23 cặp trong bảng được nhận, 127 cặp còn lại ném `InvalidTransitionError`.

---

## 5. Cách chạy

```bash
npm install                                   # ở gốc repo
npm run typecheck -w @powerme/csms            # tsc --noEmit (src + test)
npm test -w @powerme/csms                     # unit; có DATABASE_URL thì chạy cả tích hợp
DATABASE_URL=postgresql://powerme:powerme@localhost:5432/powerme_test npm test -w @powerme/csms
npm run build -w @powerme/csms                # tsc → dist/
DATABASE_URL=... OCPP_PORT=9000 npm run start -w @powerme/csms
```

Biến môi trường (xem `infra/.env.example`): `DATABASE_URL` (bắt buộc), `OCPP_PORT` (9000; dự phòng `CSMS_OCPP_WS_PORT`), `OCPP_HEARTBEAT_INTERVAL_SECONDS` (300), `SESSION_START_TIMEOUT_S` (120), `SESSION_HARD_CAP_H` (24), `REPLAY_SKEW_THRESHOLD_S` (5), `METER_VALUE_SAMPLE_INTERVAL_S` (10), `RECONCILE_GAP_FACTOR` (3), `RECONCILE_ENERGY_TOLERANCE_WH` (1).

Trụ (hoặc SAP simulator với `ws://localhost:9000/ocpp`) nối tới `ws://host:OCPP_PORT/ocpp/{serialNumber}`; serial phải có trong `charge_points` trước.

**Test tích hợp** xoá sạch schema `public` của DB được trỏ tới rồi áp `drizzle/0000_init.sql` — chỉ trỏ vào DB test. Thiếu `DATABASE_URL` thì describe bị skip (máy dev không có Postgres vẫn xanh).

---

## 6. Kết quả test

### 6.1 Tại chỗ (Windows, Node 24.18.1)

- Unit: **96 passed**, 6 suite, không DB.
- Tích hợp: chạy bằng Postgres 18 nhúng tạm (`embedded-postgres`, không đưa vào repo; DB phải tạo `ENCODING 'UTF8'` vì migration có COMMENT tiếng Việt): **19 passed**.

### 6.2 Trên CI (Postgres 16, Node 24)

Xem job CI của PR (link trong phần "Kiểm chứng" của PR). Cập nhật số sau khi CI xanh: unit 96 / tích hợp 19.

### 6.3 Các khẳng định của test tích hợp, theo **dữ liệu thật** của EXP-01

| T33 yêu cầu | Dữ liệu thật & khẳng định trong test | Khớp? |
|---|---|---|
| (a) 3 phiên, không trùng | **4 phiên** (`transaction_no` 1–4), 4 khoá tự nhiên khác nhau, 0 record `duplicate`. tx4 = StartTransaction c2 (BB2TBR09, meterStart 0, cp_timestamp 14:18:52.934Z) sinh ra lúc offline, phát lại ở epoch 2 — mini-CSMS của lab cấp lại id 1, CSMS thật cấp 4 (WF-03 mục 3 "khoá tự nhiên chưa có"). tx4 `delivered_offline = true`, còn `active` khi trace kết thúc | **Lệch: 4 thay vì 3** — test ghi 4 |
| (b) tx3 13 `meter_values`, 6 replayed | 13 dòng `Energy.Active.Import.Register` (3 + 4 live + 6 phát lại; 65 dòng tổng vì mỗi MeterValues có 5 SampledValue). Schema không có cột `replayed` → kiểm bằng ReplayDetector trên từng frame (6 MeterValues của tx3 replayed, `before_epoch`, skew 104–127 s, đều nhận sau StopTransaction) và bằng 6 record `replay` action=MeterValues + 1 record `replay` action=StopTransaction | Khớp |
| (c) tx3 `review`, record conflict, diff 242 vs 1042 | `status = review`, `meter_stop_wh = 242`, `energy_wh = 242`, `delivered_offline = true`. Enum base không có `conflict` → `record_type = meter_gap`, `resolution` bắt đầu `conflict:`; `energy_difference_wh = 801` = round(1042,64) − 242 (SAP làm tròn khi phát meterStop: 600,78 → 601, 996,78 → 997); gap đầu 14:18:47.811 → 14:20:27.901 (100 s). 6 mẫu muộn → 6 record `meter_gap` nữa (`conflict (late_sample):`), gap cuối thu còn 14:19:47.867 → 14:20:27.901 (40 s, vẫn > 30 s) | Khớp (801 chứ không phải 800) |
| (d) tx2 reconciled/consistent (997) | tx2 `reconciled`, 997 Wh, 14 mẫu, 0 record `meter_gap`/`replay`; tx1 `reconciled`, 601 Wh | Khớp (consistent = không có record, vì enum không có `consistent`) |
| (e) `ocpp_message_log` đúng số frame vào | 75 dòng `direction = in` = 75 CALL chiều vào; 54 epoch 1 + 21 epoch 2; `unique_id` và `received_at` khớp từng frame; cp_timestamp khác null đúng bằng số frame có timestamp; phân bố action: Boot 2, StatusNotification 18, Heartbeat 5, Authorize 2, StartTransaction 4, MeterValues 41, StopTransaction 3 | Khớp |
| (f) Stop/Start phát lại skew > 100 s → replayed | Đúng **8** frame replayed, tất cả `before_epoch`, skew 104,2–126,8 s: StopTransaction tx3 (125,275 s), StartTransaction c2 (125,709 s), 6 MeterValues; 67 frame còn lại live (skew ≤ 10 ms hoặc không có timestamp) | Khớp |
| Bổ sung | (g) 18 `connector_status_events`, 0 `unexpected_transition`, c1 Available / c2 Charging cuối trace · (h) 2 epoch, epoch 1 `closed_at` + `1006 …`, `current_epoch = 2`, `last_message_at` = frame cuối · (i) 4 record `unknown_id_tag` (UNDEFINED, BB2TBR09 không có trong `rfid_cards`) · (j) phát lại lần nữa StartTransaction tx3 → trả transactionId 3, vẫn 4 phiên, 1 record `duplicate` · (k) StopTransaction lặp → `orphan_stop`, phiên giữ `review` · (l) nối lại cùng identity khi socket cũ treo → đóng 1012, epoch 3, close muộn của socket cũ không coi là mất kết nối · epoch 2 mở bằng **ConnectionRegistry mới** (mô phỏng CSMS khởi động lại) vẫn ra 2 nhờ DB | — |

Đường trạng thái thật của tx3 trong test: `active` → (socket đóng) `orphaned` #13 → (MeterValues live 796 Wh) `active` #18 → (StopTransaction phát lại) `closed` #10 → (conflict) `review` #12a → 6 mẫu muộn: giữ `review`, thêm record. Không đi #16a vì #18 đã kéo về `active` trước khi Stop tới — đúng như EXP-01 giai đoạn D.

---

## 7. Chỗ chưa làm

- `pending`/`stopping`: không có RemoteStart/RemoteStop nên #1, #3, #4, #7, #8, #9a chỉ tồn tại trong máy trạng thái.
- Timer: start timeout 120 s (#4), hard cap 24 h (#16a nhánh thứ hai), 900 s im lặng của STM-3 #4 — chưa có job nền (ADR-0006 nói BullMQ; Iteration 1 chưa cài).
- Operator giải quyết `review` (#17, UC-OPS-05), `reviewed_by`/`reviewed_at` của record.
- Basic Auth Security Profile 2 (ADR-0011): auth chỉ kiểm serial có trong DB.
- BootNotification chỉ log; chưa cập nhật `model`/`firmware_version`, chưa GetConfiguration `ConnectionTimeOut`.
- `last_message_at` UPDATE mỗi frame — đủ cho Iteration 1, cần gộp khi tải lớn.
- StatusNotification không có `timestamp` (SAP) → ReplayDetector không phân loại được; `connector_status_events.pillar_timestamp` null.
- Realtime, billing, HTTP API, vendor bản copy ocpp-rpc (ADR-0004).

## 8. Chỗ cần Trí xác nhận

1. **Enum `reconciliation_record_type`** của base (replay, duplicate, meter_gap, orphan_stop, unknown_id_tag) khác bộ `{consistent, gap_detected, conflict, late_sample}` của WF-03/T33. Iteration 1 ánh xạ: consistent → không ghi; gap_detected / conflict / late_sample → `meter_gap` + tiền tố trong `resolution`. Có nên thêm giá trị enum ở migration kế (`0001_…`) không?
2. **4 phiên thay vì 3** trong EXP-01: StartTransaction c2 phát lại là phiên mới (khoá tự nhiên khác tx2). Xác nhận cách đọc này.
3. **Làm tròn Wh**: `energy_difference_wh = 801` dùng `Math.round` (khớp cách SAP phát meterStop). Nếu muốn 800 (cắt phần thập phân) thì đổi một dòng trong `evaluateSeries`.
4. **payment_mode cho thẻ lạ** = `station_wallet` tạm (chờ PR thêm `unattributed`), ghi `unknown_id_tag`.
5. **Bảng chuyển connector** (`valid-transitions.ts`) dựng từ trí nhớ về bảng mục 4.9 OCPP 1.6 — đối chiếu spec trước khi dùng làm căn cứ báo cáo.
6. **TypeScript 5.9.3 thay cho 7.0.2** của base: ts-jest 29.4.15 khai báo peer `typescript <7`, và NestJS cần `emitDecoratorMetadata`; không đáng 20 phút vật lộn với TS 7 (theo dặn của T11). drizzle-kit/Drizzle không bị ảnh hưởng.
7. **`OCPP_PORT`** (9000, như lab) song song `CSMS_OCPP_WS_PORT` (3001, compose/Caddy): config đọc `OCPP_PORT` trước. Thống nhất một tên khi dựng staging.
8. Mỗi mẫu muộn làm thay đổi lỗ hổng → một record `meter_gap` mới (append-only theo WF-03). EXP-01 sinh 7 record cho tx3 — chấp nhận, hay chỉ ghi record khi kết luận (`conflict`/`gap_detected`) đổi?
9. Nest 12 / drizzle-orm là ESM-only; app build CommonJS và chạy được trên Node 24 nhờ `require(esm)`; Jest cần `--experimental-vm-modules` (bọc trong `scripts/run-jest.cjs`). Có muốn chuyển cả app sang ESM (`"type": "module"`) ở Iteration 2?
