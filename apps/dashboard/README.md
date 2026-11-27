# @powerme/dashboard — Operator Dashboard + Admin Console (WP4)

| | |
|---|---|
| Chủ sở hữu | WP4 — Trần Trọng Nghĩa |
| Stack | React 19 + Vite + TypeScript, Redux Toolkit / RTK Query, React Router, React Hook Form + Zod (form, D43) |
| Thiết kế | Report 4 PKG-2 (presentation → features → core → foundation), SRS Table 5 / 6, Fig 10 / 11 |
| Backend | CSMS operator API (`/api/auth/v1`, `/api/operator/v1`, `/api/admin/v1`) — ADR-0018 |

## Chạy

Dashboard gọi CSMS thật (không có dữ liệu mô phỏng). Ở máy dev, Vite chuyển `/api` sang CSMS (cùng origin như Caddy trên staging).

```bash
# 1. CSMS có khoá đăng nhập dashboard (ADR-0018)
export DASHBOARD_JWT_SECRET_BASE64=$(openssl rand -base64 32)
DASHBOARD_JWT_ISSUER=powerme-local DASHBOARD_JWT_AUDIENCE=powerme-dashboard \
  npm run demo -w @powerme/csms -- --reset --port-offset 200

# 2. Dashboard (CSMS_URL mặc định http://127.0.0.1:3000; demo với --port-offset 200 dùng 3200)
CSMS_URL=http://127.0.0.1:3200 npm run dev -w @powerme/dashboard   # http://127.0.0.1:5173
```

Tài khoản demo `staff.demo@powerme.test` (Operator) và `admin.demo@powerme.test` (Admin) có trong `seed.sql` nhưng chưa có mật khẩu.

```bash
npm test -w @powerme/dashboard        # Vitest + Testing Library (fetch giả, không cần CSMS)
npm run typecheck -w @powerme/dashboard
npm run build -w @powerme/dashboard
```

## Màn hình (SRS Table 5)

| # | Màn hình | Route | Trạng thái |
|---|---|---|---|
| 16 | Login — Operator Dashboard | `/operator/login` | FE-01b |
| 17 | Operator Dashboard (hub) | `/operator` | FE-01b (khung; số liệu ở FE-03 / FE-04) |
| 19 | Charge Point Onboarding (sheet, UC-OPS-01) | nút "Onboard trụ sạc" trên `/operator/charge-points` | FE-02 (+ `GET /api/operator/v1/sites`) |
| 18, 20–25 | Charge Points, Charge Point Detail, Fault Alerts, Maintenance Tickets, Unattributed Sessions, Pricing & Promotions, Station Revenue | `/operator/…` | FE-03 … FE-07, FE-12, FE-13 |
| 26 | Login — Admin Console | `/admin/login` | FE-01b |
| 27 | Admin Dashboard (hub) | `/admin` | FE-01b (khung; số liệu ở FE-14) |
| 29 | Device Registry (UC-ADM-03) | `/admin/charge-points` | FE-15 (API BE-44 `GET`/`POST /api/admin/v1/charge-points`; chỉ xem + đăng ký serial, chưa sửa) |
| 30 | RFID Cards (Card Registry, UC-ADM-04) | `/admin/rfid-cards` | T161 (API T146 + tìm tài xế `GET /api/admin/v1/users`) |
| 28, 31–33 | Users & Roles, Network Monitor, Billing Exceptions, Refund / Retry | `/admin/…` | FE-09 |

## Quy tắc

- Mỗi màn đăng nhập chỉ nhận đúng vai trò của mình (D31); Operator không bao giờ vào `/admin/*` và ngược lại (Table 6).
- Phiên nằm trong `authSlice` (sessionStorage); tự đăng xuất khi token hết hạn hoặc CSMS trả 401 / 403 phiên không còn hợp lệ.
- Không hiện số giả: màn chưa có dữ liệu thì không có ô số (D36).
- Dùng đúng thuật ngữ GLOSSARY: Charge Point (trụ sạc), Charging Station, Connector (súng), FaultEvent. Một trụ hai súng luôn hiện hai trạng thái Connector độc lập.
- Kiểu dữ liệu API lấy từ `@powerme/shared`.
- Form: React Hook Form + Zod (`components/Field.tsx`); lỗi của từng ô hiện màu đỏ ngay dưới ô đó, lỗi máy chủ về một ô (ví dụ 409 serial) cũng hiện dưới ô đó.
