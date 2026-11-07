#!/usr/bin/env bash
# Hàm dùng chung cho deploy.sh / rollback.sh / seed.sh. Được `source`, không chạy trực tiếp.
# shellcheck shell=bash

log() { printf '==> %s\n' "$*"; }
warn() { printf '!! %s\n' "$*" >&2; }
die() {
  warn "$*"
  exit 1
}

# env_get KEY — giá trị cuối cùng của KEY trong .env. KHÔNG thực thi .env như mã shell (giá trị
# có ký tự đặc biệt không được phép làm gì cả), chỉ cắt chuỗi. Bỏ \r nếu file có CRLF.
env_get() {
  local line
  line="$(grep -E "^$1=" .env | tail -n 1 || true)"
  line="${line#*=}"
  printf '%s' "${line%$'\r'}"
}

# set_env KEY VALUE — đặt/thêm dòng KEY=VALUE trong .env. Không dùng sed: VALUE là dữ liệu, không
# phải mẫu thay thế (ký tự & / \ | trong giá trị không có nghĩa gì). Ghi file tạm rồi mv.
set_env() {
  local key="$1" val="$2" tmp line found=0
  tmp="$(mktemp ./.env.XXXXXX)"
  chmod 600 "$tmp"
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" == "$key="* ]]; then
      if [ "$found" -eq 0 ]; then
        printf '%s=%s\n' "$key" "$val"
        found=1
      fi
    else
      printf '%s\n' "$line"
    fi
  done <.env >"$tmp"
  if [ "$found" -eq 0 ]; then printf '%s=%s\n' "$key" "$val" >>"$tmp"; fi
  mv "$tmp" .env
}

# Kiểm .env trước khi làm bất cứ điều gì: tồn tại, hết giá trị mẫu, giá trị đúng dạng.
check_env() {
  [ -f .env ] || die ".env chưa có — chạy: cp .env.example .env rồi điền (xem README.md)"
  if grep -Ev '^[[:space:]]*#' .env | grep -Eqi 'change-me|staging\.example\.com'; then
    die ".env còn giá trị mẫu (change-me / staging.example.com) — điền giá trị thật rồi chạy lại"
  fi
  local k v
  for k in DOMAIN REGISTRY TAG POSTGRES_USER POSTGRES_DB POSTGRES_PASSWORD; do
    v="$(env_get "$k")"
    [ -n "$v" ] || die ".env thiếu $k"
  done
  [[ "$(env_get DOMAIN)" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "DOMAIN không phải tên miền hợp lệ"
  [[ "$(env_get REGISTRY)" =~ ^[a-z0-9._/-]+$ ]] || die "REGISTRY chỉ gồm chữ thường, số, . _ / -"
  [[ "$(env_get POSTGRES_USER)" =~ ^[a-z_][a-z0-9_]*$ ]] || die "POSTGRES_USER chỉ gồm a-z 0-9 _"
  [[ "$(env_get POSTGRES_DB)" =~ ^[a-z_][a-z0-9_]*$ ]] || die "POSTGRES_DB chỉ gồm a-z 0-9 _"
  [[ "$(env_get POSTGRES_PASSWORD)" =~ ^[A-Za-z0-9._~-]{16,}$ ]] \
    || die "POSTGRES_PASSWORD phải >= 16 ký tự, chỉ chữ/số và . _ ~ - (sinh: openssl rand -hex 24)"
  v="$(env_get DEMO_PILLAR_PASSWORD)"
  if [ -n "$v" ] && ! [[ "$v" =~ ^[A-Za-z0-9._~:/@+=,-]{16,}$ ]]; then
    die "DEMO_PILLAR_PASSWORD phải >= 16 ký tự, không có khoảng trắng/nháy/\$/# (sinh: openssl rand -base64 24)"
  fi
}

# Dùng khi seed hoặc chạy simulator: mật khẩu trụ demo là bắt buộc, không có mặc định.
require_demo_password() {
  [ -n "$(env_get DEMO_PILLAR_PASSWORD)" ] \
    || die "DEMO_PILLAR_PASSWORD trống trong .env (>= 16 ký tự; sinh: openssl rand -base64 24)"
}

# Chạy tập lệnh Node trong image csms. Mật khẩu đi qua biến môi trường (không lên argv).
run_csms_script() {
  DEMO_PILLAR_PASSWORD="$(env_get DEMO_PILLAR_PASSWORD)" \
    docker compose run --rm -T -e DEMO_PILLAR_PASSWORD csms node "$@"
}

# Simulator đang chạy? (profile sim không hiện trong `ps` thường).
sim_running() {
  [ -n "$(docker compose --profile sim ps --status running -q simulator 2>/dev/null)" ]
}

# Kiểm sức khoẻ TRONG container: console bind loopback/0.0.0.0 trong container, không nối ra ngoài.
health_internal() {
  docker compose exec -T csms node -e \
    "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" \
    >/dev/null 2>&1
}

# Kiểm CÔNG KHAI: yêu cầu nâng cấp WebSocket tới /ocpp/HEALTHCHECK qua TLS + Caddy. Trụ tên đó
# không tồn tại nên CSMS trả 401/403/404 (hoặc 426 nếu không thấy Upgrade) — mã nào trong số đó
# cũng chứng minh TLS, Caddy và handshake chạm tới CSMS. Lỗi kết nối (000), 502, 503 thì không.
# HEALTH_BASE_URL chỉ để kiểm thử script (mặc định https://$DOMAIN).
health_public() {
  local base="${HEALTH_BASE_URL:-https://$(env_get DOMAIN)}" code key
  key="$(head -c 16 /dev/urandom | base64)"
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
    -H "Sec-WebSocket-Key: $key" -H 'Sec-WebSocket-Protocol: ocpp1.6' \
    "$base/ocpp/HEALTHCHECK" 2>/dev/null || true)"
  case "$code" in
    401 | 403 | 404 | 426) return 0 ;;
    *)
      # shellcheck disable=SC2034 # script gọi (deploy/rollback) đọc để báo lỗi
      LAST_PUBLIC_CODE="${code:-000}"
      return 1
      ;;
  esac
}

# wait_healthy TRIES — chờ cả hai kiểm tra đạt; mỗi lần cách 5 s. 0 = đạt.
wait_healthy() {
  local tries="$1" i
  for ((i = 1; i <= tries; i++)); do
    if health_internal && health_public; then return 0; fi
    printf '   (%s/%s) chờ CSMS + Caddy…\n' "$i" "$tries"
    sleep 5
  done
  return 1
}

# Xoá DB rồi tạo lại rỗng (dùng cho khôi phục và --reset). Cần csms đã dừng; FORCE cắt kết nối còn lại.
recreate_db() {
  local user db
  user="$(env_get POSTGRES_USER)"
  db="$(env_get POSTGRES_DB)"
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$user" -d postgres \
    -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" -c "CREATE DATABASE \"$db\" OWNER \"$user\""
}

# confirm "câu hỏi" TỪ-KHOÁ [--yes] — buộc gõ đúng từ khoá trừ khi truyền --yes.
confirm() {
  local prompt="$1" word="$2" ans=""
  if [ "${3:-}" = "--yes" ]; then return 0; fi
  [ -t 0 ] || die "$prompt — cần terminal tương tác (hoặc thêm --yes)"
  printf '%s\nGõ %s để tiếp tục: ' "$prompt" "$word"
  read -r ans
  [ "$ans" = "$word" ] || die "đã huỷ"
}
