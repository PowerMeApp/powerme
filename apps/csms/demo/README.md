# demo — bộ chạy demo một lệnh (BE-09)

Dựng CSMS + Postgres + dữ liệu mẫu chỉ với Node (không Docker, không Postgres cài sẵn). Kịch bản demo Review 2 nằm ở [`docs/DEMO-REVIEW-2.md`](../../../docs/DEMO-REVIEW-2.md).

```bash
npm install --ignore-scripts          # một lần, ở gốc repo
npm run demo -w @powerme/csms          # hoặc: cd apps/csms && npm run demo
```

Dừng bằng **Ctrl+C**: script kill toàn bộ tiến trình con (Windows: `taskkill /T /F`) và dừng Postgres bằng `pg_ctl stop -m fast`.

## Lệnh

| Lệnh                                       | Việc                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `npm run demo -w @powerme/csms`            | Postgres nhúng + migration + seed + CSMS (+ HMI, console nếu đã có) |
| `npm run demo:reset -w @powerme/csms`      | Xoá `.demo-data/` rồi dựng lại từ đầu (mất mọi phiên đã sinh)        |
| `npm run demo:db -w @powerme/csms`         | Chỉ Postgres + seed (cho dev/test), in `DATABASE_URL`                |
| `node apps/csms/demo/scripted-station.mjs` | Trụ kịch bản (kế hoạch B khi HMI hỏng)                               |
| `node apps/csms/demo/show.mjs ["SQL"]`     | Xem DB không cần psql                                                |

Tuỳ chọn của `demo`: `--no-hmi`, `--port-offset N` (cộng N vào mọi cổng; dùng khi máy đã có thứ khác nghe 9000/54330), `--reset`.

## Cổng và tài khoản

| Thứ             | Giá trị                                                                              |
| --------------- | ------------------------------------------------------------------------------------ |
| Postgres        | `127.0.0.1:54330`, user `powerme`, mật khẩu `powerme`, DB `powerme_demo` (demo), `powerme_test` (test) |
| CSMS OCPP       | `ws://localhost:9000/ocpp/<serialNumber>`                                            |
| Console CSMS    | `http://localhost:3000/` (khi PR console merge; biến `CONSOLE_PORT`)                 |
| HMI trụ D1      | `http://localhost:8100/` (khi PR HMI merge; biến `CSMS_URL`, `CP_ID`, `PORT`)        |

Dữ liệu nằm ở `apps/csms/.demo-data/` (đã `.gitignore`). Chỉ lắng nghe 127.0.0.1.

## Dữ liệu mẫu (`seed.sql`)

Một operator, một site ở TP.HCM, trụ `RH24D1-00001` (D1-120, lifecycle `awaiting_connection` — gateway tự chuyển `in_service` khi socket mở), hai connector, ba thẻ (`DEMO-ONLINE-01` online/active gắn tài xế mẫu có ví 500.000 VND, `DEMO-WALLET-01` wallet, `DEMO-BLOCKED-01` blocked), bảng giá 7 khung. **Thẻ lạ cố ý không seed** (kịch bản DS-03c dùng `UNKNOWN-TAG-99`). Chạy lại seed không nhân đôi dòng.

## Test tích hợp tại chỗ

19 test trong `test/wf03-exp01.integration.test.ts` chạy khi có `DATABASE_URL`, và **DROP SCHEMA public** trước mỗi lần. Vì vậy dùng DB riêng, không dùng DB demo:

```bash
npm run demo:db -w @powerme/csms      # cửa sổ 1
DATABASE_URL=postgresql://powerme:powerme@127.0.0.1:54330/powerme_test npm test -w @powerme/csms   # cửa sổ 2
```

## Giới hạn cần biết

- **Postgres 17 beta.** `embedded-postgres` chỉ phát hành beta 17.x/18.x nên ghim `17.10.0-beta.17`, chỉ là devDependency cho demo. **CI và staging dùng Postgres 16 chuẩn** (`infra/docker-compose.yml`); kết quả demo không thay kiểm thử trên PG 16.
- Gói binary `@embedded-postgres/windows-x64` có `postinstall` chỉ để dựng lại symlink (chỉ cần trên Linux/macOS); trên Windows nó không làm gì nên `npm install --ignore-scripts` vẫn chạy được. Chưa kiểm trên Linux/macOS; nếu ở đó Postgres thiếu thư viện/symlink thì cài không có `--ignore-scripts` một lần.
- Ctrl+C trong cùng cửa sổ console cũng tới postgres.exe, nên Postgres thường dừng không sạch hoàn toàn và lần sau chạy crash recovery (vài trăm ms, dữ liệu đã commit không mất).
- HMI và console do PR riêng; script tự phát hiện `simulator/d1-hmi/server.mjs` và thư mục `src/console`, thiếu thì chỉ cảnh báo.
- Tên biến môi trường script truyền cho HMI (`CSMS_URL`, `CP_ID`, `PORT`/`HMI_PORT`) theo mô tả của PR HMI, chưa kiểm với mã thật.

## Các file

| File                   | Việc                                                              |
| ---------------------- | ----------------------------------------------------------------- |
| `run-demo.mjs`         | Điều phối: DB → build → CSMS → HMI/console → bảng tóm tắt → dừng sạch |
| `db-embedded.mjs`      | Postgres nhúng, áp `drizzle/0000_init.sql`, nạp `seed.sql`, dừng sạch |
| `seed.sql`             | Dữ liệu mẫu, idempotent                                           |
| `scripted-station.mjs` | Trụ kịch bản cho DS-01a/b, DS-03a/b/c/d                           |
| `show.mjs`             | Truy vấn nhanh DB demo                                            |
