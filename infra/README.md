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
| SteVe | 3.14.1 | Release ngày 12/08/2026 |
| SAP simulator | ghim theo commit | Xem [simulator/README.md](../simulator/README.md) |

Đổi bất kỳ phiên bản nào ở bảng này thì ghi lý do vào ADR.
