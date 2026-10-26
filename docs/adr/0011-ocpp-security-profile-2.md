# ADR-0011 — Bảo mật OCPP: Security Profile 2

| | |
|---|---|
| Trạng thái | Đề xuất |
| Ngày | 11/09/2026 (sửa 25/10/2026: thuật toán băm, trạng thái hiện tại) |
| Người đề xuất | Ngô Văn Minh Trí (WP2) |
| Người quyết định | WP2 |
| Liên quan | ADR-0004, NFR-OCPP-06 |

## Bối cảnh

NFR đã đăng ký "OCPP-J over TLS". `ocpp-rpc` (ADR-0004) đã hỗ trợ sẵn phần Basic Auth theo Security Profile 1 và 2.

## Quyết định

**Security Profile 2:** TLS + Basic Auth riêng cho từng trụ.

- TLS kết thúc tại Caddy 2, chứng chỉ tự động.
- Mật khẩu từng trụ sinh lúc onboarding (24 ký tự, trong khoảng 16–40 của OCPP 1.6 Security Whitepaper), **chỉ hiển thị một lần**, lưu dạng băm **scrypt** (`node:crypto`, định dạng `scrypt$N$r$p$salt$hash`).
- *Sửa 25/10/2026 (review PR #33, Trí chấp nhận):* bản đầu ghi argon2. Đổi sang scrypt vì argon2 cần native add-on, khó cài trên máy dev Windows. Định dạng có tiền tố nên thêm argon2 sau này không phải đổi dữ liệu cũ.

## Trạng thái hiện tại (25/10/2026)

Security Profile 2 là **mục tiêu**, chưa phải trạng thái hiện tại:

- Basic Auth đã chạy: `PillarAuthService` kiểm mật khẩu lúc nâng cấp WebSocket (404 / 403 / 401), trụ chưa có credential bị từ chối trừ khi bật `ALLOW_LEGACY_NO_CREDENTIAL` (PR #33, #35).
- **Chưa có TLS:** CSMS lắng nghe `ws://`, nên mật khẩu đi dạng rõ trên mạng. Thực tế hiện nay gần với Security Profile 1. TLS có khi dựng Caddy trên staging (T04).
- Cho tới lúc đó: chỉ nối trụ hoặc simulator trong mạng dev/LAN, không đưa cổng OCPP ra Internet.

## Hệ quả

**Được:**

- Khớp NFR đã đăng ký; phần Basic Auth không phải tự viết.

**Mất:**

- Basic Auth không tự giới hạn số lần thử sai: cần giới hạn tốc độ theo serial/IP trước khi mở staging (issue riêng, xem `docs/WF-05-PILLAR-ONBOARDING.md`).
- Mật khẩu chỉ hiện một lần: mất là phải cấp lại (luồng cấp lại chưa có, iteration sau).

## Các phương án đã cân nhắc và loại bỏ

| Phương án | Vì sao loại |
|---|---|
| Security Profile 3 — chứng chỉ phía client | Cần dựng PKI. Quá đắt cho 13 tuần, ghi vào hướng phát triển. |
