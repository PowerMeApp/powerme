# ADR-0003 — Node.js 24 LTS + TypeScript `strict`

| | |
|---|---|
| Trạng thái | Chấp nhận |
| Ngày | 11/09/2026 — chấp nhận 23/10/2026 |
| Người đề xuất | Ngô Văn Minh Trí (WP2) |
| Người quyết định | WP1, WP2 |
| Liên quan | BE-01, ADR-0001, ADR-0004 |

## Bối cảnh

Trạng thái đã có trong repo: `.nvmrc` ghim `24.18.1`, CI chạy `NODE_VERSION: '24'`, `README.md` đã chọn NestJS 11. ADR này chính thức hoá trạng thái đó.

Lý do bộ công cụ này hợp với bài toán:

- OCPP-J là WebSocket + JSON — đúng sở trường của Node.
- Thư viện tầng vận chuyển tốt nhất tìm được (`ocpp-rpc`, xem ADR-0004) là Node.
- SAP simulator mà WP5 phải patch viết bằng TypeScript — **cùng ngôn ngữ**, WP2 đọc và hỗ trợ patch được.
- Backend và dashboard dùng chung kiểu dữ liệu qua `packages/shared` — điều kiện tiên quyết của ADR-0001 (xem phụ lục 10/2026 của ADR-0001 về app Flutter).

## Quyết định

Node.js 24 LTS, TypeScript bật `strict`, framework NestJS 11.

## Hệ quả

**Được:**

- (chưa ghi tách bạch trong tài liệu nguồn — lý lẽ ở mục Bối cảnh)

**Mất:**

- (chưa ghi trong tài liệu nguồn)

**Việc kéo theo:** `package.json` gốc khai báo `engines.node >= 22.0.0`, trong khi `.nvmrc` và CI dùng 24. Không lỗi, nhưng nên nâng `engines` lên `>=24` để khỏi có người chạy Node 22 rồi gặp khác biệt.

## Các phương án đã cân nhắc và loại bỏ

| Phương án | Vì sao loại |
|---|---|
| Java / Spring Boot | Hợp lý nếu bám SteVe, nhưng phá vỡ việc dùng chung kiểu dữ liệu của ADR-0001. |
| Go / ocpp-go | README không hề đề cập hành vi offline hay configuration key liên quan; nhóm không dùng Go. |

## Ghi chú trạng thái

- 11/09/2026 — Đề xuất trong [WP2-KIEN-TRUC-TECHSTACK.md](../WP2-KIEN-TRUC-TECHSTACK.md).
- 23/10/2026 — Chấp nhận: repo đã commit NestJS/TypeScript, `.nvmrc` và CI đã ở Node 24.
