# Architecture Decision Records

Mỗi quyết định làm thay đổi kiến trúc, đổi thư viện lõi, hoặc lệch khỏi spec OCPP đều ghi lại thành một ADR ở đây.

**Quy tắc đánh số:** `NNNN-ten-quyet-dinh.md`, số tăng dần, không dùng lại số cũ.
**Quy tắc sửa:** ADR đã `Chấp nhận` thì không sửa nội dung. Đổi ý thì viết ADR mới và đánh dấu ADR cũ là `Thay thế bởi ADR-NNNN`.

Lý do tồn tại: hội đồng bảo vệ sẽ hỏi "vì sao chọn cách này". Ghi lúc quyết định mất 15 phút, dựng lại sau ba tháng mất cả buổi.

Dùng [_template.md](_template.md) làm khuôn.

| # | Quyết định | Trạng thái | Ngày | Tóm tắt |
|---|---|---|---|---|
| [0001](0001-monorepo-npm-workspaces.md) | Monorepo với npm workspaces | Chấp nhận | 03/09/2026 · phụ lục 23/10/2026 | Một kho mã, `packages/shared` cho backend + dashboard; app Flutter nằm trong monorepo nhưng ngoài npm workspaces |
| [0002](0002-modular-monolith.md) | Modular monolith, không làm microservices | Chấp nhận | 11/09/2026 · chấp nhận 23/10/2026 | `apps/csms` là một tiến trình NestJS chia module; `ocpp-gateway` có ranh giới để tách sau |
| [0003](0003-node-24-typescript-strict.md) | Node.js 24 LTS + TypeScript `strict` | Chấp nhận | 11/09/2026 · chấp nhận 23/10/2026 | Chính thức hoá `.nvmrc` 24.18.1, CI Node 24, NestJS (ghim 12.2.0, TS 5.9.3 — phụ lục 23/10) |
| [0004](0004-ocpp-rpc-tang-van-chuyen.md) | Dùng `ocpp-rpc` cho tầng vận chuyển OCPP-J | Chấp nhận | 11/09/2026 · chấp nhận 23/10/2026 | Ghim cứng `ocpp-rpc@2.2.1`, vendor bản copy; schema OCA là CC BY-ND 4.0, không sửa |
| [0005](0005-nhat-ky-ban-tin-ocpp-append-only.md) | Nhật ký bản tin OCPP ghi trước, chỉ thêm không sửa | Đề xuất | 11/09/2026 | Mọi frame vào `ocpp_message_log` trước khi xử lý nghiệp vụ; chỉ INSERT |
| [0006](0006-khong-redis-pubsub-tren-duong-giao-dich.md) | Không dùng Redis pub/sub trên đường đi của giao dịch | Đề xuất | 11/09/2026 | Pub/sub chỉ cho fanout tới giao diện; giao dịch đi trong tiến trình, job nền qua BullMQ |
| [0007](0007-postgresql-partition-goc.md) | PostgreSQL 16.4 với partition gốc, không dùng TimescaleDB | Đề xuất | 11/09/2026 | Partition theo tháng cho `meter_values` và `ocpp_message_log`; job tạo partition trước |
| [0008](0008-drizzle-orm-migration-sql.md) | Drizzle ORM + migration SQL thuần | Chấp nhận | 11/09/2026 · chấp nhận 23/10/2026 | ORM không cản viết SQL tay cho partition / unique / append-only; chốt cùng WP5 |
| [0009](0009-quy-uoc-du-lieu.md) | Quy ước dữ liệu | Đề xuất | 11/09/2026 | UTC `timestamptz`, hai thời điểm mỗi bản tin, Wh và VND `bigint`, connector 0/1/2, SN và `display_code`, `origin` / `payment_mode` |
| [0010](0010-idempotency-starttransaction.md) | Idempotency của `StartTransaction` | Đề xuất | 11/09/2026 | Unique trên khoá tự nhiên; gửi lại thì trả đúng `transactionId` cũ |
| [0011](0011-ocpp-security-profile-2.md) | Bảo mật OCPP: Security Profile 2 | Đề xuất | 11/09/2026 | TLS tại Caddy + Basic Auth riêng từng trụ, mật khẩu hiện một lần, băm scrypt (sửa 25/10) |
| [0012](0012-phien-the-vi-va-free-vend.md) | Phiên sạc bằng thẻ ví và free vend | Đề xuất | 11/09/2026 | Tách `origin` và `payment_mode`; sổ đăng ký thẻ; phiên thẻ ví không thu qua VNPay |
