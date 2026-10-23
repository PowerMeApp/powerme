# ADR-0008 — Drizzle ORM + migration SQL thuần

| | |
|---|---|
| Trạng thái | Chấp nhận |
| Ngày | 11/09/2026 — chấp nhận 23/10/2026 |
| Người đề xuất | Ngô Văn Minh Trí (WP2) |
| Người quyết định | WP2 + WP5 |
| Liên quan | ADR-0005, ADR-0007, ADR-0010 |

## Bối cảnh

Mô hình dữ liệu của CSMS có bảng partition (ADR-0007), ràng buộc unique phục vụ idempotency (ADR-0010), bảng append-only (ADR-0005) — **ORM nào cũng phải viết bằng SQL tay** cho mấy thứ này.

Billing, payments, invoicing của WP5 dùng chung DB và chung ORM, nên quyết định này cần WP5 đồng ý; WP5 có quyền phủ quyết.

## Quyết định

Drizzle ORM cho truy vấn, migration viết bằng SQL thuần.

Lý do: chọn ORM không cản trở việc viết SQL mà vẫn cho type-safety.

## Hệ quả

**Được:**

- (chưa ghi tách bạch trong tài liệu nguồn — lý lẽ ở mục Quyết định: viết được SQL tay cho partition / unique / append-only mà vẫn có type-safety)

**Mất:**

- (chưa ghi trong tài liệu nguồn)

## Các phương án đã cân nhắc và loại bỏ

| Phương án | Vì sao loại |
|---|---|
| (chưa ghi trong tài liệu nguồn) | |

## Ghi chú trạng thái

- 11/09/2026 — Đề xuất trong [WP2-KIEN-TRUC-TECHSTACK.md](../WP2-KIEN-TRUC-TECHSTACK.md), chờ WP5 đồng ý.
- 23/10/2026 — Chấp nhận: đã chốt cùng WP5 trong tháng 9/2026.
