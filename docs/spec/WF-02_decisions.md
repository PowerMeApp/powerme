# WF-02 – Quyết định thiết kế sau review 2

> Đặt tại `docs/spec/WF-02_decisions.md`.
> **File này được ưu tiên hơn SD-2a…2e và CD-2** cho đến khi các diagram được vẽ lại. Khi diagram đã cập nhật, đánh dấu mục tương ứng là "đã vào diagram".
> Cập nhật: 03/11/2026.

## D1. Hoàn tiền tách khỏi việc chuyển tiền thật (R8)

**Vấn đề:** ghi DB "đã hoàn" rồi gọi VNPay; VNPay lỗi thì sổ sách nói đã hoàn mà tiền chưa về, không có gì để retry. Ảnh hưởng: hoàn top-up (SD-2d E), hoàn khoản trễ (SD-2d F), hoàn khi đóng tài khoản (SD-2e B).

**Quyết định:**
- **Quyết định hoàn** (trừ ví, trả điểm, top-up `refunded`, điều chỉnh hoá đơn được *lên lịch*) xảy ra ngay trong transaction khi Admin bấm.
- Trong cùng transaction tạo một dòng **`refunds`** trạng thái `requested`.
- Sau commit đẩy job `refund.execute`. `RefundJobProcessor` → `RefundService.execute`:
  - VNPay thành công → `done`, ghi `gatewayRefundNo`, `completedAt`; **sau đó** mới đẩy `einvoice.adjust` (nếu có).
  - Timeout / kết quả không rõ → **truy vấn trạng thái trước khi gửi lại** (tránh hoàn hai lần).
  - Lỗi tạm thời → `attemptCount + 1`, retry theo D3.
  - Lỗi vĩnh viễn (`data`) hoặc hết lượt → `failed`, báo Admin.
- Admin retry: `failed → requested`, **một lần thử, không reset `attemptCount`**.
- Không có xác nhận chuyển khoản thủ công. Khoản bị VNPay từ chối vĩnh viễn giữ ở `failed`; công ty xử lý ngoài hệ thống (ngoài phạm vi).

**STM-8 Refund**
```
[*] → requested          tạo cùng transaction với quyết định hoàn
requested → done         VNPay xác nhận
requested → requested    lỗi tạm thời: attempt + 1, hẹn retry
requested → failed       lỗi vĩnh viễn hoặc hết lượt
failed → requested       Admin retry (1 lần thử, không reset bộ đếm)
```
Không có `failed → done`.

**Entity `Refund` (bảng `refunds`)**

| Thuộc tính | Ghi chú |
|---|---|
| `id` | PK bigint |
| `topUpId` | FK → top_ups (nguồn để hoàn về) |
| `refundKind` | enum `top_up` · `late_payment` · `closure_part` |
| `amountVnd` | bigint, ≤ `topUp.amountPaidVnd` (với `late_payment`: ≤ `lateAmountVnd`) |
| `refundStatus` | enum `requested` · `done` · `failed` |
| `attemptCount` | int, mặc định 0 |
| `lastErrorKind` [0..1] | `transient` · `data` |
| `lastErrorMessage` [0..1] | |
| `lastAttemptAt` [0..1] | |
| `gatewayRefundNo` [0..1] | mã hoàn VNPay trả về |
| `requestedBy` | FK → users (Admin) |
| `createdAt`, `completedAt` [0..1] | |

Ràng buộc / index:
- Partial unique `(top_up_id, refund_kind) WHERE refund_kind IN ('top_up','late_payment')`.
- Index `(refund_status, created_at)` cho job quét.
- Index `(top_up_id)`.

Nghĩa mới của cột cũ:
- `top_ups.late_refunded_at` = thời điểm refund `late_payment` chuyển `done`.
- `credit_accounts.closure_refunded_at` = chỉ ghi khi **mọi** refund `closure_part` của tài khoản đều `done`.

Hệ quả cho class: thêm `RefundService` (`request`, `execute`, `retryByAdmin`), `RefundJobProcessor`. `TopUpService` và `AccountClosureService` gọi `RefundService.request`, không gọi `VnpayAdapter.refund`. `AdminBillingController` thêm `retryRefund`. `BillingExceptionsQuery` thêm danh sách refund `failed`. `VnpayAdapter` thêm `queryRefund` nếu VNPay sandbox có API tương ứng.

## D2. "Top-up đang mở" chỉ là `pending`

- Chỉ top-up `pending` mới chặn tạo top-up mới. Trả **409 kèm `topUpId` và `paymentUrl`** để app hỏi "tiếp tục thanh toán?".
- Top-up `expired` (kể cả trong LATE_WINDOW) **không** chặn tạo mới.
- Khi cộng tiền trễ (`expired → credited`, trong LATE_WINDOW 1 giờ): **kiểm tra lại** tài khoản chưa đóng và hạn mức BR-P22 (số dư sau nạp ≤ 5.000.000). Vi phạm → không cộng, xử lý như `recordLatePayment` để Admin hoàn.
- Điều kiện đóng tài khoản chỉ xét top-up `pending`. IPN trễ đến khi tài khoản đã đóng → ghi thành khoản trễ.

## D3. Chính sách retry dùng chung: `RETRY_LIMIT = 4`

- 1 lần đầu + 3 lần retry sau **5 phút, 30 phút, 2 giờ**. Hết lượt → `needs_review` (e-invoice) hoặc `failed` (refund).
- Lỗi `data` → dừng ngay, báo Admin, không retry.
- Admin retry: 1 lần thử, không reset bộ đếm.
- Áp dụng cho cả `einvoice.*` (nhà cung cấp hoá đơn) và `refund.execute` (VNPay). Nên viết một helper chung cho lịch retry.

## D4. Việc nền chạy bằng quét DB (chốt 03/11, không dùng BullMQ ở giai đoạn này)

- DB là nguồn sự thật cho mọi việc nền: trạng thái + `attempt_count` + **`next_attempt_at`** nằm ngay trên dòng nghiệp vụ, giống `charge_settlement_jobs` của WP3.
- Mỗi loại việc có một worker quét định kỳ: `SELECT … WHERE status = 'requested' AND next_attempt_at <= now() ORDER BY next_attempt_at LIMIT n FOR UPDATE SKIP LOCKED`, xử lý từng dòng trong transaction riêng. `SKIP LOCKED` để hai worker (hoặc hai tiến trình) không xử lý trùng một dòng.
- `Scheduler` (`src/common/scheduler.ts`) chỉ dùng để **chạy sớm** (vd. ngay sau commit, hoặc đúng lúc `expires_at`); mất khi sập cũng không sao vì vòng quét bắt lại. Lúc khởi động mỗi worker quét một lần.
- Lịch retry D3 ghi thành `next_attempt_at = now() + 5 phút / 30 phút / 2 giờ`.
- Timeout top-up: quét `top_ups WHERE status = 'pending' AND expires_at <= now()` (đã có `expires_at`, không thêm cột).
- `PendingWorkSweeper` vì thế không còn là job riêng: chính các worker quét này là cơ chế chính. Tên giữ lại cho nhóm worker nếu muốn.
- Viết sau một interface trong billing (vd. `BackgroundWork`) để sau này đổi sang BullMQ mà không sửa service nghiệp vụ.
- Cột / index cần thêm (Phần 1): `next_attempt_at` cho `e_invoices`, `refunds`, `invoice_adjustments`; index `(status, next_attempt_at)` trên ba bảng đó; index `top_ups (status, expires_at)`.

## D5. `InvoiceAdjustment` bổ sung

- Thêm `refundId` (FK → refunds, unique).
- Thêm `providerAdjustmentNo` [0..1].
- `issuedAt` thành [0..1].
- Thêm `adjustmentStatus` và `attemptCount`, `lastErrorKind`, `lastErrorMessage`, `lastAttemptAt` theo cùng mô hình `EInvoice` (STM-7).
- Hoàn khoản trễ không có điều chỉnh hoá đơn (không có hoá đơn gốc).

## D6. E-invoice dùng stub

- `EInvoiceProviderAdapter` là implementation giả lập, không gọi HTTP ra ngoài.
- Trả `invoiceNo` / `adjustmentNo` giả theo định dạng ổn định.
- Có cấu hình (env hoặc config test) để giả lập: thành công, lỗi `transient` (timeout/5xx), lỗi `data`, độ trễ.
- Thiết kế qua interface để sau này thay bằng provider thật mà không sửa `EInvoiceService`.

## D7. Sửa nhỏ đã thống nhất

- `einvoice.issue` chỉ đẩy khi cộng tiền thành công.
- Hoàn khoản trễ ghi DB trước rồi mới chuyển tiền, giống hoàn top-up (nay qua D1).
- `AccountClosureService` gọi `TopUpService.hasOpenTopUp`, `TopUpService.listCreditedNewestFirst` và `SessionQuery.hasRunningSession` (WF-01/03).
- `allocateNewestFirst(account, refundAmountVnd)`: chia về các top-up `credited` mới nhất trước, mỗi phần ≤ `amountPaidVnd`; tạo các refund `closure_part`; không ghi thêm sổ cái, top-up vẫn `credited`.
- `RETRY_LIMIT`, `PENDING_TIMEOUT = 15 phút`, `LATE_WINDOW = 1 giờ`, ngưỡng của sweeper đặt trong config, không hard-code.

## D8. Khớp với repo hiện tại (khảo sát 03/11, commit `ce3902c`)

- Schema billing đã có từ migration 0003. D1 và D5 làm bằng **một migration mới** (số `0010` vì nhánh `wp2/be-11-bo-payment-mode-free` của Trí đã dùng `0009`; đặt tên kiểu `0010_billing-refunds-wf02.sql`, báo nhóm là đã giữ số này): tạo enum `refund_kind`, `refund_status`, bảng `refunds`, thêm cột cho `invoice_adjustments`, index cho sweeper. Ghi `docs/NHAT-KY-MIGRATION-0010.md`. Mã task: **T32** ("Iteration 1 + test: WF-02 nạp Charging Credit"); mọi nhánh WF-02 dạng `wp5/t32-<mo-ta>`, commit kèm `[T32]`.
- Nếu trùng số migration: người merge sau đổi tên file sang số kế tiếp, đổi tên test và nhật ký đi kèm, rebase; DB local đã áp tên cũ thì dựng lại (`npm run demo:reset`), test tích hợp tự reset. Tiền lệ: `docs/ITERATION-1-WF04.md`.
- `invoice_adjustments.issued_at` hiện `NOT NULL DEFAULT now()` → migration bỏ NOT NULL và DEFAULT (D5).
- `top_ups.late_refunded_at` và `credit_accounts.closure_refunded_at` đã có, chỉ đổi nghĩa theo D1, không đổi schema.
- Enum lỗi hiện tên `e_invoice_error_kind` (`transient`, `data`). Dùng lại cho `refunds.last_error_kind` hoặc tạo enum chung; chọn khi viết migration và ghi lý do.

## D9. Chốt sau khảo sát repo (03/11)

- **Sổ cái khi trừ tiền phiên sạc:** phương án (a). Billing làm `CreditLedgerService.post` và `LoyaltyService.earnForSession`; sau khi Phần 3 merge, WP3 (Sơn) thay SQL thô trong `charge-settlement.service.ts` bằng lời gọi hai service này. Cho tới lúc đó, code WP3 giữ nguyên; billing không sửa file của WP3. Mọi nơi ghi sổ khoá `credit_accounts FOR UPDATE` trước khi tính `entry_no`.
- **Tạo tài khoản:** billing cung cấp `ensureAccounts(driverId)` idempotent (tạo `credit_accounts` + `loyalty_accounts`, `INSERT … ON CONFLICT DO NOTHING`). Luồng đăng ký tài xế (khi có) gọi hàm này; billing tự gọi khi tạo top-up.
- **Đường dẫn:** billing quyết. Tài xế `/api/driver/v1/top-ups…`; admin `/api/admin/billing/…` (theo hợp đồng mà dashboard đang giả định, xem D10); VNPay IPN và return dưới tiền tố công khai `/payment/vnpay/ipn`, `/payment/vnpay/return`. Sửa `infra/.env.example` trong cùng PR; báo sớm người lo Caddy staging và app Flutter khi chốt.
- **Việc nền:** quét DB, xem D4.

## D10. Hợp đồng admin mà nhánh dashboard đang giả định (`wp4/fe-01-dashboard-shell`, chưa merge, dùng mock)

| Dashboard gọi | Dùng cho | Ghi chú cần thống nhất với WP4 |
|---|---|---|
| `GET /api/admin/billing/top-ups?status=credited` | danh sách top-up có thể hoàn | |
| `POST /api/admin/billing/top-ups/{id}/refund` → `{status:'refunded', refundedVnd, pointsRestored}` | hoàn top-up (E) | Theo D1, top-up `refunded` ngay nhưng tiền về sau: nên trả thêm `refund: {id, status:'requested'}` |
| `GET /api/admin/billing/top-ups/late-payments` | khoản trễ | |
| `POST /api/admin/billing/top-ups/{id}/late-refund` → `{lateRefundedAt}` | hoàn khoản trễ (F) | Theo D1, `lateRefundedAt` chỉ có khi refund `done`: nên trả `{refund: {id, status:'requested'}}` |
| `GET /api/admin/billing/e-invoices?status=needs_review`, `POST …/e-invoices/{id}/retry` | retry hoá đơn (G) | Dashboard dùng `lastErrorKind: 'temporary' \| 'rejected'`; DB dùng `transient \| data`. Chốt một bộ tên |
| `GET /api/admin/billing/credit-accounts?status=closed_unrefunded`, closure refund | hoàn khi đóng tài khoản (SD-2e B) | Trả danh sách refund `closure_part` `requested` |
| (chưa có) | danh sách refund `failed` + `POST …/refunds/{id}/retry` | Cần WP4 thêm màn hình hoặc mục cho R8 |

Dashboard dùng mock nên không chặn backend. Lấy bảng này làm hợp đồng ban đầu, đối chiếu lại khi nhánh dashboard merge.

## Còn mở (hỏi trước khi code phần liên quan)

- Nếu nhánh khác cũng lấy `0010` trước khi bạn merge: người merge sau đổi số (xem D8).
- Thống nhất D10 với người làm dashboard.
- Diagram mới (BA đã đưa lên Drive) cần đẩy vào `diagrams/wf02/`.
- Đổi tên `lateGatewayRef` → `lateGatewayTransactionNo`?
- VNPay sandbox: refund có chống trùng không, có API tra trạng thái hoàn không, thời hạn được hoàn, danh sách mã IPN.
- Cách tạo `CreditAccount` + `LoyaltyAccount` khi tài xế đăng ký (WF-05 gọi billing hay billing nghe event).
- Chiều gọi `session_debit` và loyalty `earn` từ WF-01/03.
