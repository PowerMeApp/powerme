#!/usr/bin/env bash
# Tạo / cập nhật role Postgres riêng cho dev (`app_dev`) trên staging (BE-27, DEV-ACCESS.md).
#
#   ./create-dev-db-role.sh            tạo role nếu chưa có, cấp lại quyền (chạy lại được)
#   ./create-dev-db-role.sh --rotate   sinh mật khẩu MỚI (mật khẩu cũ hết hiệu lực ngay)
#   ./create-dev-db-role.sh --read-only [--rotate]
#                                      T153: role `app_ro` CHỈ SELECT (mật khẩu ~/.powerme-app-ro-db-password),
#                                      cho người chỉ cần xem dữ liệu staging (vd. Sơn kiểm phiên/quyết toán).
#                                      Thêm default_transaction_read_only = on: lỡ có quyền ghi vẫn bị chặn.
#
# Chạy bằng user `deploy` (nhóm docker, không cần sudo), trong infra/staging, khi Postgres đang chạy.
#
# Quyền của app_dev: LOGIN, đọc/ghi (SELECT/INSERT/UPDATE/DELETE) mọi bảng của schema public và
# dùng sequence; KHÔNG superuser, không tạo DB/role, không replication, không bypass RLS, không
# TRUNCATE, không DDL (không sở hữu bảng nào), chỉ ĐỌC bảng _migrations. Tối đa 5 kết nối.
# Bảng do migration sau này tạo cũng tự có quyền (ALTER DEFAULT PRIVILEGES cho POSTGRES_USER).
#
# Mật khẩu: 48 ký tự hex ngẫu nhiên, lưu ở ~/.powerme-app-dev-db-password (chmod 600, NGOÀI thư mục
# repo để không lỡ commit), không in ra màn hình, không lên argv (đi qua stdin của psql).
# Trao cho dev qua kênh riêng: sudo -u deploy cat ~deploy/.powerme-app-dev-db-password
set -Eeuo pipefail
cd "$(dirname "$0")"
# shellcheck source=lib.sh
. ./lib.sh

ROTATE=false
READ_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --rotate) ROTATE=true ;;
    --read-only) READ_ONLY=true ;;
    *)
      echo "dùng: ./create-dev-db-role.sh [--read-only] [--rotate]" >&2
      exit 2
      ;;
  esac
done

if [ "$READ_ONLY" = true ]; then
  ROLE=app_ro
  PW_FILE="${APP_RO_PASSWORD_FILE:-$HOME/.powerme-app-ro-db-password}"
  TABLE_PRIVS="SELECT"
  SEQ_PRIVS="SELECT"
  READ_ONLY_TX=on
else
  ROLE=app_dev
  PW_FILE="${APP_DEV_PASSWORD_FILE:-$HOME/.powerme-app-dev-db-password}"
  TABLE_PRIVS="SELECT, INSERT, UPDATE, DELETE"
  SEQ_PRIVS="USAGE, SELECT"
  READ_ONLY_TX=off
fi

check_env
command -v openssl >/dev/null 2>&1 || die "thiếu openssl"
[ -n "$(docker compose ps --status running -q postgres)" ] || die "Postgres chưa chạy (docker compose up -d --wait postgres)"

umask 077
if [ "$ROTATE" = true ] || [ ! -s "$PW_FILE" ]; then
  openssl rand -hex 24 >"$PW_FILE.tmp"
  mv "$PW_FILE.tmp" "$PW_FILE"
  log "Đã sinh mật khẩu mới cho $ROLE → $PW_FILE (chmod 600, không in ra)"
fi
chmod 600 "$PW_FILE"
PW="$(tr -d '\r\n' <"$PW_FILE")"
[[ "$PW" =~ ^[0-9a-f]{48}$ ]] || die "$PW_FILE không đúng dạng (48 hex) — xoá file rồi chạy lại để sinh mới"

OWNER="$(env_get POSTGRES_USER)"
DB="$(env_get POSTGRES_DB)"
# SQL đi qua stdin; mật khẩu là biến psql (:'pw' tự đặt nháy) nên không có trên argv của tiến trình nào.
docker compose exec -T postgres psql -X -q -v ON_ERROR_STOP=1 -U "$OWNER" -d "$DB" <<SQL
\\set pw '$PW'
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$ROLE') AS need_create \\gset
\\if :need_create
CREATE ROLE $ROLE LOGIN PASSWORD :'pw';
\\else
ALTER ROLE $ROLE LOGIN PASSWORD :'pw';
\\endif
ALTER ROLE $ROLE NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 5;
-- Câu lệnh chạy quá 60 s bị cắt: dev lỡ tay quét bảng lớn không làm CSMS chậm.
ALTER ROLE $ROLE SET statement_timeout = '60s';
ALTER ROLE $ROLE SET idle_in_transaction_session_timeout = '5min';
-- T153: app_ro mở mọi giao dịch ở chế độ chỉ đọc (lớp chặn thứ hai ngoài GRANT).
ALTER ROLE $ROLE SET default_transaction_read_only = $READ_ONLY_TX;
REVOKE ALL ON DATABASE "$DB" FROM $ROLE;
GRANT CONNECT ON DATABASE "$DB" TO $ROLE;
REVOKE CREATE ON SCHEMA public FROM $ROLE;
GRANT USAGE ON SCHEMA public TO $ROLE;
GRANT $TABLE_PRIVS ON ALL TABLES IN SCHEMA public TO $ROLE;
GRANT $SEQ_PRIVS ON ALL SEQUENCES IN SCHEMA public TO $ROLE;
ALTER DEFAULT PRIVILEGES FOR ROLE "$OWNER" IN SCHEMA public
  GRANT $TABLE_PRIVS ON TABLES TO $ROLE;
ALTER DEFAULT PRIVILEGES FOR ROLE "$OWNER" IN SCHEMA public
  GRANT $SEQ_PRIVS ON SEQUENCES TO $ROLE;
-- Sổ migration: chỉ đọc (sửa nó làm migrate.mjs bỏ qua hoặc áp lại file).
DO \$\$ BEGIN
  IF to_regclass('public._migrations') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE ON public._migrations FROM $ROLE;
  END IF;
END \$\$;
SQL
unset PW

log "Role $ROLE sẵn sàng trên DB $DB (không superuser, không DDL; bảng: $TABLE_PRIVS)."
log "Dev nối qua SSH tunnel (DEV-ACCESS.md): postgres://$ROLE:<mật khẩu nhận riêng>@127.0.0.1:5433/$DB"
log "Mật khẩu ở $PW_FILE — gửi riêng (tin nhắn trực tiếp), không dán chat nhóm/commit."
