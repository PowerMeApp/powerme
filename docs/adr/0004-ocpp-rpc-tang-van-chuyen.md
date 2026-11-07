# ADR-0004 — Dùng `ocpp-rpc` cho tầng vận chuyển OCPP-J

| | |
|---|---|
| Trạng thái | Chấp nhận |
| Ngày | 11/09/2026 — chấp nhận 23/10/2026 |
| Người đề xuất | Ngô Văn Minh Trí (WP2) |
| Người quyết định | WP2 |
| Liên quan | BE-02, BE-07, ADR-0003, ADR-0011 |

## Bối cảnh

Tầng RPC-over-WebSocket của OCPP-J (đóng gói CALL / CALLRESULT / CALLERROR, một CALL đang chờ mỗi chiều, timeout, ping/pong, validate schema) là phần việc lặp lại ở mọi CSMS. Nhóm cần một thư viện Node làm phần này để dành công sức cho logic nghiệp vụ OCPP — thứ đồ án thật sự đo.

**Đã kiểm chứng trực tiếp từ mã nguồn `ocpp-rpc` ngày 11/09/2026** (commit gần nhất của thư viện: 10/08/2026):

| Yêu cầu của OCPP-J | `ocpp-rpc` xử lý thế nào |
|---|---|
| Mỗi chiều chỉ một CALL đang chờ | `callConcurrency` **mặc định = 1**. Chú thích trong code: *"OCPP requires this to be set to 1"*. CALL dư được xếp hàng |
| Định danh trụ nằm trên URL | Server lấy đoạn cuối của đường dẫn làm `identity` |
| Basic Auth theo Security Profile 1 và 2 | Server tự parse header `Authorization` với username = identity, đưa `password` vào callback `auth` |
| Thoả thuận subprotocol | Tuỳ chọn `protocols`, ghi đè được trong callback `auth` |
| Validate bản tin theo schema OCA | `strictMode`, có sẵn schema OCA cho `ocpp1.6`, `ocpp2.0.1`, `ocpp2.1` |
| Timeout cho CALL | `callTimeoutMs` mặc định 60 000 ms |
| WebSocket ping/pong — khác với OCPP Heartbeat | `pingIntervalMs` mặc định 30 000 ms, tự ngắt kết nối chết |
| Không lộ stack trace ra ngoài | `respondWithDetailedErrors` mặc định `false` |

**Yêu cầu hệ thống:** Node.js ≥ 20. Phụ thuộc: `ws`, `ajv`, `backoff`.

## Quyết định

Không tự viết tầng RPC-over-WebSocket. Dùng **`ocpp-rpc@2.2.1`** (MIT), **ghim cứng** — không `^`, không `~`.

- Trên npm **chưa có 3.x** (kiểm 12/09/2026). Bản 3.0.0 đang phát triển là **ESM breaking change**, nên không để range version.
- Thư viện **một maintainer** (235/241 commit) → **vendor một bản copy trong repo làm dự phòng**. Giấy phép MIT cho phép.
- **Bẫy giấy phép:** thư viện là MIT, nhưng **các file JSON schema của OCA đi kèm theo giấy phép CC BY-ND 4.0** (không phái sinh). Dùng nguyên văn, **không sửa đổi**. Ghi điều này vào SDD.

### Ba điều thư viện KHÔNG làm — WP2 phải tự làm

1. **Không giới hạn đồng thời cho CALL chiều vào.** Trụ tuân thủ spec sẽ không gửi dồn, nhưng **đừng dựa vào điều đó** — trụ đang replay hàng đợi offline hoặc trụ lỗi firmware có thể gửi dồn. Nếu handler chạy song song, bản ghi vào DB sai thứ tự và làm hỏng chính dữ liệu mà engine đối soát dựa vào. **WP2 phải tuần tự hoá xử lý chiều vào theo từng trụ.**
2. **Không xử lý trụ nối lại với cùng identity** khi kết nối cũ còn treo. WP2 phải chủ động đóng phiên cũ khi phiên mới cùng identity được xác thực.
3. **Không có logic nghiệp vụ OCPP nào** — không state machine, không giao dịch, không đối soát. Đó vẫn nguyên là phần việc của đồ án.

## Hệ quả

**Được:**

- Tầng vận chuyển đã có sẵn và đã được đối chiếu với yêu cầu OCPP-J (bảng ở mục Bối cảnh); Basic Auth cho Security Profile 2 (ADR-0011) có sẵn.

**Mất:**

- Phụ thuộc vào thư viện một maintainer — phải vendor bản copy để tự chủ nếu thư viện ngừng bảo trì.
- Ba phần việc ở trên (tuần tự hoá chiều vào theo trụ, đóng phiên cũ khi nối lại cùng identity, toàn bộ logic nghiệp vụ) thuộc BE-02 và các task sau.
- Ràng buộc giấy phép CC BY-ND 4.0 trên schema OCA: không được sửa schema.

## Các phương án đã cân nhắc và loại bỏ

| Phương án | Vì sao loại |
|---|---|
| Tự viết tầng RPC-over-WebSocket | (lý do chưa ghi tách bạch trong tài liệu nguồn — quyết định chỉ nêu "không tự viết"; bảng kiểm chứng ở mục Bối cảnh cho thấy thư viện đã đáp ứng các yêu cầu OCPP-J) |
| Để range version `^2.2.1` / `~2.2.1` | 3.0.0 sắp tới là ESM breaking change; range version có thể kéo bản vỡ vào build. |

## Ghi chú trạng thái

- 11/09/2026 — Đề xuất trong [WP2-KIEN-TRUC-TECHSTACK.md](../WP2-KIEN-TRUC-TECHSTACK.md).
- 23/10/2026 — Chấp nhận: `apps/csms/package.json` trên nhánh `wp2/be-02-ban-thi-nghiem-ocpp` (#9) đã ghim `"ocpp-rpc": "2.2.1"`.
