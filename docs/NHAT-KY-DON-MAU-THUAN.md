# Nhật ký dọn mâu thuẫn nội bộ trước tag `review-2`

Nguồn danh sách: `docs/BAO-CAO-HIEN-TRANG-REPO.md` mục 10 (M1–M14), kiểm lại trên `main` ngày 23/10/2026. Báo cáo gốc là bản chụp lịch sử nên không sửa.

## Bảng đối chiếu

| Mâu thuẫn | Trước | Sau | Cách kiểm |
|---|---|---|---|
| M1 Node | `engines >=22`, README "≥ 22", `.nvmrc` 24.18.1, CI `24` | `engines.node >=24.0.0`; README ghi Node 24 theo `.nvmrc` | `grep -n '"node"' package.json`; `npm ci` qua |
| M2 Postgres/Redis | CI `postgres:16-alpine`, `redis:7-alpine` | CI `postgres:16.4-alpine`, `redis:7.4-alpine` (bằng compose) | `grep -n alpine .github/workflows/ci.yml infra/docker-compose.yml` |
| M3 React Native/Expo | còn ở `apps/mobile/README.md`, `packages/shared/README.md`, README gốc ("ba đầu ra TypeScript") | ghi Flutter; shared phục vụ CSMS + dashboard; App dùng `openapi.json`. ADR-0001 không đụng: câu "cả ba đầu ra TypeScript" nằm ở mục Bối cảnh gốc và đã được Phụ lục 10/2026 đính chính | `grep -rniE "react.native\|\bexpo\b" --include=*.md .` chỉ còn ADR-0001 (phụ lục), tài liệu lịch sử, `.gitignore` |
| M4 SAP simulator | `<điền commit SHA khi clone>` | tag `web@v4.12.0` = `227ec233edbc115a879fb18fb0094b99694954fe`, pnpm 11.22.0; `infra/README.md` đồng bộ | `git ls-remote --tags https://github.com/SAP/e-mobility-charging-stations-simulator.git web@v4.12.0`; `package.json` upstream tại SHA đó có `"packageManager": "pnpm@11.22.0"` |
| M5 SteVe | compose bảo "ghi commit ở docs/adr/", không có | compose và `infra/README.md` ghi cách build từ tag `steve-3.14.1` = `3fd8cda4722822214f744329bc48dba349456514` (không tạo ADR) | `git ls-remote --tags https://github.com/steve-community/steve.git steve-3.14.1` |
| M6 `apps/csms/README.md` | báo cáo ghi thiếu ocpp-rpc/NestJS/Drizzle, "Redis pub/sub" | **đã đúng sẵn** trên main: Stack có NestJS 12, TS 5.9, ocpp-rpc 2.2.1, Drizzle; BE-08 "Socket.IO + Redis adapter … chưa"; lệnh `npm run build/start/test -w @powerme/csms` đều có trong `apps/csms/package.json` | đọc `apps/csms/README.md` đối chiếu `apps/csms/package.json` |
| M7 README `infra:up` | ghi bật cả SteVe | ghi PostgreSQL + Redis; SteVe chỉ với `--profile reference` | `grep -n profiles infra/docker-compose.yml` |
| M8 ocpp-rpc "Node ≥ 20" | báo cáo ghi sai | **đã đúng sẵn**: TECHSTACK không còn câu này | `grep -n "≥ 20" docs/WP2-KIEN-TRUC-TECHSTACK.md` rỗng |
| M9 số phiên bản TECHSTACK | NestJS 11, TS 5.x, Socket.IO 4.x, Caddy | NestJS 12.2.0, TS 5.9.3 (theo `apps/csms/package.json` + lock); Socket.IO và Caddy ghi "đề xuất" vì chưa có trong lock/repo | `node -e` đọc `package-lock.json`: `@nestjs/core` 12.2.0, `typescript` 5.9.3, không có `socket.io` |
| M10 | R-A02 trích khác nhau | không thuộc phạm vi dọn lần này (cần sổ rủi ro gốc từ Ân) | – |
| M11 Prettier | `^3.4.2` vs lock 3.9.6 | chỉ ghi nhận, không sửa | – |
| M12 Dependabot | `pr-title.yml` bắt tiêu đề "Bump …" của Dependabot | job `conventional-commit` có `if: github.actor != 'dependabot[bot]'` | đọc `.github/workflows/pr-title.yml`; PR Dependabot kế tiếp không còn fail check này |
| M13 CI | báo cáo ghi lọc nhánh | **đã đúng sẵn**: `pull_request:` không lọc nhánh | `.github/workflows/ci.yml` dòng 8 |
| M14 KE-HOACH §9 | "ghim … trong `package.json`" | ghi: Postgres/Redis/SteVe trong compose, SAP bằng tag trong `simulator/README.md` | `grep -n "web@v4.12.0" docs/KE-HOACH-POWERME.md` |

## Phát hiện thêm (đã sửa)

| Mâu thuẫn | Sau |
|---|---|
| `docs/WP2-KIEN-TRUC-TECHSTACK.md` mục 1 liệt kê module `message-log`, `charging`, `payments`… trong khi `apps/csms/src/` chỉ có `ocpp-gateway`, `sessions`, `reconciliation`, `db` | thêm ghi chú đối chiếu code |
| Cùng file mục 3 dùng `transactions`, `id_tags`, `remote_commands`; schema thật là `sessions`, `rfid_cards`, `remote_commands` chưa có | thêm ghi chú trỏ `THIET-KE-CSDL-VAT-LY.md` |
| Cùng file nói trụ nối `ws://localhost:3001`; code mặc định cổng 9000 (`OCPP_PORT`) | thêm ghi chú |
| `packages/shared/README.md` ghi luồng "Redis pub/sub" | đổi thành Socket.IO tới giao diện (ADR-0006) |

Đã kiểm khớp, không cần sửa: 32 bảng + 10 partition con = 42 `CREATE TABLE` và 28 `CREATE TYPE` trong `0000_init.sql` (đúng `THIET-KE-CSDL-VAT-LY.md`); 96 unit + 19 tích hợp (đúng `ITERATION-1-WF03.md`; `npm test` thật: 96 pass, 19 skip vì không có `DATABASE_URL`); 12 ADR (`docs/adr/README.md`); không có link `.md` chết trong tài liệu không thuộc nhóm lịch sử.

## Cần Trí quyết (không tự sửa)

1. **ADR-0003** (đã Chấp nhận, không được sửa theo `docs/adr/README.md`) còn ghi "NestJS 11" và "engines >= 22"; dòng 0003 trong `docs/adr/README.md` cũng ghi NestJS 11. Thực tế NestJS 12.2.0 và engines đã nâng lên `>=24`. Cần một dòng phụ lục như ADR-0001, hoặc ADR mới.
2. **SteVe + compose**: `Dockerfile` SteVe 3.14.1 chờ DB host `mariadb` và build profile Maven `mariadb`; compose dùng `mysql:8.0` host `steve-db`. Chưa chạy được (máy không có Docker). Cần quyết đổi DB sang MariaDB hay dùng mysql, rồi thử.
3. **`docs/BANG-KHAI-BAO-CONG-NGHE.md`** (T18) vẫn mô tả Node/NestJS/Flutter theo trạng thái trước sửa (ghi `engines >=22`, NestJS "11", Flutter "chưa ghim"). Là sản phẩm Report 4 nên chưa đụng; cần cập nhật khi chốt Report 4.
4. **M10** cần sổ rủi ro gốc từ Ân.
5. **Dependabot #1, #2, #3, #10**: `@dependabot rebase` không dùng được trong phiên này; sau khi PR này merge cần Trí/Hải bình luận rebase trên GitHub hoặc đóng và để Dependabot tạo lại.
6. **Ngưỡng cổng OCPP**: TECHSTACK nói 3001, code mặc định 9000; chọn một số làm chuẩn.
