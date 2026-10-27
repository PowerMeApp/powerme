# @powerme/csms — WP2

CSMS OCPP 1.6J. **Trái tim kỹ thuật của đồ án.**

| | |
|---|---|
| Chủ sở hữu | WP2 — Backend / IoT Engineer |
| Cột mốc | **M2 — 04/10/2026** (cổng kỹ thuật), M5 — 15/11/2026 |
| Stack | NestJS 12 + TypeScript 5.9 (strict) · ocpp-rpc 2.2.1 (ADR-0004) · Drizzle ORM + PostgreSQL 16 (ADR-0008) · Redis (chưa dùng ở Iteration 1) |
| Lộ trình chi tiết | [docs/WP2-LO-TRINH-KY-THUAT.md](../../docs/WP2-LO-TRINH-KY-THUAT.md) |
| Iteration 1 | [docs/ITERATION-1-WF03.md](../../docs/ITERATION-1-WF03.md) — gateway + state machine phiên + đối soát, test phát lại trace EXP-01 |
| Iteration 1 WF-04 | [docs/ITERATION-1-WF04.md](../../docs/ITERATION-1-WF04.md) — sự cố trụ STM-6 (FE-04): FaultService, Reset từ xa qua console, 26 test tích hợp |

## Chạy

```bash
npm install                                    # ở gốc repo
npm run typecheck -w @powerme/csms             # tsc --noEmit
npm test -w @powerme/csms                      # unit (không DB); có DATABASE_URL thì chạy cả tích hợp
npm run build -w @powerme/csms                 # tsc → dist/
DATABASE_URL=postgresql://powerme:powerme@localhost:5432/powerme OCPP_PORT=9000 npm run start -w @powerme/csms
```

Migration: `DATABASE_URL=... node apps/csms/scripts/migrate.mjs` (áp tuần tự `drizzle/0000_…` rồi `0001_…`, ghi bảng `_migrations`; không dùng `psql -f` rời từng file vì sẽ lệch bảng theo dõi). Trụ nối tới `ws://host:9000/ocpp/{serialNumber}`; serial phải có trong `charge_points`.

Staging: `apps/csms/Dockerfile` (build từ gốc repo, image chạy `node dist/main.js`, kèm `scripts/migrate.mjs` và `scripts/seed-demo.mjs`). Seed staging cần `DEMO_PILLAR_PASSWORD` (>= 16 ký tự) vì `ALLOW_LEGACY_NO_CREDENTIAL=false`.

Cấu trúc `src/`: `ocpp-gateway/` (socket, registry epoch, log frame, tuần tự hoá, handler) · `sessions/` (state machine STM-1, phiên, chuỗi đo, trạng thái connector) · `reconciliation/` (phát hiện phát lại, đối soát) · `db/` (Drizzle schema + module). Test tích hợp: `test/wf03-exp01.integration.test.ts` với fixture `test/fixtures/exp1-disconnect-81s.jsonl`.

## Bảng điều khiển vận hành (demo)

`src/console/` — trang web một file + vài endpoint JSON để xem hệ thống đang chạy (demo Review 2). Mở `http://127.0.0.1:3000/` sau khi chạy CSMS. Cấu hình: `CONSOLE_ENABLED` (mặc định `true`), `CONSOLE_HOST` (mặc định `127.0.0.1`), `CONSOLE_PORT` (mặc định `3000`).

- Chỉ đọc: `GET /api/admin/{stations,sessions,sessions/:id,reconciliation,messages,summary}`. Ngoài ra `GET /health` → `{"ok":true,"db":true}` (sau `select 1`), 503 `{"ok":false,"db":false}` nếu DB lỗi; không lộ phiên bản/chi tiết. Image Docker và staging dùng nó: xem `infra/staging/README.md`. Hai lệnh: `POST /api/admin/stations/:serial/disconnect` (đóng socket phía CSMS), `POST /api/admin/sessions/:id/remote-stop` (RemoteStopTransaction).
- **Chưa có xác thực** (RolesGuard là việc sau — ADR-0011): đừng bind ra `0.0.0.0`. POST từ `Origin` không phải localhost bị từ chối 403.
- **Chưa làm:** xác thực/phân quyền, realtime Socket.IO (trang poll mỗi 1 s), billing, hiển thị lịch sử chuyển trạng thái phiên (bảng `session_status_history` có từ migration 0001 nhưng chi tiết phiên của console chưa đọc nó).
- Ảnh chụp: [docs/console.png](docs/console.png) (tổng quan), [docs/console-detail.png](docs/console-detail.png) (chi tiết phiên) — dữ liệu là trace EXP-01 phát lại qua gateway vào Postgres thử nghiệm, không phải trụ thật.

## Phạm vi

- **BE-02** Máy chủ WebSocket OCPP-J 1.6, định danh trụ theo SN trên đường dẫn — *Iteration 1: có*
- **BE-03** Bản tin từ trụ lên: `BootNotification`, `Heartbeat`, `StatusNotification`, `Authorize`, `StartTransaction`, `MeterValues`, `StopTransaction` — *Iteration 1: có*
- **BE-04** Lệnh xuống trụ: `RemoteStartTransaction`, `RemoteStopTransaction`, `Reset`, `UnlockConnector`, `GetConfiguration`, `ChangeConfiguration`, `TriggerMessage` — *Iteration 1: chỉ TriggerMessage(StatusNotification) khi trụ nối lại*
- **BE-05** State machine trụ và connector cho cấu hình súng đôi, lưu bền và khôi phục — *Iteration 1: STM-1 phiên (22 chuyển), STM-2 phản chiếu + gắn cờ, STM-3 in_service/offline theo socket*
- **BE-06** Lưu trữ MeterValues DC: SoC, điện áp, dòng, kWh — *Iteration 1: mỗi SampledValue một dòng, dedup*
- **BE-07** Engine đối soát: phát lại hàng đợi offline, phát hiện replay theo timestamp, chống trùng giao dịch, phát hiện lỗ hổng chuỗi meter — *Iteration 1: có*
- **BE-08** Fanout realtime tới giao diện qua Socket.IO + Redis adapter — chỉ cho fanout, không nằm trên đường giao dịch (ADR-0006) — *chưa*

## Ràng buộc không được quên

- Khoá nghiệp vụ là `(chargePointId, connectorId)`. **`connectorId = 0` dành riêng cho trạng thái toàn trụ** theo OCPP 1.6 — không phải một súng.
- Chỉ làm **1.6J**. Không có 2.0.1 trong phạm vi.
- **CSMS là nguồn sự thật cho bản ghi phiên và bản tính giá** (ADR-0012 thu hẹp từ "cho hoá đơn"). Giá trên trụ chỉ để hiển thị. Mọi lệch so với Settlement của trụ phải sinh bản ghi đối soát.
- Phải nhận được `StartTransaction` với `idTag` lạ (quẹt RFID / nhập mật khẩu trên HMI) và ghi nhận thành phiên vãng lai.
- Mọi frame OCPP ghi vào `ocpp_message_log` **trước** khi xử lý (ADR-0005); CALL chiều vào xử lý **tuần tự theo trụ** (ADR-0004).

## WP3 — T31/T72 service contracts

This slice exposes backend services and PostgreSQL/OCPP integration tests. It does not expose
Driver HTTP endpoints or connect Flutter; the existing mobile UI still uses simulated data.
Callers must obtain principal IDs from authenticated server context before invoking these services.

- `DriverChargingService.start/getStart/stop/progress/statement`: energy-limit charging,
  principal-scoped idempotency and separate command/session/settlement outcomes. Accepted is not
  a confirmed start. `progress` includes settlement reason, retry time and held credit.
- `beginStartRecovery/startRecovery/completeStartRecovery/restoreRecoveredConnector`: an active
  staff member of the owning active operator records evidence, fences the connector with
  `ChangeAvailability(Inoperative)`, and requires observed Unavailable in the same connection epoch
  before releasing an unbound start's credit. Elapsed time alone never releases an unknown start.
  Restore requires a subsequent observed Available before another start. `retryStartRecovery`
  repeats only availability commands, never RemoteStart. Late starts retain attribution and require
  audited `approveLateStart` before billing.
- `ChargeSettlementService.settle/retryPending`: stop evidence atomically creates a durable billing
  job. Billing errors cannot reject an already persisted StopTransaction. The recovery worker runs
  at bootstrap and every 10 seconds; due pending jobs retry after 30 seconds. Ledger/statement
  constraints and session locks prevent duplicate debit/points under retries or concurrent workers.
- Pricing temporarily follows BR-P45 from Ân's `wp1/t71-br-p45-rounding` at `7e91f34` as authorized:
  exact milli-VND portions are summed, then rounded half up once per session. Points use the rounded
  debit. Repeated daily tariff segments are distinguished by segment start. No policy branch is merged.
  CSMS receipt timestamps define tariff portions. Each boundary needs an exact aggregate meter sample
  at that receipt time, or audited `recordTariffBoundary` evidence from the owning active operator.
  Missing evidence, tariff gaps/overlaps, reconciliation review, promotions and offline-delivered sessions
  remain observable pending with their credit liability retained; they are not silently priced.
- `findStations(driverId, vehicleId, input)` returns `{items,total,page,pageSize}` grouped by site,
  with compatible connectors and string resource IDs. Input supports literal accent-insensitive Vietnamese
  name/code/address search, availability, optional coordinates/radius, name/distance sort, page/pageSize
  (maximum 100), and explicit VinFast-only override. Distance is straight-line metres, not route/ETA.
  Disabled pillars/inactive operators are excluded; connectivity, raw status and freshness remain separate.
  Stale/future status cannot promise Available. `resolveConnector` uses exact code/gun lookup independently
  of pagination. Ranking, travel/wait/charging estimates and recommendations remain WP4 dependencies.

Apply migrations through `0006_wp3_stop_attempts.sql` using the existing migration runner before
starting this build. `CHARGE_*` configuration is listed in `infra/.env.example`; minimum/cutoff values
remain configurable proposals. Integration tests require the dedicated `powerme_test` database and
reset only its schema. Run `npm test -w @powerme/csms -- --runInBand` with that DATABASE_URL.


## WP3 — review fixes: stop attempts and start freshness

- Public `stop(driverId,key,sessionId)` still requires an active authenticated Driver with an owned
  app session. The `limit:` key namespace is reserved for the internal cutoff hook. Account suspension
  cannot disable an existing session's system energy/credit cutoff: the private command path rechecks
  app attribution, `csms_billed`, energy mode, live aggregate telemetry and cutoff eligibility under
  the session lock. System commands have `requested_by=NULL`; history actor is `system`.
- Automatic cutoff follows the latest stop intent for the session, including a manual stop. It adds
  a persisted command attempt only after confirmed Rejected and newer live telemetry received after
  backoff (1, 2, 4, 8, 16, then 30 seconds). Session locks and the open-intent constraint prevent parallel
  commands. Unknown/Accepted never enter this automatic rejection retry path. Retry waits for actual
  telemetry; the timer does not invent meter readings or treat silence as failure.
- `recoverStop(operatorId,sessionId,previousCommandId,note)` is an authorized service method, not an
  exposed endpoint. Active staff of the owning active operator can append an audited attempt to the
  **same business intent and physical transaction** after an unknown/sent or Accepted-without-effect stop.
  There is no new client business key. Persisted linkage to the previous command makes duplicate requests
  return the same attempt, including historical requests after a newer recovery. Recovery requires the
  current registry/DB epoch, online pillar, current Charging/Suspended status and non-replayed aggregate
  meter evidence in that epoch. Evidence must be newer than the previous command's timeout window and
  response, non-future and within the configured freshness window; a new connection requires new evidence.
  Conflicting open sessions, stopped sessions and absent evidence are refused. Dispatch checks the epoch
  again. A crash after preparing an attempt leaves a queryable sent/unknown outcome; fresh evidence and
  explicit operator recovery are required, rather than blindly resending on restart.
- Recovery does not fabricate `REMOTE_STOP_REJECTED` or change the STM-1 table. A rejected recovery
  attempt leaves the unresolved stop intent unknown. Only actual StopTransaction evidence confirms
  effect and allows normal settlement; recovery itself releases no credit and posts no debit/points.
  Late responses update their own command history without overwriting a newer intent or completed effect.
- Start now requires current-epoch Available evidence linked to the recorded StatusNotification, an
  online matching registry epoch, and non-future/fresh last-message times. A Heartbeat after reconnect
  cannot reuse Available from the prior connection. Replayed/future-dated status is refused; a new valid
  StatusNotification permits start. Dispatch checks the selected epoch again. Missing optional pillar
  status timestamps are accepted as a known OCPP limitation when the receipt/epoch evidence is valid.
  Provided pillar timestamps are checked conservatively against the connection and CSMS receipt times;
  a legitimately skewed pillar clock can therefore require resynchronization. No real-pillar compatibility
  or hardware safety certification is claimed.

Migration 0006 backfills existing stop intents into immutable attempt history. These are still backend
service contracts: operator/Driver HTTP endpoints and Flutter integration remain outside this slice.
