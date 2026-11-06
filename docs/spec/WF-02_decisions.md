# WF-02 – Quyết định thiết kế

> Đặt tại `docs/spec/WF-02_decisions.md`. Cập nhật: 06/11/2026.
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
| SD-2f `SD-2f_close_account.puml` | Tài xế đóng tài khoản; Admin hoàn số dư (**diagram vẽ sai**, theo D6) | STM-5, STM-10 |

STM-4 TopUp, STM-5 CreditAccount, STM-7 EInvoice (cũng dùng cho InvoiceAdjustment), **STM-10 Refund** (STM-8 đã là RfidCard; file `diagrams/stm/STM-10_Refund.puml` v1.0, 01/11). Code: `TopUpStateMachine`, `RefundStateMachine` trong `apps/csms/src/billing/` (T32 Phần 2).

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
| `requestedBy` [0..1] | FK → `admins (user_id)` (ISA của BE-16/0011; chốt 04/11). Thay `top_ups.refunded_by` (bỏ ở 0015, ERD Alignment B5). 0015 cho phép null với `account_closure` (theo SD-2f cũ). Từ 06/11, refund `account_closure` cũng do Admin tạo (D6), nên code **luôn ghi** `requestedBy` |
| `lastErrorKind`, `lastErrorMessage`, `lastAttemptAt` [0..1] | theo mẫu `e_invoices` |
| `gatewayRefundNo` [0..1] | mã hoàn VNPay trả về |
| `nextAttemptAt` [0..1] | lịch chạy nền (D4) |
| `createdAt`, `completedAt` [0..1] | |

Ràng buộc / index đề xuất cho migration:
- Partial unique `(top_up_id, kind) WHERE kind IN ('top_up','late_payment')`.
- CHECK `kind = 'account_closure' OR requested_by IS NOT NULL` (đã có ở 0015; có thể siết thành `requested_by IS NOT NULL`, xem "Còn mở").
- CHECK `(status = 'done') = (completed_at IS NOT NULL)`; `status <> 'done' OR gateway_refund_no IS NOT NULL`.
- Index `(status, next_attempt_at)` cho worker; index `(top_up_id)`.

Nghĩa của cột đã có:
- `top_ups.late_refunded_at` = lúc refund `late_payment` chuyển `done`.
- `credit_accounts.closure_refunded_at` = lúc tài khoản `closed` không còn refund `account_closure` nào chưa `done` (chốt 06/11, D6). Có ba trường hợp:
  - refund cuối cùng chuyển `done`;
  - bước 2 không tạo refund nào (toàn bộ số dư là phần dư) → `now()` trong cùng transaction;
  - số dư = 0 lúc đóng → `closed_at`, ghi ở bước 1.

## D2. Tạo top-up (SD-2a)

- `POST …/billing/top-ups {amountVnd, redeemPoints}`, header `Idempotency-Key`. Cùng key trả lại cùng top-up.
- Kiểm tra: tài khoản chưa đóng, hạn mức **BR-P22 theo ADR-0013**: mỗi lần nạp 50.000–2.000.000 VND, số dư sau nạp ≤ 5.000.000 VND; không có top-up đang mở khác. Sai → `TopUpRejected(reason)` → 409 / 422 `{reason}`.
- `redeemPoints` và còn ≥ 500 điểm → tính `discountVnd`. **Chỉ trừ điểm khi cộng tiền** (SD-2b). Điểm hết hạn trong lúc chờ thanh toán: xem D3 ⊕.
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
⊕ **Điểm đã dùng hết hạn trước lúc cộng tiền** (chốt 06/11). Tài xế đã trả giá sau giảm `amountVnd − discountVnd`, nên:
- vẫn cộng đủ `amountVnd`;
- `redeemForTopUp` ghi dòng `redeem` chỉ cho số điểm còn hiệu lực (`points` = −số điểm còn hiệu lực);
- phần điểm thiếu (điểm đã hết hạn) ghi thêm một dòng loyalty `adjust`, `top_up_id` = top-up, **`points = 0`**:
  - dòng `expire` đã trừ các điểm này rồi, nên dòng `adjust` không trừ thêm và `pointsBalance` không bị âm;
  - dòng này chỉ ghi lại rằng top-up đã được giảm giá cho số điểm không còn. Số điểm thiếu = `top_ups.points_redeemed` − |Σ `redeem` của top-up|;
- không từ chối, không bắt tài xế trả thêm.

Áp dụng cho mọi đường cộng tiền (D4).
⊕ **`restoreForTopUp` (Admin hoàn top-up, D1) trả lại số điểm thực tế đã trừ** = −Σ `points` của các dòng `redeem` có `top_up_id` này (giữ hạn cũ). Không lấy theo `top_ups.points_redeemed`, vì như vậy sẽ trả dư phần điểm đã hết hạn.
⊕ Kết quả thanh toán tới khi top-up đã có kết quả không đổi trạng thái (BR-P13), không ném lỗi (chốt 04/11, T32 Phần 2):
- `already_applied` → RspCode 02: thành công trên `credited` / `refunded` với `transactionNo` = `gateway_transaction_no` đã ghi; lỗi trên `failed` / `expired`.
- `conflicting_result` → không ghi gì, service log warn: thành công trên `credited` / `refunded` với `transactionNo` **khác** (có thể là lần trả thứ hai cho cùng top-up); lỗi trên `credited` / `refunded`.
- Timeout (`TIMEOUT_NOT_PAID`) tới khi đã rời `pending` → `stale`, bỏ qua (đua với IPN qua Scheduler).
- Chỉ Admin hoàn sai trạng thái mới ném `InvalidTransition`.
⊕ Realtime emit số dư mới sau commit.

## D4. Timeout và thanh toán trễ (SD-2d)

- 15 phút sau khi tạo mà chưa có IPN: `TopUpService.onPendingTimeout(topUpId)`; nếu vẫn `pending` thì `VnpayAdapter.queryTransaction(ref)` (querydr, 10 s). Đã trả → `pending → credited` + ghi sổ; chưa trả → `pending → expired`.
- IPN đến khi top-up `expired`:
  - trong vòng 1 giờ sau khi hết hạn và chưa áp dụng → `expired → credited` + ghi sổ;
  - quá 1 giờ → ghi khoản trễ (`late_*`), top-up vẫn `expired`, đưa lên Billing Exceptions để Admin hoàn (SD-2e, `late_payment`).
  - Trả 00.
- ⊕ Mọi đường cộng tiền ở đây (querydr, IPN trễ) làm giống nhánh "đã trả" của SD-2b: trừ điểm đã dùng (điểm hết hạn thì ghi `adjust` cho phần thiếu, D3 ⊕) và yêu cầu e-invoice.
- ⊕ Trước khi cộng tiền trễ, **kiểm tra lại** tài khoản chưa đóng và số dư sau nạp ≤ 5.000.000. Vi phạm → không cộng, ghi thành khoản trễ để Admin hoàn.
- ⊕ querydr lỗi hoặc timeout → giữ `pending`, hẹn quét lại; không chuyển `expired` khi chưa biết kết quả.
- ⊕ **Thành công tới khi top-up đã `failed`** (VNPay báo lỗi/huỷ trước, rồi báo đã trả): giữ `failed`, ghi khoản trễ như IPN sau cửa sổ (không cộng, không hoá đơn, Admin hoàn `late_payment`). Không xét cửa sổ trễ hay hạn mức. Chốt 04/11.
- ⊕ **Khoản trễ đã ghi rồi** (`late_gateway_ref` khác NULL, trên `expired` hoặc `failed`), có kết quả thành công mới:
  - cùng `transactionNo` → no-op `already_applied`, trả 02 (TC-STM4-15);
  - khác `transactionNo` → `conflicting_result`: không ghi gì, service log warn.
  - Kiểm **trước** guard cửa sổ, vì khoản trễ có thể đã ghi ngay trong cửa sổ khi vượt hạn mức.
- ⊕ **Cần migration mới** cho ý thứ nhất (số kế tiếp lúc làm Phần 6; 0015 đã merge): CHECK `top_ups_late_payment_status_check` của 0003 đang là `late_gateway_ref IS NULL OR status = 'expired'`, sẽ chặn khoản trễ trên `failed`.
  - Nới thành `status IN ('expired','failed')`.
  - Sửa COMMENT của `late_gateway_ref`.
  - Test cả ca hợp lệ (khoản trễ trên `failed`) lẫn ca bị chặn (trên `pending` / `credited` / `refunded`).
  - Trí review.
- ⊕ Khoản trễ chờ hoàn = `late_gateway_ref IS NOT NULL AND late_refunded_at IS NULL`, **không** lọc `status = 'expired'` (dashboard tab 2, `BillingExceptionsQuery`).

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

## D6. Đóng tài khoản (SD-2f; theo SRS UC-ACC-02 + UC-ADM-08) ⊕

SD-2f vẽ hệ thống tự hoàn ngay khi tài xế đóng tài khoản. SRS (UC-ACC-02, UC-ADM-08, §3.4.1) ghi **Admin thực hiện hoàn**. Chốt 06/11: theo SRS, SD-2f cần vẽ lại (mục "Còn mở"). Luồng chia thành hai bước.

**Bước 1: tài xế đóng tài khoản.** `POST …/me/account/close` → `AccountClosureService.requestClosure(driverId)`, một DB transaction:
- Kiểm tra: tài khoản `active` (số dư ≥ 0), không có top-up đang mở, không có phiên sạc đang chạy, **không có phiên đã dừng mà chưa quyết toán** (`charge_settlement_jobs.state = 'pending'`, xem "Còn mở"). Sai → `ClosureNotAllowed(reason)` → 409 / 422 (MSG23).
- `active → closed`, ghi `closed_at`, khoá đăng nhập.
- **Không ghi sổ cái, không tạo refund.** Số dư giữ nguyên tới khi Admin hoàn.
- Số dư = 0 lúc đóng: không có gì để hoàn, nên ghi luôn `closure_refunded_at = closed_at`. Tài khoản này không vào danh sách chờ hoàn.
- Trả **200 `{closed: true}`**.

**Bước 2: Admin hoàn số dư.** `POST /api/admin/billing/credit-accounts/{id}/closure-refund` → `AccountClosureService.refundClosedAccount(accountId, adminId)`, một DB transaction:
- **Guard chống bấm đúp:** unique `(top_up_id, transaction_type)` không chặn được dòng `refund` có `top_up_id` NULL. Vì vậy:
  - khoá `credit_accounts … FOR UPDATE` trước;
  - chỉ chạy khi `status = 'closed'` và `balance_vnd > 0`; ngược lại → `RefundNotAllowed(reason)` → 409.
  - Request thứ hai chờ khoá, sau đó thấy số dư = 0 và bị từ chối.
- Chia số dư về các top-up `credited` (chưa hoàn) **mới nhất trước**. Mỗi phần ≤ `amountPaidVnd` của top-up đó (tiền thật đã trả qua VNPay).
- **Phần dư không hoàn được:** nếu số dư lớn hơn tổng `amountPaidVnd` của các top-up này (vd. phần giảm giá bằng điểm, bút toán `adjustment` cũ), phần vượt là phần dư. Phần dư không hoàn về nguồn nào. SRS chưa nói gì về trường hợp này (BR-P21, mục "Còn mở").
- Ghi sổ, đưa số dư về 0:
  - `CreditLedgerService.post(accountId, refund, −tổng các phần)`: một dòng, `top_up_id` NULL. Unique `(top_up_id, transaction_type)` chỉ áp khi `top_up_id` khác NULL.
  - Nếu có phần dư: `CreditLedgerService.post(accountId, adjustment, −phần dư)`.
  - `CreditLedgerService.post` trên tài khoản `closed` **chỉ nhận** loại `refund` và `adjustment`; loại khác bị từ chối. Không đổi `status`, vì `active ↔ in_shortfall` không áp dụng ở đây.
- Mỗi phần gọi `RefundService.create(topUpId, kind = account_closure, shareVnd, requestedBy = adminId)` → refund `requested`.
- Không tạo refund nào (toàn bộ số dư là phần dư) → ghi `closure_refunded_at = now()` trong cùng transaction.
- Trả **202 `{refundIds, refundTotalVnd, nonRefundableVnd, status: 'requested'}`**.
- Mỗi refund được gửi như SD-2e phần 2: `done` thì điều chỉnh hoá đơn và báo tài xế (MSG25); `failed` thì hiện ở Billing Exceptions, Admin retry. Khi không còn refund `account_closure` nào chưa `done` thì ghi `closure_refunded_at` (D1).

Repo: khoá đăng nhập qua interface `UserAccountService.disableLogin` (stub, chưa có module `users`); kiểm tra phiên đang chạy qua `SessionQuery.hasRunningSession` (stub); phiên chưa quyết toán cần thêm `hasUnsettledSession` (xem "Còn mở").

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

- **Migration `0015_billing-refunds-wf02.sql`.** CD-2 ghi 0012, nhưng `0010`–`0012` đã dùng cho BE-16 (Trí, PR #84, merge trước theo thoả thuận 04/11), `0013` cho BE-07 (PR #82), `0014` cho BE-16 đợt 2 (PR #86), nên người merge sau đổi sang số kế tiếp (tiền lệ `docs/ITERATION-1-WF04.md`). Nội dung: enum `refund_kind`, `refund_status`, bảng `refunds`, cột mới cho `invoice_adjustments` và `e_invoices.next_attempt_at`, index của D7, và **B5** (bỏ `top_ups.refunded_by`). Kèm `docs/NHAT-KY-MIGRATION-0015.md` và `test/migration-0015.integration.test.ts`.
- `refunds.last_error_kind` (và `invoice_adjustments.last_error_kind`): **dùng lại enum `e_invoice_error_kind`** (`transient`, `data`), chốt 04/11 khi viết 0015. Lý do: cùng nghĩa, một helper retry dùng chung (D7); không đổi tên enum của 0003 đã merge. `invoice_adjustments.status` dùng lại `e_invoice_status` (D5). Chi tiết: `docs/NHAT-KY-MIGRATION-0015.md` mục 2. Theo quy ước BE-16: mọi FK có index (A5), FK của `refunds` giữ NO ACTION (C3).
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
  - ~~`CreditTransaction.transactionType` có `reservation_fee`; enum `credit_transaction_type` không có.~~ Hết lệch từ 0010 (BE-16): enum đã có `reservation_fee`, CD-2 đúng.
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
| `GET /api/admin/billing/credit-accounts?status=closed_unrefunded`, `POST …/credit-accounts/{id}/closure-refund` | tài khoản đóng chờ hoàn | Theo D6, **Admin bấm hoàn** (UC-ADM-08). Dashboard đang mong `{status:'refunded', allocations, uncoveredVnd}`; theo D6 trả **202** `{refundIds, refundTotalVnd, nonRefundableVnd, status:'requested'}`. Hộp thoại xác nhận phải hiện số **không hoàn được** (phần dư) trước khi Admin bấm |
| (chưa có) | refund `failed` + `POST …/refunds/{id}/retry` | WP4 cần thêm mục này |

## Còn mở (hỏi trước khi code phần liên quan)

- Vẽ lại diagram: đưa các mục ⊕ vào; sửa "monthly cap" ở SD-2a; ~~bỏ `reservation_fee` ở CD-2~~ (không cần nữa, 0010 đã thêm vào enum); ghi số migration 0015 thay 0012 ở CD-2; ~~thêm file STM-10 Refund vào `diagrams/stm/`~~ (đã có, v1.0).
- STM-4: thêm ghi chú ở `failed` giống ghi chú ở `expired` (thành công sau đó ghi thành khoản trễ, không cộng, Admin hoàn); ghi rõ kết quả lặp / khoản trễ trùng `transactionNo` là no-op (D3, D4 ⊕).
- Thống nhất D10 với WP4.
- **SD-2f cần vẽ lại** theo D6: tài xế chỉ đóng (bước 1), Admin hoàn (bước 2, `requestedBy = adminId`). Sửa cả nhãn SD-2f trong bảng diagram.
- **BR-P21 cần sửa SRS:** số dư lúc đóng lớn hơn tổng `amountPaidVnd` của các top-up `credited` chưa hoàn thì phần dư không hoàn được, ghi credit `adjustment` −phần dư để số dư về 0 (D6, chốt 06/11). BR-P21 hiện chưa nói về trường hợp này.
- **Migration mới ở Phần 6** (gộp với migration nới `top_ups_late_payment_status_check`, D4 ⊕) có thể siết `refunds_requested_by_check` của 0015 thành `requested_by IS NOT NULL`, vì giờ mọi `kind` đều do Admin tạo (D6). Trí review.
- **Lần trả thứ hai cho cùng top-up** (D3 ⊕: thành công với `transactionNo` khác trên `credited` / `refunded` → `conflicting_result`): tiền đã vào VNPay nhưng không có cột để ghi (`late_*` chỉ dành cho top-up chưa cộng, `gateway_transaction_no` đã có giá trị). Cần chốt cách ghi và cách Admin hoàn (cột mới? bảng riêng? `refunds.kind` mới?) trước Phần 6.
- Đổi tên `lateGatewayRef` → `lateGatewayTransactionNo`?
- VNPay sandbox: refund có chống trùng không, có API tra trạng thái hoàn không (`VnpayAdapter.queryRefund`), thời hạn được hoàn, danh sách mã IPN.
- Cách tạo `CreditAccount` + `LoyaltyAccount` khi tài xế đăng ký (WF-05 gọi billing hay billing nghe event).
- Chiều gọi `session_debit` và loyalty `earn` từ WF-01/03.
- **Đóng tài khoản khi còn phiên chưa quyết toán** (phát hiện ở T32 Phần 3): điều kiện bước 1 của D6 phải chặn cả phiên đã dừng mà `charge_settlement_jobs` còn `state = 'pending'`, không chỉ phiên đang chạy. Nếu không, job quyết toán chạy sau khi đóng bị `CreditLedgerService.post` từ chối (`account_closed`: tài khoản `closed` chỉ nhận `refund` / `adjustment`) và kẹt `pending`. `SessionQuery` cần thêm `hasUnsettledSession` (hoặc mở rộng `hasRunningSession`). Thống nhất với Sơn (WP3) trước Phần 11.
