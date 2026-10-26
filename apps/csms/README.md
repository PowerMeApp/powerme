# @powerme/csms — WP2

CSMS OCPP 1.6J. **Trái tim kỹ thuật của đồ án.**

| | |
|---|---|
| Chủ sở hữu | WP2 — Backend / IoT Engineer |
| Cột mốc | **M2 — 04/10/2026** (cổng kỹ thuật), M5 — 15/11/2026 |
| Stack | NestJS 12 + TypeScript 5.9 (strict) · ocpp-rpc 2.2.1 (ADR-0004) · Drizzle ORM + PostgreSQL 16 (ADR-0008) · Redis (chưa dùng ở Iteration 1) |
| Lộ trình chi tiết | [docs/WP2-LO-TRINH-KY-THUAT.md](../../docs/WP2-LO-TRINH-KY-THUAT.md) |
| Iteration 1 | [docs/ITERATION-1-WF03.md](../../docs/ITERATION-1-WF03.md) — gateway + state machine phiên + đối soát, test phát lại trace EXP-01 |

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
