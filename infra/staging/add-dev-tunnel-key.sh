#!/usr/bin/env bash
# Thêm khoá SSH công khai của một dev vào user tunnel hạn chế `devtunnel` (BE-27, DEV-ACCESS.md).
#
#   sudo ./add-dev-tunnel-key.sh <file-khoá-công-khai.pub>
#
# CHẠY BẰNG `azureuser` + sudo (user `deploy` không có sudo). Ví dụ:
#   ssh -i ~/.ssh/powerme_staging azureuser@<FQDN>
#   sudo /home/deploy/powerme/infra/staging/add-dev-tunnel-key.sh /tmp/son.pub
#
# Khớp với trạng thái Trí đã tạo tay trên VM: user `devtunnel`, shell /usr/sbin/nologin, home
# /home/devtunnel, ~/.ssh 700 + authorized_keys 600 (owner devtunnel), mỗi khoá một dòng
#   restrict,port-forwarding,permitopen="127.0.0.1:5432",permitopen="127.0.0.1:3000" <khoá>
# `restrict` tắt mọi thứ (pty, agent, X11, forward) rồi `port-forwarding` bật lại riêng `ssh -L`, và
# `permitopen` chỉ cho mở tới đúng hai đích đó (man authorized_keys). Shell nologin: không chạy lệnh.
#
# Idempotent: user/thư mục đã có thì giữ nguyên; khoá đã có (so phần "kiểu + base64", bỏ qua comment
# và option) thì không thêm lần nữa; KHÔNG xoá hay sửa khoá cũ. Thu hồi khoá: xoá dòng đó bằng tay.
# Chỉ nhận khoá công khai (ssh-keygen -l đọc được); không bao giờ nhận/in khoá riêng.
set -Eeuo pipefail

TUNNEL_USER=devtunnel
OPTIONS='restrict,port-forwarding,permitopen="127.0.0.1:5432",permitopen="127.0.0.1:3000"'

die() {
  printf '!! %s\n' "$*" >&2
  exit 1
}
log() { printf '==> %s\n' "$*"; }

[ "$#" -eq 1 ] || die "dùng: sudo ./add-dev-tunnel-key.sh <file-khoá-công-khai.pub>"
[ "$(id -u)" -eq 0 ] || die "cần root: chạy bằng azureuser với sudo"
PUB="$1"
[ -f "$PUB" ] || die "không thấy file $PUB"

# Đúng MỘT dòng khoá công khai (bỏ dòng trống/CR). Dòng có option phía trước thì bỏ option: script
# tự gắn OPTIONS, không nhận option do người gửi khoá tự đặt.
if grep -q 'PRIVATE KEY' "$PUB"; then
  die "đây là KHOÁ RIÊNG — bảo dev xoá nó khỏi nơi đã gửi và chỉ gửi file .pub"
fi
mapfile -t LINES < <(tr -d '\r' <"$PUB" | grep -v '^[[:space:]]*$' || true)
[ "${#LINES[@]}" -eq 1 ] || die "file phải có đúng một dòng khoá công khai (đang có ${#LINES[@]})"
LINE="${LINES[0]}"
KEY=""
read -r -a F <<<"$LINE"
for ((i = 0; i < ${#F[@]} - 1; i++)); do
  case "${F[$i]}" in
    ssh-ed25519 | ssh-rsa | ecdsa-sha2-nistp256 | ecdsa-sha2-nistp384 | ecdsa-sha2-nistp521 | \
      sk-ssh-ed25519@openssh.com | sk-ecdsa-sha2-nistp256@openssh.com)
      KEY="${F[$i]} ${F[$((i + 1))]}"
      COMMENT="${F[*]:$((i + 2))}"
      break
      ;;
  esac
done
[ -n "$KEY" ] || die "không nhận ra kiểu khoá (cần ssh-ed25519 / ecdsa / ssh-rsa)"
[[ "${KEY#* }" =~ ^[A-Za-z0-9+/]+={0,3}$ ]] || die "phần base64 của khoá không hợp lệ"
# ssh-keygen kiểm khoá thật sự giải mã được; in vân tay (không bí mật) để đối chiếu với dev.
FP="$(ssh-keygen -l -f /dev/stdin <<<"$KEY" 2>/dev/null)" || die "ssh-keygen không đọc được khoá"
COMMENT="$(printf '%s' "${COMMENT:-dev}" | tr -cd 'A-Za-z0-9@._ -' | cut -c1-60)"

if id "$TUNNEL_USER" >/dev/null 2>&1; then
  log "user $TUNNEL_USER đã có — giữ nguyên"
else
  useradd --create-home --home-dir "/home/$TUNNEL_USER" --shell /usr/sbin/nologin "$TUNNEL_USER"
  log "đã tạo user $TUNNEL_USER (shell /usr/sbin/nologin)"
fi
passwd -l "$TUNNEL_USER" >/dev/null 2>&1 || true # không mật khẩu: chỉ đăng nhập bằng khoá

HOME_DIR="$(getent passwd "$TUNNEL_USER" | cut -d: -f6)"
SSH_DIR="$HOME_DIR/.ssh"
AK="$SSH_DIR/authorized_keys"
umask 077
[ -d "$SSH_DIR" ] || mkdir -m 700 "$SSH_DIR"
[ -f "$AK" ] || : >"$AK"
chown "$TUNNEL_USER:$TUNNEL_USER" "$SSH_DIR"
chmod 700 "$SSH_DIR"

# Khoá đã có? So "kiểu base64" ở bất kỳ vị trí nào trong dòng (dòng cũ có option phía trước).
if awk -v k="$KEY" '{ for (i = 1; i < NF; i++) if ($i " " $(i + 1) == k) f = 1 } END { exit !f }' "$AK"; then
  log "khoá đã có trong $AK — không thêm ($FP)"
else
  printf '%s %s %s\n' "$OPTIONS" "$KEY" "$COMMENT" >>"$AK"
  log "đã thêm khoá ($FP)"
fi
chown "$TUNNEL_USER:$TUNNEL_USER" "$AK"
chmod 600 "$AK"
chmod 700 "$SSH_DIR"

# Dòng nào trong file thiếu permitopen là cảnh báo (có thể ai đó dán tay khoá không hạn chế).
if grep -v '^[[:space:]]*\(#\|$\)' "$AK" | grep -qv 'permitopen='; then
  printf '!! CẢNH BÁO: %s có dòng KHÔNG có permitopen — kiểm tay (sudo cat %s)\n' "$AK" "$AK" >&2
fi
log "$TUNNEL_USER hiện có $(grep -c '^restrict,' "$AK") khoá hạn chế. Dev nối bằng:"
log "  ssh -N -L 5433:127.0.0.1:5432 -L 3000:127.0.0.1:3000 $TUNNEL_USER@<FQDN>"
