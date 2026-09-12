#!/usr/bin/env sh
#
# Trỏ git sang thư mục hook của dự án. Chạy một lần trên mỗi máy.
# npm install tự gọi script này qua "prepare", nên thường không cần chạy tay.

if [ ! -d .git ] && ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "⚠️  Không phải kho git — bỏ qua cài hook."
  exit 0
fi

git config core.hooksPath .githooks || exit 0
echo "✓ Đã bật hook của dự án (core.hooksPath = .githooks)"
echo "  pre-push sẽ chặn push thẳng vào main."
