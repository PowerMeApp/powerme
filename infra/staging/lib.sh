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
  v="$(demo_cp_password)"
  if [ -n "$v" ] && ! [[ "$v" =~ ^[A-Za-z0-9._~:/@+=,-]{16,}$ ]]; then
    die "DEMO_CHARGE_POINT_PASSWORD phải >= 16 ký tự, không có khoảng trắng/nháy/\$/# (sinh: openssl rand -base64 24)"
  fi
  v="$(env_get DEMO_DRIVER_PASSWORD)"
  if [ -n "$v" ] && ! [[ "$v" =~ ^[A-Za-z0-9._~:/@+=,-]{12,128}$ ]]; then
    die "DEMO_DRIVER_PASSWORD phải 12..128 ký tự, không có khoảng trắng/nháy/\$/# (sinh: openssl rand -hex 8)"
  fi
  v="$(env_get DEMO_STAFF_PASSWORD)"
  if [ -n "$v" ] && ! [[ "$v" =~ ^[A-Za-z0-9._~:/@+=,-]{12,128}$ ]]; then
    die "DEMO_STAFF_PASSWORD phải 12..128 ký tự, không có khoảng trắng/nháy/\$/# (sinh: openssl rand -hex 8)"
  fi
  check_driver_api_env
  check_dashboard_env
}

# check_jwt_trio PREFIX "hậu quả khi trống" — luật chung của <PREFIX>_SECRET_BASE64, _ISSUER, _AUDIENCE,
# giống loadDriverApiConfig (driver/driver-auth.ts) và loadDashboardAuthConfig (users/auth.ts).
# CẢNH BÁO chứ không dừng khi cả ba đều trống: CI deploy bằng `.env` đang có trên VPS, `.env` cũ chưa
# có các biến này, và CSMS vẫn khởi động bình thường (chỉ route tương ứng trả 503 auth_unavailable).
# DỪNG khi đặt thiếu hoặc sai dạng: hàm load* sẽ ném lỗi lúc khởi động, nên chặn ở đây — trước sao lưu
# và migrate — thay vì để deploy hỏng ở bước kiểm sức khoẻ. Không bao giờ in khoá.
check_jwt_trio() {
  local p="$1" off="$2" secret issuer audience canon bytes
  secret="$(env_get "${p}_SECRET_BASE64")"
  issuer="$(env_get "${p}_ISSUER")"
  audience="$(env_get "${p}_AUDIENCE")"
  if [ -z "$secret$issuer$audience" ]; then
    warn "$off (${p}_* trống)."
    warn "   Bổ sung mà không đổi mật khẩu cũ: ./init-env.sh --add-missing, rồi deploy lại."
    return 0
  fi
  [ -n "$secret" ] && [ -n "$issuer" ] && [ -n "$audience" ] \
    || die "${p}_SECRET_BASE64, _ISSUER, _AUDIENCE phải đặt đủ cả ba hoặc để trống cả ba"
  # Base64 chuẩn (giải mã rồi mã hoá lại ra đúng chuỗi cũ), >= 32 byte.
  canon=""
  bytes=0
  if [[ "$secret" =~ ^[A-Za-z0-9+/]+={0,2}$ ]]; then
    canon="$(printf '%s' "$secret" | base64 -d 2>/dev/null | base64 -w 0 2>/dev/null || true)"
    bytes="$(printf '%s' "$secret" | base64 -d 2>/dev/null | wc -c || true)"
  fi
  [ "$canon" = "$secret" ] && [ "${bytes// /}" -ge 32 ] \
    || die "${p}_SECRET_BASE64 phải là base64 chuẩn của >= 32 byte (sinh: openssl rand -base64 32)"
  [[ "$issuer" =~ ^[A-Za-z0-9._:/-]{1,100}$ ]] || die "${p}_ISSUER chỉ gồm chữ/số và . _ : / -"
  [[ "$audience" =~ ^[A-Za-z0-9._:/-]{1,100}$ ]] || die "${p}_AUDIENCE chỉ gồm chữ/số và . _ : / -"
}

# Driver API (BE-27): ba biến JWT theo check_jwt_trio, cộng TTL refresh token.
check_driver_api_env() {
  local ttl
  check_jwt_trio DRIVER_API_JWT "Driver API chưa cấu hình: app tài xế sẽ nhận 503 auth_unavailable"
  ttl="$(env_get DRIVER_API_REFRESH_TTL_S)"
  if [ -n "$ttl" ]; then
    [[ "$ttl" =~ ^[1-9][0-9]{0,8}$ ]] && [ "$ttl" -ge 3600 ] && [ "$ttl" -le 7776000 ] \
      || die "DRIVER_API_REFRESH_TTL_S phải là số nguyên 3600..7776000 (hoặc để trống = 30 ngày)"
  fi
}

# Dashboard (T128, FE-01a, ADR-0018): cùng chính sách ba-biến với Driver API — trống cả ba chỉ cảnh báo
# (.env tạo trước T128 vẫn deploy được, /api/auth/v1/login trả 503), thiếu một/sai dạng thì dừng. Khoá
# trùng khoá Driver API cũng dừng: ADR-0018 đòi khoá riêng (lộ một khoá không được mở cả hai bề mặt).
check_dashboard_env() {
  local dash
  check_jwt_trio DASHBOARD_JWT "Dashboard chưa cấu hình: đăng nhập dashboard sẽ nhận 503 auth_unavailable"
  dash="$(env_get DASHBOARD_JWT_SECRET_BASE64)"
  if [ -n "$dash" ] && [ "$dash" = "$(env_get DRIVER_API_JWT_SECRET_BASE64)" ]; then
    die "DASHBOARD_JWT_SECRET_BASE64 phải KHÁC DRIVER_API_JWT_SECRET_BASE64 (ADR-0018; sinh: openssl rand -base64 32)"
  fi
}

# Mật khẩu trụ demo trong .env; tên cũ DEMO_PILLAR_PASSWORD (trước T92) vẫn được đọc khi tên mới trống.
demo_cp_password() {
  local v
  v="$(env_get DEMO_CHARGE_POINT_PASSWORD)"
  [ -n "$v" ] || v="$(env_get DEMO_PILLAR_PASSWORD)"
  printf '%s' "$v"
}

# Dùng khi seed hoặc chạy simulator: mật khẩu trụ demo là bắt buộc, không có mặc định.
require_demo_password() {
  [ -n "$(demo_cp_password)" ] \
    || die "DEMO_CHARGE_POINT_PASSWORD trống trong .env (>= 16 ký tự; sinh: openssl rand -base64 24)"
}

# Chạy tập lệnh Node trong image csms. Mật khẩu đi qua biến môi trường (không lên argv).
#
# DEMO_DRIVER_PASSWORD (BE-27) và DEMO_STAFF_PASSWORD (T128) chỉ đi vào container chạy một lần này,
# không vào csms đang chạy.
run_csms_script() {
  DEMO_CHARGE_POINT_PASSWORD="$(demo_cp_password)" DEMO_DRIVER_PASSWORD="$(env_get DEMO_DRIVER_PASSWORD)" \
    DEMO_STAFF_PASSWORD="$(env_get DEMO_STAFF_PASSWORD)" \
    docker compose run --rm -T -e DEMO_CHARGE_POINT_PASSWORD -e DEMO_DRIVER_PASSWORD \
    -e DEMO_STAFF_PASSWORD csms node "$@"
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
