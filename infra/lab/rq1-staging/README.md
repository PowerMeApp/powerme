# Hai cấu hình đối chứng của RQ1 trên VM staging (T133)

Lần đo 13/11 chạy PowerMe trên VM staging nhưng hai cấu hình đối chứng (PowerMe tắt đối soát, SteVe 3.14.1) trên máy dev, nên không cùng tài nguyên. Thư mục này dựng hai cấu hình đó **trên cùng VM**, chạy lần lượt, rồi xoá.

| Cấu hình | Dựng bằng | Cổng trên VM (chỉ loopback) |
|---|---|---|
| PowerMe tắt đối soát | `docker-compose.yml` ở đây: cùng ảnh CSMS với staging, `RECONCILIATION_ENABLED=false`, Postgres 16.4 riêng | OCPP `127.0.0.1:9100`, Postgres `127.0.0.1:5434` |
| SteVe 3.14.1 | `infra/lab/steve/docker-compose.yml` | OCPP + web `127.0.0.1:8180` |

Không mở cổng nào ra internet và không đụng DB staging. Trụ giả vẫn chạy từ máy dev (như lần đo PowerMe), nối vào VM qua SSH tunnel.

## Khác gì so với lần đo PowerMe

- PowerMe đi qua Caddy (TLS, `wss://`); hai cấu hình đối chứng đi qua SSH tunnel tới cổng loopback, không qua Caddy. Cùng VM, cùng đường Việt Nam → Nhật, khác lớp mã hoá và proxy.
- CSMS staging vẫn chạy (không tải) trong lúc đo đối chứng; lúc đo PowerMe thì hai cấu hình đối chứng không chạy.
- SteVe tự build bằng Maven khi container khởi động lần đầu: tốn CPU và RAM của VM trong vài phút. Chờ build xong và tải VM lắng xuống rồi mới đo.

## Chạy

Chọn lúc không ai dùng staging. Trên VM (user `deploy`):

```bash
cd ~/powerme/infra/lab/rq1-staging
./up.sh                                                        # CSMS tắt đối soát
docker compose -f ../steve/docker-compose.yml up -d --build    # SteVe (lần đầu rất lâu)
```

Trên máy dev, mở tunnel rồi chạy harness (từ `apps/csms`, đã `npm run build`):

```bash
ssh -N -L 9100:127.0.0.1:9100 -L 5434:127.0.0.1:5434 -L 8180:127.0.0.1:8180 deploy@<FQDN>

# Tắt đối soát. Mật khẩu DB đọc từ rq1.env trên VM vào biến môi trường, không in ra.
export CP_PASSWORD="$(openssl rand -hex 16)"
node lab/rq1/run.mjs --config powerme-off --scenario all --runs 30 --seed 20261112 \
  --url ws://127.0.0.1:9100/ocpp --db-url "postgres://rq1:<mật khẩu>@127.0.0.1:5434/powerme_rq1_off" \
  --hidden-site --interval-s 10 --grace-s 120 --offline-extra-max-s 60 --concurrency 10

# SteVe: OCPP qua tunnel, MariaDB qua `ssh … docker compose exec`.
node lab/rq1/run.mjs --config steve --scenario all --runs 30 --seed 20261112 \
  --url ws://127.0.0.1:8180/steve/websocket/CentralSystemService \
  --steve-ssh "deploy@<FQDN>" --steve-compose "~/powerme/infra/lab/steve/docker-compose.yml" \
  --interval-s 10 --grace-s 120 --offline-extra-max-s 60 --concurrency 10 --stagger-s 5
```

## Dọn

Trên VM, ngay sau khi đo:

```bash
cd ~/powerme/infra/lab/rq1-staging && ./down.sh                 # dừng, xoá volume và rq1.env
docker compose -f ../steve/docker-compose.yml down --volumes    # dừng SteVe, xoá DB của nó
docker image rm powerme-lab/steve:3.14.1                        # tuỳ chọn: lấy lại ~1 GB đĩa
```
