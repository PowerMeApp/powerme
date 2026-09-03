#!/usr/bin/env bash
#
# Thiết lập phần "GitHub" của kho mã: nhãn, cột mốc M1–M6, bảo vệ nhánh main.
# Chạy MỘT LẦN sau khi repo đã tồn tại trên GitHub và đã push nhánh main.
#
#   gh auth login
#   bash scripts/setup-github.sh
#
# Script chạy được nhiều lần (idempotent) — nhãn/cột mốc đã có thì bỏ qua.

set -uo pipefail

if ! command -v gh >/dev/null 2>&1; then
  echo "❌ Chưa có GitHub CLI. Cài bằng:  winget install --id GitHub.cli"
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "❌ Chưa đăng nhập. Chạy:  gh auth login"
  exit 1
fi

REPO="${1:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)}"
if [ -z "$REPO" ]; then
  echo "❌ Không xác định được repo. Truyền vào:  bash scripts/setup-github.sh OWNER/REPO"
  exit 1
fi
echo "▶ Repo: $REPO"
echo

# ---------------------------------------------------------------------------
# 1. Nhãn
# ---------------------------------------------------------------------------
echo "▶ Tạo nhãn..."

label() {  # $1=tên  $2=màu  $3=mô tả
  gh label create "$1" --repo "$REPO" --color "$2" --description "$3" --force >/dev/null 2>&1 \
    && echo "  ✓ $1" || echo "  ⚠ bỏ qua $1"
}

# Work package — ai sở hữu
label "wp1:pm"          "5319E7" "WP1 — Project Manager / BA"
label "wp2:backend"     "0E8A16" "WP2 — Backend / IoT — CSMS OCPP"
label "wp3:mobile"      "1D76DB" "WP3 — Mobile Developer"
label "wp4:fullstack"   "D93F0B" "WP4 — Full-stack — Dashboard"
label "wp5:qa"          "FBCA04" "WP5 — Backend / QA — Simulator, tính tiền, nghiên cứu"

# Loại việc
label "task"            "C2E0C6" "Task có mã trong bảng phân rã công việc"
label "bug"             "D73A4A" "Có gì đó chạy sai"
label "research"        "BFD4F2" "Câu hỏi nghiên cứu hoặc rủi ro cần làm rõ"
label "docs"            "CFD3D7" "Tài liệu: SRS, SDD, ADR, báo cáo"
label "chore"           "EDEDED" "Cấu hình, phụ thuộc, hạ tầng"

# Vùng mã
label "area:ocpp"       "006B75" "Giao thức OCPP 1.6J"
label "area:csms"       "006B75" "apps/csms"
label "area:dashboard"  "006B75" "apps/dashboard"
label "area:mobile"     "006B75" "apps/mobile"
label "area:simulator"  "006B75" "simulator"
label "area:infra"      "006B75" "infra, CI, docker"
label "area:billing"    "006B75" "Tính tiền, thanh toán, hoá đơn"

# Mức ưu tiên và trạng thái
label "p0:chan-moc"     "B60205" "Chặn một cột mốc — xử lý trước mọi thứ khác"
label "p1:quan-trong"   "D93F0B" "Quan trọng, có đường vòng tạm thời"
label "p2:binh-thuong"  "FEF2C0" "Bình thường"
label "blocked"         "000000" "Đang bị chặn — ghi rõ chặn bởi cái gì"
label "needs-review"    "0052CC" "Chờ người khác review"

# Phạm vi
label "ngoai-pham-vi"   "EEEEEE" "Nằm ngoài phạm vi bản 13 tuần — xem mục 8 của kế hoạch"

echo

# ---------------------------------------------------------------------------
# 2. Cột mốc M1–M6
# ---------------------------------------------------------------------------
echo "▶ Tạo cột mốc..."

milestone() {  # $1=tiêu đề  $2=hạn ISO  $3=mô tả
  if gh api "repos/$REPO/milestones" -q '.[].title' 2>/dev/null | grep -Fxq "$1"; then
    echo "  ⚠ đã có: $1"
    return
  fi
  gh api "repos/$REPO/milestones" -X POST \
    -f title="$1" -f due_on="$2" -f description="$3" >/dev/null 2>&1 \
    && echo "  ✓ $1" || echo "  ✗ lỗi khi tạo $1"
}

milestone "M1 — Đặc tả chốt, simulator chạy" "2026-09-06T17:00:00Z" \
  "CỔNG CỨNG. SRS rút gọn, SDD + OpenAPI, wireframe, SAP simulator chạy template D1/YJ-EU hai súng, đã đọc LICENSE của SteVe, đã gọi hỏi VNPay, GVHD duyệt bằng văn bản."

milestone "M2 — OCPP Core chạy thông" "2026-10-04T17:00:00Z" \
  "CỔNG KỸ THUẬT. Trọn bộ Core Profile hai chiều, lệnh xuống trụ, state machine dual gun, MeterValues DC, simulator đã patch, xong khảo sát tài liệu học thuật."

milestone "M3 — Demo xuyên suốt một phiên sạc" "2026-10-18T17:00:00Z" \
  "E2E trên staging: mở app, tìm trụ, quét QR, bắt đầu sạc, xem số liệu chạy, dừng, ra chi phí. Trình xem bản tin OCPP thô hoạt động."

milestone "M4 — Tính tiền và vận hành thông" "2026-11-01T17:00:00Z" \
  "Tính tiền bốn khung giờ, đối chiếu Settlement của trụ, VNPay sandbox, XML hoá đơn theo NĐ 123/2020 và TT 78/2021, trung tâm cảnh báo."

milestone "M5 — Đối soát và nghiên cứu xong" "2026-11-15T17:00:00Z" \
  "ĐÓNG BĂNG TÍNH NĂNG. Engine đối soát chạy, thí nghiệm ablation đủ ma trận tối thiểu 30 phiên/kịch bản, load test k6, tự chấm 76 ca TC_*_CSMS."

milestone "M6 — Bảo vệ" "2026-11-22T17:00:00Z" \
  "Báo cáo đầy đủ, môi trường demo có phương án dự phòng, slide xong, đã tập hai lượt đủ 5 người."

echo

# ---------------------------------------------------------------------------
# 3. Bảo vệ nhánh main
# ---------------------------------------------------------------------------
echo "▶ Bật bảo vệ nhánh main..."
echo "  (Repo private trên GitHub Free KHÔNG hỗ trợ branch protection —"
echo "   nếu bước này lỗi thì để repo public, hoặc dùng GitHub Team/Education.)"

if gh api "repos/$REPO/branches/main/protection" -X PUT \
  -H "Accept: application/vnd.github+json" \
  --input - >/dev/null 2>&1 <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["Lint · Typecheck · Test · Build"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
then
  echo "  ✓ main đã được bảo vệ: cần 1 approve, cần CI xanh, cấm force push"
else
  echo "  ✗ Không bật được. Bật tay ở: Settings → Branches → Add rule"
fi

echo
echo "▶ Chỉ cho phép squash merge..."
gh api "repos/$REPO" -X PATCH \
  -F allow_squash_merge=true \
  -F allow_merge_commit=false \
  -F allow_rebase_merge=false \
  -F delete_branch_on_merge=true \
  -F squash_merge_commit_title=PR_TITLE \
  -F squash_merge_commit_message=PR_BODY >/dev/null 2>&1 \
  && echo "  ✓ Squash merge, tự xoá nhánh sau khi gộp" \
  || echo "  ⚠ Không đặt được — chỉnh tay ở Settings → General → Pull Requests"

echo
echo "✅ Xong. Việc còn phải làm tay:"
echo "   1. Sửa .github/CODEOWNERS — thay placeholder bằng GitHub username thật"
echo "   2. Mời 4 thành viên còn lại vào repo (Settings → Collaborators)"
echo "   3. Tạo GitHub Project (bảng Kanban) và bật auto-add issue của repo"
echo "   4. Settings → Code security → bật Secret scanning + Push protection"
