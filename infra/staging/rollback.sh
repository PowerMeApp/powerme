#!/usr/bin/env bash
# Lùi staging về tag trước đó. Chạy trên VPS, trong infra/staging.
#
#   ./rollback.sh                              lùi ẢNH (chỉ khi lần deploy gần nhất không áp migration)
#   ./rollback.sh --force                      lùi ảnh dù lần deploy gần nhất đã áp migration (nguy hiểm)
#   ./rollback.sh --restore-db <file.dump>     khôi phục DB từ bản sao lưu RỒI lùi ảnh
#   thêm --yes để bỏ bước gõ xác nhận (khi --restore-db)
#
# MIGRATION KHÔNG ĐẢO ĐƯỢC BẰNG LÙI ẢNH. Migration 0001 và 0003 có `ALTER TYPE … ADD VALUE` (Postgres
# không có DROP VALUE), 0001 đổi tên cột (cp_timestamp), 0003 đặt NOT NULL (top_ups.gateway_reference,
# expires_at) và đổi UNIQUE của sổ cái. Ảnh cũ viết cho
# schema cũ sẽ lỗi trên schema mới: `review-2-v0` KHÔNG tương thích schema sau 0001. Vì vậy:
#   - deploy.sh ghi lại migration của mỗi lần deploy (.deploy/migrated_<tag>);
#   - nếu lần deploy đang chạy đã áp migration, lùi ảnh bị TỪ CHỐI trừ khi có --force;
#   - cách đúng để lùi qua migration là --restore-db với bản sao lưu `backups/pre-<tag>-*.dump`
#     chụp trước lần deploy đó. Dữ liệu ghi SAU thời điểm sao lưu sẽ mất.
set -Eeuo pipefail
cd "$(dirname "$0")"
# shellcheck source=lib.sh
. ./lib.sh

usage() {
  echo "dùng: ./rollback.sh [--force] [--restore-db <file.dump>] [--yes]" >&2
  exit 2
}

FORCE=false
YES=""
DUMP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=true ;;
    --yes) YES="--yes" ;;
    --restore-db)
      shift
      DUMP="${1:-}"
      [ -n "$DUMP" ] || usage
      ;;
    *) usage ;;
  esac
  shift
done

mkdir -p .deploy
if command -v flock >/dev/null 2>&1; then
  exec 9>.deploy/lock
  flock -n 9 || die "đang có một lần deploy/rollback khác chạy"
fi
check_env

PREV="$(cat .deploy/previous_tag 2>/dev/null || true)"
CUR="$(cat .deploy/current_tag 2>/dev/null || echo '?')"
[ -n "$PREV" ] || die "chưa ghi nhận tag trước đó (.deploy/previous_tag) — chưa có gì để lùi"
LAST_PUBLIC_CODE=""

trap 'warn "rollback THẤT BẠI (dòng $LINENO, lệnh: $BASH_COMMAND). Trạng thái: xem docker compose ps; .env TAG=$(env_get TAG)"' ERR

SIM_ON=false
if sim_running; then
  SIM_ON=true
  require_demo_password
  export COMPOSE_PROFILES=sim
fi

MIGRATED_FILE=".deploy/migrated_${CUR}"
if [ -z "$DUMP" ] && [ -s "$MIGRATED_FILE" ]; then
  warn "Lần deploy $CUR đã áp migration:"
  sed 's/^/     - /' "$MIGRATED_FILE" >&2
  # Gợi ý mức rủi ro: tìm thao tác không additive trong file SQL (nếu repo ở tag $CUR có file đó).
  while IFS= read -r name; do
    sql="../../apps/csms/drizzle/${name}.sql"
    if [ -f "$sql" ] && grep -Eqi 'RENAME|DROP[[:space:]]+(COLUMN|TABLE|TYPE|CONSTRAINT)|ALTER[[:space:]]+TYPE|SET[[:space:]]+NOT[[:space:]]+NULL|ALTER[[:space:]]+COLUMN' "$sql"; then
      warn "     ${name}.sql có thao tác KHÔNG additive (đổi tên/kiểu/xoá/ALTER TYPE) — ảnh cũ gần như chắc chắn không chạy được"
    fi
  done <"$MIGRATED_FILE"
  if [ "$FORCE" != true ]; then
    warn "Lùi ảnh $CUR -> $PREV sẽ chạy ảnh cũ trên schema MỚI. Từ chối."
    warn "Khôi phục DB trước deploy đó:  ./rollback.sh --restore-db backups/pre-${CUR}-<giờ>.dump"
    # shellcheck disable=SC2012
    ls -1t backups/pre-"${CUR}"-*.dump 2>/dev/null | head -n 3 | sed 's/^/     có sẵn: /' >&2 || true
    warn "Hoặc, nếu BIẾT ảnh cũ chạy được với schema mới:  ./rollback.sh --force"
    exit 1
  fi
  warn "--force: tiếp tục lùi ảnh trên schema mới (rủi ro đã nêu)."
fi

if [ -n "$DUMP" ]; then
  [ -f "$DUMP" ] || die "không thấy file sao lưu: $DUMP"
  case "$(basename "$DUMP")" in
    pre-"${CUR}"-*) ;;
    *) warn "Cảnh báo: $DUMP không phải bản chụp TRƯỚC lần deploy $CUR; kiểm tra nó khớp với ảnh $PREV." ;;
  esac
  confirm "Sẽ XOÁ cơ sở dữ liệu hiện tại và thay bằng $DUMP. Dữ liệu ghi sau lúc sao lưu sẽ MẤT." RESTORE "$YES"
  log "Dừng ứng dụng"
  docker compose stop csms caddy
  if [ "$SIM_ON" = true ]; then docker compose stop simulator; fi
  docker compose up -d --wait postgres
  log "Khôi phục DB từ $DUMP (tạo lại DB rỗng, rồi pg_restore)"
  recreate_db
  docker compose exec -T postgres pg_restore -U "$(env_get POSTGRES_USER)" -d "$(env_get POSTGRES_DB)" \
    --no-owner --exit-on-error <"$DUMP"
  # Schema đã về trước lần deploy $CUR: bỏ ghi chú migration của nó.
  rm -f "$MIGRATED_FILE"
fi

log "Lùi ảnh $CUR -> $PREV"
set_env TAG "$PREV"
if [ "$SIM_ON" = true ]; then
  docker compose pull csms simulator
else
  docker compose pull csms
fi
docker compose up -d csms caddy
if [ "$SIM_ON" = true ]; then docker compose up -d simulator; fi

if wait_healthy 30; then
  echo "$PREV" >.deploy/current_tag
  echo "$CUR" >.deploy/previous_tag
  log "OK: đang chạy $PREV"
  exit 0
fi
trap - ERR
warn "$PREV không khoẻ sau khi lùi (mã công khai gần nhất: ${LAST_PUBLIC_CODE:-?}). Xem: docker compose logs csms caddy"
exit 1
