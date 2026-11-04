# WF-02 – Quyết định thiết kế

> Đặt tại `docs/spec/WF-02_decisions.md`. Cập nhật: 03/11/2026.
> **Nguồn chính là diagram trong `diagrams/wf02/`** (CD-2, SD-2a…2f v2.0, 01/11/2026, bản đã chia sẻ vào tài liệu chung của nhóm). File này chỉ ghi lại:
> (1) những điểm trong diagram mà code phải bám, viết ra cho dễ tra;
> (2) cách khớp diagram với repo hiện tại;
> (3) các **bổ sung chưa có trong diagram** (đánh dấu ⊕). Khi vẽ lại diagram, đưa các mục ⊕ vào rồi ghi "đã vào diagram".
> Diagram và file này mâu thuẫn thì theo diagram và sửa file này. Diagram mâu thuẫn với code, SRS hoặc ADR thì dừng lại hỏi.

## Bảng diagram

| Diagram | Luồng | State machine |
|---|---|---|
| CD-2 `CD-2_topup_classes.puml` | Class của module billing (chỉ thành viên chính) | |
| SD-2a `SD-2a_create_topup.puml` | Tài xế tạo top-up, chuyển sang trang thanh toán | STM-4 |
| SD-2b `SD-2b_ipn_credit.puml` | IPN cộng tiền đúng một lần | STM-4, STM-5, STM-7 |
| SD-2c `SD-2c_einvoice_issue.puml` | Xuất e-invoice chạy nền, có retry | STM-7 |
| SD-2d `SD-2d_timeout_late_payment.puml` | Quá 15 phút chưa có kết quả; thanh toán trễ | STM-4 |
| SD-2e `SD-2e_admin_refund.puml` | Admin hoàn top-up; gửi refund về nguồn thanh toán | STM-4, STM-10, STM-7 |
| SD-2f `SD-2f_close_account.puml` | Tài xế đóng tài khoản, hoàn số dư | STM-5, STM-10 |

STM-4 TopUp, STM-5 CreditAccount, STM-7 EInvoice (cũng dùng cho InvoiceAdjustment), **STM-10 Refund** (STM-8 đã là RfidCard). File STM-10 chưa có trong `diagrams/stm/`; tạm lấy chuyển trạng thái ở D1.

## D1. Hoàn tiền: ghi quyết định trước, chuyển tiền sau (SD-2e, STM-10)

**Phần 1: Admin ghi nhận hoàn**, một DB transaction trong `TopUpService.refund(topUpId, adminId)`:
- Kiểm tra top-up `credited` và số dư ≥ số tiền; sai thì `RefundNotAllowed(reason)` → 409 / 422 `{reason}`.
- `credited → refunded`; `CreditLedgerService.post(accountId, refund, −amountVnd, topUpId)`.
- Nếu top-up có dùng điểm: `LoyaltyService.restoreForTopUp(topUp)`.
- `RefundService.create(topUpId, kind = top_up, amountPaidVnd, adminId)` → refund `requested`.
- Trả **202 `{refundId, status: 'requested'}`**.

**Phần 2: gửi refund về nguồn thanh toán**, chạy nền theo từng lượt: `RefundService.send(refundId)` → `VnpayAdapter.refund(ref, amountVnd)` (timeout 10 s):
- Kết quả không rõ → **truy vấn trạng thái trước khi gửi lại** (tránh hoàn hai lần).
- VNPay xác nhận → `requested → done`; sau đó `EInvoiceService.adjustForRefund(refund)` chạy bất đồng bộ (tạo InvoiceAdjustment `requested → issued`, STM-7); báo tài xế (MSG25).
- Lỗi tạm thời và chưa hết 4 lượt → ghi lỗi, vẫn `requested`, hẹn lại sau 5 phút / 30 phút / 2 giờ.
- Bị từ chối, hoặc lượt thứ 4 lỗi → `requested → failed`, đưa lên Billing Exceptions, báo Admin.

**Cùng mẫu:** hoàn khoản trễ (`TopUpService.refundLatePayment`, `kind = late_payment`, **không ghi sổ cái**, không có điều chỉnh hoá đơn); Admin retry refund `failed` (`RefundService.retry(refundId, adminId)`: một lượt thử, không reset bộ đếm).

**STM-10 Refund**
```
[*] → requested          RefundService.create (cùng transaction với quyết định hoàn)
requested → requested    lỗi tạm thời: attempt + 1, hẹn retry
requested → done         VNPay xác nhận
requested → failed       bị từ chối hoặc hết 4 lượt
failed → requested       Admin retry (1 lượt, không reset bộ đếm)
```
Không có `failed → done`.

**Entity `Refund`** (CD-2; cột theo quy ước repo, cột trạng thái tên là `status`)

| Thuộc tính | Ghi chú |
|---|---|
| `id` | PK bigint |
| `topUpId` | FK → top_ups (TopUp 1 – 0..* Refund) |
| `kind` | enum `top_up` · `late_payment` · `account_closure` |
| `amountVnd` | bigint > 0 |
| `status` | enum `requested` · `done` · `failed` |
| `attemptCount` | int, mặc định 0 |
| `requestedBy` [0..1] | FK → users (Admin); **null = hệ thống tạo** (đóng tài khoản, SD-2f) |
| `lastErrorKind`, `lastErrorMessage`, `lastAttemptAt` [0..1] | theo mẫu `e_invoices` |
| `gatewayRefundNo` [0..1] | mã hoàn VNPay trả về |
| `nextAttemptAt` [0..1] | lịch chạy nền (D4) |
| `createdAt`, `completedAt` [0..1] | |

Ràng buộc / index đề xuất cho migration:
- Partial unique `(top_up_id, kind) WHERE kind IN ('top_up','late_payment')`.
- CHECK `kind = 'account_closure' OR requested_by IS NOT NULL`.
- CHECK `(status = 'done') = (completed_at IS NOT NULL)`; `status <> 'done' OR gateway_refund_no IS NOT NULL`.
- Index `(status, next_attempt_at)` cho worker; index `(top_up_id)`.

Nghĩa của cột đã có:
- `top_ups.late_refunded_at` = lúc refund `late_payment` chuyển `done`.
- `credit_accounts.closure_refunded_at` = lúc **mọi** refund `account_closure` của tài khoản đã `done`.

## D2. Tạo top-up (SD-2a)

- `POST …/billing/top-ups {amountVnd, redeemPoints}`, header `Idempotency-Key`. Cùng key trả lại cùng top-up.
- Kiểm tra: tài khoản chưa đóng, hạn mức **BR-P22 theo ADR-0013**: mỗi lần nạp 50.000–2.000.000 VND, số dư sau nạp ≤ 5.000.000 VND; không có top-up đang mở khác. Sai → `TopUpRejected(reason)` → 409 / 422 `{reason}`.
- `redeemPoints` và còn ≥ 500 điểm → tính `discountVnd`. **Chỉ trừ điểm khi cộng tiền** (SD-2b).
- Lưu top-up `pending`, `expiresAt = now + 15 phút`; `VnpayAdapter.buildPaymentUrl(topUp, amountVnd − discountVnd)`; trả **201 `{topUpId, paymentUrl}`**.
- Return URL chỉ hiển thị. Chỉ IPN có chữ ký (SD-2b) hoặc querydr sau 15 phút (SD-2d) mới cộng tiền.
- ⊕ "Top-up đang mở" chỉ tính `pending`; `expired` (kể cả trong cửa sổ trễ 1 giờ) không chặn tạo mới.
- ⊕ Khi bị chặn vì có top-up `pending`: 409 trả thêm `topUpId` và `paymentUrl` để app hỏi "tiếp tục thanh toán?".

## D3. IPN cộng tiền (SD-2b)

`VnpayIpnController.handleIpn` → `TopUpService.applyPaymentResult(ipn)`, luôn trả 200 `{RspCode, Message}`:

| Trường hợp | Kết quả | RspCode |
|---|---|---|
| Sai chữ ký / không thấy top-up / sai số tiền | không ghi gì | 97 / 01 / 04 |
| Đã áp dụng rồi | không ghi gì | 02 |
| Thanh toán lỗi hoặc huỷ | `pending → failed` | 00 |
| Đã trả | `pending → credited`, `CreditLedgerService.post(+amountVnd)` (`in_shortfall → active` nếu số dư ≥ 0), `LoyaltyService.redeemForTopUp` nếu có dùng điểm, `EInvoiceService.requestForTopUp` chạy sau commit | 00 |

Cộng tiền, dòng sổ cái và điểm nằm trong **một** DB transaction, nên IPN lặp không cộng hai lần.
⊕ Realtime emit số dư mới sau commit.

## D4. Timeout và thanh toán trễ (SD-2d)

- 15 phút sau khi tạo mà chưa có IPN: `TopUpService.onPendingTimeout(topUpId)`; nếu vẫn `pending` thì `VnpayAdapter.queryTransaction(ref)` (querydr, 10 s). Đã trả → `pending → credited` + ghi sổ; chưa trả → `pending → expired`.
- IPN đến khi top-up `expired`:
  - trong vòng 1 giờ sau khi hết hạn và chưa áp dụng → `expired → credited` + ghi sổ;
  - quá 1 giờ → ghi khoản trễ (`late_*`), top-up vẫn `expired`, đưa lên Billing Exceptions để Admin hoàn (SD-2e, `late_payment`).
  - Trả 00.
- ⊕ Mọi đường cộng tiền ở đây (querydr, IPN trễ) làm giống nhánh "đã trả" của SD-2b: trừ điểm đã dùng và yêu cầu e-invoice.
- ⊕ Trước khi cộng tiền trễ, **kiểm tra lại** tài khoản chưa đóng và số dư sau nạp ≤ 5.000.000. Vi phạm → không cộng, ghi thành khoản trễ để Admin hoàn.
- ⊕ querydr lỗi hoặc timeout → giữ `pending`, hẹn quét lại; không chuyển `expired` khi chưa biết kết quả.

## D5. E-invoice (SD-2c, STM-7) và InvoiceAdjustment

- `EInvoiceService.issue(invoiceId)` chạy nền; `EInvoiceProviderAdapter.createInvoice(...)` timeout 10 s.
  - Có `invoiceNo` → `requested → issued`.
  - Lỗi tạm thời, chưa hết 4 lượt → `requested → failed`, attempt + 1, hẹn 5 phút / 30 phút / 2 giờ. Đến hạn: `failed → requested` rồi thử lại.
  - Bị từ chối (`data`) hoặc lượt thứ 4 lỗi → `needs_review`, báo Admin (Billing Exceptions).
  - Admin retry `needs_review`: một lượt, không reset bộ đếm.
- Top-up luôn giữ `credited`, dù hoá đơn ra sao.
- **InvoiceAdjustment**: EInvoice 1 – 0..* InvoiceAdjustment; Refund 1 – 0..1 InvoiceAdjustment. Tạo bởi `adjustForRefund` **sau khi refund `done`**; trạng thái `requested · issued · failed · needs_review` và retry giống EInvoice. Hoàn khoản trễ không có điều chỉnh hoá đơn (không có hoá đơn gốc).
- Cột thêm cho `invoice_adjustments` (khớp repo): `refund_id` (FK, unique), `status`, `attempt_count`, `last_error_kind`, `last_error_message`, `last_attempt_at`, `next_attempt_at`, `provider_adjustment_no` [0..1]; `issued_at` thành [0..1].
- Provider là **stub**: không gọi HTTP; trả `invoiceNo` / `adjustmentNo` giả theo định dạng ổn định; cấu hình được để giả lập thành công, lỗi `transient`, lỗi `data`, độ trễ; viết qua interface để sau thay provider thật.

## D6. Đóng tài khoản (SD-2f)

`POST …/me/account/close` → `AccountClosureService.requestClosure(driverId)`:
- Kiểm tra: tài khoản `active` (số dư ≥ 0), không có top-up đang mở, không có phiên sạc đang chạy. Sai → `ClosureNotAllowed(reason)` → 409 / 422.
- `CreditLedgerService.post(accountId, refund, −balanceVnd)` đưa số dư về 0.
- Chia số dư về các top-up `credited` **mới nhất trước**, mỗi phần ≤ `amountPaidVnd` của top-up đó; mỗi phần gọi `RefundService.create(topUpId, kind = account_closure, shareVnd, requestedBy = null)`.
- `active → closed`, khoá đăng nhập; trả **200 `{closed, refundTotalVnd}`**.
- Mỗi refund được gửi như SD-2e phần 2. **Admin không cần làm gì**; refund `failed` hiện ở Billing Exceptions như các refund khác.
- Repo: khoá đăng nhập qua interface `UserAccountService.disableLogin` (stub, chưa có module `users`); kiểm tra phiên đang chạy qua `SessionQuery.hasRunningSession` (stub).

## D7. Việc nền chạy bằng quét DB ⊕

Diagram chỉ ghi "job" / "queue" / "after commit". Repo chưa có BullMQ (Redis có nhưng chưa dùng), nên chốt 03/11:
- DB là nguồn sự thật: `status` + `attempt_count` + `next_attempt_at` nằm trên dòng nghiệp vụ, giống `charge_settlement_jobs` của WP3.
- Mỗi loại việc có một worker quét `… WHERE <điều kiện đến hạn> ORDER BY next_attempt_at LIMIT n FOR UPDATE SKIP LOCKED`, xử lý từng dòng trong transaction riêng:
  - `refunds`: `status = 'requested' AND next_attempt_at <= now()` → `RefundService.send`.
  - `e_invoices`, `invoice_adjustments`: `status IN ('requested','failed') AND next_attempt_at <= now()` → `EInvoiceService.issue` / điều chỉnh.
  - `top_ups`: `status = 'pending' AND expires_at <= now()` → `TopUpService.onPendingTimeout` (dùng `expires_at` đã có).
- `Scheduler` (`src/common/scheduler.ts`) chỉ để **chạy sớm** (ngay sau commit, đúng `expires_at`); mất khi sập cũng được vì vòng quét bắt lại. Lúc khởi động mỗi worker quét một lần.
- Lịch retry: `next_attempt_at = now() + 5 phút / 30 phút / 2 giờ`; một helper dùng chung cho e-invoice và refund. `RETRY_LIMIT = 4`, `PENDING_TIMEOUT = 15 phút`, `LATE_WINDOW = 1 giờ` đặt trong config.
- Viết sau interface `BackgroundWork` trong billing để sau đổi sang BullMQ mà không sửa service.
- Index cần: `(status, next_attempt_at)` trên `e_invoices`, `invoice_adjustments`, `refunds`; `top_ups (status, expires_at)`.

## D8. Khớp với repo

- **Migration `0012`** (theo CD-2), tên kiểu `0012_billing-refunds-wf02.sql`. `migrate.mjs` áp theo thứ tự tên file, nên chưa có `0010`/`0011` vẫn chạy được. Nội dung: enum `refund_kind`, `refund_status`, bảng `refunds`, cột mới cho `invoice_adjustments` và `e_invoices.next_attempt_at`, index của D7. Kèm `docs/NHAT-KY-MIGRATION-0012.md` và `test/migration-0012.integration.test.ts`. Báo nhóm đã giữ số này. Nếu trùng số: người merge sau đổi sang số kế tiếp, đổi cả test và nhật ký (tiền lệ `docs/ITERATION-1-WF04.md`).
- `refunds.last_error_kind`: dùng lại enum `e_invoice_error_kind` (`transient`, `data`) hoặc tạo enum chung; chọn khi viết migration và ghi lý do.
- Mã task **T32**; nhánh `wp5/t32-<mo-ta>`; commit kèm `[T32]`.
- **Đường dẫn:** giữ phần tài nguyên của diagram, ghép tiền tố theo `docs/api/DRIVER-API-HOP-DONG.md`:

  | Diagram | Code |
  |---|---|
  | `POST /billing/top-ups`, `GET /billing/top-ups/{id}` | `/api/driver/v1/billing/top-ups…` |
  | `POST /me/account/close` | `/api/driver/v1/me/account/close` |
  | `POST /admin/billing/…` | `/api/admin/billing/…` |
  | `GET /billing/vnpay/ipn` | `/billing/vnpay/ipn` (công khai, không xác thực, chỉ dựa chữ ký); return URL `/billing/vnpay/return` |

  Sửa `infra/.env.example` trong cùng PR; báo người lo Caddy staging và app Flutter.
- **Chỗ CD-2 lệch code** (theo code, ghi vào `diagrams/README.md` mục "Known differences"):
  - `CreditTransaction.transactionType` có `reservation_fee`; enum `credit_transaction_type` không có.
  - Tiền ghi `number`; code dùng `bigint` VND (Drizzle `mode: 'number'` ở tầng TS, không dùng số thực).
  - CD-2 chỉ có thành viên chính. Code thêm các class / method sau, không mâu thuẫn diagram: `TopUpStateMachine`, `RefundStateMachine`, worker của D7, `BillingExceptionsQuery`, `CreditLedgerService.getBalance`, `ensureAccounts`, `LoyaltyService.quoteRedemption` / `earnForSession`.
- SD-2a ghi "monthly cap": theo ADR-0013 thì BR-P22 không có hạn mức tháng. Code theo ADR-0013; cần sửa diagram.

## D9. Ranh giới với WP3 và tạo tài khoản ⊕

- **Sổ cái khi trừ tiền phiên sạc:** billing làm `CreditLedgerService.post` và `LoyaltyService.earnForSession`. Sau khi Phần 3 merge, WP3 (Sơn) thay SQL thô trong `charge-settlement.service.ts` bằng lời gọi hai hàm này. Tới lúc đó code WP3 giữ nguyên, billing không sửa file của WP3. Mọi nơi ghi sổ khoá `credit_accounts FOR UPDATE` trước khi tính `entry_no`.
- **Tạo tài khoản:** `ensureAccounts(driverId)` idempotent (tạo `credit_accounts` + `loyalty_accounts`, `INSERT … ON CONFLICT DO NOTHING`). Luồng đăng ký tài xế (khi có) gọi hàm này; billing tự gọi khi tạo top-up.

## D10. Hợp đồng admin với dashboard (`wp4/fe-01-dashboard-shell`, chưa merge, dùng mock)

| Dashboard gọi | Dùng cho | Cần thống nhất với WP4 (theo diagram) |
|---|---|---|
| `GET /api/admin/billing/top-ups?status=credited` | top-up có thể hoàn | |
| `POST /api/admin/billing/top-ups/{id}/refund` | hoàn top-up (SD-2e) | Dashboard đang mong `{status:'refunded', refundedVnd, pointsRestored}`; SD-2e trả **202 `{refundId, status:'requested'}`** |
| `GET /api/admin/billing/top-ups/late-payments` | khoản trễ | |
| `POST /api/admin/billing/top-ups/{id}/late-refund` | hoàn khoản trễ | Dashboard mong `{lateRefundedAt}`; theo SD-2e trả `{refundId, status:'requested'}`, `lateRefundedAt` chỉ có khi refund `done` |
| `GET /api/admin/billing/e-invoices?status=needs_review`, `POST …/e-invoices/{id}/retry` | retry hoá đơn (SD-2c) | Dashboard dùng `lastErrorKind: 'temporary' \| 'rejected'`; DB dùng `transient \| data`. Chốt một bộ tên |
| `GET /api/admin/billing/credit-accounts?status=closed_unrefunded` | tài khoản đóng chờ hoàn | Theo SD-2f, Admin **không** phải bấm hoàn: chỉ để xem các refund `account_closure` chưa `done` |
| (chưa có) | refund `failed` + `POST …/refunds/{id}/retry` | WP4 cần thêm mục này |

## Còn mở (hỏi trước khi code phần liên quan)

- Vẽ lại diagram: đưa các mục ⊕ vào; sửa "monthly cap" ở SD-2a; bỏ `reservation_fee` ở CD-2; thêm file STM-10 Refund vào `diagrams/stm/`.
- Thống nhất D10 với WP4.
- Đổi tên `lateGatewayRef` → `lateGatewayTransactionNo`?
- VNPay sandbox: refund có chống trùng không, có API tra trạng thái hoàn không (`VnpayAdapter.queryRefund`), thời hạn được hoàn, danh sách mã IPN.
- Cách tạo `CreditAccount` + `LoyaltyAccount` khi tài xế đăng ký (WF-05 gọi billing hay billing nghe event).
- Chiều gọi `session_debit` và loyalty `earn` từ WF-01/03.
