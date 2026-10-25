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
| Console CSMS    | `http://localhost:3000/` (biến `CONSOLE_PORT`)                                       |
| HMI trụ D1      | `http://localhost:8100/` (biến `CSMS_URL`, `CP_ID`, `HMI_PORT`, `STALE_METERSTOP`)   |

Dữ liệu nằm ở `apps/csms/.demo-data/` (đã `.gitignore`). Chỉ lắng nghe 127.0.0.1.

## Dữ liệu mẫu (`seed.sql`)

Một operator, một site ở TP.HCM, trụ `RH24D1-00001` (D1-120, lifecycle `awaiting_connection` — gateway tự chuyển `in_service` khi socket mở), hai connector, ba thẻ (`DEMO-CARD-0001` online/active gắn tài xế mẫu có ví 500.000 VND, `DEMO-WALLET-0001` wallet, `DEMO-BLOCKED-01` blocked), bảng giá 7 khung, và `charge_points.free_vend_tag = HMI-FREEVEND` (mật khẩu HMI `123456` → phiên `origin=free_vend`, `payment_mode=free`). Tên thẻ khớp `CARDS` trong `simulator/d1-hmi/model.mjs`. **Thẻ lạ cố ý không seed** (`DEMO-UNKNOWN-999` của HMI, `UNKNOWN-TAG-99` của DS-03c); HMI không có nút thẻ bị chặn nên DS-01b dùng trụ kịch bản. Chạy lại seed không nhân đôi dòng.

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
- **HMI và trụ kịch bản dùng chung identity `RH24D1-00001`**: không chạy cả hai cùng lúc (hai client cùng một identity làm epoch và phiên lẫn lộn; chưa kiểm cách CSMS xử lý socket thứ hai). Dùng trụ kịch bản thì chạy `npm run demo -w @powerme/csms -- --no-hmi`.
- Script truyền cho HMI `CSMS_URL`, `CP_ID`, `HMI_PORT` (đã đối chiếu với `server.mjs`: chỉ `HMI_PORT` được đọc) và `STALE_METERSTOP=1` (mặc định bật: sau rớt mạng, `StopTransaction` mang `meterStop` cũ để ra phiên `review`; tắt bằng `STALE_METERSTOP=0`). Script chỉ in URL, không tự mở trình duyệt.

## Các file

| File                   | Việc                                                              |
| ---------------------- | ----------------------------------------------------------------- |
| `run-demo.mjs`         | Điều phối: DB → build → CSMS → HMI/console → bảng tóm tắt → dừng sạch |
| `db-embedded.mjs`      | Postgres nhúng, áp migration (qua `migrate.mjs`), nạp `seed.sql`, dừng sạch |
| `migrate.mjs`          | Áp tuần tự `drizzle/*.sql` còn thiếu, theo dõi bằng bảng `_migrations` (DB demo cũ tự lên 0001) |
| `seed.sql`             | Dữ liệu mẫu, idempotent                                           |
| `scripted-station.mjs` | Trụ kịch bản cho DS-01a/b, DS-03a/b/c/d                           |
| `show.mjs`             | Truy vấn nhanh DB demo                                            |
