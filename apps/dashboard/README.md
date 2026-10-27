# @powerme/dashboard — WP4

Một ứng dụng web React cho hai vai trò: **Operator Dashboard** (đối tác vận hành trụ, Fig 10, screen 16–25) và **Admin Console** (quản trị nền tảng, Fig 11, screen 26–33). Đăng nhập xong, vai trò quyết định vào khu nào (`/operator/*` hoặc `/admin/*`).

> Không nhầm với **bảng điều khiển dev của CSMS** (`apps/csms/src/console`, BE-08): đó là công cụ demo/debug của Trí, không đăng nhập, không phải giao diện sản phẩm.

| | |
|---|---|
| Chủ sở hữu | WP4 — Full-stack Developer |
| Cột mốc | M3 — 18/10/2026, **M4 — 01/11/2026** |
| Stack | React 19 + Vite 7 + TypeScript 5.9 · React Router 7 · Redux Toolkit 2 / RTK Query · Vitest 3 + Testing Library |
| Trạng thái | **FE-01 shell — chạy trên dữ liệu mô phỏng** (`src/mocks`), chưa nối REST API của CSMS |

## Phạm vi

- **FE-01** Đăng nhập, phân quyền theo vai trò
- **FE-02** Onboarding trụ: SN, connector, site, vòng đời `Đã đăng ký → Chờ kết nối → Trực tuyến`
- **FE-03** Giám sát realtime: trạng thái từng súng, danh sách phiên đang chạy
- **FE-04** Trung tâm cảnh báo: ánh xạ mã lỗi OCPP sang hướng xử lý lấy từ SRS phần cứng
- **FE-05** Điều khiển từ xa: start, stop, reset, mở khoá súng
- **FE-06** Biểu giá bốn khung giờ Sharp / Peak / Shoulder / Off-peak
- **FE-07** Analytics cơ bản: doanh thu và tỉ lệ sử dụng
- **FE-08** **Trình xem bản tin OCPP thô** — thứ người trong ngành nhìn vào đầu tiên khi chấm

## Ràng buộc

Một trụ dual gun phải hiện **hai trạng thái độc lập** trong cùng một thẻ thiết bị. Gộp thành một trạng thái là sai mô hình.

## Chạy

Cần Node **24.18.1** (`.nvmrc`; `volta run --node 24.18.1 …` nếu máy đang Node 22).

```bash
npm install                                  # ở gốc repo
npm run dev -w @powerme/dashboard            # http://127.0.0.1:5173
npm test -w @powerme/dashboard               # 62 test (Vitest + Testing Library, không cần backend)
npm run typecheck -w @powerme/dashboard
npm run build -w @powerme/dashboard          # dist/
```

Tài khoản mô phỏng (mật khẩu `powerme123`): `operator@powerme.local` · `admin@powerme.local` — trang đăng nhập có nút điền sẵn.

## Giao diện

Cùng hệ thiết kế với app tài xế Flutter (`apps/mobile/lib/core/theme/app_theme.dart`, nhánh WP3): nền Rich Black `#0A0A0A`, thẻ Graphite `#141414` bo 20 px, teal `#00E0C2` là màu chính, gold `#D4AF37` là màu thương hiệu, pill trạng thái bo tròn nền 12 % (như `StatusPill`), ô nhập bo 14 px viền teal khi focus, chỉ giao diện tối, tiếng Việt. Token ở `src/styles/global.css`.

## Bản đồ màn hình

| SRS | Route | Mức | Dựng theo |
|---|---|---|---|
| 16 / 26 | `/login` | Đủ | Fig 10/11 — "log in [Operator role] / [Admin role]" |
| 17 | `/operator` | Đủ — số trụ/súng theo trạng thái, cảnh báo mở, lối tắt | Fig 10, UC-OPS-02/03 |
| 18 | `/operator/pillars` | Đủ — **hai súng độc lập trên mỗi thẻ**, lọc | STM-2/3, UC-OPS-02 |
| 19 | sheet trong `/operator/pillars` | Đủ — serial phải được Admin đăng ký trước, mật khẩu hiện **một lần** | WF-05 (SD-5a), AD-8 |
| 20 | `/operator/pillars/:id` | Đủ — lệnh từ xa + trạng thái `remote_commands`, lịch sử sự cố | UC-OPS-04 |
| 21 | `/operator/alerts` | Đủ — **STM-6**: xác nhận → Reset (đếm ngược) → xử lý xong / về đã xác nhận; đóng sau kiểm tra | WF-04 seq 1/2, FE-04 |
| 22 | `/operator/sessions` | Đủ — đối soát conflict (STM-1 #17), không định danh, **lệnh start bị kẹt** (WP3 T72) | WF-03, UC-OPS-05, WF-01 |
| 23 | `/operator/pricing` | Đủ — 4 khung giờ, kiểm tra phủ 24 h / không chồng | M4, UC-OPS-06/07 |
| 24, 25 | `/operator/tickets`, `/operator/analytics` | Khung «Should» | UC-OPS-08/09 |
| 27 | `/admin` | Đủ — người dùng, trụ, thẻ, ngoại lệ thanh toán | Fig 11 |
| 28 | `/admin/users` | Danh sách + đổi vai trò | UC-ADM-01/02 |
| 29 | `/admin/devices` | Danh sách + đăng ký serial | UC-ADM-03 |
| 30 | `/admin/cards` | Danh sách thẻ, tag free vend | UC-ADM-04/05 |
| 31 | `/admin/billing` | Đủ — **UC-ADM-08**: hoàn top-up (409/422), thanh toán trễ (502 rồi thử lại), hoá đơn needs_review (thử lại một lần), tài khoản đã đóng (*chờ xác nhận phạm vi*) | docs/UC-ADM-08-BILLING-EXCEPTIONS.md, SD-2b/2c, STM-4/7, BR-P21/P44 |
| 32, 33 | `/admin/policies`, `/admin/health` | Khung «Should» | UC-ADM-06/07 |

## Cấu trúc (theo package diagram PKG-2)

```
src/
  routes/      bảng route theo Fig 10/11 + RequireRole
  layouts/     AppShell: thanh điều hướng theo vai trò, thanh trên, đăng xuất
  pages/       một file cho mỗi màn hình SRS (operator/, admin/)
  components/  Pill, ConnectorPill, Card, Tabs, ConfirmDialog, Sheet, Icon…
  hooks/       toast
  features/    alerts (STM-6, bảng mã lỗi, FaultItem), billing (luật BR-P21), tariffs, stations
  core/        api (RTK Query), store, context (phiên đăng nhập), realtime (nhịp làm mới), config
  mocks/       "CSMS" giả trong trình duyệt: fixtures + route REST + luật nghiệp vụ
  types/ utils/ styles/
```

## Dữ liệu mô phỏng → API thật

- `src/core/api/api.ts` gọi đúng đường dẫn REST dự kiến (`/api/v1/operator/*`, `/api/admin/*` — UC-ADM-08 §7). `mockBaseQuery` chuyển chúng vào `src/mocks/server.ts`; nối CSMS thật = thay bằng `fetchBaseQuery` (+ JWT), UI không đổi.
- Mock áp cùng luật với sơ đồ và trả mã lỗi HTTP thật (404/409/422/502), nên luồng lỗi trên UI đã được thử.
- `features/alerts/faultStateMachine.ts` và `errorCodeGuide.ts` trùng nội dung với `apps/csms/src/stations/faults/*` (FE-04) — chuyển sang `@powerme/shared` khi package đó có build.
- Realtime: tạm dùng `pollingInterval` 3 s (1 s khi có sự cố đang reset); đích là Socket.IO (BE-08).

