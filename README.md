# PowerMe

**Nền tảng phần mềm quản lý trạm sạc xe điện (CSMS) theo OCPP 1.6J** cho dòng trạm sạc DC **D1 Series** và **YJ-EU Series** — 60–160 kW, súng đôi.

> Đồ án Capstone SE · FPT University · 24/08/2026 – 22/11/2026
> Phần cứng được mô phỏng hoàn toàn bằng simulator — không có trụ vật lý trong phạm vi đồ án.

---

## Trạng thái

| | |
|---|---|
| Sprint hiện tại | S1 — Khởi động và đặc tả (24/08 – 06/09) |
| Cột mốc kế tiếp | **M1 — 06/09/2026** · Đặc tả chốt, simulator chạy |
| Kế hoạch đầy đủ | [docs/KE-HOACH-POWERME.md](docs/KE-HOACH-POWERME.md) |

---

## Cấu trúc kho mã

```
powerme/
├── apps/
│   ├── csms/          WP2 — CSMS: WebSocket OCPP 1.6J, state machine, engine đối soát (NestJS)
│   ├── dashboard/     WP4 — Dashboard vận hành: giám sát, cảnh báo, biểu giá (React + Vite)
│   └── mobile/        WP3 — App tài xế: quét QR, màn hình sạc realtime (React Native / Expo)
├── packages/
│   └── shared/        Kiểu dữ liệu dùng chung, client sinh từ OpenAPI, hằng số OCPP
├── simulator/         WP5 — SAP simulator + bản patch nhánh 1.6 (task QA-02)
├── infra/             docker compose, cấu hình hạ tầng, kịch bản load test k6
├── docs/              WP1 — SRS, SDD, ADR, kế hoạch, biên bản
└── scripts/           Tiện ích thiết lập và vận hành kho mã
```

Ba đầu ra TypeScript nằm chung một npm workspace để dùng chung kiểu dữ liệu qua `packages/shared` — hợp đồng API chỉ định nghĩa một lần.

---

## Bộ công cụ

| Vai trò | Công cụ |
|---|---|
| Backend CSMS | NestJS + TypeScript · PostgreSQL · Redis |
| Dashboard | React + Vite + TypeScript |
| App | React Native / Expo |
| Charge point mô phỏng | [SAP e-mobility-charging-stations-simulator](https://github.com/SAP/e-mobility-charging-stations-simulator) (Apache-2.0) |
| CSMS đối chứng | [SteVe](https://github.com/steve-community/steve) — **chạy tiến trình riêng, không fork, không copy code** |
| Load test | k6 |
| Checklist tuân thủ | 76 ca `TC_*_CSMS` trong tài liệu OCTT của OCA |

---

## Bắt đầu

**Yêu cầu:** Node.js ≥ 22 (xem [.nvmrc](.nvmrc)) · Docker Desktop · Git

```bash
git clone https://github.com/PowerMeApp/powerme.git
cd powerme
npm install

cp infra/.env.example infra/.env    # điền giá trị cho máy của bạn
npm run infra:up                    # PostgreSQL + Redis + SteVe (CSMS đối chứng)
```

`npm install` tự bật hook `pre-push` của dự án. Nếu nghi ngờ chưa bật, chạy `npm run setup:hooks`.

| Lệnh | Việc |
|---|---|
| `npm run infra:up` | Bật PostgreSQL, Redis, SteVe |
| `npm run infra:down` | Tắt hạ tầng (giữ dữ liệu) |
| `npm run infra:reset` | Tắt và **xoá sạch volume** |
| `npm run build` | Build toàn bộ workspace |
| `npm test` | Chạy test toàn bộ workspace |
| `npm run lint` | Lint toàn bộ workspace |

---

## Quy trình làm việc

Đọc [CONTRIBUTING.md](CONTRIBUTING.md) trước khi mở nhánh đầu tiên. Tóm tắt:

- Nhánh `main` được bảo vệ — **không push thẳng**, mọi thay đổi đi qua Pull Request.

> ⚠️ **GitHub không thực thi bảo vệ nhánh trên repo này.** Org `PowerMeApp` ở gói Free, mà GitHub
> chỉ cho branch protection và ruleset hoạt động trên repo public hoặc gói trả phí. Nâng org lên
> GitHub Team (miễn phí qua GitHub Education) rồi chạy `bash scripts/setup-github.sh PowerMeApp/powerme`
> là có lại. Trong lúc chờ, nhóm dùng ba rào chắn thay thế dưới đây.

### Ba rào chắn thay cho branch protection

| Rào | Ở đâu | Chặn được gì |
|---|---|---|
| Hook `pre-push` | [.githooks/pre-push](.githooks/pre-push) — bật qua `npm run setup:hooks` | Chặn `git push` vào `main` **ngay trên máy**, trước khi lệnh chạm tới GitHub |
| Quét bí mật `gitleaks` | [.github/workflows/security.yml](.github/workflows/security.yml) | Fail PR nếu có token, khoá, mật khẩu lọt vào mã nguồn. Thay cho Secret scanning — thứ gói Free không bật được trên repo private |
| Cảnh gác `main` | [.github/workflows/main-push-guard.yml](.github/workflows/main-push-guard.yml) | Không chặn, nhưng mỗi commit vào `main` không qua PR sẽ tự sinh một issue gán cho người push |

Hiểu đúng giới hạn: hook nằm trên máy nên người cố tình vẫn vượt được, và cảnh gác `main` chỉ ghi
nhận sau khi việc đã xảy ra. Chúng chặn **lỗi bất cẩn**, không chặn **ý định**. Với một nhóm đồ án
thì gần như toàn bộ sự cố thuộc loại thứ nhất.
- Đặt tên nhánh: `wp<số>/<mã-task>-<mô-tả-ngắn>` — ví dụ `wp2/be-04-state-machine-dual-gun`.
- Mỗi PR cần **ít nhất một approve** và CI xanh.
- Commit theo [Conventional Commits](https://www.conventionalcommits.org/).

---

## Ba câu không được viết sai trong báo cáo

1. **"Chạy qua kịch bản OCTT" ≠ "được chứng nhận OCPP".** Chứng nhận cần test lab độc lập của OCA cộng form PICS.
2. **Chứng chỉ OCA của Powerfill không lan sang SteVe open-source.**
3. **"CitrineOS compliant OCPP 1.6" là tự khai**, không phải chứng nhận.

---

## Tài liệu

| Tài liệu | Nội dung |
|---|---|
| [KE-HOACH-POWERME.md](docs/KE-HOACH-POWERME.md) | Kế hoạch thực thi 13 tuần, 6 sprint, 6 cột mốc, bảng phân rã công việc |
| [NGHIEN-CUU-NEN-TANG.md](docs/NGHIEN-CUU-NEN-TANG.md) | Nghiên cứu nền: cơ sở và nguồn dẫn cho các quyết định công cụ |
| [WP2-LO-TRINH-KY-THUAT.md](docs/WP2-LO-TRINH-KY-THUAT.md) | Lộ trình kỹ thuật cho WP2 — CSMS OCPP và đối soát |
| [AGENDA-GAP-GVHD.md](docs/AGENDA-GAP-GVHD.md) | Nội dung làm việc với giảng viên hướng dẫn |

---

## Giấy phép

Dự án học thuật, chưa cấp phép công khai. Mọi quyền được bảo lưu bởi nhóm đồ án và FPT University.
Việc sử dụng các thành phần bên thứ ba tuân theo giấy phép gốc của từng thành phần — xem [docs/NGHIEN-CUU-NEN-TANG.md](docs/NGHIEN-CUU-NEN-TANG.md).
