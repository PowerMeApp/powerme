# ADR-0010 — Idempotency của `StartTransaction`

| | |
|---|---|
| Trạng thái | Đề xuất |
| Ngày | 11/09/2026 |
| Người đề xuất | Ngô Văn Minh Trí (WP2) |
| Người quyết định | WP2 |
| Liên quan | BE-07, ADR-0008, ADR-0009 |

## Bối cảnh

Lúc trụ gửi `StartTransaction` thì `transactionId` chưa tồn tại — CSMS mới là bên sinh ra nó — nên không dùng nó làm khoá chống trùng được.

Trụ gửi lại `StartTransaction` khi mất `CALLRESULT` hoặc khi replay hàng đợi offline. Không idempotent thì một phiên sạc thành hai giao dịch và bị tính tiền hai lần. **Đây là bug kinh điển nhất của CSMS tự xây, và là nền móng của BE-07.**

## Quyết định

Ràng buộc unique trên khoá tự nhiên:

```
(charge_point_id, connector_id, id_tag, meter_start_wh, cp_timestamp)
```

Khi trụ gửi lại cùng một `StartTransaction`, CSMS trả về **đúng `transactionId` cũ** thay vì tạo giao dịch mới.

## Hệ quả

**Được:**

- Một phiên sạc chỉ sinh một giao dịch, dù trụ gửi lại bao nhiêu lần.

**Mất:**

- (chưa ghi trong tài liệu nguồn)

## Các phương án đã cân nhắc và loại bỏ

| Phương án | Vì sao loại |
|---|---|
| Dùng `transactionId` làm khoá chống trùng | Lúc trụ gửi `StartTransaction` thì `transactionId` chưa tồn tại — CSMS mới là bên sinh ra nó. |
