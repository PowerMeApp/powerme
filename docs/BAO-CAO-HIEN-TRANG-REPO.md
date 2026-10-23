# Báo cáo hiện trạng repo — T63

**Ngày:** 23/10/2026 · **Lập:** Ngô Văn Minh Trí (WP2, Team Leader) · **Cho:** Ân (WP1) viết Report 4, và cả nhóm trước Review 2 (26/10)
**Repo:** `github.com/PowerMeApp/powerme` · `main` tại `59abc4a` (16/09/2026)
**Mở khoá:** T11, T18, T19, T30 và mọi việc phụ thuộc T63.

---

## 1. Năm điều quan trọng nhất

1. **`main` không đổi từ 16/09.** Trên `main`, `apps/csms` chỉ có `package.json` + `README.md`. Toàn bộ công việc WP2 (tài liệu kiến trúc, 12 ADR, bàn thí nghiệm, lớp điều khiển, hai thí nghiệm) nằm ở **5 nhánh chưa merge** (mục 3).
2. **Nguyên nhân gốc — phát hiện hôm nay:** 4/5 thành viên chỉ có quyền **đọc** repo; 5 team `wp1…wp5` mà CODEOWNERS trỏ tới chỉ có một thành viên là Trí. Không ai ngoài Trí mở được nhánh, approve có hiệu lực hay merge. Đã sửa cho Ân (mục 2); ba người còn lại chờ một lệnh.
3. **CI hoạt động.** Ba workflow chạy trên mọi PR; xanh ở #7, #8, #11, #12. #9 đỏ vì định dạng — đã sửa trong #11 (mục 7).
4. **Iteration 1 chưa đạt định nghĩa trong kế hoạch** (khung NestJS, TLS, gateway sản phẩm). Đạt phần *dụng cụ đo*: mini-CSMS trên `ocpp-rpc`, lớp điều khiển 12 lệnh, EXP-01 (ngắt 81 s) và EXP-02 (đặt chỗ) có log thật (mục 4).
5. **Để T50 ("Iteration 1 chạy được, CI xanh, tài liệu đã có trong repo") có nghĩa trước 26/10:** merge chuỗi #7 → #8 → #12 và #9 → #11 trong 48 giờ. Cần quyết ở mục 8.

---

## 2. Quyền truy cập

| Thành viên | GitHub | Trước 23/10 | Sau 23/10 |
|---|---|---|---|
| Trí (WP2) | `ngovanminhtri05` | admin | admin |
| Ân (WP1) | `TDuckAn` | **chỉ đọc**, không thuộc team | **write**, thành viên `wp1` ✅ |
| Sơn (WP3) | `Son2110` | **chỉ đọc**, không thuộc team | *chờ Trí quyết* |
| Khang (WP5) | `KhangLe7405` | **chỉ đọc**, không thuộc team | *chờ Trí quyết* |
| Nghĩa (WP4) | `ggbb0711` *(suy ra, cần xác nhận)* | **chỉ đọc**, không thuộc team | *chờ Trí quyết* |

Team `wp1…wp5` đều đã có quyền `push` trên repo — chỉ thiếu thành viên. Cách sửa đúng là **thêm người vào team** (một lệnh mỗi người), không cấp collaborator lẻ.

Hệ quả cho Report: mọi ghi chép "review trong 24 giờ" ở CONTRIBUTING §4 **chưa bao giờ khả thi** cho tới hôm nay. Ghi đúng như vậy, đừng ghi là nhóm bỏ qua quy trình.

---

## 3. Nhánh và PR

| PR | Nhánh | Nội dung | Base | CI | Mở từ |
|---|---|---|---|---|---|
| #7 | `wp2/be-01-nhan-flutter-va-mo-ta-task` | Nhãn React Native → Flutter; mô tả BE-02/BE-08; ignore `HANDOFF.md` | `main` | ✅ | 16/09 |
| #8 | `wp2/be-01-tai-lieu-kien-truc-va-tong-quan` | Tài liệu kiến trúc WP2 (11 ADR), phân tích WP1, tổng quan dự án (PDF) | `main` | ✅ | 16/09 |
| #12 | `wp2/be-01-tach-adr-rieng` | 11 ADR tách thành file riêng trong `docs/adr/`, trạng thái cập nhật | **#8** | ✅ | 23/10 |
| #9 | `wp2/be-02-ban-thi-nghiem-ocpp` | Mini-CSMS, EXP-01, cấu hình SAP simulator, `ocpp-rpc@2.2.1` | `main` | ❌ format | 16/09 |
| #11 | `wp2/be-02-csms-ctl-tuong-tac` | Lớp điều khiển (`csms-ctl`), trụ giả, `trace.mjs` với `epoch`, EXP-02 đặt chỗ; sửa format của #9; CI cho PR xếp tầng | **#9** | ✅ | 08/10 |
| #1 #2 #3 #10 | Dependabot | Nâng actions / prettier | `main` | ❌ tiêu đề | 11/09 |

Thứ tự merge bắt buộc (vì xếp tầng): **#7**, rồi **#8 → #12**, rồi **#9 → #11**. Merge #11 vào #9 trước thì #9 tự xanh.

Dependabot đỏ chỉ vì kiểm tra tiêu đề (scope `ci` không trong danh sách, "Bump" viết hoa). Sửa tận gốc: thêm điều kiện bỏ qua actor `dependabot[bot]` vào job kiểm tiêu đề — 1 dòng, task PM-01.

---

## 4. Iteration 1 — kế hoạch vs thực tế

Theo `docs/KE-HOACH-POWERME.md` (S1–S3):

| Mã | Kế hoạch | Thực tế 23/10 | Ở đâu |
|---|---|---|---|
| BE-01 | Khung backend, CI, docker compose, WSS/TLS staging | CI ✅ · compose ✅ (chưa chạy được trên máy Trí — không có Docker) · **khung NestJS ❌** · **TLS/Caddy ❌** | `main`, `infra/` |
| BE-02 | Gateway OCPP-J, định danh theo SN, tuần tự hoá, đóng phiên cũ | **Dạng lab, chưa phải sản phẩm**: `ocpp-rpc` ghim 2.2.1; connection registry + epoch + đóng phiên cũ có trong `csms-ctl.mjs`; chưa có NestJS | #9, #11 |
| BE-03 | 7 bản tin chiều lên | Trả lời tối thiểu hợp schema (strictMode) — đủ để trụ chạy phiên, **chưa có nghiệp vụ, chưa có DB** | #9 |
| BE-04 | Lệnh chiều xuống | 12 lệnh gửi được qua HTTP điều khiển, có log thật | #11 |
| BE-05 | State machine súng đôi | ❌ — chờ T12/T13 | — |
| BE-06 | Lưu MeterValues | ❌ — chưa có schema (T11) | — |
| BE-07 | Engine đối soát | **Thiết kế 5 lớp đã viết; EXP-01 chứng minh hiện tượng** (6 mẫu phát lại sau StopTransaction, `meterStop` 242 vs MeterValues 1042 Wh); `epoch` trong trace là nền phát hiện phát lại. Chưa có code sản phẩm | #9, #11 |
| BE-08 | Realtime Socket.IO | ❌ | — |
| — | API tìm trạm cho WP3 (nợ từ 16/09) | ❌ | — |

**Kết luận trung thực:** Iteration 1 = *bàn thí nghiệm hoàn chỉnh và hai thí nghiệm có log thật*, không phải *backend chạy được*. Khi viết Report, gọi đúng tên: "Iteration 1 — xác minh giao thức và dụng cụ đo".

Hai thí nghiệm đáng đưa vào Report:
- **EXP-01** (`apps/csms/lab/EXP-01-ngat-ket-noi-81s.md`): ngắt 81 s giữa phiên; 8 mẫu buffer, 6 phát lại *sau* StopTransaction; tín hiệu phân biệt duy nhất là `received_at − cp_timestamp` (0 s vs 104–127 s); trụ nối lại không gửi BootNotification. Một lần chạy — *minh hoạ*, chưa phải *đo*.
- **EXP-02** (`apps/csms/lab/EXP-02-dat-cho.md`): 9/9 hành vi đặt chỗ đạt; tính duy nhất "hai đặt chỗ đồng thời → đúng một thành công" **đạt nhờ `callConcurrency=1` của thư viện, không nhờ CSMS** → phải có `UNIQUE` trong DB (ADR riêng); ước lượng FR-20 nên từ 1 lên 4–5 ngày công.

---

## 5. Quy tắc làm việc — tóm tắt để trích vào Report 4

Nguồn đầy đủ: `CONTRIBUTING.md`.

- **Nhánh:** `wp<số>/<mã-task>-<mô-tả-không-dấu>`; một nhánh một task; sống > 5 ngày là chia chưa đủ nhỏ. Đồng bộ bằng `rebase`, không merge ngược.
- **Commit:** Conventional Commits + mã task: `feat(csms): ...  [BE-05]`. Loại: feat fix refactor test docs chore perf. Scope: csms dashboard mobile shared simulator infra docs repo.
- **PR:** CI xanh · ≥ 1 approve từ người khác · < 400 dòng (trừ file sinh) · theo mẫu `.github/PULL_REQUEST_TEMPLATE.md` · **Squash and merge**. Task chạm OCPP phải kèm log bản tin thật.
- **Định nghĩa hoàn thành:** merge vào `main` qua PR có approve · test tự động cả nhánh lỗi · chạy trên staging · tài liệu cập nhật cùng sprint · không `TODO` thiếu issue.
- **ADR:** mọi quyết định kiến trúc → `docs/adr/NNNN-ten.md`, 4 mục. Sau #12: 12 ADR, 5 *Chấp nhận* (0001–0004, 0008), 7 *Đề xuất*.
- **Bí mật:** gitleaks quét toàn bộ lịch sử trên mọi PR; lộ = coi như đã lộ, thu hồi trước dọn sau.
- **Ghim phiên bản:** không `latest` ở bất kỳ đâu.
- **Rào chắn thay branch protection** (org gói Free): hook `pre-push` chặn push thẳng `main` · gitleaks · workflow cảnh gác `main` tự tạo issue khi có commit không qua PR.

---

## 6. Phiên bản công nghệ đã ghim trong repo

| Thành phần | Phiên bản | Nguồn |
|---|---|---|
| Node.js | 24.18.1 | `.nvmrc` (lưu ý: `package.json` ghi `engines.node >= 22` — lệch, cần đồng bộ) |
| npm | ≥ 10 | `package.json` |
| `ocpp-rpc` | **2.2.1** (ghim cứng; npm chưa có 3.x) | `apps/csms/package.json` (#9) |
| PostgreSQL | 16.4-alpine | `infra/docker-compose.yml` |
| Redis | 7.4-alpine | `infra/docker-compose.yml` |
| SteVe | 3.14.1 (image build tại chỗ, profile `reference`, chạy tiến trình riêng — không fork) | `infra/docker-compose.yml` |
| MySQL (cho SteVe) | 8.0 | `infra/docker-compose.yml` |
| SAP simulator | v4.12.0 (tag `web@v4.12.0`), pnpm 11.22.0 | `apps/csms/lab/simulator/README.md` (#11) |
| Prettier | 3.9.x | `package-lock.json` |
| GitHub Actions | checkout@v4, setup-node@v4, semantic-pull-request@v5, gitleaks | `.github/workflows/` (Dependabot đề xuất v7/v7/v6) |

Bảng đầy đủ năm nhóm (ngôn ngữ, thư viện, hạ tầng, repo/CI, dịch vụ ngoài & công cụ AI) với cột nguồn và trạng thái ghim: **`docs/BANG-KHAI-BAO-CONG-NGHE.md` (T18)**.

Chưa ghim, cần quyết: NestJS, Drizzle, Socket.IO, Caddy, k6 (đề xuất trong tài liệu kiến trúc, chưa có trong `package.json`); Flutter (chưa có code); vùng hosting; FCM.

---

## 7. CI (T30)

| Workflow | Chạy khi | Làm gì |
|---|---|---|
| `ci.yml` — Lint · Typecheck · Test · Build | push `main`, mọi PR (#11 mở rộng cho PR xếp tầng) | `npm ci` → `format:check` → lint → typecheck → test → build, có Postgres 16 + Redis 7 service |
| `security.yml` — Quét bí mật | mọi PR, push `main` | gitleaks **toàn bộ lịch sử** |
| `pr-title.yml` | mở/sửa PR | Conventional Commits, scope trong danh sách, không viết hoa chữ đầu |
| `main-push-guard.yml` | push `main` không qua PR | Tạo issue gán người push, nhãn `p1:quan-trong` |

`docs/` và `**/*.md` nằm trong `.prettierignore` — tài liệu không làm CI đỏ. Hiện chưa có test nào vì chưa có code sản phẩm; `npm test` chạy qua với 0 test.

---

## 8. Quyết định cần Trí trong 48 giờ

| # | Quyết định | Một lệnh / một câu |
|---|---|---|
| 1 | Thêm Sơn, Khang, Nghĩa vào team `wp3`, `wp5`, `wp4` | `gh api -X PUT orgs/PowerMeApp/teams/wp3/memberships/Son2110 -f role=member` (×3) — xác nhận `ggbb0711` là Nghĩa trước |
| 2 | Thứ tự merge: #7 → #8 → #12 → #9 → #11, ai approve cái nào | Ân: #7, #8, #12 (tài liệu) · Khang: #9, #11 (lab, simulator) |
| 3 | Luật tạm cho tới Hội đồng: PR tài liệu/lab không có review sau 48 giờ → tác giả tự merge, ghi biên bản | Cả nhóm gật trong họp tuần này |
| 4 | Sửa kiểm tra tiêu đề cho Dependabot (1 dòng) rồi merge 4 PR bot | PM-01 |
| 5 | Đồng bộ `engines.node` với `.nvmrc` | PM-01 |

---

## 9. Ân dùng báo cáo này cho Report 4 ở đâu

| Mục Report 4 | Lấy từ |
|---|---|
| Môi trường phát triển, công cụ, phiên bản | Mục 6 + `BANG-KHAI-BAO-CONG-NGHE.md` |
| Quy trình phát triển, quản lý mã nguồn | Mục 5, 7 |
| Kiến trúc, quyết định thiết kế | `docs/adr/` (sau #12), `WP2-KIEN-TRUC-TECHSTACK.md`, `PACKAGE-DIAGRAM-CSMS.md` (T19) |
| Tiến độ Iteration 1 | Mục 4 — **ghi đúng là "xác minh giao thức và dụng cụ đo"** |
| Kết quả thực nghiệm sơ bộ | EXP-01, EXP-02 (đều ghi rõ giới hạn) |
| Rủi ro quy trình | Mục 2 — quyền truy cập, và R-A02 |
