#!/usr/bin/env bash
# Nạp lại dữ liệu mẫu mà không deploy lại. Chạy trên VPS, trong infra/staging.
#
#   ./seed.sh                nạp/áp lại dữ liệu mẫu, đặt lại credential trụ demo từ
#                            DEMO_CHARGE_POINT_PASSWORD (đổi mật khẩu trong .env rồi chạy = xoay mật khẩu).
#                            Kèm dữ liệu cho app tài xế (BE-27: 9 trạm TP.HCM, mẫu xe, tài xế
#                            app.ds0x@powerme.test, mật khẩu = DEMO_DRIVER_PASSWORD).
#                            Idempotent; KHÔNG xoá phiên/meter/sổ cái đã phát sinh.
#   ./seed.sh --no-app       như trên nhưng bỏ phần dữ liệu app (chỉ seed.sql của demo Review 2).
#   ./seed.sh --reset [--yes]  XOÁ TOÀN BỘ DB, migrate lại, seed — về trạng thái đầu cho kịch bản
#                            DS-01..DS-10. Mất mọi dữ liệu, cả backup tự động không có.
#
# Dữ liệu mẫu nằm ở apps/csms/demo/seed.sql + seed-app.sql; script thực thi: apps/csms/scripts/seed-demo.mjs.
set -Eeuo pipefail
cd "$(dirname "$0")"
# shellcheck source=lib.sh
. ./lib.sh

RESET=false
YES=""
SEED_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --reset) RESET=true ;;
    --yes) YES="--yes" ;;
    --no-app) SEED_ARGS+=(--no-app) ;;
    *)
      echo "dùng: ./seed.sh [--reset [--yes]] [--no-app]" >&2
      exit 2
      ;;
  esac
done

mkdir -p .deploy
if command -v flock >/dev/null 2>&1; then
  exec 9>.deploy/lock
  flock -n 9 || die "đang có một lần deploy/rollback khác chạy"
fi
check_env
require_demo_password
trap 'warn "seed THẤT BẠI (dòng $LINENO, lệnh: $BASH_COMMAND)"' ERR

docker compose up -d --wait postgres

if [ "$RESET" = true ]; then
  confirm "Sẽ XOÁ TOÀN BỘ cơ sở dữ liệu staging rồi nạp lại dữ liệu mẫu." RESET "$YES"
  SIM_WAS_ON=false
  if sim_running; then SIM_WAS_ON=true; fi
  log "Dừng ứng dụng"
  docker compose stop csms
  if [ "$SIM_WAS_ON" = true ]; then docker compose --profile sim stop simulator; fi
  recreate_db
  log "Migrate"
  docker compose run --rm -T csms node scripts/migrate.mjs
fi

log "Nạp dữ liệu mẫu"
run_csms_script scripts/seed-demo.mjs "${SEED_ARGS[@]}"

if [ "$RESET" = true ]; then
  log "Khởi động lại ứng dụng"
  docker compose up -d csms
  if [ "${SIM_WAS_ON:-false}" = true ]; then docker compose --profile sim up -d simulator; fi
fi
log "OK: dữ liệu mẫu đã nạp"
