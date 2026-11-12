#!/usr/bin/env bash
# Tạo infra/staging/.env cho staging với mật khẩu NGẪU NHIÊN. Chạy trên VPS, trong infra/staging.
#
#   ./init-env.sh <domain> [tag] [--force]   tạo .env mới (một lần)
#   ./init-env.sh --add-missing              .env đã có: chỉ THÊM biến còn trống/thiếu (BE-27)
#
#   domain  tên miền đã trỏ về VPS (với Azure: <nhãn>.<vùng>.cloudapp.azure.com, xem AZURE.md)
#   tag     tag ảnh sẽ deploy (mặc định lấy từ .env.example; deploy.sh sẽ tự ghi lại khi chạy)
#   --force ghi đè .env đã có (mất mật khẩu cũ — DB đã tạo bằng mật khẩu cũ sẽ không đăng nhập được!)
#   --add-missing  sinh những biến chưa có giá trị: khoá JWT + issuer + audience của Driver API,
#           DEMO_DRIVER_PASSWORD, DEMO_CHARGE_POINT_PASSWORD (khi cả tên mới lẫn tên cũ đều trống).
#           KHÔNG đụng biến đã có giá trị (POSTGRES_PASSWORD, mật khẩu trụ, TAG…) và không bao giờ
#           sinh POSTGRES_PASSWORD (DB đã tạo bằng mật khẩu cũ). Chạy lại nhiều lần không đổi gì.
#
# Không in mật khẩu ra màn hình: chúng chỉ nằm trong .env (chmod 600). Xem bằng: sudo -u deploy cat .env
set -Eeuo pipefail
cd "$(dirname "$0")"
# shellcheck source=lib.sh
. ./lib.sh

usage() {
  echo "dùng: ./init-env.sh <domain> [tag] [--force]  |  ./init-env.sh --add-missing" >&2
  exit 2
}

# Giá trị không bí mật của Driver API (BE-27). Đổi issuer/audience = token app đang giữ hết hiệu lực.
DRIVER_ISSUER_DEFAULT=powerme-staging
DRIVER_AUDIENCE_DEFAULT=powerme-driver-app

DOMAIN_NEW=""
TAG_NEW=""
FORCE=false
ADD_MISSING=false
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
    --add-missing) ADD_MISSING=true ;;
    -*) usage ;;
    *)
      if [ -z "$DOMAIN_NEW" ]; then
        DOMAIN_NEW="$arg"
      elif [ -z "$TAG_NEW" ]; then
        TAG_NEW="$arg"
      else
        usage
      fi
      ;;
  esac
done
command -v openssl >/dev/null 2>&1 || die "thiếu openssl (apt-get install -y openssl)"

# Khoá HS256: base64 chuẩn của 32 byte ngẫu nhiên (44 ký tự, một dấu '=' đệm) — đúng luật driver-auth.ts.
gen_jwt_secret() { openssl rand -base64 32 | tr -d '\n'; }
gen_driver_issuer() { printf '%s' "$DRIVER_ISSUER_DEFAULT"; }
gen_driver_audience() { printf '%s' "$DRIVER_AUDIENCE_DEFAULT"; }
# Mật khẩu tài xế mẫu: 16 ký tự hex — đủ dài (>= 12), gõ được trên điện thoại.
gen_driver_password() { openssl rand -hex 8; }
# Base64 24 byte: 32 ký tự, không có dấu '=' đệm.
gen_cp_password() { openssl rand -base64 24 | tr -d '\n'; }

# add_if_empty KEY hàm-sinh — chỉ ghi khi KEY trống hoặc chưa có dòng; nhớ TÊN biến, không in giá trị.
ADDED=()
add_if_empty() {
  local key="$1" gen="$2" val
  if [ -z "$(env_get "$key")" ]; then
    val="$("$gen")"
    set_env "$key" "$val"
    ADDED+=("$key")
  fi
}

if [ "$ADD_MISSING" = true ]; then
  if [ -n "$DOMAIN_NEW" ] || [ "$FORCE" = true ]; then usage; fi
  [ -f .env ] || die ".env chưa có — tạo mới bằng: ./init-env.sh <domain> [tag]"
  umask 077
  chmod 600 .env
  # Thiếu một phần (vd đã có issuer nhưng chưa có khoá) cũng chỉ bổ sung phần thiếu; check_env bên
  # dưới kiểm dạng của giá trị cũ.
  add_if_empty DRIVER_API_JWT_SECRET_BASE64 gen_jwt_secret
  add_if_empty DRIVER_API_JWT_ISSUER gen_driver_issuer
  add_if_empty DRIVER_API_JWT_AUDIENCE gen_driver_audience
  add_if_empty DEMO_DRIVER_PASSWORD gen_driver_password
  if [ -z "$(demo_cp_password)" ]; then add_if_empty DEMO_CHARGE_POINT_PASSWORD gen_cp_password; fi
  check_env
  if [ "${#ADDED[@]}" -eq 0 ]; then
    log ".env đã đủ biến — không đổi gì"
  else
    log "Đã thêm vào .env (giá trị không in ra): ${ADDED[*]}"
    log "Bước tiếp: ./deploy.sh $(env_get TAG) --seed   (csms nhận biến mới + nạp dữ liệu mẫu cho app)"
  fi
  exit 0
fi

[ -n "$DOMAIN_NEW" ] || usage
[ -f .env.example ] || die "không thấy .env.example — chạy trong infra/staging"

if [ -f .env ] && [ "$FORCE" != true ]; then
  die ".env đã tồn tại — không ghi đè (mật khẩu DB đã tạo sẽ lệch). Chỉ thêm biến mới: --add-missing. Ghi đè: --force."
fi

umask 077
cp .env.example .env
chmod 600 .env
# Lỗi giữa chừng (tên miền sai, thiếu openssl...) thì xoá .env dở dang, kẻo lần chạy sau bị từ chối ghi đè.
trap 'rc=$?; if [ "$rc" -ne 0 ]; then rm -f .env; warn ".env chưa hoàn tất — đã xoá, chạy lại được"; fi' EXIT

set_env DOMAIN "$DOMAIN_NEW"
if [ -n "$TAG_NEW" ]; then
  [[ "$TAG_NEW" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || die "tag không hợp lệ: '$TAG_NEW'"
  set_env TAG "$TAG_NEW"
fi
# Hex: chỉ 0-9a-f, an toàn trong DATABASE_URL.
set_env POSTGRES_PASSWORD "$(openssl rand -hex 24)"
set_env DEMO_CHARGE_POINT_PASSWORD "$(gen_cp_password)"
set_env DRIVER_API_JWT_SECRET_BASE64 "$(gen_jwt_secret)"
set_env DRIVER_API_JWT_ISSUER "$DRIVER_ISSUER_DEFAULT"
set_env DRIVER_API_JWT_AUDIENCE "$DRIVER_AUDIENCE_DEFAULT"
set_env DEMO_DRIVER_PASSWORD "$(gen_driver_password)"

check_env
log ".env đã tạo (chmod 600) cho DOMAIN=$(env_get DOMAIN), TAG=$(env_get TAG)"
log "Mật khẩu Postgres, mật khẩu trụ demo, khoá JWT Driver API và mật khẩu tài xế mẫu đã sinh ngẫu nhiên,"
log "chỉ nằm trong .env — đừng dán lên chat/commit."
log "Bước tiếp: ./deploy.sh $(env_get TAG) --seed"
