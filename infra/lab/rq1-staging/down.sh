#!/usr/bin/env bash
# Dừng CSMS "tắt đối soát" của RQ1 và XOÁ dữ liệu thí nghiệm của nó (volume Postgres riêng).
# Không đụng staging: project compose khác tên (powerme-rq1-off), DB khác.
set -euo pipefail
cd "$(dirname "$0")"

STAGING_ENV=../../staging/.env
[ -s rq1.env ] || { echo "không có rq1.env: chưa từng chạy up.sh ở đây"; exit 0; }

docker compose --env-file "$STAGING_ENV" --env-file rq1.env down --volumes
rm -f rq1.env
echo "==> OK: đã dừng và xoá dữ liệu thí nghiệm tắt đối soát"
