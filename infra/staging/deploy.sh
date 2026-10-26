#!/usr/bin/env bash
# Triển khai một tag lên staging. Chạy trên VPS, trong infra/staging (CI gọi qua SSH).
#
#   ./deploy.sh <tag> [--seed] [--sim]
#
#   --seed  nạp dữ liệu mẫu (trụ RH24D1-00001 có credential từ DEMO_PILLAR_PASSWORD)
#   --sim   cập nhật/bật cả simulator (tự bật nếu nó đang chạy sẵn)
#
# Các bước: kiểm .env -> sao lưu DB -> pull ảnh -> migrate -> (seed) -> khởi động -> kiểm sức khoẻ
# (trong container + công khai qua TLS) -> nếu hỏng, tự lùi ẢNH về tag cũ khi an toàn.
#
# LÙI ẢNH KHÔNG ĐẢO ĐƯỢC MIGRATION. Nếu lần deploy này đã áp migration, script KHÔNG tự lùi ảnh
# (ảnh cũ có thể không chạy được với schema mới — ví dụ review-2-v0 với schema sau 0001); nó in
# hướng dẫn khôi phục từ bản sao lưu. Xem README.md mục "Rollback".
set -Eeuo pipefail
cd "$(dirname "$0")"
# shellcheck source=lib.sh
. ./lib.sh

usage() {
  echo "dùng: ./deploy.sh <tag> [--seed] [--sim]" >&2
  exit 2
}

TAG_NEW="${1:-}"
[ -n "$TAG_NEW" ] || usage
shift
SEED=false
SIM=false
for arg in "$@"; do
  case "$arg" in
    --seed) SEED=true ;;
    --sim) SIM=true ;;
    *) usage ;;
  esac
done
# Tag trở thành tên image và đi qua SSH/shell: chỉ nhận ký tự an toàn.
[[ "$TAG_NEW" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || die "tag không hợp lệ: '$TAG_NEW'"

mkdir -p .deploy backups
if command -v flock >/dev/null 2>&1; then
  exec 9>.deploy/lock
  flock -n 9 || die "đang có một lần deploy/rollback khác chạy"
fi

check_env
if [ "$SEED" = true ]; then require_demo_password; fi

TAG_OLD="$(cat .deploy/current_tag 2>/dev/null || true)"
STEP="khởi tạo"
APP_TOUCHED=false # true sau khi đã đổi container ứng dụng; trước đó chỉ cần trả TAG trong .env về cũ
MIGRATED=() # migration áp trong lần chạy này
LAST_PUBLIC_CODE=""
BACKUP=""
FAIL_MSG="" # nếu đặt, in thay cho lệnh gây lỗi

# abort "lý do" — dừng có ngữ cảnh qua trap ERR (cùng đường xử lý với lỗi lệnh).
abort() {
  FAIL_MSG="$1"
  return 1
}

# shellcheck disable=SC2329 # gọi gián tiếp qua trap ERR
on_err() {
  local code=$? line="$1"
  trap - ERR
  warn "deploy THẤT BẠI ở bước '$STEP' (dòng $line, ${FAIL_MSG:-lệnh: $BASH_COMMAND}, mã $code)"
  if [ "$APP_TOUCHED" = false ] && [ -n "$TAG_OLD" ]; then
    set_env TAG "$TAG_OLD"
    warn ".env đã trả TAG về $TAG_OLD; ứng dụng đang chạy chưa bị đụng tới."
  fi
  if [ "${#MIGRATED[@]}" -gt 0 ]; then
    warn "đã áp migration: ${MIGRATED[*]} — DB đã đổi. Bản sao lưu trước deploy: ${BACKUP:-(không có)}"
    warn "khôi phục: ./rollback.sh --restore-db ${BACKUP:-backups/<file>.dump}"
  fi
  exit "$code"
}
trap 'on_err $LINENO' ERR

SIM_ON=false
if [ "$SIM" = true ] || sim_running; then SIM_ON=true; fi
if [ "$SIM_ON" = true ]; then
  require_demo_password
  export COMPOSE_PROFILES=sim
fi

STEP="sao lưu DB"
log "Sao lưu cơ sở dữ liệu (trước migrate)"
if [ -n "$(docker compose ps --status running -q postgres)" ]; then
  BACKUP="backups/pre-${TAG_NEW}-$(date +%Y%m%d-%H%M%S).dump"
  docker compose exec -T postgres pg_dump -U "$(env_get POSTGRES_USER)" -d "$(env_get POSTGRES_DB)" -Fc >"$BACKUP.partial"
  [ -s "$BACKUP.partial" ] || die "bản sao lưu rỗng"
  mv "$BACKUP.partial" "$BACKUP"
  echo "   $BACKUP ($(wc -c <"$BACKUP") byte) — CHỈ nằm trên VPS này, không phải sao lưu ngoài máy"
  # Giữ 10 bản mới nhất.
  # shellcheck disable=SC2012
  ls -1t backups/*.dump 2>/dev/null | tail -n +11 | while IFS= read -r old; do rm -f -- "$old"; done || true
else
  echo "   Postgres chưa chạy (lần deploy đầu) — không có gì để sao lưu"
fi

STEP="pull ảnh"
log "Kéo ảnh $TAG_NEW"
set_env TAG "$TAG_NEW"
if [ "$SIM_ON" = true ]; then
  docker compose pull csms simulator
else
  docker compose pull csms
fi

STEP="khởi động Postgres"
log "Bật Postgres"
docker compose up -d --wait postgres

STEP="migrate"
log "Áp migration (scripts/migrate.mjs)"
MIGRATE_OUT="$(mktemp)"
trap 'rm -f "$MIGRATE_OUT"' EXIT
MIGRATE_RC=0
docker compose run --rm -T csms node scripts/migrate.mjs | tee "$MIGRATE_OUT" || MIGRATE_RC=$?
# Ghi nhận cả khi migrate chết giữa chừng: mỗi file tự có BEGIN/COMMIT nên file đã áp là đã áp.
while IFS= read -r name; do
  if [ -n "$name" ]; then MIGRATED+=("$name"); fi
done < <(sed -n 's#.*drizzle/\([0-9A-Za-z_.-]*\)\.sql.*#\1#p' "$MIGRATE_OUT")
if [ "$MIGRATE_RC" -ne 0 ]; then abort "migrate trả mã $MIGRATE_RC (xem log ở trên)"; fi

if [ "$SEED" = true ]; then
  STEP="seed"
  log "Nạp dữ liệu mẫu (scripts/seed-demo.mjs)"
  run_csms_script scripts/seed-demo.mjs
fi

STEP="khởi động ứng dụng"
if [ "$SIM_ON" = true ]; then log "Khởi động CSMS + Caddy + simulator"; else log "Khởi động CSMS + Caddy"; fi
APP_TOUCHED=true
docker compose up -d csms caddy
if [ "$SIM_ON" = true ]; then docker compose up -d simulator; fi

STEP="kiểm sức khoẻ"
log "Kiểm sức khoẻ: trong container (GET /health) + công khai (https://$(env_get DOMAIN)/ocpp/HEALTHCHECK)"
if wait_healthy 30; then
  if [ -n "$TAG_OLD" ] && [ "$TAG_OLD" != "$TAG_NEW" ]; then echo "$TAG_OLD" >.deploy/previous_tag; fi
  echo "$TAG_NEW" >.deploy/current_tag
  # Ghi migration của lần này để rollback.sh biết lùi ảnh có an toàn không.
  if [ "${#MIGRATED[@]}" -gt 0 ]; then
    printf '%s\n' "${MIGRATED[@]}" >".deploy/migrated_${TAG_NEW}"
  else
    rm -f ".deploy/migrated_${TAG_NEW}"
  fi
  log "OK: $TAG_NEW đang chạy (migration mới: ${MIGRATED[*]:-không})"
  exit 0
fi

# ---- Hỏng sau khi khởi động ----
trap - ERR
warn "Kiểm sức khoẻ THẤT BẠI (mã công khai gần nhất: ${LAST_PUBLIC_CODE:-?})"
docker compose logs --tail 40 csms || true
if [ "${#MIGRATED[@]}" -gt 0 ]; then
  warn "Lần deploy này đã áp migration (${MIGRATED[*]}): KHÔNG tự lùi ảnh vì ảnh cũ có thể không chạy được với schema mới."
  warn "Sửa lỗi rồi deploy lại, hoặc khôi phục DB: ./rollback.sh --restore-db ${BACKUP:-backups/<file>.dump}"
  exit 1
fi
if [ -n "$TAG_OLD" ] && [ "$TAG_OLD" != "$TAG_NEW" ]; then
  warn "Không có migration mới → lùi ảnh về $TAG_OLD (schema không đổi)"
  set_env TAG "$TAG_OLD"
  docker compose pull csms
  docker compose up -d csms caddy
  if [ "$SIM_ON" = true ]; then docker compose up -d simulator; fi
  if wait_healthy 12; then
    warn "Đã lùi về $TAG_OLD và khoẻ. $TAG_NEW KHÔNG được triển khai."
  else
    warn "Lùi về $TAG_OLD cũng không khoẻ — xem: docker compose logs csms caddy"
  fi
else
  warn "Không có tag cũ để lùi. Xem: docker compose logs csms caddy"
fi
exit 1
