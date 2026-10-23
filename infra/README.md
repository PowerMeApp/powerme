# infra

Hạ tầng phát triển cục bộ và kịch bản đo tải.

## Bật hạ tầng

```bash
cp .env.example .env      # rồi sửa giá trị
npm run infra:up          # postgres + redis
```

Bật thêm CSMS đối chứng SteVe:

```bash
docker compose -f infra/docker-compose.yml --profile reference up -d
```

### Build SteVe 3.14.1 (một lần, trước khi dùng profile `reference`)

Không có image công khai tên `steve:3.14.1`; compose giả định image này đã có trên máy. Build từ mã nguồn ở tag đã ghim, ngoài kho PowerMe (không fork, không copy code):

```bash
git clone --branch steve-3.14.1 --depth 1 https://github.com/steve-community/steve.git
git -C steve rev-parse HEAD     # phải ra 3fd8cda4722822214f744329bc48dba349456514
docker build -t steve:3.14.1 steve
```

Lưu ý chưa kiểm: `Dockerfile` của SteVe 3.14.1 chờ DB ở host `mariadb` và build với profile Maven `mariadb`, còn compose của PowerMe dùng `mysql:8.0` ở host `steve-db`. Chưa ai chạy profile `reference` trên repo này (máy không có Docker), nên cấu hình DB cần được kiểm khi lần đầu bật. Tag và commit nói trên đã xác minh bằng `ls-remote`.

## Bàn thí nghiệm OCPP

```
SAP simulator  ──WebSocket──>  CSMS của nhóm (apps/csms)
       │
       └──────WebSocket──────>  SteVe (đối chứng, để so hành vi)
```

Khi hành vi hai bên lệch nhau, **SteVe không phải là chuẩn** — spec OCPP 1.6 mới là chuẩn.
SteVe chỉ là một cách đọc spec. Lệch thì tra spec rồi ghi kết luận vào `docs/adr/`.

## Load test (QA-07)

Kịch bản k6 nằm ở [k6/](k6/), theo mẫu của MaEVe: **1 virtual user = 1 trạm sạc**, dùng khung OCPP 1.6J thật.
MaEVe đã archived nhưng mẫu load test còn dùng được.

Mục tiêu đo: số trụ đồng thời mà CSMS chịu được trước khi độ trễ `MeterValues` vượt ngưỡng NFR.

## Ghim phiên bản

| Thành phần | Phiên bản | Ghi chú |
|---|---|---|
| PostgreSQL | 16.4-alpine | |
| Redis | 7.4-alpine | |
| SteVe | 3.14.1 | Release ngày 12/08/2026 · tag `steve-3.14.1` = commit `3fd8cda4722822214f744329bc48dba349456514` · build cục bộ, xem mục trên |
| SAP simulator | tag `web@v4.12.0` | Xem [simulator/README.md](../simulator/README.md) |

Đổi bất kỳ phiên bản nào ở bảng này thì ghi lý do vào ADR.
