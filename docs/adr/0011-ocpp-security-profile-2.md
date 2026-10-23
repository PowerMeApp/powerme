# ADR-0011 — Bảo mật OCPP: Security Profile 2

| | |
|---|---|
| Trạng thái | Đề xuất |
| Ngày | 11/09/2026 |
| Người đề xuất | Ngô Văn Minh Trí (WP2) |
| Người quyết định | WP2 |
| Liên quan | ADR-0004, NFR-OCPP-06 |

## Bối cảnh

NFR đã đăng ký "OCPP-J over TLS". `ocpp-rpc` (ADR-0004) đã hỗ trợ sẵn phần Basic Auth theo Security Profile 1 và 2.

## Quyết định

**Security Profile 2:** TLS + Basic Auth riêng cho từng trụ.

- TLS kết thúc tại Caddy 2, chứng chỉ tự động.
- Mật khẩu từng trụ sinh lúc onboarding, **chỉ hiển thị một lần**, lưu dạng băm argon2.

## Hệ quả

**Được:**

- Khớp NFR đã đăng ký; phần Basic Auth không phải tự viết.

**Mất:**

- (chưa ghi trong tài liệu nguồn)

## Các phương án đã cân nhắc và loại bỏ

| Phương án | Vì sao loại |
|---|---|
| Security Profile 3 — chứng chỉ phía client | Cần dựng PKI. Quá đắt cho 13 tuần, ghi vào hướng phát triển. |
