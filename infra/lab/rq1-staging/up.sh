#!/usr/bin/env bash
# Dựng CSMS "tắt đối soát" của RQ1 trên VM staging (T133). Chạy bằng user `deploy`, trong thư mục này.
# Idempotent: chạy lại giữ nguyên mật khẩu DB và dữ liệu đã có.
set -euo pipefail
cd "$(dirname "$0")"

STAGING_ENV=../../staging/.env
[ -f "$STAGING_ENV" ] || { echo "thiếu $STAGING_ENV (cần REGISTRY, TAG của staging)" >&2; exit 2; }

# Mật khẩu DB thí nghiệm: sinh một lần, chỉ nằm trên VM (chmod 600), không in ra.
if [ ! -s rq1.env ]; then
  umask 077
  printf 'RQ1_OFF_DB_PASSWORD=%s\n' "$(openssl rand -hex 24)" > rq1.env
  # RQ1_TAG ghim ảnh CSMS (vd. tag của lần đo PowerMe); dòng TAG ở đây ghi đè TAG của staging.
  if [ -n "${RQ1_TAG:-}" ]; then printf 'TAG=%s\n' "$RQ1_TAG" >> rq1.env; fi
fi
chmod 600 rq1.env

dc() { docker compose --env-file "$STAGING_ENV" --env-file rq1.env "$@"; }

dc pull --quiet csms-off postgres-off
dc up -d postgres-off
# Cùng script migrate mà deploy.sh của staging dùng.
dc run --rm -T csms-off node scripts/migrate.mjs
dc up -d csms-off

for _ in $(seq 1 30); do
  if dc logs csms-off 2>/dev/null | grep -q 'OCPP-J 1.6 lắng nghe'; then
    echo "==> OK: csms-off đang nghe ws://127.0.0.1:9100/ocpp/<serial> (RECONCILIATION_ENABLED=false)"
    dc ps --format '{{.Name}} {{.Status}}'
    exit 0
  fi
  sleep 2
done
echo "csms-off chưa sẵn sàng sau 60 s; xem: docker compose logs csms-off" >&2
exit 1
