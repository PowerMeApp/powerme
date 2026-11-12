# SteVe cho thí nghiệm RQ1 (đối chứng của NFR-02)

SteVe là CSMS mã nguồn mở (Java + MariaDB) dùng làm cấu hình đối chứng thứ ba của RQ1. Thư mục này chỉ chứa cách **chạy** SteVe ở một phiên bản ghim; mã SteVe không nằm trong repo PowerMe.

> **Chưa kiểm chứng.** Máy dev không có Docker nên **chưa ai chạy** `docker-compose.yml` này và adapter `apps/csms/lab/rq1/adapters/steve.mjs` chưa từng nối vào SteVe thật. Phần đã kiểm là **đọc mã nguồn SteVe tag `steve-3.14.1`** trên GitHub ngày 12/11/2026 (xem bảng dưới) và unit test adapter bằng dữ liệu giả. Lần chạy đầu trên VM phải đi hết mục "Việc phải kiểm khi bật lần đầu".

## Phiên bản ghim

| Thành phần | Phiên bản | Nguồn |
|---|---|---|
| SteVe | tag `steve-3.14.1`, commit `3fd8cda4722822214f744329bc48dba349456514` (phát hành 12/08/2026) | `git ls-remote --tags https://github.com/steve-community/steve.git` (đã chạy 12/11/2026) |
| MariaDB | `mariadb:10.11.16` | `docker-compose.yml` gốc của SteVe ở tag này, cũng nằm trong ma trận CI của họ |
| JDK trong image | `eclipse-temurin:25-jdk` | `Dockerfile` của SteVe ở tag này |

Bản mới nhất lúc viết là `steve-3.15.0` (10/11/2026, mới 2 ngày). Giữ 3.14.1 vì `infra/README.md` đã ghim bản này từ trước; đổi phiên bản thì phải đọc lại migration vì tên bảng có thể đổi (xem dưới).

## Những gì đã đối chiếu với mã nguồn SteVe 3.14.1

| Điều harness dựa vào | Ở đâu trong SteVe |
|---|---|
| URL trụ: `ws://<host>:8180/steve/websocket/CentralSystemService/<chargeBoxId>` | `context.path = steve`, `http.port = 8180` (`application-docker.properties`); `PATH_INFIX = "/websocket/CentralSystemService/"` (`WebSocketConfiguration.java`) |
| Trụ lạ bị từ chối cho tới khi có dòng trong `charge_box` | `auto.register.unknown.stations = false`; README: "the charge point must first be registered" |
| `charge_box(charge_box_id, registration_status DEFAULT 'Accepted')`, `ocpp_tag(id_tag, max_active_transaction_count)` | `B1_0_5__stevedb.sql` |
| Bảng súng tên `evse` (`evse_pk`, `charge_box_id`, `evse_id`); `transaction_start.evse_pk`; `connector_meter_value.evse_pk` | `V1_1_4__update.sql` đổi tên `connector` → `evse` và `connector_pk` → `evse_pk` |
| View `transaction` = `transaction_start` LEFT JOIN dòng `transaction_stop` mới nhất; cột `start_value`, `stop_value` kiểu `varchar` | `B1_0_5__stevedb.sql`, dựng lại trong `V1_1_4__update.sql` |
| `StartTransaction` trùng (cùng súng, `id_tag`, `start_timestamp`, `start_value`) trả lại `transaction_pk` cũ | `OcppServerRepositoryImpl.insertIgnoreTransaction` |
| `StopTransaction` ghi thêm một dòng `transaction_stop`; ghi lỗi thì vào `transaction_stop_failed` | `OcppServerRepositoryImpl.updateTransaction` |
| Thẻ lạ trong `StartTransaction` được tự thêm vào `ocpp_tag` với `max_active_transaction_count = 0` (bị chặn) | `insertIgnoreIdTag` — vì vậy harness đăng ký thẻ trước với giá trị 1 |

## Chạy trên VM

Cần: Docker Engine + plugin compose, Node ≥ 24, một bản checkout repo PowerMe đã `npm ci`. VM cần ra internet lúc build (clone SteVe, tải Maven). **Không** chạy chung lúc với đo PowerMe nếu muốn so tài nguyên công bằng.

```bash
# 1. Bật SteVe. Lần đầu rất lâu: container tự build bằng Maven khi KHỞI ĐỘNG (CMD của Dockerfile),
#    cần DB đã lên vì bước build chạy migration + sinh mã jOOQ.
docker compose -f infra/lab/steve/docker-compose.yml up -d --build
docker compose -f infra/lab/steve/docker-compose.yml logs -f steve      # chờ tới khi Jetty lắng nghe :8180
curl -sI http://127.0.0.1:8180/steve/manager | head -1                  # mong đợi 200 hoặc 302 (trang đăng nhập)

# 2. Đăng ký 90 trụ + 90 thẻ (INSERT IGNORE thẳng vào MariaDB), chưa chạy gì.
cd apps/csms
node lab/rq1/run.mjs --config steve --scenario all --runs 30 --seed 20261112 --register-only
#    Hoặc chỉ in SQL để tự chạy tay:
node lab/rq1/run.mjs --config steve --scenario all --runs 30 --seed 20261112 --print-sql

# 3. Thử 1 lần mỗi kịch bản trước, đọc kỹ rows.jsonl.
node lab/rq1/run.mjs --config steve --scenario all --runs 1 --seed 20261112 --out /tmp/rq1-steve-thu

# 4. Chạy đủ. CÙNG seed với hai cấu hình PowerMe → cùng kế hoạch, cùng E_true.
node lab/rq1/run.mjs --config steve --scenario all --runs 30 --seed 20261112 \
     --out lab/rq1/results/<ngày>

# 5. Gộp ba cấu hình thành một báo cáo.
node lab/rq1/analyze.mjs lab/rq1/results/<ngày>/powerme/rows.jsonl \
     lab/rq1/results/<ngày>/powerme-off/rows.jsonl lab/rq1/results/<ngày>/steve/rows.jsonl \
     --out lab/rq1/results/<ngày>
```

Harness đọc kết quả bằng `docker compose -f infra/lab/steve/docker-compose.yml exec -T mariadb mariadb …` (mật khẩu lấy từ biến môi trường của chính container), nên phải chạy ở nơi lệnh `docker` nói chuyện được với VM đó. Chạy lại trên DB chưa xoá thì thêm `--batch <chữ số khác>` để không trùng định danh, hoặc `down -v` rồi làm lại từ bước 1.

SteVe không có ân hạn offline hay khái niệm giữ phiên, nên `--grace-s` chỉ quyết định độ dài đứt kết nối của trụ; giữ nguyên giá trị đã dùng cho PowerMe.

## Việc phải kiểm khi bật lần đầu

1. `docker compose build` có nhận build context dạng URL git + `#steve-3.14.1` không (cần Docker ≥ 23 với BuildKit). Không được thì `git clone --branch steve-3.14.1 --depth 1` rồi đổi `context` thành đường dẫn cục bộ.
2. Container `steve` build xong và lên được: Dockerfile build bằng `./mvnw … -Pdocker,mariadb` lúc khởi động; kiểm log không có lỗi Flyway/jOOQ và bảng `evse` tồn tại (`SHOW TABLES` trong `stevedb`).
3. `healthcheck.sh` có trong image `mariadb:10.11.16` (image chính thức có; nếu không, đổi healthcheck sang `mariadb-admin ping`).
4. Chèn thẳng `charge_box` bằng SQL có đủ để SteVe chấp nhận kết nối WebSocket ngay không (có thể SteVe giữ bộ nhớ đệm danh sách trụ; nếu trụ vẫn bị từ chối thì khởi động lại container `steve` sau bước đăng ký, hoặc thêm trụ qua giao diện web).
5. SteVe có chấp nhận `StopTransaction`/`MeterValues` với `transactionId` hợp lệ khi trụ nối lại **không** gửi `BootNotification` không (kịch bản S1–S3 đều nối lại không Boot, như EXP-01).
6. Client `mariadb` trong container in `NULL` cho giá trị null ở chế độ `--batch --raw` (adapter dựa vào điều này).
7. Giờ của VM và của container là UTC (compose đặt `TZ` cho MariaDB; SteVe ghi `start_timestamp` theo múi giờ JVM).

Ghi kết quả từng mục vào PR chạy SteVe; mục nào sai thì sửa adapter/compose trong PR đó.
