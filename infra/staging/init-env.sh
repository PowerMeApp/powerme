#!/usr/bin/env bash
# Tạo infra/staging/.env cho staging với mật khẩu NGẪU NHIÊN. Chạy MỘT lần trên VPS, trong infra/staging.
#
#   ./init-env.sh <domain> [tag] [--force]
#
#   domain  tên miền đã trỏ về VPS (với Azure: <nhãn>.<vùng>.cloudapp.azure.com, xem AZURE.md)
#   tag     tag ảnh sẽ deploy (mặc định lấy từ .env.example; deploy.sh sẽ tự ghi lại khi chạy)
#   --force ghi đè .env đã có (mất mật khẩu cũ — DB đã tạo bằng mật khẩu cũ sẽ không đăng nhập được!)
#
# Không in mật khẩu ra màn hình: chúng chỉ nằm trong .env (chmod 600). Xem bằng: sudo -u deploy cat .env
set -Eeuo pipefail
cd "$(dirname "$0")"
# shellcheck source=lib.sh
. ./lib.sh

usage() {
  echo "dùng: ./init-env.sh <domain> [tag] [--force]" >&2
  exit 2
}

DOMAIN_NEW=""
TAG_NEW=""
FORCE=false
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
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
[ -n "$DOMAIN_NEW" ] || usage
command -v openssl >/dev/null 2>&1 || die "thiếu openssl (apt-get install -y openssl)"
[ -f .env.example ] || die "không thấy .env.example — chạy trong infra/staging"

if [ -f .env ] && [ "$FORCE" != true ]; then
  die ".env đã tồn tại — không ghi đè (mật khẩu DB đã tạo sẽ lệch). Dùng --force nếu chắc chắn."
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
# Hex: chỉ 0-9a-f, an toàn trong DATABASE_URL. Base64 24 byte: 32 ký tự, không có dấu '=' đệm.
set_env POSTGRES_PASSWORD "$(openssl rand -hex 24)"
set_env DEMO_CHARGE_POINT_PASSWORD "$(openssl rand -base64 24 | tr -d '\n')"

check_env
log ".env đã tạo (chmod 600) cho DOMAIN=$(env_get DOMAIN), TAG=$(env_get TAG)"
log "Mật khẩu Postgres và mật khẩu trụ demo đã sinh ngẫu nhiên, chỉ nằm trong .env — đừng dán lên chat/commit."
log "Bước tiếp: ./deploy.sh $(env_get TAG) --seed"
