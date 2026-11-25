# WF-02 – Quyết định thiết kế

> Đặt tại `docs/spec/WF-02_decisions.md`. Cập nhật: 24/11/2026 (D1 nghĩa `done`; "Còn mở": điều kiện của Ân, kết quả querydr sandbox, Phần 10 dự kiến 25/11); 23/11/2026 (D1, D7, "Còn mở" theo T32 Phần 9a; "Còn mở": VNPay trả lời 18/11, giả định vnp_Amount khi khuyến mãi); 17/11/2026 (D3, D5, D7, "Còn mở" theo T32 Phần 7); 14/11/2026 (D2, D3, D4, D7, "Còn mở" theo T32 Phần 8; D3, D4, D7, D8 theo T32 Phần 6 13/11; D2 theo T32 Phần 5, 12/11).
> **Nguồn chính là diagram trong `diagrams/report4/class/CD-2/` + `diagrams/report4/sequence/SD-2a…2f/`** (CD-2, SD-2a…2f v2.0, 01/11/2026, bản đã chia sẻ vào tài liệu chung của nhóm). File này chỉ ghi lại:
> (1) những điểm trong diagram mà code phải bám, viết ra cho dễ tra;
> (2) cách khớp diagram với repo hiện tại;
> (3) các **bổ sung chưa có trong diagram** (đánh dấu ⊕). Khi vẽ lại diagram, đưa các mục ⊕ vào rồi ghi "đã vào diagram".
> Diagram và file này mâu thuẫn thì theo diagram và sửa file này. Diagram mâu thuẫn với code, SRS hoặc ADR thì dừng lại hỏi.

## Bảng diagram

| Diagram | Luồng | State machine |
|---|---|---|
| CD-2 `diagrams/report4/class/CD-2/CD-2.puml` | Class của module billing (chỉ thành viên chính) | |
| SD-2a `diagrams/report4/sequence/SD-2a/SD-2a.puml` | Tài xế tạo top-up, chuyển sang trang thanh toán | STM-4 |
| SD-2b `diagrams/report4/sequence/SD-2b/SD-2b.puml` | IPN cộng tiền đúng một lần | STM-4, STM-5, STM-7 |
| SD-2c `diagrams/report4/sequence/SD-2c/SD-2c.puml` | Xuất e-invoice chạy nền, có retry | STM-7 |
| SD-2d `diagrams/report4/sequence/SD-2d/SD-2d.puml` | Hết hạn 15 phút, thêm 2 phút vẫn chưa có kết quả; thanh toán trễ | STM-4 |
| SD-2e `diagrams/report4/sequence/SD-2e/SD-2e.puml` | Admin hoàn top-up; gửi refund về nguồn thanh toán | STM-4, STM-10, STM-7 |
| SD-2f `diagrams/report4/sequence/SD-2f/SD-2f.puml` | Tài xế đóng tài khoản, hệ thống tự hoàn số dư (D6) | STM-5, STM-10 |

STM-4 TopUp, STM-5 CreditAccount, STM-7 EInvoice (cũng dùng cho InvoiceAdjustment), **STM-10 Refund** (STM-8 đã là RfidCard; file `diagrams/report4/state/STM-10/STM-10.puml` v1.0, 01/11). Code: `TopUpStateMachine`, `RefundStateMachine` trong `apps/csms/src/billing/` (T32 Phần 2).

## D1. Hoàn tiền: ghi quyết định trước, chuyển tiền sau (SD-2e, STM-10)

**Phần 1: Admin ghi nhận hoàn**, một DB transaction trong `TopUpService.refund(topUpId, adminId)`:
- Kiểm tra top-up `credited` và **số dư khả dụng** ≥ số tiền; sai thì `RefundNotAllowed(reason)` → 409 / 422 `{reason}`.
- ⊕ **Số dư khả dụng** (chốt 09/11) = `balance_vnd` − Σ `reserved_vnd` của `driver_charge_intents` của tài xế chưa kết thúc (`state NOT IN ('rejected','settled','released')`), cùng công thức `src/sessions/card-eligibility.ts` (BE-19). Thiếu → `RefundNotAllowed('insufficient_available_balance')`.
- ⊕ Tài khoản `closed` → `RefundNotAllowed('account_closed')` 409. Sau khi đóng số dư = 0 nên guard số dư cũng chặn; lý do riêng chỉ để thông báo rõ. **Hoàn khoản trễ (`late_payment`) vẫn cho phép** trên tài khoản `closed` (không ghi sổ cái).
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

⊕ **Cài đặt T32 Phần 9a (Khang chốt 23/11).** Code: `billing/refund.service.ts`, `billing/vnpay.adapter.ts` (`refundRequest`, `classifyRefundResponse`, `classifyRefundQueryResponse`), `TopUpService.refund` / `refundLatePayment`, migration 0028. Chưa có route (Phần 10); điều chỉnh hoá đơn ở Phần 9b.

- **Ba số khi hoàn top-up (theo SD-2e):** sổ cái và guard số dư khả dụng dùng `amount_vnd`; VNPay hoàn `amount_paid_vnd` (`refunds.amount_vnd`); điểm trả qua `restoreForTopUp`. Ví dụ: nạp 100.000, điểm 20.000, trả 80.000 → ví −100.000, VNPay hoàn 80.000, điểm được trả lại.
- **Điều kiện trước khi quyết định hoàn:** VNPay chưa cấu hình → `RefundNotAllowed('payment_unconfigured')` trước khi đổi bất cứ gì, để không có ca trừ ví rồi refund nằm chờ vô hạn. Thứ tự kiểm sau đó: `not_found`, `account_closed`, `not_refundable`, `insufficient_available_balance`. Khoản trễ: `not_found`, `no_late_payment`, `already_requested`.
- **Tham số gửi theo kind:**

  | kind | `vnp_TxnRef` | `vnp_TransactionNo` | `vnp_TransactionDate` | `vnp_Amount` | `vnp_TransactionType` |
  |---|---|---|---|---|---|
  | `top_up` | `gateway_reference` | `gateway_transaction_no` | `vnpDate(created_at)` | `refunds.amount_vnd` × 100 | 02 nếu = `amount_paid_vnd`, khác thì 03 |
  | `late_payment` | như trên (cùng TxnRef với top-up gốc) | `late_gateway_ref` | như trên | `refunds.amount_vnd` × 100 | 02 nếu = `late_amount_vnd`, khác thì 03 |
  | `account_closure` | như `top_up` | `gateway_transaction_no` | như trên | phần chia × 100 | 02 / 03 như `top_up` |

  `vnp_CreateBy` = `admin:<requested_by>` hoặc `system`; `vnp_OrderInfo` = `Hoan tien PowerMe <refund.id>`; `vnp_IpAddr` như querydr; `vnp_RequestId` mới cho mỗi lần gọi.
- **Phân loại kết quả gửi hoàn:**

  | Response | Kết quả | STM-10 |
  |---|---|---|
  | Chữ ký đúng, khớp `vnp_TmnCode` / `vnp_TxnRef` / số tiền, có mã hoàn, RC 00, TS 00 / 05 / 06 | `accepted` | #3 `done`, `gateway_refund_no` = `vnp_TransactionNo` của response |
  | Chữ ký đúng, RC 00, TS 09 | `rejected` | #4 `failed` (`data`) |
  | Chữ ký đúng, RC 02 / 03 / 91 / 95 (thiếu TmnCode / TxnRef thì chấp nhận, có mà khác thì `unknown`); hoặc HTTP 200 RC 97 | `rejected` | #4 `failed` (`data`) |
  | RC 94 (có hay không có chữ ký) | `in_progress` | lỗi tạm thời (#2, hoặc #4 khi hết lượt); không gửi lại |
  | RC 99, lỗi mạng, timeout, HTTP ≠ 200, JSON hỏng, sai / thiếu chữ ký, sai TmnCode / TxnRef / số tiền, thiếu mã hoàn, RC 00 mà TS khác | `unknown` | lỗi tạm thời |

  **Nghĩa của `done`:** refund `done` = VNPay đã nhận yêu cầu hoàn (RC 00 + TS 00 / 05 / 06, hoặc querydr thấy lệnh hoàn); không có nghĩa tiền đã về tài khoản tài xế (VNPay / ngân hàng chuyển sau, ta không có kênh báo về). `late_refunded_at` / `closure_refunded_at` là lúc refund chuyển `done` theo nghĩa này.
- **Truy vấn trước khi gửi lại.** Mỗi lượt theo `planRound`:

  | Lượt | Cách chạy |
  |---|---|
  | `attempt_count = 0`, `last_error_kind IS NULL`, `unfinished_claims = 1` | gửi luôn |
  | Ngay sau Admin retry (`unfinished_claims = 1` và (`last_error_kind = 'data'` hoặc `attempt_count >= RETRY_LIMIT`)) | querydr, thấy 01 / 00 thì gửi đúng một lần |
  | Mọi lượt khác | querydr, không bao giờ gửi |

  - `unfinished_claims > 1` nghĩa là lượt trước giữ chỗ mà chưa ghi được kết quả, có thể đã gửi rồi sập, nên không được coi là lượt đầu.
  - Kết quả querydr: 02 / 03 khớp mã giao dịch gốc của kind và số tiền, TS 00 / 05 / 06 → `done`, `confirmed_via_query = true`, `gateway_refund_no` NULL (0028), log `refund_done_via_query`; TS 09 → `failed` (`data`); 01 / 00 cùng mã → theo bảng trên; còn lại (không xác thực được, RC 94 / 99, mã khác, sai số tiền, lỗi mạng) → lỗi tạm thời, không gửi.
  - 01 / 00 **không** chứng minh là chưa hoàn: tài liệu VNPay không ghi querydr có đổi sang 02 / 03 sau khi hoàn, cũng không ghi giới hạn tổng tiền hoàn. Nên lượt tự động không gửi. Thà hết lượt rồi `failed` để Admin xem, còn hơn hoàn hai lần.
- **Admin retry là khẳng định "đã kiểm trên cổng VNPay là chưa hoàn".** `failed → requested` (#5), giữ `attempt_count`, `unfinished_claims = 0`, `next_attempt_at = now()`. Lượt ngay sau đó được gửi đúng một lần nếu querydr thấy 01 / 00. **Phần 10 phải hiện cảnh báo này trên nút retry.**
- **Hết lượt giữ chỗ** (`onExhausted`, D7): `requested → failed` (#4), `attempt_count = max(attempt_count + 1, RETRY_LIMIT)`, `last_error_kind = 'transient'`, `last_error_message = 'retry_exhausted'`, log error, không gọi VNPay.
- **Tắt có kiểm soát:** đã có kết quả từ VNPay thì vẫn chạy tx2 dù signal đã abort, vì bỏ một kết quả `accepted` có thể dẫn tới hoàn hai lần qua Admin retry. Runner chờ lượt đang chạy xong trước khi `DbModule` đóng pool. Lời gọi bị abort giữa chừng tính là lỗi tạm thời một lượt.
- **Khoá ở tx2 khi `done`:** `top_ups` (`late_payment`) hoặc `credit_accounts` (`account_closure`) rồi mới `lockLeased(refunds)`, cùng thứ tự với đường tạo refund, tránh deadlock; khoá `credit_accounts` cũng làm tuần tự việc kiểm "refund closure cuối cùng".

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
| `requestedBy` [0..1] | FK → `admins (user_id)` (ISA của BE-16/0011; chốt 04/11). Thay `top_ups.refunded_by` (bỏ ở 0015, ERD Alignment B5). `top_up` / `late_payment` = `adminId`; `account_closure` = **NULL** (hệ thống tạo lúc tài xế đóng, D6; đúng CHECK `refunds_requested_by_check` của 0015) |
| `lastErrorKind`, `lastErrorMessage`, `lastAttemptAt` [0..1] | theo mẫu `e_invoices` |
| `gatewayRefundNo` [0..1] | mã hoàn VNPay trả về trong response của lệnh refund; NULL khi done qua querydr (⊕ 0028) |
| ⊕ `confirmedViaQuery` | boolean, mặc định false (0028, T32 Phần 9a): done nhờ querydr thấy lệnh hoàn, không có mã lệnh hoàn |
| `nextAttemptAt` [0..1] | lịch chạy nền (D4) |
| `createdAt`, `completedAt` [0..1] | |

Ràng buộc / index đề xuất cho migration:
- Partial unique `(top_up_id, kind) WHERE kind IN ('top_up','late_payment')`.
- CHECK `kind = 'account_closure' OR requested_by IS NOT NULL` (đã có ở 0015, giữ nguyên).
- CHECK `(status = 'done') = (completed_at IS NOT NULL)`; ~~`status <> 'done' OR gateway_refund_no IS NOT NULL`~~ → thay bởi 0028 (T32 Phần 9a): `status <> 'done' OR gateway_refund_no IS NOT NULL OR confirmed_via_query`, và `NOT confirmed_via_query OR (status = 'done' AND gateway_refund_no IS NULL)`.
- Index `(status, next_attempt_at)` cho worker; index `(top_up_id)`.

Nghĩa của cột đã có:
- `top_ups.late_refunded_at` = lúc refund `late_payment` chuyển `done` (VNPay đã nhận yêu cầu hoàn, xem "Nghĩa của `done`" ở trên).
- `credit_accounts.closure_refunded_at` = lúc tài khoản `closed` không còn refund `account_closure` nào chưa `done` (chốt 09/11, D6). Có hai trường hợp:
  - refund `account_closure` cuối cùng chuyển `done` (cùng nghĩa `done` ở trên);
  - lúc đóng không tạo refund nào (số dư 0, hoặc toàn bộ là phần dư) → `= closed_at`, ghi trong transaction đóng.
  - NULL chỉ còn nghĩa "chưa hoàn xong". COMMENT của 0015 còn ghi "NULL = … không có gì để hoàn" → sửa ở migration Phần 6 (mục "Còn mở").

## D2. Tạo top-up (SD-2a)

> **Viết lại theo T32 Phần 5 (Khang, 12/11).** Code: `billing/top-up.service.ts`, `billing/vnpay.adapter.ts`, route `driver/top-ups.http.ts`, migration 0019. Hợp đồng: `docs/api/DRIVER-API-HOP-DONG.md` §14, `driver-api.openapi.yaml`. ~~**Chưa dùng cho app** tới khi Phần 8 (quét quá hạn) merge; IPN và trang return đã có từ Phần 6 (13/11).~~ → thay bởi T32 Phần 8 14/11: app dùng được từ Phần 8 (IPN, trang return, quét quá hạn + querydr đã có); chưa có e-invoice (Phần 7), chưa thử sandbox VNPay thật.

- ~~`POST …/billing/top-ups {amountVnd, redeemPoints}`, header `Idempotency-Key`. Cùng key trả lại cùng top-up.~~ → thay bởi T32 Phần 5 12/11:
  - `POST /api/driver/v1/billing/top-ups` body `{amount_vnd, points_to_redeem?}` (snake_case, hợp đồng §8; `points_to_redeem` bỏ trống / `null` = 0; trường lạ → 400), header `Idempotency-Key` (8–100 ký tự, dùng chung `headerKey` của route charges). Tạo mới **201**, gửi lại cùng key cùng body **200** cùng top-up, cùng key khác body → 409 `idempotency_conflict`.
  - Idempotency **theo tài khoản** (UNIQUE `(credit_account_id, idempotency_key)`, 0019). `request_hash` = sha256 hex của `JSON.stringify([amount_vnd, points_to_redeem])`, cùng cách `driver-charging.service.ts`; chỉ băm giá trị tài xế gửi (không băm số server tính), nên gửi lại sau khi điểm đổi vẫn trả top-up cũ, không báo giá lại. Dòng `request_hash` NULL (seed / trước 0019) → `idempotency_conflict`.
  - ⊕ `GET …/billing/top-ups/quote?amount_vnd=` → `{points_available, max_points, max_discount_vnd}` (`TopUpService.quote`, chỉ đọc; dưới 500 điểm → 0, không phải lỗi). `GET …/billing/top-ups/{id}` → top-up của tài xế; của người khác / không có → 404 `not_found`.
  - Một schema `TopUp` cho cả ba chỗ: `{top_up_id, status, amount_vnd, points_redeemed, points_discount_vnd, amount_paid_vnd, created_at, expires_at, payment_url}`; `payment_url` chỉ có khi `pending` và chưa quá `expires_at`, còn lại null.
- ~~Kiểm tra: tài khoản chưa đóng, hạn mức **BR-P22 theo ADR-0013** …; không có top-up đang mở khác. Sai → `TopUpRejected(reason)` → 409 / 422 `{reason}`.~~ → thay bởi T32 Phần 5 12/11. Một DB transaction, thứ tự:
  1. `ensureAccounts(driverId)` (D9), rồi `credit_accounts … FOR UPDATE` trước mọi kiểm tra;
  2. tìm theo `(credit_account_id, idempotency_key)`, so `request_hash`;
  3. tài khoản `closed` → 409 `account_closed` (`active` và `in_shortfall` đều tạo được — SD-2a);
  4. có top-up `pending` (`TopUpStateMachine.isOpen`) → hai ca ở dưới;
  5. BR-P22: `amount_vnd` 50.000–2.000.000 → ngoài khoảng 422 `amount_out_of_range`; `balance_vnd + amount_vnd > 5.000.000` → 422 `balance_limit_exceeded` (cộng đủ `amount_vnd`, vì ví được cộng đủ số nạp dù trả bớt bằng điểm);
  6. `points_to_redeem > 0` → `quoteRedemption(…, {requestedPoints})`; `below_minimum` / `insufficient_points` / `exceeds_cap` → 422 `points_below_minimum` / `points_unavailable` / `points_exceed_cap`. Không tự hạ số điểm;
  7. INSERT `pending` (`initial()`), `expires_at = now() + PENDING_TIMEOUT` (đồng hồ DB).
  
  Lỗi là `TopUpRejected(code, extra?)` (`billing-errors.ts`) → `{error, detail}` (+ `top_up_id`, `payment_url` cùng cấp). Chưa cấu hình VNPay (thiếu `VNPAY_TMN_CODE` / `VNPAY_HASH_SECRET`) → 503 `payment_unconfigured`, không ghi dòng nào.
- ⊕ Ba lớp chống trùng: Idempotency-Key + `request_hash`; khoá `credit_accounts` (hai request cùng key → request sau chờ khoá rồi thấy dòng ở bước 2; khác key → thấy pending ở bước 4); partial UNIQUE `top_ups_one_pending_per_account_key` + UNIQUE key (0019). Vẫn lọt 23505 trên hai ràng buộc này (ghi ngoài API) → chạy lại transaction một lần, trả như bước 2 / 4, không 500.
- `redeemPoints` và còn ≥ 500 điểm → tính `discountVnd`. ⊕ `LoyaltyService.quoteRedemption` nhận `requestedPoints?` (bỏ trống = dùng tối đa `min(điểm còn sống, trần 50 %)`), không bắt bội số 100 (1 điểm = 10 VND), chỉ tính điểm còn sống (D11). Chốt 10/11, T32 Phần 4. **Chỉ trừ điểm khi cộng tiền** (SD-2b). Điểm hết hạn trong lúc chờ thanh toán: xem D3 ⊕.
- ~~Lưu top-up `pending`, `expiresAt = now + 15 phút`; `VnpayAdapter.buildPaymentUrl(topUp, amountVnd − discountVnd)`; trả **201 `{topUpId, paymentUrl}`**.~~ → thay bởi T32 Phần 5 12/11: `VnpayAdapter.buildPaymentUrl(topUp, cfg, ip)` là hàm thuần, URL **không lưu DB** mà dựng lại từ dòng `top_ups` + cấu hình mỗi lần cần (tạo, gửi lại key, GET, lỗi `top_up_pending`). Tham số VNPay 2.1.0: `vnp_Amount = amount_paid_vnd × 100`, `vnp_TxnRef = gateway_reference` (`PM` + 14 ký tự `[0-9A-Z]`, sinh lại khi trùng UNIQUE, tối đa 5 lần), `vnp_CreateDate` / `vnp_ExpireDate` = `created_at` / `expires_at` theo GMT+7, `vnp_OrderType = other`, `vnp_Locale = vn`; ký HMAC-SHA512 trên chuỗi tham số đã sắp xếp và encode kiểu PHP `urlencode`.
  - ⊕ `vnp_IpAddr` lấy từ socket của request hiện tại (`clientIp`, bỏ tiền tố `::ffff:`). **Sau Caddy / tunnel staging đây là IP proxy**: Phần 5 chưa tin `X-Forwarded-For`. Cần chốt nếu VNPay bắt IP thật của tài xế (tin header của proxy nào, cấu hình ra sao).
- Return URL chỉ hiển thị. Chỉ IPN có chữ ký (SD-2b) hoặc querydr sau `expires_at + 2 phút` (SD-2d) mới cộng tiền. Route return `/billing/vnpay/return` (D8) có từ Phần 6 (trang HTML tĩnh, không đọc tham số, không ghi DB). App poll `GET …/top-ups/{id}`.
- ⊕ "Top-up đang mở" chỉ tính `pending`; `expired` không chặn tạo mới. SRS BR-P22 sửa theo (chốt 09/11).
- ⊕ Khi bị chặn vì có top-up `pending` (T117 11/11), hai ca, app phân biệt bằng ~~`reason`~~ `error` (T32 Phần 5 12/11), **không** dựa vào việc có hay không có `payment_url`:
  - `pending` **chưa** quá `expires_at` → 409 `{error: 'top_up_pending', detail, top_up_id, payment_url}` để app hỏi "tiếp tục thanh toán?" (tên chốt ở Phần 5);
  - `pending` **đã** quá `expires_at` (đang chờ querydr chốt, D4 ⊕) → 409 `{error: 'pending_top_up_confirming', detail, top_up_id}`, báo "giao dịch trước đang được xác nhận, thử lại sau ít phút". **Không** trả `payment_url` cũ (`vnp_ExpireDate` đã qua).
  - ⊕ **Không tự chuyển pending đã quá hạn sang `expired`** khi tạo top-up (T32 Phần 5): theo D4 ⊕ ĐIỀU KIỆN chỉ querydr trả lời dứt khoát "chưa trả" (Phần 8) mới được. Tài xế chờ (thường ~2 phút sau `expires_at`, tối đa ~1 giờ) là hành vi cố ý.
- ⊕ **Không hẹn timeout ở Phần 5**: top-up quá hạn do vòng quét ~~`top_ups (status, expires_at)`~~ `top_ups (next_attempt_at) WHERE status = 'pending'` (→ thay bởi T32 Phần 6 / 8) của Phần 8 xử lý (D7). Hệ quả tới khi Phần 8 merge (→ hết từ T32 Phần 8 14/11): không có gì chuyển `pending` sang `expired`, tài xế bỏ dở thanh toán bị chặn `pending_top_up_confirming` mãi (staging dọn tay: `docs/NHAT-KY-MIGRATION-0019.md` mục 5); ~~tới khi Phần 6 merge chưa có IPN để cộng tiền.~~ IPN có từ Phần 6 (13/11). Vì vậy route top-up chưa dùng cho app tới khi Phần 8 merge.

## D3. IPN cộng tiền (SD-2b)

`VnpayIpnController.handleIpn` → `TopUpService.applyPaymentResult(ipn)`, luôn trả 200 `{RspCode, Message}`:

| Trường hợp | Kết quả | RspCode |
|---|---|---|
| Sai chữ ký / không thấy top-up / sai số tiền (~~mọi IPN~~ → thay bởi T32 Phần 8b 16/11: chỉ IPN không thành công) | không ghi gì | 97 / 01 / 04 |
| ⊕ Đã trả nhưng không cộng được (IPN thành công, top-up `pending`, sai số tiền hoặc tài khoản `closed`; T32 Phần 8b) | `pending → failed` (STM-4 #8) + khoản trễ = số VNPay thực trừ | 00 |
| Đã áp dụng rồi | không ghi gì | 02 |
| Thanh toán lỗi hoặc huỷ | `pending → failed` | 00 |
| Đã trả | `pending → credited`, `CreditLedgerService.post(+amountVnd)` (`in_shortfall → active` nếu số dư ≥ 0), `LoyaltyService.redeemForTopUp` nếu có dùng điểm, ~~`EInvoiceService.requestForTopUp` chạy sau commit~~ → thay bởi T32 Phần 7 17/11: `EInvoiceService.requestForTopUp` tạo dòng `e_invoices` `requested` **trong cùng transaction** (sau `post` và bước điểm); sau commit chỉ đánh thức việc nền `e-invoice-issue` | 00 |

⊕ **Cài đặt T32 Phần 6 (13/11, Khang + Ân chốt 12–13/11).** Code: `billing/top-up.service.ts` (`applyPaymentResult`), `billing/vnpay.adapter.ts` (`verifyIpnSignature`, `classifyIpn`, `parseVnpDate`), route `billing/vnpay-ipn.http.ts` (thay `VnpayIpnController`, gắn trong `console.server.ts` trước nhánh console). Migration 0021.
- **Kiểm request, không ghi gì nếu lỗi** (theo thứ tự):

  | Trường hợp | RspCode |
  |---|---|
  | Chưa cấu hình VNPay (thiếu `VNPAY_TMN_CODE` / `VNPAY_HASH_SECRET`; phải đứng trước vì không có secret thì không kiểm được chữ ký), log error | 99 |
  | Chữ ký sai / thiếu, tham số `vnp_*` lặp, `vnp_TmnCode` khác cấu hình | 97 |
  | Chữ ký đúng mà thiếu / sai dạng `vnp_TxnRef`, `vnp_Amount`, hoặc `vnp_TransactionNo` ở ca thành công; ⊕ ca thành công mà `vnp_Amount` không chia hết cho 100 (T32 Phần 8b, Khang 16/11: không ghi được khoản trễ bằng VND), log error | 99 |
  | Không thấy top-up theo `vnp_TxnRef` = `gateway_reference` | 01 |
  | ~~`vnp_Amount ≠ amount_paid_vnd × 100`, log warn~~ → thay bởi T32 Phần 8b 16/11: IPN **không thành công** (thất bại / huỷ / chưa ngã ngũ) mà `vnp_Amount ≠ amount_paid_vnd × 100`, log warn (không có tiền bị trừ). IPN thành công sai số tiền đi vào state machine (bảng dưới) | 04 |
  | Lỗi bất ngờ (DB, …): rollback | 99 (VNPay gọi lại tối đa 10 lần, cách 5 phút) |

  Chữ ký: như code mẫu PHP của VNPay, chỉ lấy tham số `vnp_*`, bỏ `vnp_SecureHash` / `vnp_SecureHashType`, sắp tên tăng dần, encode + nối bằng đúng `vnpSignData` (cùng hàm ký URL thanh toán), HMAC-SHA512, so sánh thời gian hằng.
- **Phân loại** (`classifyIpn`):
  - thành công ⇔ `vnp_ResponseCode = 00` **và** `vnp_TransactionStatus = 00`;
  - **chưa ngã ngũ** ⇔ `vnp_ResponseCode = 07`, hoặc `vnp_TransactionStatus ∈ {01, 04, 07}`, hoặc **đúng một trong hai mã là `00`** (code mẫu VNPay dùng HOẶC; Khang chốt 13/11, log warn kèm hai mã): **giữ `pending`, không ghi gì, trả 00**; querydr Phần 8 hỏi lại theo `next_attempt_at`. Tới khi top-up đã rời `pending`: cũng không ghi gì, trả 00, log info (status, hai mã, `top_up_id`). 07 chốt Ân 12/11; 01 / 04 theo cùng lý do (Khang); nghĩa 01 / 04 / 07 cần đối chiếu lại trên sandbox;
  - thất bại ⇔ còn lại → `PAYMENT_FAILED`. Chỉ ca thành công mới đọc `vnp_TransactionNo` (giao dịch huỷ có thể mang số 0).
- **Một DB transaction, thứ tự khoá cố định** ở mọi đường cộng tiền (IPN, querydr Phần 8): `top_ups … FOR UPDATE` (theo `gateway_reference`) → `credit_accounts … FOR UPDATE` → `loyalty_accounts` (trong `redeemForTopUp`). Rồi `TopUpStateMachine.apply` với đủ guard:

  | Outcome | Ghi | RspCode |
  |---|---|---|
  | `transition` → `credited` (#2) | `status`, `gateway_transaction_no`, `completed_at = now()`, `next_attempt_at = NULL`; `post(+amount_vnd)`; trừ điểm | 00 |
  | `transition` → `failed` (#3) | `status`, `completed_at = now()`, `next_attempt_at = NULL` | 00 |
  | ⊕ `not_creditable` → `failed` (#8, T32 Phần 8b) | thành công trên `pending` mà không cộng được — kiểm dưới khoá, **sai số tiền trước** (`vnp_Amount ≠ amount_paid_vnd × 100`), rồi tài khoản `closed`: `status = failed`, `completed_at = now()`, `next_attempt_at = NULL`, `late_gateway_ref = vnp_TransactionNo`, `late_paid_at = vnp_PayDate` (thiếu → `now()`), `late_amount_vnd = vnp_Amount / 100` (số thực trừ), một câu UPDATE; không cộng, không sổ cái, không trừ điểm, không hoá đơn; log error `payment_not_creditable` | 00 |
  | `late_payment` (mọi trạng thái trừ `pending`, D4) | `late_gateway_ref = vnp_TransactionNo`, `late_paid_at = vnp_PayDate` (GMT+7; thiếu → `now()` của DB), `late_amount_vnd = vnp_Amount / 100` (⊕ T32 Phần 8b: code Phần 6–8 ghi `amount_paid_vnd`, lệch dòng này; 8b sửa code theo dòng này — số VNPay thực trừ, kể cả khi khác `amount_paid_vnd`); giữ trạng thái; không cộng, không trừ điểm, không hoá đơn | 00 |
  | `already_applied` / `stale` | không ghi gì | 02 |
  | `conflicting_result` | ~~không ghi gì~~ (→ thay bởi T32 Phần 8b bổ sung 16/11, 0024: lần trả **thành công** mâu thuẫn — `reason` `extra_payment` / `amount_differs` — ghi **một dòng `top_up_payment_conflicts`** trong cùng transaction, `INSERT … ON CONFLICT (top_up_id, gateway_transaction_no) DO NOTHING`; không đụng `top_ups`. Báo lỗi trên top-up đã cộng — `PAYMENT_FAILED` — vẫn không ghi gì); log **error** có cấu trúc (`top_up_id`, `gateway_reference`, `vnp_TransactionNo`, `gateway_transaction_no`, `late_gateway_ref`, số tiền; ⊕ 8b: `late_amount_vnd`, `paid_amount_vnd`; ⊕ bổ sung: `reason`, `conflict_id`, `inserted`, ghi **sau commit**; VNPay gửi lại cùng giao dịch cùng số tiền → `inserted: false` mức **log**; gửi lại khác số tiền → vẫn error, kèm `existing_amount_vnd`, không ghi đè dòng) để Admin xử lý ngoài hệ thống. ⊕ T32 Phần 8b: thêm ca **cùng giao dịch khác số tiền** (D4) | 02 |
  | ⊕ RspCode theo ca (T32 Phần 8b bổ sung, Ân đồng ý 16/11) | khoản trễ → **00**; mâu thuẫn (ghi dòng mới) → **02**; gửi lại giao dịch đã ghi (khoản trễ hoặc dòng mâu thuẫn) → **02** | |
- `completed_at` (nghĩa từ 0021, Khang chốt 13/11): lúc rời `pending` (#2, #3; Phần 8 ghi ở #4; Phần 8b ở #8). Không đổi khi `credited → refunded` và khi ghi khoản trễ. Chỉ COMMENT, chưa CHECK.
- ⊕ **Đã trả nhưng không cộng được** (T32 Phần 8b, theo review #143 của Trí; Ân chốt 16/11):
  - ~~Sai số tiền → 04, không ghi gì; tài khoản `closed` → `ledger.post` ném `account_closed` → rollback → 99 (VNPay gửi lại mãi).~~ → thay bởi T32 Phần 8b 16/11: IPN thành công có chữ ký hợp lệ trên top-up `pending` mà không cộng được → #8 (`failed` + khoản trễ, bảng trên), trả **00**.
  - Chọn 00 theo tài liệu VNPay PAY 2.1.0, mục "Cơ chế retry IPN" (đọc lại 16/11): "RspCode: 00, 02 là mã lỗi IPN của merchant phản hồi đã cập nhật được tình trạng giao dịch. VNPAY kết thúc luồng"; "RspCode: 01, 04, 97, 99 hoặc IPN timeout … VNPAY bật cơ chế retry IPN" (tối đa 10 lần, cách 5 phút). Như vậy 04 **không** làm VNPay ngừng gửi lại.
  - Chọn `failed`, không chọn `expired`: đã nhận kết quả thanh toán, không phải hết hạn chờ. BR-P13 đã coi khoản trả sau `failed` là khoản trễ; Admin hoàn `late_payment` theo `late_amount_vnd`.
  - IPN lặp sau đó: cùng `vnp_TransactionNo` cùng số → `already_applied` (02); khác số → `conflicting_result` (02, D4 ⊕ 3.4; ⊕ bổ sung: dòng `top_up_payment_conflicts` `amount_differs`).
  - `PaymentResultCommitted.outcome = 'not_creditable'` (+ `reason`); Phần 7 chỉ gắn e-invoice khi `credited`. MSG26: chưa có kênh, không phát.
- ⊕ **Log áp dụng** (T32 Phần 8b; thử sandbox 14/11 thấy IPN áp dụng xong không có log nào): sau commit (kết quả bị rollback không log) ghi `ipn_applied` (IPN) / `querydr_applied` (vòng quét và recheck, kèm `source`), mức log: `top_up_id`, `gateway_reference`, `outcome` (`credited` / `failed` / `expired` / `late_payment` / `not_creditable`), `vnp_TransactionNo`, `amount_paid_vnd`, có thì `reason`, `late_amount_vnd`. #8 thêm `payment_not_creditable` mức **error** (`reason` `amount_mismatch` / `account_closed`, `source` `ipn` / `querydr` / `recheck`). `already_applied` / `stale` không log (VNPay gửi lại tới 10 lần).
- Sau commit: `afterPaymentCommitted` (lỗi ở đây chỉ log error `ipn_after_commit_failed`, vẫn trả RspCode của transaction đã commit, không trả 99). ~~Phần 7 gọi `EInvoiceService.requestForTopUp` ở đây.~~ → thay bởi T32 Phần 7 17/11: `outcome = 'credited'` → chỉ `EInvoiceService.kickIssue()` (dòng hoá đơn đã tạo trong transaction, lỗi / sập sau commit không làm mất hoá đơn). Realtime: repo chưa có kênh realtime cho tài xế, chưa phát.
- ⊕ **Đường áp kết quả dùng chung** (T32 Phần 8 14/11): phần sau khi đã khoá `top_ups` → `credit_accounts` tách thành `applyLockedResult` (state machine → `credit()` gồm savepoint điểm / `failed` / `expired` + `unresolved_*` / khoản trễ / `already_applied` / `conflicting_result`), dùng cho IPN, querydr của vòng quét và `recheckTopUp`. Đây là chỗ **duy nhất** ghi `credited`, khoản trễ và `exception_kind = 'loyalty_error'`. Cộng qua querydr ghi `gateway_transaction_no = vnp_TransactionNo` của response querydr (IPN tới sau cùng số → `already_applied` → 02). `afterPaymentCommitted` gọi cho **cả** đường querydr (try / catch riêng, log `top_up_timeout_after_commit_failed`) và khoản trễ của recheck (`recheck_after_commit_failed`); `PaymentResultCommitted.outcome` thêm `expired`. Tên log của IPN giữ nguyên; đường khác dùng tiền tố `querydr_` / `recheck_`. Hành vi IPN không đổi (test Phần 6 không sửa assertion).

Cộng tiền, dòng sổ cái và điểm nằm trong **một** DB transaction, nên IPN lặp không cộng hai lần.
⊕ **Điểm đã dùng hết hạn trước lúc cộng tiền** (chốt 06/11). Tài xế đã trả giá sau giảm `amountVnd − discountVnd`, nên:
- vẫn cộng đủ `amountVnd`;
- `redeemForTopUp` ghi dòng `redeem` chỉ cho số điểm còn hiệu lực (`points` = −số điểm còn hiệu lực);
- phần điểm thiếu (điểm đã hết hạn) ghi thêm một dòng loyalty `adjust`, `top_up_id` = top-up, **`points = 0`**:
  - dòng `expire` đã trừ các điểm này rồi, nên dòng `adjust` không trừ thêm và `pointsBalance` không bị âm;
  - dòng này chỉ ghi lại rằng top-up đã được giảm giá cho số điểm không còn. Số điểm thiếu = `top_ups.points_redeemed` − |Σ `redeem` của top-up|;
- không từ chối, không bắt tài xế trả thêm.
- Áp dụng cả khi điểm hết hạn **giữa lúc báo giá và lúc IPN về**: khoản giảm giữ nguyên, nền tảng chịu phần thiếu, ghi `adjust` 0. Ân xác nhận 10/11; SRS BR-P35 sẽ thêm câu tương ứng (Ân).

Áp dụng cho mọi đường cộng tiền (D4).
⊕ **`redeemForTopUp` ném `LoyaltyLedgerCorrupt` khi cộng tiền** (sổ điểm sai dạng hoặc lệch snapshot; chốt 10/11, Ân): **cộng tiền + log lỗi + ~~ghi `adjust`~~ đánh dấu `exception_kind = 'loyalty_error'` (→ thay bởi T32 Phần 6 13/11, chốt Ân 13/11) + báo Admin**. Lý do: tài xế đã trả giá sau giảm trên VNPay; chặn cộng tiền không lấy lại được khoản giảm, chỉ làm kẹt tiền thật của tài xế. Yêu cầu cho Phần 6:
- lỗi phần điểm không được rollback việc cộng tiền. Chỉ catch đúng `LoyaltyLedgerCorrupt` (lỗi khác vẫn rollback cả transaction → 99); lời gọi redeem nằm trong `SAVEPOINT ipn_loyalty`, gặp lỗi thì `ROLLBACK TO SAVEPOINT` (bỏ mọi dòng điểm ghi dở);
- vẫn trả VNPay RspCode 00 để VNPay dừng retry;
- ~~ghi `adjust` 0 cho top-up bằng một hàm riêng (khoá `loyalty_accounts`, không phát lại sổ đang hỏng), log lỗi có cấu trúc, báo Admin. Dòng `adjust` này làm `redeemForTopUp` gọi lặp trả `created: false`;~~ → thay bởi T32 Phần 6 13/11: **không ghi dòng loyalty nào**, không sửa sổ điểm; đặt `top_ups.exception_kind = 'loyalty_error'` (0021) cùng transaction cộng tiền, log error có cấu trúc (`reason`, `entry_no`, `top_up_id`, `loyalty_account_id`), Admin xem ở Billing Exceptions (Phần 10). Điểm chưa trừ do nền tảng chịu (như phần điểm hết hạn ở trên). Hoàn top-up này sau đó (Phần 9): `restoreForTopUp` trả −Σ `redeem` thực có (= 0), không đổi;
- idempotent theo `topUpId`: IPN lặp gặp `already_applied` trước bước điểm, nên không cộng tiền hai lần, không chạy lại bước điểm.
- Từ Phần 6, dòng `adjust` 0 gắn top-up chỉ còn nghĩa "điểm hết hạn trước lúc cộng tiền"; tối đa một dòng mỗi top-up (partial UNIQUE `loyalty_transactions_one_adjust_per_top_up`, 0021).
⊕ **`restoreForTopUp` (Admin hoàn top-up, D1) trả lại số điểm thực tế đã trừ** = −Σ `points` của các dòng `redeem` có `top_up_id` này (giữ hạn cũ). Không lấy theo `top_ups.points_redeemed`, vì như vậy sẽ trả dư phần điểm đã hết hạn.
Điểm "còn hiệu lực", "hạn cũ" ở trên tính theo lô earn FIFO của D11 (redeem tiêu lô cũ nhất; restore trả về đúng hạn cũ của lô).
⊕ Cách ghi (chốt 10/11, T32 Phần 4): mỗi dòng `redeem` / `restore` ghi đúng một lô và mang `expires_at` của lô đó, nên một top-up tiêu hai lô có hai dòng `redeem`. Dòng `adjust` `points = 0` để `expires_at` NULL. Restore vào lô **đã hết hạn** tới lúc hoàn: vẫn trả về lô cũ (= −Σ `redeem`), rồi expire ngay trong cùng transaction, nên ngay sau khi hoàn `points_balance` = điểm còn sống.
⊕ Kết quả thanh toán tới khi top-up đã có kết quả không đổi trạng thái (BR-P13), không ném lỗi (chốt 04/11, T32 Phần 2):
- `already_applied` → RspCode 02: thành công trên `credited` / `refunded` với `transactionNo` = `gateway_transaction_no` đã ghi (kiểm trước, kể cả khi đã có khoản trễ) hoặc = khoản trễ đã ghi; lỗi trên `failed` / `expired`.
- ~~`conflicting_result` → không ghi gì, service log warn: thành công trên `credited` / `refunded` với `transactionNo` **khác** (có thể là lần trả thứ hai cho cùng top-up); lỗi trên `credited` / `refunded`.~~ → thay bởi T32 Phần 6 13/11: lần trả thứ hai (thành công trên `credited` / `refunded`, `transactionNo` khác giao dịch đã cộng, chưa có khoản trễ) là **khoản trễ** (D4, T116). `conflicting_result` chỉ còn cho: khoản thứ ba (đã có khoản trễ với `transactionNo` khác), và báo lỗi trên top-up đã `credited` / `refunded`; không ghi gì, log **error**, trả 02.
- Timeout (`TIMEOUT_NOT_PAID`) tới khi đã rời `pending` → `stale`, bỏ qua (đua với IPN qua Scheduler).
- Chỉ Admin hoàn sai trạng thái mới ném `InvalidTransition`.
⊕ Realtime emit số dư mới sau commit. (T32 Phần 6: repo chưa có kênh realtime cho tài xế; điểm gọi `afterPaymentCommitted` để sẵn, chưa phát.)

## D4. Timeout và thanh toán trễ (SD-2d)

> **Bỏ cửa sổ trễ 1 giờ: Ân đề xuất 09/11, Khang đồng ý 10/11 kèm điều kiện (T117).** SRS (bản nộp 09/11), STM-4 v1.1, SD-2d đã sửa theo; còn lệch: `report3-srs.md` trên repo vẫn BR-P13/BR-P22 cũ, và STM-4 v1.1 `c1 --> expired : [else]` chưa thể hiện điều kiện querydr dứt khoát (xem Còn mở). `top-up-state-machine.ts` bỏ chuyển #5 và guard `withinLateWindow` / `limitsOk`, D7 bỏ `LATE_WINDOW` (T117 11/11).

- `expired` là **trạng thái cuối**. Kết quả thành công tới sau khi top-up đã `expired` → **khoản trễ** (#6): ghi `late_*`, top-up vẫn `expired`, không cộng, không hoá đơn, đưa lên Billing Exceptions để Admin hoàn (SD-2e, `late_payment`). Trả 00.
- ⊕ **Khoản trễ trên mọi trạng thái trừ `pending`** (T116, Ân 12/11; T32 Phần 6): khoản trễ = khoản thanh toán thành công có `vnp_TransactionNo` khác khoản đã ghi, tới khi top-up không còn `pending` — `expired` (#6), `failed`, và **lần trả thứ hai** cho top-up đã `credited` / `refunded`. `late_gateway_ref` lưu **`vnp_TransactionNo`** của khoản đó (refund `late_payment` gửi số này); `late_paid_at` = `vnp_PayDate` (GMT+7), thiếu thì lúc nhận IPN; `late_amount_vnd` = `vnp_Amount / 100` = **số VNPay thực trừ**, kể cả khi khác `amount_paid_vnd` (⊕ T32 Phần 8b; refund VNPay không cho hoàn quá số giao dịch, hoàn thiếu thì tài xế mất tiền). CHECK `top_ups_late_payment_status_check` = `late_gateway_ref IS NULL OR status <> 'pending'` (0021).
- ⊕ **STM-4 #8 — `pending --PAYMENT_SUCCEEDED [không cộng được]--> failed` + khoản trễ** (T32 Phần 8b, Ân chốt 16/11; chưa có trong STM-4, Ân sửa). "Không cộng được", kiểm dưới khoá `top_ups` → `credit_accounts`, theo thứ tự: (1) số VNPay thực trừ ≠ `amount_paid_vnd` (IPN `vnp_Amount`, querydr `vnp_Amount` của response); (2) `credit_accounts.status = 'closed'`. Hai ca cùng kết quả, khác `reason` trong log. Ghi như D3 (bảng outcome). Cài trong `TopUpStateMachine` (guard `amountMismatch`, `accountClosed`; outcome `not_creditable`, `no = '#8'`), không tách `if` trong service.
- ⊕ **IPN thành công sai số tiền theo trạng thái** (T32 Phần 8b, Khang chốt 16/11, ~~**chờ Ân xác nhận**~~ **Ân chốt 16/11**). Kiểm số tiền chuyển vào `applyLockedResult` / state machine (đã biết trạng thái, dưới khoá):

  | Trạng thái lúc IPN thành công sai số tiền tới | Xử lý | RspCode |
  |---|---|---|
  | `pending` | #8: `failed` + khoản trễ | 00 |
  | `expired` / `failed`, chưa có khoản trễ | khoản trễ (số thực trừ), giữ trạng thái | 00 |
  | `credited` / `refunded`, `vnp_TransactionNo` **khác** giao dịch đã cộng | khoản trễ, lần trả thứ hai | 00 |
  | `credited` / `refunded`, **cùng** `vnp_TransactionNo` đã cộng | **mâu thuẫn** (guard `amountMismatch`): không đổi `top_ups`, dòng `top_up_payment_conflicts` `amount_differs` (bổ sung 0024), log error `ipn_conflicting_result` kèm hai số tiền | 02 |
  | Đã có khoản trễ, cùng `vnp_TransactionNo` nhưng khác `late_amount_vnd` | **mâu thuẫn** (guard `lateAmountMismatch`): không ghi đè `late_*`, dòng `amount_differs`, log error | 02 |
  | IPN không thành công sai số tiền (mọi trạng thái) | không ghi gì, như cũ | 04 |

  Hai dòng "mâu thuẫn" thay `already_applied` cũ; thiếu chúng thì có thể hoàn hai lần cho một giao dịch.
- ⊕ **Bảng `top_up_payment_conflicts`** (T32 Phần 8b bổ sung, migration 0024, Ân chốt 16/11 chiều; theo lỗi Gap 2 ngày 15/11: `conflicting_result` chỉ log nên Admin không thấy). Mỗi lần trả **thành công** mâu thuẫn một dòng: `top_up_id`, `gateway_transaction_no` (`vnp_TransactionNo`), `amount_vnd` (số VNPay thực trừ), `paid_at` (`vnp_PayDate`, thiếu → `now()`), `source` (`ipn` / `querydr` / `recheck`), `reason`, `reviewed_at` / `reviewed_by` (→ `admins`) / `review_note` (Phần 10). UNIQUE `(top_up_id, gateway_transaction_no)`.
  - `reason` do `TopUpStateMachine` trả cùng `conflicting_result`: **`extra_payment`** = đã có khoản trễ, thêm lần trả khác giao dịch; **`amount_differs`** = cùng giao dịch đã cộng (`amountMismatch`) hoặc đã ghi khoản trễ (`lateAmountMismatch`), khác số tiền. `PAYMENT_FAILED` trên top-up đã cộng là `conflicting_result` không có `reason` → chỉ log, không ghi dòng (Ân điểm 4: chỉ ghi khi chữ ký hợp lệ và mã thành công).
  - **Không** dùng `top_ups.exception_kind = 'conflicting_payment'`: (a) mỗi top-up chỉ có một `exception_kind`, sẽ đè `loyalty_error` / `unresolved_04/07`; (b) `late_*` đã giữ khoản trễ thứ nhất, không còn chỗ lưu `vnp_TransactionNo` và số tiền của lần trả mâu thuẫn. Ghi dòng **không đụng** `top_ups.status`, `late_*`, `exception_kind`, `exception_reviewed_at` (Ân điểm 5).
  - Nguồn `querydr` **không sinh được** mâu thuẫn: vòng quét chỉ giữ chỗ `pending`; `lockLeased` khớp token ⇒ dòng vẫn `pending` (mọi đường rời `pending` đặt `next_attempt_at = NULL`); nhánh `pending` của STM-4 chỉ trả #2 / #8. Giá trị `querydr` giữ trong enum cho đủ (test: querydr đua IPN → 0 dòng).
  - `recheckTopUp`: `paid` → `conflicting_result` → dòng `source = 'recheck'`, trả `conflicting_result` như cũ; **không** đặt `exception_reviewed_at` (ngoại lệ `unresolved_*` chưa được giải quyết).
  - `PaymentResultCommitted` không thêm outcome (Phần 7 không gắn e-invoice; Phần 10 đọc bảng); không log `ipn_applied` / `querydr_applied` cho ca này (đã có `${source}_conflicting_result`).
  - Phần 10: Billing Exceptions hiện dòng `reviewed_at IS NULL` (partial index `top_up_payment_conflicts_unreviewed_idx`), nút "Đã xử lý" ghi `reviewed_at`, `reviewed_by`, `review_note` (CHECK bắt buộc, không rỗng) + audit; **không có nút hoàn** (Ân điểm 3).
- ⊕ **Lịch querydr** (T127, 0021): `top_ups.next_attempt_at` = lần querydr kế tiếp. `create` đặt `expires_at + 2 phút` (`QUERYDR_FIRST_DELAY_MS`); chưa ngã ngũ thì Phần 8 hẹn tiếp ~~+ 5, 10, 20, 40, 60 phút~~ → thay bởi T32 Phần 8c 19/11: + 15, 30, 45, 60 phút (+ 75 khi RC `94`, xem dưới); mọi chỗ rời `pending` đặt NULL. ~~Không có `attempt_count` (lần thứ mấy suy từ `next_attempt_at − expires_at`).~~ → thay bởi T32 Phần 8 14/11: lease (D7) ghi đè `next_attempt_at`, nên **không** suy lần thứ mấy từ cột này. Các mốc ~~`QUERYDR_SCHEDULE_MIN = [2, 5, 10, 20, 40, 60]`~~ (→ thay bởi T32 Phần 8c 19/11: `[2, 15, 30, 45, 60]`) phút tính **từ `expires_at`**; chưa ngã ngũ → mốc kế = mốc nhỏ nhất có `expires_at + mốc > now()` (đồng hồ DB, tính trong SQL); không còn mốc → hết lịch. Đánh thức trễ (now đã qua vài mốc) nhảy tới mốc kế còn lại, không hỏi dồn; thức dậy khi đã quá +60 thì chỉ hỏi một lần rồi hết lịch (đúng chữ chốt 14/11; xem "Còn mở"). Index `top_ups_pending_next_attempt_idx (next_attempt_at) WHERE status = 'pending'` (Trí review).
  - ⊕ **Lịch mới và mốc RC `94`** (T32 Phần 8c, Khang chốt 19/11): `QUERYDR_SCHEDULE_MIN = [2, 15, 30, 45, 60]`, bỏ +5 vì sandbox VNPay trả RC `94` (yêu cầu trùng) khi hỏi lại cùng giao dịch trong khoảng ≤ 4,5 phút, cách 11 phút trở lên thì không bị chặn (thử 16/11). `QUERYDR_FIRST_DELAY_MS` giữ 2 phút.
    - Thêm **một** mốc +75 (`QUERYDR_RC94_EXTRA_MIN`), **chỉ** khi lần hỏi ở mốc +60 trả `unresolved` với RC `94`. "Ở mốc +60" = `now() >= expires_at + 60 phút` (đồng hồ DB): code thêm 75 vào danh sách mốc khi RC là `94`, mốc kế vẫn là mốc nhỏ nhất còn ở tương lai, nên `94` ở +45 trở về trước vẫn hẹn +60 như thường.
    - Ở +75 mà vẫn chưa ngã ngũ (kể cả lại `94`) thì hết lịch → `expired` theo luật có sẵn (TS `04` / `07` → `unresolved_*`, còn lại không có `exception_kind`). Không có +90.
    - **Ngoại lệ về RC chưa xác thực** (Khang chốt 19/11): RC chưa xác thực (`unverified.responseCode`, response sai / thiếu chữ ký) chỉ để log, ngoại lệ duy nhất là `94` ở mốc +60 để hẹn thêm một lần querydr. Không bao giờ dùng nó để phân loại kết quả hay ghi gì vào DB (`kind` / `reason` / `exception_kind` giữ nguyên). RC `94` đã xác thực cũng được nhận như vậy. Lý do: response `94` của sandbox thử 16/11 không có chữ ký, nên chỉ nhận RC đã xác thực thì mốc +75 không bao giờ chạy; hỏi thêm một lần không ghi kết quả nên rủi ro thấp.
    - Log `querydr_rescheduled` có `rc94_extension: true` khi mốc kế là +75.
- ⊕ **Ca 04 / 07 tới hạn mà vẫn chưa ngã ngũ** (làm ở Phần 8): `pending → expired` (`TIMEOUT_NOT_PAID`) + `exception_kind = 'unresolved_04'` / `'unresolved_07'` (0021), đưa lên Billing Exceptions; khoản tới sau đó là khoản trễ.
- ⊕ **Bảng kết quả querydr** (Ân 12/11; cài ở T32 Phần 8 14/11, `classifyQuerydrResponse` trong `vnpay.adapter.ts`):

  | querydr | Phân loại | Với top-up `pending` |
  |---|---|---|
  | RC `00` + TS `00` | `paid` (⊕ 8b: kèm `amount` = số thực trừ, VND) | `PAYMENT_SUCCEEDED` → `credited` (#2), cùng đường cộng tiền với IPN (D3); ⊕ 8b: không cộng được (sai số tiền / tài khoản `closed`) → **kết quả dứt khoát**: `failed` + khoản trễ (#8) ngay lần này, không chờ hết lịch |
  | RC `00` + TS `02` | `failed` | `PAYMENT_FAILED` → `failed` (#3) |
  | RC `91` (không có giao dịch) | `not_found` | `TIMEOUT_NOT_PAID` → `expired` (#4) |
  | RC `00` + TS `01` / `04` / `07` / mã khác; RC `94` / `99` / `02` / `03` / `97`; lỗi mạng, timeout, HTTP ≠ 200, JSON hỏng, sai / thiếu chữ ký, `vnp_TmnCode` / `vnp_TxnRef` khác, `vnp_TransactionType ≠ 01`, ~~`paid` mà `vnp_Amount ≠ amount_paid_vnd × 100`~~ (→ thay bởi T32 Phần 8b 16/11: dòng `paid` ở trên), ⊕ `vnp_Amount` không chia hết cho 100 (`malformed`) | `unresolved` | giữ `pending`, hẹn mốc kế |

  - Log: sai chữ ký / `vnp_TmnCode` / `vnp_TxnRef` → warn; `vnp_TransactionType ≠ 01`~~, sai số tiền~~ → error (→ thay bởi T32 Phần 8b 16/11: sai số tiền log error `payment_not_creditable` sau commit). ⊕ 8b: với ba lý do warn, `querydr_result` có thêm `unverified_response_code`, `unverified_message` (thô, cắt ≤ 200 ký tự) và `has_secure_hash` — **chưa xác thực**, không dùng để quyết định; không log `vnp_SecureHash` / secret / toàn bộ body.
  - ⊕ 8b: `classifyQuerydrResponse` không so số tiền (hàm thuần trả `paid` + `amount`); `applyLockedResult` là chỗ duy nhất quyết định. Bỏ lý do `amount_mismatch`.
  - **Hết lịch mà vẫn `unresolved`** → `TIMEOUT_NOT_PAID` → `expired` (#4). Lần querydr cuối là RC `00` + TS `04` / `07` → thêm `exception_kind = 'unresolved_04'` / `'unresolved_07'`; các ca khác (TS `01`, lỗi mạng, 94 / 99, sai chữ ký) → `expired`, không `exception_kind`, log warn `querydr_schedule_exhausted` kèm lý do.
  - Mọi chỗ rời `pending` ở Phần 8: `completed_at = now()`, `next_attempt_at = NULL`.
- ⊕ **Admin "Kiểm tra lại"** (chốt Khang 14/11): `TopUpService.recheckTopUp(topUpId)` (Phần 8; route + phân quyền + audit ở Phần 10). Chỉ cho top-up `expired`, `exception_kind ∈ {unresolved_04, unresolved_07}`, `exception_reviewed_at IS NULL`; sai → `not_eligible` (kèm lý do), không gọi querydr. Đọc không khoá → querydr ngoài transaction → khoá `top_ups` → `credit_accounts`, kiểm lại điều kiện dưới khoá:
  - `paid` → khoản trễ (#6, `late_*` qua đường dùng chung) → `late_payment_recorded`; IPN đã ghi cùng số → `already_recorded`; cả hai đặt `exception_reviewed_at = now()`; ⊕ 8b: `paid` mà sai số tiền (~~`still_unresolved`~~ → thay bởi T32 Phần 8b 16/11) → khoản trễ với `late_amount_vnd` = số thực trừ → `late_payment_recorded`;
  - `paid` nhưng `conflicting_result` → không ghi, log error → `conflicting_result`;
  - `failed` / `not_found` → `exception_reviewed_at = now()` → `not_paid`;
  - `unresolved` → không ghi → `still_unresolved` (kèm RC / TS / lý do).
  - Không đổi `status`, không ghi sổ cái. Chưa cấu hình VNPay → `TopUpRejected('payment_unconfigured')`.
- `vnp_ExpireDate` = `expires_at`. Báo tài xế MSG26 khi top-up `expired`. ⊕ T32 Phần 8: repo chưa có kênh realtime / thông báo cho tài xế (như D3) → **chưa phát MSG26**; điểm gọi `afterPaymentCommitted` (`outcome: 'expired'`) để sẵn.
- ~~15 phút sau khi tạo~~ → thay bởi T117 11/11: vòng quét lúc **`expires_at + 2 phút`** (IPN đang trên đường vẫn kịp tới), nếu top-up vẫn `pending` thì `TopUpService.onPendingTimeout(topUpId)` gọi `VnpayAdapter.queryTransaction(ref)` (querydr, 10 s):
  - đã trả → `pending → credited` (#2) + ghi sổ;
  - chưa trả / thất bại, **dứt khoát** → `pending → expired` (#4, `TIMEOUT_NOT_PAID`);
  - chưa ngã ngũ → theo khối ĐIỀU KIỆN dưới đây.
- ⊕ **ĐIỀU KIỆN của Khang (làm ở Phần 8):**
  - chỉ chuyển `pending → expired` (`TIMEOUT_NOT_PAID`) khi querydr trả lời **dứt khoát** là chưa thanh toán / thất bại;
  - kết quả chưa ngã ngũ (đang xử lý / chưa hoàn tất, lỗi, timeout, sai chữ ký) → **giữ `pending`**, hẹn querydr lại theo lịch lùi dần, tổng tối đa khoảng 1 giờ sau `expires_at` (số cụ thể chốt ở Phần 8). Trong lúc đó IPN thành công tới thì cộng bình thường (#2);
  - hết giới hạn mà vẫn chưa rõ mới chuyển `expired`; khoản tới sau đó là khoản trễ, Admin hoàn `late_payment`.
  - Đây là ca duy nhất mà querydr lúc `+2 phút` không tự bắt được (ngân hàng xác nhận chậm).
- ~~IPN đến khi top-up `expired`: trong vòng 1 giờ sau khi hết hạn và chưa áp dụng → `expired → credited` + ghi sổ~~ → thay bởi T117 11/11 (không còn #5).
- ~~IPN đến khi top-up `expired`: quá 1 giờ → ghi khoản trễ~~ → thay bởi T117 11/11 (mọi thành công tới sau `expired` là khoản trễ, ý đầu của D4).
- ⊕ Mọi đường cộng tiền ở đây (querydr, IPN tới khi còn `pending`) làm giống nhánh "đã trả" của SD-2b: trừ điểm đã dùng (điểm hết hạn thì ghi `adjust` cho phần thiếu, D3 ⊕) và yêu cầu e-invoice.
- ~~⊕ Trước khi cộng tiền trễ, **kiểm tra lại** tài khoản chưa đóng và số dư sau nạp ≤ 5.000.000. Vi phạm → không cộng, ghi thành khoản trễ để Admin hoàn.~~ → thay bởi T117 11/11. Lý do bỏ: tiền chỉ được cộng khi top-up còn `pending`; lúc đó tài khoản không thể đóng (D6 chặn đóng khi có top-up `pending`) và hạn mức đã kiểm lúc tạo.
- ~~⊕ querydr lỗi hoặc timeout → giữ `pending`, hẹn quét lại; không chuyển `expired` khi chưa biết kết quả.~~ → thay bởi T117 11/11 (gộp vào khối ĐIỀU KIỆN).
- ⊕ **Thành công tới khi top-up đã `failed`** (VNPay báo lỗi/huỷ trước, rồi báo đã trả): giữ `failed`, ghi khoản trễ như trên `expired` (không cộng, không hoá đơn, Admin hoàn `late_payment`). Chốt 04/11.
- ⊕ **Khoản trễ đã ghi rồi** (`late_gateway_ref` khác NULL, trên `expired` hoặc `failed`; từ T116 cả `credited` / `refunded`), có kết quả thành công mới:
  - cùng `transactionNo` → no-op `already_applied`, trả 02;
  - khác `transactionNo` → `conflicting_result`: không ghi gì, service log ~~warn~~ error (→ thay bởi T32 Phần 6 13/11).
  - Kiểm khoản trễ đã ghi **trước**, để IPN lặp trả 02 thay vì ghi khoản trễ lần hai. ~~Kiểm **trước** guard cửa sổ, vì khoản trễ có thể đã ghi ngay trong cửa sổ khi vượt hạn mức.~~ → thay bởi T117 11/11.
- ⊕ **Cần migration mới** cho ý `failed` ở trên (số kế tiếp lúc làm Phần 6 — 0017 đã dùng cho BE-30, 0018 cho BE-34, 0019 cho Phần 5): CHECK `top_ups_late_payment_status_check` của 0003 đang là `late_gateway_ref IS NULL OR status = 'expired'`, sẽ chặn khoản trễ trên `failed`. **Đã làm ở 0021** (T32 Phần 6).
  - ~~Nới thành `status IN ('expired','failed')`.~~ → thay bởi T32 Phần 6 13/11: `status <> 'pending'` (T116).
  - Sửa COMMENT của `late_gateway_ref` (0003 còn ghi "sau cửa sổ 1 giờ … cửa sổ 1 giờ do service kiểm").
  - Sửa COMMENT của `credit_accounts.closure_refunded_at` theo D1 (chốt 09/11).
  - ~~Test cả ca hợp lệ (khoản trễ trên `failed`) lẫn ca bị chặn (trên `pending` / `credited` / `refunded`).~~ → thay bởi T32 Phần 6 13/11: hợp lệ trên `credited` / `refunded` / `failed` / `expired`, bị chặn trên `pending` (`test/migration-0021.integration.test.ts`).
  - Trí review.
- ⊕ ~~Khoản trễ chờ hoàn = `late_gateway_ref IS NOT NULL AND late_refunded_at IS NULL`, **không** lọc `status = 'expired'` (dashboard tab 2, `BillingExceptionsQuery`).~~ → thay bởi T32 Phần 8b 16/11 (Ân điểm 3, Khang chốt): khoản trễ **cần hoàn** = `late_gateway_ref IS NOT NULL` (⇔ `late_amount_vnd IS NOT NULL`, CHECK `top_ups_late_payment_check`) **AND NOT EXISTS** dòng `refunds` `kind = 'late_payment'` của top-up; **gồm cả `failed`** (#8), không lọc theo `status`. `late_refunded_at` chỉ ghi khi refund `done`, nên `late_refunded_at IS NULL` = "chưa hoàn xong" (gồm refund đang `requested` / `failed`, xem ở tab refund). Số tiền hoàn = `late_amount_vnd`.

## D5. E-invoice (SD-2c, STM-7) và InvoiceAdjustment

⊕ **T32 Phần 7 (Khang chốt 17/11):**
- **Tạo dòng trong cùng transaction cộng tiền** (thay SD-2b "requestForTopUp sau commit"): `EInvoiceService.requestForTopUp(client, topUpId)` nhận client của transaction bên gọi (không tự BEGIN/COMMIT), gọi trong nhánh `credited` của `TopUpService.applyLockedResult` sau `credit()` và bước điểm. Lý do: INSERT sau commit thì sập giữa commit và `afterPaymentCommitted` làm mất hoá đơn mà không gì quét lại được (D7: DB là nguồn sự thật); cùng cách `refunds` tạo cùng transaction với quyết định hoàn (D1). `INSERT … ON CONFLICT (top_up_id) DO NOTHING`: một hoá đơn mỗi top-up. Nguồn cộng tiền thật chỉ có IPN và querydr của vòng quét (recheck chỉ ghi khoản trễ / mâu thuẫn, không `credited`); cả hai đi qua nhánh này. Không hoá đơn cho `late_payment`, `not_creditable`, `failed`, `expired`, `conflicting_result`, `already_applied`. Lỗi INSERT rollback cả giao dịch như mọi lỗi DB (không SAVEPOINT). Sau commit chỉ `kickIssue()`; việc gọi nhà cung cấp chạy nền.
- **Số tiền:** `amount_vnd` = `top_ups.amount_paid_vnd` (số thực thu, BR-P04 "for the amount collected"), **đã gồm VAT**; phần giảm bằng điểm không lên hoá đơn. `vat_amount_vnd` = phần thuế nằm trong tổng = `round(amount × r / (100 + r))`, làm tròn nửa lên, tính bằng BigInt (`splitVat`, `billing/e-invoice.ts`).
- **Thuế suất theo thời điểm thu tiền** (`top_ups.completed_at`, cùng transaction), không theo lúc gọi nhà cung cấp (retry có thể vắt qua 31/12):
  - trước `2027-01-01T00:00:00+07:00` → 8% (Nghị quyết 204/2025/QH15, Nghị định 174/2025/NĐ-CP, hết hiệu lực 31/12/2026);
  - từ mốc đó → 10%.

  Quy tắc nằm ở một hàm thuần `vatRateAt` (hằng số, không đọc biến môi trường). Thuế suất lưu ở cột **`e_invoices.vat_rate`** (migration 0025: `smallint` NOT NULL không DEFAULT, CHECK `IN (0, 5, 8, 10)`), để hoá đơn điều chỉnh (Phần 9) dùng đúng thuế suất gốc, không suy ngược từ `vat_amount_vnd`. Lượt gọi nhà cung cấp gửi đúng `amount_vnd` / `vat_rate` / `vat_amount_vnd` đã lưu trên dòng, không tính lại; `completed_at` chỉ dùng làm `paidAt`. Căn cứ thuế suất: ngay bên dưới.
- **Căn cứ thuế suất (Ân hỏi khi review #168, 17/11):**
  - **8%:** Nghị quyết 204/2025/QH15 (Quốc hội thông qua 17/6/2025, hiệu lực 01/7/2025 đến hết 31/12/2026; toàn văn: https://hcc.nghean.gov.vn/tin-tong-hop/toan-van-nghi-quyet-so-204-2025-qh15-ve-giam-thue-gia-tri-gia-tang-2308.html) và Nghị định 174/2025/NĐ-CP (30/6/2025, hướng dẫn NQ 204): giảm 2% (10% → 8%) cho hàng hoá, dịch vụ đang chịu 10%, trừ các nhóm ở khoản 1 Điều 1 và Phụ lục I–II.
  - **10% từ 01/01/2027:** không có văn bản mới; là mức chuẩn của Luật Thuế GTGT số 48/2024/QH15 (Điều 9), áp dụng lại khi NQ 204 hết hiệu lực, "trừ trường hợp có quy định mới".
  - **Sạc xe điện có được giảm không:** có. Đã đối chiếu Phụ lục I NĐ 174/2025 (danh mục không được giảm) qua bản toàn văn trên thutucxuatnhapkhau.vn. Phụ lục I chỉ gồm các nhóm cấp 1: B (khai khoáng), C (chế biến, chế tạo; trong đó có sản phẩm kim loại), J (thông tin và truyền thông), K (tài chính, ngân hàng, bảo hiểm), L (bất động sản). **Không có nhóm D (điện, mã 35) hay mã 52 (hỗ trợ vận tải).** Phụ lục II là hàng chịu thuế TTĐB (sạc xe điện không chịu TTĐB); Phụ lục III là mẫu kê khai. Điện sinh hoạt năm 2026 cũng chịu 8%. Bản gốc để đối chiếu: https://vanban.chinhphu.vn/?pageid=27160&docid=214310.
  - **Khi thuế suất đổi hoặc được gia hạn:** sửa `VAT_RATE_CHANGE_AT` / hằng số trong `vatRateAt` (`billing/e-invoice.ts`) và test hai phía mốc, qua PR có review. Cố ý **không** dùng biến môi trường:
    - cấu hình sai thì hoá đơn sai thuế mà không test nào bắt;
    - quy tắc phải khớp backfill của migration 0025.

    Hoá đơn đã tạo giữ `vat_rate` đã lưu, không bị ảnh hưởng.
- **Nhà cung cấp:** `EInvoiceProviderAdapter.createInvoice(input, signal)` trả `{issued, invoiceNo}` hoặc lỗi `transient` / `data` kèm message.
  - Input: khoá idempotent = `e_invoices.id`, mô tả "Trả trước dịch vụ sạc xe điện", `amountVnd`, `vatRate`, `vatAmountVnd`, `paidAt`. **Không có người mua** (người tiêu dùng cá nhân, SRS §3.4.1).
  - **Idempotent theo khoá**: gọi lại cùng khoá trả cùng `invoiceNo`. Nhà cung cấp đã cấp số mà tx2 mất lease (hoặc sập) thì lượt sau gọi lại; nhà cung cấp thật không được cấp hai hoá đơn.
  - Timeout 10 s bọc ngoài adapter (`callProvider`) → `transient`; adapter ném → `transient`; số hoá đơn rỗng / quá 20 ký tự → `data` (không ghi được `varchar(20)`).
  - Thông tin người bán thuộc cấu hình adapter thật (xem "Còn mở").
- **Stub** (`StubEInvoiceProvider`): không gọi HTTP; `invoiceNo` = `STUB-` + base36 của khoá (ổn định, ≤ 18 ký tự). `EINVOICE_STUB_MODE=success|transient|data` (mặc định `success`), `EINVOICE_STUB_DELAY_MS` (0–60000, mặc định 0); giá trị sai → `invalid_einvoice_config` lúc khởi động.
- **Worker `e-invoice-issue`** (`EInvoiceService` tự cài `BackgroundWork`, luôn đăng ký):
  1. `runLeasedBatch` trên `e_invoices` (`status IN ('requested','failed') AND next_attempt_at <= now()`);
  2. gọi nhà cung cấp ngoài transaction;
  3. tx2 `lockLeased`: `null` → bỏ kết quả, log `e_invoice_lease_lost`;
  4. `EInvoiceStateMachine` (STM-7) → một câu UPDATE (`updated_at = now()`). `failed → requested` (`RETRY_DUE`, #6) làm ở **tx2**, vì tx1 là `claimDue` dùng chung.

  Kết quả:
  - thành công → `issued`, log `e_invoice_issued`;
  - lỗi tạm thời và `attempt_count` (sau lượt) < `RETRY_LIMIT` → `failed`, `next_attempt_at = now() + nextRetry(n)`;
  - còn lại → `needs_review`, `next_attempt_at` NULL, log error `e_invoice_needs_review`.

  `last_error_message` cắt còn 500 ký tự. Thành công không xoá `last_error_*`.
- **Admin retry** `EInvoiceService.adminRetry(invoiceId, adminId)` (route Phần 10): chỉ `needs_review` → `requested` (`ADMIN_RETRY`, #7), `next_attempt_at = now()`, giữ `attempt_count`, sau commit `kickIssue`. Không có hoá đơn → `EInvoiceNotFound` (404); trạng thái khác → `InvalidTransition('STM-7', …)` (409). Repo chưa có bảng audit nên `adminId` chỉ ghi vào log `e_invoice_admin_retry`.
- Gửi hoá đơn cho tài xế (STM-7 #2 "/ send invoice to Driver"): chưa có kênh, không làm.

- `EInvoiceService.issue(invoiceId)` chạy nền; `EInvoiceProviderAdapter.createInvoice(...)` timeout 10 s.
  - Có `invoiceNo` → `requested → issued`.
  - Lỗi tạm thời, chưa hết 4 lượt → `requested → failed`, attempt + 1, hẹn 5 phút / 30 phút / 2 giờ. Đến hạn: `failed → requested` rồi thử lại.
  - Bị từ chối (`data`) hoặc lượt thứ 4 lỗi → `needs_review`, báo Admin (Billing Exceptions).
  - Admin retry `needs_review`: một lượt, không reset bộ đếm.
- Top-up luôn giữ `credited`, dù hoá đơn ra sao.
- **InvoiceAdjustment**: EInvoice 1 – 0..* InvoiceAdjustment; Refund 1 – 0..1 InvoiceAdjustment. Tạo bởi `adjustForRefund` **sau khi refund `done`**; trạng thái `requested · issued · failed · needs_review` và retry giống EInvoice. Hoàn khoản trễ không có điều chỉnh hoá đơn (không có hoá đơn gốc).
- Cột thêm cho `invoice_adjustments` (khớp repo): `refund_id` (FK, unique), `status`, `attempt_count`, `last_error_kind`, `last_error_message`, `last_attempt_at`, `next_attempt_at`, `provider_adjustment_no` [0..1]; `issued_at` thành [0..1].
- Provider là **stub**: không gọi HTTP; trả `invoiceNo` / `adjustmentNo` giả theo định dạng ổn định; cấu hình được để giả lập thành công, lỗi `transient`, lỗi `data`, độ trễ; viết qua interface để sau thay provider thật.

## D6. Đóng tài khoản (SD-2f; SRS UC-ACC-02)

**Chốt 09/11 (Khang + Ân), thay bản 06/11 (PR #90, hai bước tài xế đóng / Admin hoàn):** làm theo SD-2f. **Hệ thống tự hoàn ngay khi tài xế đóng**, Admin không bấm hoàn. SD-2f, AD-9, STM-5, STM-10, CD-2 và CHECK `refunds_requested_by_check` của 0015 (`requested_by` NULL cho `account_closure`) vốn đã theo hướng này. SRS (UC-ADM-08, §3.4.1, màn hình 31) sửa theo (mục "Còn mở"). Các ý ⊕ dưới đây SD-2f chưa vẽ.

`POST /api/driver/v1/me/account/close` → `AccountClosureService.requestClosure(driverId)`, **một** DB transaction:

a. Khoá `credit_accounts … FOR UPDATE` **trước mọi kiểm tra**. `DriverChargingService.start` cũng khoá dòng này, nên đóng tài khoản và bắt đầu sạc tự xếp hàng.
b. ⊕ Tài khoản đã `closed` → trả **200 với kết quả cũ**, dựng lại từ dữ liệu đã ghi (không thêm bảng / cột):
   - `refundIds`, `refundTotalVnd`: các `refunds` `kind = account_closure` của tài khoản;
   - `nonRefundableVnd`: dòng credit `adjustment` ghi lúc đóng;
   - `pointsForfeited`: dòng loyalty `expire` ghi lúc đóng.
   - "Ghi lúc đóng" nhận ra bằng `created_at = closed_at`: dòng credit `adjustment` và dòng loyalty `expire` ghi cùng transaction đóng nên `now()` bằng nhau. Refunds lấy theo `kind = account_closure`.
   - Header `Idempotency-Key` không bắt buộc.
c. Điều kiện (sai → `ClosureNotAllowed(reason)` → 409 / 422, MSG23):
   - `status = active` (`in_shortfall` bị chặn);
   - không có top-up `pending` (D2 ⊕). ⊕ T32 Phần 8b (Ân điểm 5): theo BR-P21 / MSG23, ca "tài khoản `closed` khi còn top-up `pending`" **không được xảy ra**; chặn ở Phần 11 (khoá `credit_accounts` rồi kiểm `pending` trong cùng transaction; `create` cũng khoá `credit_accounts` trước khi INSERT `top_ups`, nên hai đường tuần tự). Billing vẫn xử lý phòng thủ: kết quả thanh toán tới cho top-up `pending` của tài khoản `closed` → STM-4 #8 (`failed` + khoản trễ, D4), không rollback / 99;
   - ⊕ `SessionQuery.hasUnsettledSession(driverId) = false`. "Chưa xong" là **bất kỳ** trường hợp nào sau:
     - intent chưa kết thúc (`driver_charge_intents.state NOT IN ('rejected','settled','released')`, gồm `pending` của BE-18);
     - phiên của tài xế (kể cả phiên thẻ RFID) chưa ở trạng thái cuối về tiền (kể cả `review` do hard cap);
     - `charge_settlement_jobs.state = 'pending'`.
d. Chia số dư về các top-up `credited` chưa hoàn, **mới nhất trước**, mỗi phần ≤ `amountPaidVnd` của top-up đó (tiền thật đã trả qua VNPay). Hàm thuần, dùng chung với preview. ⊕ Phần vượt tổng `amountPaidVnd` (vd. phần giảm giá bằng điểm, bút toán `adjustment` cũ) là **phần dư không hoàn được**.
e. Ghi sổ khi tài khoản **còn `active`** (trước bước h), đưa số dư về 0:
   - `CreditLedgerService.post(accountId, refund, −tổng các phần)` nếu > 0: một dòng, `top_up_id` NULL;
   - ⊕ `CreditLedgerService.post(accountId, adjustment, −phần dư)` nếu > 0.
f. Mỗi phần: `RefundService.create(topUpId, kind = account_closure, shareVnd, requestedBy = null)` → refund `requested`.
g. ⊕ Điểm (BR-P36): nếu `points_balance > 0` thì ghi một dòng loyalty `expire` = −`points_balance` (`top_up_id`, `session_id` NULL), snapshot về 0 (`LoyaltyService.forfeitOnClosure(driverId)`). Thứ tự khoá `credit_accounts` → `loyalty_accounts`.
h. `active → closed`, ghi `closed_at`; khoá đăng nhập qua `UserAccountService.disableLogin`. Đề xuất cài bằng `users.account_status = 'closed'` (enum đã có), chờ Ân (chủ WF-05) đồng ý; tới lúc đó giữ stub.
i. Không tạo refund nào → `closure_refunded_at = closed_at` (D1).
j. Trả **200 `{closed: true, refundIds, refundTotalVnd, nonRefundableVnd, pointsForfeited}`**.

⊕ **Xem trước:** `GET /api/driver/v1/me/account/close-preview` → `AccountClosureService.previewClosure(driverId)` → `{balanceVnd, refundableVnd, nonRefundableVnd, pointsForfeited, blockers[]}`. Chỉ đọc, không khoá, dùng cùng hàm chia ở (d). App gọi trước để tài xế thấy phần dư không hoàn được trước khi xác nhận. Số liệu thật là response của POST.

Sau commit: mỗi refund `account_closure` được gửi như SD-2e phần 2: `done` thì điều chỉnh hoá đơn và báo tài xế (MSG25); `failed` thì hiện ở Billing Exceptions, Admin retry như mọi refund. Khi refund `account_closure` cuối cùng `done` thì ghi `closure_refunded_at` (D1).

Tài khoản `closed`: `CreditLedgerService.post` chỉ nhận `refund` / `adjustment` (lưới an toàn của Phần 3, giữ nguyên). ⊕ `LoyaltyService.earnForSession` nên từ chối tài khoản `closed` (làm ở Phần 11).

Repo: `UserAccountService.disableLogin` và `SessionQuery.hasUnsettledSession` là stub trong billing tới khi WF-05 / WF-01/03 có bản thật (định nghĩa ở (c), thống nhất với Sơn / Trí).

## D7. Việc nền chạy bằng quét DB ⊕

Diagram chỉ ghi "job" / "queue" / "after commit". Repo chưa có BullMQ (Redis có nhưng chưa dùng), nên chốt 03/11:
- DB là nguồn sự thật: `status` + `attempt_count` + `next_attempt_at` nằm trên dòng nghiệp vụ, giống `charge_settlement_jobs` của WP3.
- Mỗi loại việc có một worker quét `… WHERE <điều kiện đến hạn> ORDER BY next_attempt_at LIMIT n FOR UPDATE SKIP LOCKED`. ⊕ **Giữ chỗ có hạn** (T32 Phần 12, 10/11): vì không được gọi VNPay / querydr / e-invoice (HTTP ~10 s) trong DB transaction, mỗi dòng đi qua ba bước (`src/billing/due-rows.ts`):
  1. tx ngắn giữ chỗ **một** dòng: SKIP LOCKED + `next_attempt_at = now() + lease`, COMMIT;
  2. gọi bên ngoài, ngoài transaction;
  3. tx thứ hai khoá lại dòng (`lockLeased`, kiểm `next_attempt_at` còn đúng lease của mình) rồi ghi kết quả qua state machine.

  Sập giữa chừng thì hết lease dòng tự đến hạn lại. Lease không tăng `attempt_count`. ~~(rủi ro: mục "Lỗi lặp ở tx2" của "Còn mở"; ⊕ T32 Phần 7 17/11: PR 8c sửa chung trong `due-rows.ts`, bao cả `e_invoices`)~~ → thay bởi T32 Phần 8c 19/11:
  - ⊕ **Bộ đếm lần giữ chỗ chưa ra kết quả** (0027, Khang chốt 19/11): cột `unfinished_claims` trên cả bốn bảng của `LeasedTable`. tx1 (`claimDue`) tăng 1 trong cùng câu UPDATE đẩy lease và trả số mới. tx2 (`lockLeased`) khoá lại được bằng lease của mình thì đặt về 0 (CTE `SELECT … FOR UPDATE` + `UPDATE`, giữ đúng mức khoá cũ); tx2 rollback thì phần đặt về 0 cũng rollback; mất lease thì không đụng bộ đếm.
  - Giới hạn: hằng `UNFINISHED_CLAIM_LIMIT = 5` (`due-rows.ts`, không qua biến môi trường). Lần giữ chỗ làm bộ đếm **vượt** giới hạn (lần thứ 6 liên tiếp) thì `runLeasedBatch` không gọi `handle` mà gọi `spec.onExhausted` của bảng, trong một tx ngắn riêng tự khoá lại dòng bằng lease (không đặt bộ đếm về 0: dòng giữ số 6 làm dấu vết), không gọi bên ngoài, log error `leased_row_exhausted` (`table`, `id`, `unfinished_claims`). `onExhausted` ném → rollback, log `leased_row_exhausted` kèm `exhaust_failed: true`, dòng giữ lease như trước (không thêm cơ chế lặp: mỗi lần hết lease lại chạy `onExhausted` và log, không gọi bên ngoài).
  - `top_ups`: `pending → expired` (STM-4 #4, `TIMEOUT_NOT_PAID`, đường có sẵn `applyLockedResult`) + `exception_kind = 'retry_exhausted'`, `next_attempt_at = NULL`, `completed_at`. Không giữ `pending` (tài xế sẽ bị chặn `pending_top_up_confirming` tới khi có Admin). IPN thành công tới sau → khoản trễ như `unresolved_04/07`; `recheckTopUp` nhận `retry_exhausted`. Log warn `top_up_retry_exhausted`; `querydr_applied` của đường này có `reason: 'retry_exhausted'` (không có querydr nào ra kết quả).
  - `e_invoices`: `needs_review` qua chuyển có sẵn của STM-7 (`failed` qua #6 trước, rồi `ATTEMPT_FAILED` → #3→#5), không thêm chuyển mới. `attempt_count = max(attempt_count + 1, RETRY_LIMIT)`, guard cùng số, `last_error_kind = 'transient'`, `last_error_message = 'unfinished_claims_exhausted'` (Khang chốt 19/11: guard #5 "lượt thứ RETRY_LIMIT trở đi" giữ nghĩa, Admin retry #7 vẫn là một lượt; đổi lại `attempt_count` có thể lớn hơn số lần gọi thật). Log error `e_invoice_needs_review` `reason: 'unfinished_claims_exhausted'`. Admin retry đặt `unfinished_claims = 0`.
  - ~~`refunds`, `invoice_adjustments`: chỉ có cột; chưa có `onExhausted` (Phần 9).~~ → thay bởi T32 Phần 9a 23/11: `refunds` hết lượt → `failed` (STM-10 #4, D1). `invoice_adjustments`: chỉ có cột, chưa có `onExhausted` (Phần 9b); tới lúc đó `runLeasedBatch` log error `no_handler` rồi vẫn gọi `handle`.
  - Staging không gọi ra được VNPay: querydr trả `unresolved` (timeout), tx2 vẫn hẹn mốc kế và commit, nên bộ đếm về 0 mỗi lần, không tích luỹ (có test).

  Các điều kiện đến hạn:
  - `refunds`: `status = 'requested' AND next_attempt_at <= now()` → `RefundService.send`.
  - `e_invoices`, `invoice_adjustments`: `status IN ('requested','failed') AND next_attempt_at <= now()` → `EInvoiceService.issue` / điều chỉnh.
  - ~~`top_ups`: `status = 'pending' AND expires_at <= now()` → `TopUpService.onPendingTimeout` (dùng `expires_at` đã có; D4 09/11: chạy lúc `expires_at + 2 phút`). Không có `next_attempt_at`, nên cách giữ chỗ do Phần 5/8 chọn (interface `BackgroundWork.runDue` không ràng buộc).~~ → thay bởi T32 Phần 6 13/11: `top_ups`: `status = 'pending' AND next_attempt_at <= now()` → `TopUpService.onPendingTimeout` (0021 thêm `next_attempt_at`, D4; giữ chỗ như các bảng khác bằng `runLeasedBatch`).
    - ⊕ Cài ở T32 Phần 8 (14/11): `TopUpService` tự cài `BackgroundWork` tên `top-up-timeout`, đăng ký trong `onModuleInit`; `LeasedTable` thêm `top_ups`, lease = `BILLING_WORKER_LEASE_MS`. Thứ tự: tx1 giữ chỗ → querydr **ngoài transaction** → tx2 `lockLeased` (khoá `top_ups`; `null` = IPN đã chốt / đổi lịch → bỏ kết quả) → khoá `credit_accounts` → state machine → ghi. VNPay chưa cấu hình → `runDue` trả 0, không giữ chỗ dòng nào, warn một lần mỗi tiến trình. Thiếu cấu hình worker → `runDue` ném `top_up_timeout_missing_config`.
    - ⊕ Index partial (14/11): `top_ups_pending_next_attempt_idx` có predicate `status = 'pending'`; câu `status = ANY($1::top_up_status[])` có tham số không khớp được predicate trong generic plan. Nên `due-rows.ts` viết điều kiện **hằng** `status = 'pending'` cho `top_ups` (map cố định `FIXED_DUE_STATUS`, chỉ nhận `statuses = ['pending']`, vẫn không nhận SQL từ bên gọi). `EXPLAIN ANALYZE`: ghi chú 14/11 của plan.
- `Scheduler` (`src/common/scheduler.ts`) chỉ để **chạy sớm** (ngay sau commit, đúng `expires_at`); mất khi sập cũng được vì vòng quét bắt lại. Lúc khởi động mỗi worker quét một lần.
- Lịch retry: `next_attempt_at = now() + 5 phút / 30 phút / 2 giờ`; một helper dùng chung cho e-invoice và refund (`nextRetry` trong `retry-schedule.ts`). `RETRY_LIMIT = 4` là hằng số export ở `refund-state-machine.ts` (không phải biến môi trường). `PENDING_TIMEOUT = 15 phút`: hằng số export `PENDING_TIMEOUT_MS` ở `top-up.service.ts` (T32 Phần 5, `expires_at = now() + PENDING_TIMEOUT` bằng đồng hồ DB); Phần 5 không hẹn timeout, vòng quét Phần 8 xử lý. ~~`LATE_WINDOW = 1 giờ`~~ bỏ theo D4; đã bỏ trong code (T117).
- Viết sau interface `BackgroundWork` trong billing để sau đổi sang BullMQ mà không sửa service. ⊕ Runner `BackgroundWorkRunner` (Phần 12): các loại chạy song song, mỗi loại không chạy chồng; `kick` / `kickAt` để chạy sớm; cấu hình `BILLING_WORKER_*` (`infra/.env.example`).
- Index cần: `(status, next_attempt_at)` trên `e_invoices`, `invoice_adjustments`, `refunds`; `top_ups (status, expires_at)`; ⊕ `top_ups (next_attempt_at) WHERE status = 'pending'` (0021).

## D8. Khớp với repo

- **Migration `0015_billing-refunds-wf02.sql`.** CD-2 ghi 0012, nhưng `0010`–`0012` đã dùng cho BE-16 (Trí, PR #84, merge trước theo thoả thuận 04/11), `0013` cho BE-07 (PR #82), `0014` cho BE-16 đợt 2 (PR #86), nên người merge sau đổi sang số kế tiếp (tiền lệ `docs/ITERATION-1-WF04.md`). Nội dung: enum `refund_kind`, `refund_status`, bảng `refunds`, cột mới cho `invoice_adjustments` và `e_invoices.next_attempt_at`, index của D7, và **B5** (bỏ `top_ups.refunded_by`). Kèm `docs/NHAT-KY-MIGRATION-0015.md` và `test/migration-0015.integration.test.ts`.
- `refunds.last_error_kind` (và `invoice_adjustments.last_error_kind`): **dùng lại enum `e_invoice_error_kind`** (`transient`, `data`), chốt 04/11 khi viết 0015. Lý do: cùng nghĩa, một helper retry dùng chung (D7); không đổi tên enum của 0003 đã merge. `invoice_adjustments.status` dùng lại `e_invoice_status` (D5). Chi tiết: `docs/NHAT-KY-MIGRATION-0015.md` mục 2. Theo quy ước BE-16: mọi FK có index (A5), FK của `refunds` giữ NO ACTION (C3).
- Mã task **T32**; nhánh `wp5/t32-<mo-ta>`; commit kèm `[T32]`.
- **Đường dẫn:** giữ phần tài nguyên của diagram, ghép tiền tố theo `docs/api/DRIVER-API-HOP-DONG.md`:

  | Diagram | Code |
  |---|---|
  | `POST /billing/top-ups`, `GET /billing/top-ups/{id}` | `/api/driver/v1/billing/top-ups…` |
  | ⊕ (chưa vẽ) báo giá dùng điểm | `GET /api/driver/v1/billing/top-ups/quote?amount_vnd=` (D2, T32 Phần 5) |
  | `POST /me/account/close` | `/api/driver/v1/me/account/close` |
  | ⊕ (chưa vẽ) xem trước đóng | `GET /api/driver/v1/me/account/close-preview` (D6) |
  | `POST /admin/billing/…` | `/api/admin/billing/…` |
  | `GET /billing/vnpay/ipn` | `/billing/vnpay/ipn` (công khai, không xác thực, chỉ dựa chữ ký); return URL `/billing/vnpay/return` — **có từ T32 Phần 6** (`billing/vnpay-ipn.http.ts`) |

  Sửa `infra/.env.example` trong cùng PR; báo người lo Caddy staging và app Flutter.
  ⊕ T32 Phần 6: `ConsoleServer` chuyển mọi URL `/billing…` (`/^\/billing(?:\/|\?|$)/`) vào listener VNPay **trước** nhánh console chưa xác thực; ngoài hai đường trên → 404, method khác GET → 405. Caddy staging mở đúng `handle /billing/vnpay/ipn` và `handle /billing/vnpay/return` → `csms:3000` (Trí duyệt; không mở `/billing/*`). Staging compose truyền `VNPAY_*` cho csms. URL IPN khai trên cổng merchant: `https://<DOMAIN>/billing/vnpay/ipn`.
  ⊕ T32 Phần 8b (Khang 16/11): `VNPAY_URL` (trang thanh toán) và `VNPAY_API_URL` (querydr) chỉ nhận `https:` ở mọi môi trường (test thay `fetch`, không cần ngoại lệ `http:`); `VNPAY_RETURN_URL` (URL của PowerMe, mặc định `http://localhost`) vẫn nhận http(s).
- **Chỗ CD-2 lệch code** (theo code, ghi vào `diagrams/README.md` mục "Known differences"):
  - ~~`CreditTransaction.transactionType` có `reservation_fee`; enum `credit_transaction_type` không có.~~ Hết lệch từ 0010 (BE-16): enum đã có `reservation_fee`, CD-2 đúng.
  - Tiền ghi `number`; code dùng `bigint` VND (Drizzle `mode: 'number'` ở tầng TS, không dùng số thực).
  - CD-2 chỉ có thành viên chính. Code thêm các class / method sau, không mâu thuẫn diagram: `TopUpStateMachine`, `RefundStateMachine`, worker của D7, `BillingExceptionsQuery`, `CreditLedgerService.getBalance`, `ensureAccounts`, `LoyaltyService.quoteRedemption` / `earnForSession` / `expireDueForAccount`.
  - ⊕ T32 Phần 6: `VnpayIpnController` là hàm trong `billing/vnpay-ipn.http.ts`; `applyPaymentResult` nhận tham số query thô, tự kiểm chữ ký (như SD-2b) và trả `{RspCode, Message}`; `VnpayAdapter.verifyIpn` mới (diagrams/README.md, Known differences dòng 10).
- ~~SD-2a ghi "monthly cap": theo ADR-0013 thì BR-P22 không có hạn mức tháng. Code theo ADR-0013; chờ Ân sửa diagram (mục "Còn mở").~~ Đã vào diagram: SD-2a v2.1 (10/11) bỏ "monthly cap", ghi "no pending top-up".

## D9. Ranh giới với WP3 và tạo tài khoản ⊕

**T148, 24/11/2026 (phase 3 đã nâng local sau backup/review):** WP3 đã thay khối SQL thô chung
trong `charge-settlement.service.ts` bằng hai service dưới đây trên cùng transaction,
khóa phiên → credit → loyalty; nhận thêm RFID có chủ captured và csms_billed.
`OcppGatewayModule` import `BillingModule` vì settler được cung cấp tại gateway.
Ledger closed giữ pending/account_closed theo D6. Xem [T148](../tasks/t148-rfid-settlement.md).
Đoạn yêu cầu ban đầu dưới đây được giữ để truy nguyên.


- **Sổ cái khi trừ tiền phiên sạc:** billing làm `CreditLedgerService.post` và `LoyaltyService.earnForSession`. Sau khi Phần 3 merge, WP3 (Sơn) thay SQL thô trong `charge-settlement.service.ts` bằng lời gọi hai hàm này. Tới lúc đó code WP3 giữ nguyên, billing không sửa file của WP3. Mọi nơi ghi sổ khoá `credit_accounts FOR UPDATE` trước khi tính `entry_no`.
- **Tạo tài khoản:** `ensureAccounts(driverId)` idempotent (tạo `credit_accounts` + `loyalty_accounts`, `INSERT … ON CONFLICT DO NOTHING`). Luồng đăng ký tài xế (khi có) gọi hàm này; billing tự gọi khi tạo top-up.

## D10. Hợp đồng admin với dashboard (`wp4/fe-01-dashboard-shell`, chưa merge, dùng mock)

| Dashboard gọi | Dùng cho | Cần thống nhất với WP4 (theo diagram) |
|---|---|---|
| `GET /api/admin/billing/top-ups?status=credited` | top-up có thể hoàn | ⊕ Loại top-up của tài khoản `closed`: đóng tài khoản không đổi trạng thái top-up nên chúng vẫn `credited`, nhưng số dư đã được hoàn qua `account_closure` (D6) |
| `POST /api/admin/billing/top-ups/{id}/refund` | hoàn top-up (SD-2e) | Dashboard đang mong `{status:'refunded', refundedVnd, pointsRestored}`; SD-2e trả **202 `{refundId, status:'requested'}`**. ⊕ Lý do từ chối mới (D1): `insufficient_available_balance` (số dư khả dụng không đủ), `account_closed` (409) |
| `GET /api/admin/billing/top-ups/late-payments` | khoản trễ | |
| `POST /api/admin/billing/top-ups/{id}/late-refund` | hoàn khoản trễ | Dashboard mong `{lateRefundedAt}`; theo SD-2e trả `{refundId, status:'requested'}`, `lateRefundedAt` chỉ có khi refund `done` |
| `GET /api/admin/billing/e-invoices?status=needs_review`, `POST …/e-invoices/{id}/retry` | retry hoá đơn (SD-2c) | Dashboard dùng `lastErrorKind: 'temporary' \| 'rejected'`; DB dùng `transient \| data`. Chốt một bộ tên |
| (chưa có) | refund `failed` + `POST …/refunds/{id}/retry`, **gồm cả `account_closure`** | WP4 cần thêm mục này. Retry một lượt, không reset bộ đếm (D1) |

Không còn route Admin hoàn tài khoản đóng: hệ thống tự hoàn lúc tài xế đóng (D6, chốt 09/11).

## D11. Hết hạn điểm (BR-P36, SRS job #18) ⊕

Chốt 09/11: WP5 làm job hết hạn điểm.
- **Điểm còn sống tính theo lô earn, FIFO:** mỗi dòng `earn` là một lô có hạn riêng.
  - `redeem` tiêu lô cũ nhất trước;
  - `restoreForTopUp` trả điểm về **đúng hạn cũ của lô** đã bị tiêu (D3: trả −Σ `redeem` của top-up, không theo `points_redeemed`);
  - dòng `expire` trừ phần còn sống của lô hết hạn. Điểm đã bị `expire` trước lúc cộng tiền thì D3 ghi `adjust` `points = 0`, không trừ thêm;
  - `expire` lúc đóng tài khoản (D6 (g)) xoá toàn bộ phần còn lại.
- **Nhận diện lô** (chốt 10/11, T32 Phần 4, không migration):
  - lô = các dòng `earn` cùng `expires_at` (so chính xác µs; trùng hạn gộp một lô);
  - mỗi dòng `redeem` / `restore` / `expire` theo hạn ghi đúng một lô và mang `expires_at` của lô đó, **copy bằng SQL** từ dòng earn (JS `Date` mất phần µs);
  - `adjust` 0 và `expire` lúc đóng tài khoản để `expires_at` NULL;
  - dòng không khớp quy tắc → `LoyaltyLedgerCorrupt`, không đoán cách sửa.
- Restore vào lô đã hết hạn → trả về lô cũ rồi expire ngay trong cùng transaction (D3 ⊕).
- **Hiển thị điểm** (UC-PAY-04, API sau này) và mọi chỗ cần "điểm khả dụng" dùng `livePoints` / `pointsExpiringBy` từ `replayLots`, **không** đọc `points_balance`: lô đã hết hạn vẫn nằm trong `points_balance` tới khi job Phần 13 ghi `expire`.
- **Phần 4:** hàm thuần `loyalty-lots.ts` + `LoyaltyService.expireDueForAccount(tx, loyaltyAccountId, asOf?)` (một tài khoản, khoá `loyalty_accounts`). `expireDue(now)` của CD-2 (lặp qua tài khoản) để Phần 13.
- **Phần 13:** job chạy hằng ngày gọi `expireDue(now)`. Chống chạy chồng (hai instance / hai lượt không trừ hai lần), bỏ qua tài khoản `closed`, chỉ trừ phần còn sống.

## Còn mở (hỏi trước khi code phần liên quan)

- **Diagram chờ Ân vẽ lại** (Khang đã gửi danh sách 09/11):
  - ~~SD-2a: bỏ "monthly cap"; "no other open top-up" → "no other pending top-up".~~ Đã vào SD-2a v2.1 (10/11).
  - SD-2a theo T32 Phần 5 (D2, 12/11): `open_top_up` → `top_up_pending`; thêm ca `pending_top_up_confirming` (pending đã quá `expires_at`, không kèm `payment_url`); thêm `GET /billing/top-ups/quote` + `TopUpService.quote`; body `{amount_vnd, points_to_redeem?}`; 201 tạo mới / 200 gửi lại cùng key; lỗi `{error, detail}` thay `{reason}`.
  - SD-2f: điều kiện "account active, no pending top-up, no open charge intent or unsettled session"; thêm bước xoá phần dư không hoàn được (`adjustment`) và huỷ điểm (`LoyaltyService.forfeitOnClosure(driverId)`, `expire`); response `200 {closed, refundTotalVnd, nonRefundableVnd}`; ghi chú app gọi `close-preview` trước; footer bỏ "R8 Q1, Khang to confirm".
  - CD-2: migration 0003 / 0015; tiền `bigint`; `AccountClosureController.preview()`, `AccountClosureService.previewClosure(driverId)`, `LoyaltyService.forfeitOnClosure(driverId)` và `expireDue(now)`, `AccountClosureService --> LoyaltyService`.
  - Đã xong: ~~bỏ `reservation_fee` ở CD-2~~ (0010 đã thêm vào enum); ~~STM-10 Refund~~ (đã có, v1.0); ~~STM-4 ghi chú ở `failed`~~ (Ân đã làm, PR #95).
- Thống nhất D10 với WP4.
- **SRS cần sửa** (Khang + Ân):
  - BR-P21: phần dư không hoàn được (số dư lúc đóng vượt tổng `amountPaidVnd` của các top-up `credited` chưa hoàn) ghi `adjustment` −phần dư; tài xế thấy trước khi xác nhận (`close-preview`, D6).
  - BR-P22: "top-up đang mở" chỉ là `pending` (D2 ⊕).
  - BR-P44: đổi "third failure" thành "after the third retry fails", khớp `RETRY_LIMIT = 4`.
  - UC-ADM-08 và §3.4.1: bỏ "Admin executes the closure refund".
  - Màn hình 31: bỏ "closed accounts awaiting their refund".
  - Figure 14: "AD-3" → AD-2.
- **Theo T117 (bỏ cửa sổ trễ, 11/11), chờ Ân / Nghĩa:**
  - Ân: `report3-srs.md` còn BR-P13 / BR-P22 bản cũ (cửa sổ trễ 1 giờ).
  - Ân: STM-4 v1.1 `c1 --> expired : [else]` cần tách: `[chưa trả, dứt khoát] → expired`; `[chưa ngã ngũ] →` ở lại `pending`, hẹn querydr lại (D4 ⊕ ĐIỀU KIỆN).
  - Ân / Nghĩa: `docs/UC-ADM-08-BILLING-EXCEPTIONS.md` (tab 2 ghi "after `LATE_WINDOW` (1 h)", lọc `status = expired`; dòng TC-STM4-06 "after window") → lọc ~~`late_gateway_ref IS NOT NULL AND late_refunded_at IS NULL`~~ (→ thay bởi T32 Phần 8b 16/11: `late_gateway_ref IS NOT NULL` và chưa có dòng `refunds` `late_payment`, gồm `failed`, D4), bỏ chữ cửa sổ.
- ~~**Lịch querydr lại của D4 ⊕ ĐIỀU KIỆN** (hẹn querydr lại lùi dần khi chưa ngã ngũ) cần lưu lần hỏi kế tiếp cho từng top-up, nhưng `top_ups` chưa có `next_attempt_at` / `attempt_count` (D7, dòng điều kiện quét `top_ups`). Chốt trước khi viết migration của Phần 6/8 (~~0017~~: 0017 đã dùng cho BE-30, 0018 cho BE-34, 0019 cho Phần 5): thêm cột vào migration đó, hay suy lịch từ `expires_at`. Khi chốt thì sửa luôn điều kiện quét ở D7 thành `expires_at + 2 phút <= now()`.~~ Đã chốt (T127, T32 Phần 6): cột `top_ups.next_attempt_at` (0021), D4 / D7.
- ~~**COMMENT `credit_accounts.closure_refunded_at` của 0015** ghi "NULL = chưa xong / không có gì để hoàn", lệch D1 (không tạo refund nào → `= closed_at`). Sửa ở migration Phần 6, cùng migration nới `top_ups_late_payment_status_check` và COMMENT `late_gateway_ref`. Trí review.~~ Đã sửa ở 0021 (Trí review).
- **Physical ERD v1.1 lệch 0015:** enum `refund_error_kind` riêng (0015 dùng lại `e_invoice_error_kind`); unique đầy đủ thay partial unique `(top_up_id, kind)`; `invoice_adjustments.refund_id` NOT NULL (0015 nullable); thiếu `next_attempt_at`; thiếu `refunds_requested_by_check`. Báo Ân.
- AD-9 và Physical ERD dẫn BR-P45 cho refund, trong khi BR-P45 là làm tròn tiền phiên. Hỏi Ân.
- ~~**Lần trả thứ hai cho cùng top-up** (D3 ⊕: thành công với `transactionNo` khác trên `credited` / `refunded` → `conflicting_result`): tiền đã vào VNPay nhưng không có cột để ghi (`late_*` chỉ dành cho top-up chưa cộng, `gateway_transaction_no` đã có giá trị). Cần chốt cách ghi và cách Admin hoàn (cột mới? bảng riêng? `refunds.kind` mới?) trước Phần 6.~~ Đã chốt (T116, Ân 12/11): ghi vào `late_*` như khoản trễ, Admin hoàn `late_payment` (D4).
- ~~**Billing Exceptions (Phần 10) phân biệt hai loại `adjust` 0 của top-up:** do sổ điểm hỏng (D3 ⊕, chốt 10/11) và do điểm hết hạn (D3 ⊕) — nhận ra bằng log riêng hay một dấu hiệu ghi trên dòng / bảng nào. Chốt trước Phần 6: cả hai cách đều phải ghi ngay lúc xảy ra ở Phần 6 (nếu chọn dấu hiệu trên dòng thì hàm ghi `adjust` cho sổ hỏng ghi luôn dấu hiệu đó).~~ Đã chốt (Ân 13/11): sổ hỏng không ghi `adjust`, đánh dấu `top_ups.exception_kind = 'loyalty_error'` (D3); `adjust` 0 chỉ còn nghĩa điểm hết hạn.
- ~~**Báo Admin cho `conflicting_result`** (khoản thứ ba, lỗi trên top-up đã cộng): T32 Phần 6 chỉ log error có cấu trúc. Cần chốt có đưa lên Billing Exceptions không (cột / bảng nào) trước Phần 10.~~ Đã chốt (Ân 16/11, T32 Phần 8b bổ sung): bảng `top_up_payment_conflicts` (0024, D4) cho lần trả thành công mâu thuẫn; báo lỗi trên top-up đã cộng vẫn chỉ log.
- ~~**Admin "Kiểm tra lại" (querydr theo yêu cầu) và đánh dấu `exception_reviewed_at`**: Phần 8 (querydr) / Phần 10 (route Admin).~~ → thay bởi T32 Phần 8 14/11: `TopUpService.recheckTopUp` có ở Phần 8 (D4); route "Kiểm tra lại", phân quyền, audit và route đánh dấu `exception_reviewed_at` thủ công ở Phần 10. Tới Phần 10 chưa có ai gọi `recheckTopUp`.
- **querydr — chỗ trang VNPay không ghi** (đọc trang `truy-van-hoan-tien/querydr&refund.html` 14/11; thứ tự chuỗi ký request / response khớp thứ tự đang dùng, trang thiếu dấu `+` giữa `vnp_Amount` và `vnp_BankCode`). ~~Chờ thử sandbox thật~~ → **kết quả thử sandbox 16/11** (Khang):
  - ~~giá trị trong chuỗi ký có encode không (đang: **không encode**);~~ chuỗi ký request **không encode** được chấp nhận;
  - ~~`vnp_Amount` của response có nhân 100 không (đang: ×100 như IPN);~~ `vnp_Amount` của querydr là **×100**;
  - ~~trường tuỳ chọn thiếu (`vnp_PayDate`, `vnp_PromotionCode`, `vnp_PromotionAmount`) có đưa chuỗi rỗng vào chuỗi ký không (đang: có);~~ thứ tự chuỗi ký response đúng như `QUERYDR_RESPONSE_SIGN_FIELDS` (RC `00` và `91` đều khớp); trường thiếu là chuỗi rỗng;
  - ~~response RC `91` (không có giao dịch) và response lỗi (`02` / `03` / `94` / `97` / `99`) **có được ký và có trả `vnp_TxnRef` không**.~~ RC `91` **có chữ ký**, có `vnp_TxnRef` và `vnp_TmnCode` → `not_found` dùng được. RC `94` / `99` **không có chữ ký** và không có `vnp_TxnRef` (→ `unresolved/signature`; từ 8b log thêm mã thô chưa xác thực để phân biệt). Code hiện bắt chữ ký đúng + `vnp_TmnCode` / `vnp_TxnRef` khớp trước khi đọc RC. Nếu VNPay không ký, hoặc không trả `vnp_TxnRef` ở các response này, thì RC `91` thành `unresolved` → top-up bỏ dở (tài xế chưa mở trang thanh toán) chờ tới `expires_at + 60 phút` mới `expired` (bị chặn `pending_top_up_confirming` suốt lúc đó). **Quyết sau khi thử sandbox; chưa nới kiểm** (Khang 14/11);
  - giá trị JSON không phải chuỗi: code chuẩn hoá trước khi ký (`null` = thiếu → chuỗi rỗng, số hữu hạn → `String(v)`, object / array / boolean → `malformed`), chờ xem VNPay trả kiểu gì.
- **`vnp_IpAddr` của querydr** = "IP của máy chủ gọi API": biến `VNPAY_SERVER_IP` (trống = `127.0.0.1`). Thử sandbox 16/11: sandbox **chấp nhận** `127.0.0.1`; môi trường thật chưa biết. Nếu VNPay kiểm IP (whitelist / khớp IP gọi thật) thì querydr luôn `unresolved` → top-up hết lịch thành `expired` không `exception_kind`, tiền đã trừ (nếu có) thành khoản trễ khi IPN tới. Người lo staging điền IP ra ngoài của VM khi thử sandbox.
- **VNPay trả `94` ("Request is duplicated", không chữ ký) khi querydr lặp cho cùng giao dịch** (thử sandbox 16/11): sandbox chặn ít nhất khoảng 4,5 phút; lần cách 11 phút thì không bị chặn. Mốc +2 → +5 chỉ cách 3 phút nên lần +5 có thể bị chặn; "Kiểm tra lại" ngay sau một lượt quét có thể trả `still_unresolved`. Code vẫn an toàn (`94` → hẹn mốc kế). ~~Đổi lịch: **chờ Ân** (D4 / T117); T32 Phần 8b không đổi `QUERYDR_SCHEDULE_MIN`.~~ → thay bởi T32 Phần 8c 19/11: lịch 2/15/30/45/60, mốc +75 khi lần hỏi ở +60 trả 94 (D4).
- **Sandbox không gửi lại IPN** trong ~30 phút sau khi nhận HTTP 403 (thử 16/11), khác tài liệu VNPay (gọi lại tối đa 10 lần, cách 5 phút). Hệ quả: querydr là đường duy nhất bắt được khoản đã trả mà IPN không tới (ca E 16/11 đã chứng minh đường này chạy). Ca "IPN tới sau khi querydr đã cộng → 02" mới chỉ có test integration làm bằng chứng.
- **VNPay trả lời email (18/11/2026, Online Service Dept.):** (1) IPN ở môi trường test chỉ gọi 1 lần, không gọi lại — khớp quan sát 16/11 ở mục "Sandbox không gửi lại IPN"; (2) thông tin test tự đăng ký qua trang dev không hỗ trợ API query / refund, muốn đủ thì làm việc với kinh doanh VNPay kèm đăng ký kinh doanh. Mâu thuẫn với thử 16/11 (querydr trả RC `00` / `91` có chữ ký hợp lệ; ngày 14/11 luôn `99`) → coi querydr sandbox là không cam kết, lúc chạy lúc không; refund (Phần 9) có thể không thử được trên sandbox, khi đó chỉ có test tự động. (3) Câu `vnp_Amount` khi có mã giảm giá: VNPay không trả lời — xem mục dưới.
- **Giả định `vnp_Amount` khi có khuyến mãi phía VNPay** (Khang 23/11, VNPay chưa trả lời): nếu số VNPay thực trừ (`vnp_Amount / 100`, IPN hoặc querydr) khác `amount_paid_vnd` — ví dụ do mã khuyến mãi của VNPay — hệ thống coi là sai số tiền theo T32 Phần 8b: top-up `pending → failed` (STM-4 #8, `not_creditable`), khoản trễ ghi đúng số VNPay thực trừ (`late_amount_vnd`), không cộng tiền, không trừ điểm, không hoá đơn; Admin hoàn qua Billing Exceptions (Phần 9 / 10). Nếu VNPay báo `vnp_Amount` là số trước giảm giá (bằng `amount_paid_vnd`, khuyến mãi do VNPay / ngân hàng chịu) thì cộng đủ như thanh toán thường, không vào #8. Đây là hành vi code đang chạy, không đổi code.
- **querydr trả `paid` với txn khác bị bỏ khi mất lease** (T32 Phần 8b bổ sung ghi lại, Khang 16/11; chưa sửa code): IPN cộng txn A trong lúc querydr đang chạy, querydr trả `paid` với txn B ≠ A → `lockLeased` trả `null` → kết quả querydr bị bỏ. Nếu B là lần trả thật thứ hai, chỉ bắt được khi IPN của B tới. Khó xảy ra (VNPay thường trả cùng giao dịch cho một `vnp_TxnRef`), nhưng sandbox 16/11 cho thấy VNPay có thể không gửi lại IPN. Hướng xử lý sau: khi `lockLeased` trả `null` mà querydr là `paid` với txn khác `gateway_transaction_no`, áp kết quả như IPN (khoá theo `id`, không theo token) → khoản trễ hoặc dòng `top_up_payment_conflicts`.
- ~~**Lỗi lặp ở tx2 của vòng quét** (T32 Phần 8b ghi lại, chưa sửa): lease không đếm số lần thử. Một lỗi lặp lại ở tx2 (sau querydr; trước 8b có `account_closed`, nay #8 xử lý; còn lại: lỗi DB / lỗi code bất kỳ) làm `runLeasedBatch` log warn rồi để dòng giữ lease → hết lease lại tới hạn → gọi querydr lại. Hệ quả: gọi VNPay lặp mỗi `BILLING_WORKER_LEASE_MS` (có thể dính `94`), log lặp, top-up kẹt `pending` không bao giờ hết lịch. Hướng xử lý có thể làm: đếm lần thử (cột mới, cần migration), hoặc tx2 lỗi thì vẫn hẹn mốc kế của `QUERYDR_SCHEDULE_MIN` trong một transaction riêng (hết lịch → `expired`).~~ → thay bởi T32 Phần 8c 19/11: đếm lần giữ chỗ (`unfinished_claims`, 0027), lần thứ 6 → `expired` + `retry_exhausted` (D7).
- **Thuế suất hoá đơn** (T32 Phần 7): Đã đối chiếu Phụ lục I–II NĐ 174/2025 (17/11, xem căn cứ ở D5): dịch vụ sạc xe điện không bị loại trừ, áp 8% tới hết 31/12/2026. Còn lại: người lập hoá đơn thật (kế toán / công ty khách hàng) xác nhận mã ngành đăng ký; nếu có nghị quyết gia hạn hoặc đổi mức thì sửa `vatRateAt`.
- ~~**Lease không đếm lần thử, cả với `e_invoices`** (T32 Phần 7 ghi lại): giống mục "Lỗi lặp ở tx2" của top-up. Dòng làm tiến trình sập, hoặc gặp lỗi lặp ở tx2, được thử lại sau mỗi lease mà không bị đếm, nên nhà cung cấp bị gọi lặp. Ví dụ lỗi lặp: nhà cung cấp trả `invoice_no` đã có ở dòng khác → 23505 UNIQUE. PR 8c sửa chung trong `due-rows.ts`, bao cả `e_invoices`.~~ → thay bởi T32 Phần 8c 19/11: lần thứ 6 → `needs_review` (D7).
- **Top-up `credited` trước khi deploy Phần 7** (sandbox trên staging) không có hoá đơn và không tạo bù (T32 Phần 7).
- **Thông tin người bán** (MST, mẫu số, ký hiệu hoá đơn) và biến môi trường của nhà cung cấp thật (MISA): chốt khi làm provider thật; stub không dùng (T32 Phần 7).
- **Đánh thức trễ quá +60 phút** (worker dừng lâu): vòng quét chỉ hỏi querydr một lần rồi hết lịch (`expired`). Đề xuất cho sau (chưa làm): cho Admin "Kiểm tra lại" cả top-up `expired` hết lịch không `exception_kind` (ca lỗi mạng / TS `01`).
- **Billing Exceptions thêm mục lỗi sổ điểm (`loyalty_error`) và ca 04 / 07 chưa ngã ngũ (`unresolved_04` / `unresolved_07`)**: UC-ADM-08 hiện có 3 tab (Ân / Nghĩa).
- **Nghĩa `vnp_TransactionStatus` 01 / 04 / 07** (coi là chưa ngã ngũ ở D3): trang tài liệu VNPay đọc được không có bảng mã này nguyên văn; đối chiếu trên sandbox.
- Đổi tên `lateGatewayRef` → `lateGatewayTransactionNo`? (T32 Phần 6 giữ tên, JSDoc / COMMENT ghi rõ là `vnp_TransactionNo`.)
- VNPay sandbox: refund có chống trùng không, có API tra trạng thái hoàn không (`VnpayAdapter.queryRefund`), thời hạn được hoàn, danh sách mã IPN. ⊕ T32 Phần 9a đọc lại trang 23/11: không có API riêng tra trạng thái hoàn; chống trùng chỉ thấy RC 94; không ghi thời hạn hoàn và giới hạn tổng tiền hoàn.
- **Refund (T32 Phần 9a) chưa thử được trên sandbox** (xem "VNPay trả lời email 18/11", ý (2)). Khang chốt 23/11: chấp nhận chỉ kiểm bằng test tự động với VNPay giả lập. Các giả định cần đối chiếu khi có tài khoản đủ quyền:
  - `vnp_Amount` của refund là VND × 100 (như lệnh trả, IPN, querydr);
  - trường thiếu trong response refund đưa vào chuỗi ký là chuỗi rỗng;
  - RC 00 + TS 00 / 05 / 06 coi là `done`, nghĩa là VNPay đã nhận yêu cầu hoàn (D1).

  Ân chấp nhận 3 giả định 24/11, điều kiện: (a) done = VNPay đã nhận yêu cầu hoàn (đã ghi ở D1); (b) thử querydr trùng vnp_TxnRef trên sandbox (kết quả ở mục Khoản trễ và querydr).
- **Cách nhận lệnh hoàn qua querydr là suy luận từ tài liệu** (T32 Phần 9a): trang chỉ liệt kê `vnp_TransactionType` 02 / 03, không ghi khi nào xuất hiện, không ghi `vnp_TransactionNo` là của giao dịch gốc hay lệnh hoàn.
  - Nếu là mã của lệnh hoàn: so với mã gốc không khớp → lỗi tạm thời → `failed`, Admin xem (an toàn, không hoàn hai lần).
  - Nếu querydr vẫn trả 01 / 00 sau khi hoàn: lượt tự động không gửi; chỉ lượt ngay sau Admin retry mới gửi, nên Admin phải kiểm trên cổng VNPay trước khi retry (D1).
- **`gateway_refund_no` khi done qua querydr** (Khang chốt 23/11): querydr không có trường mã lệnh hoàn, nên để NULL và đánh dấu `confirmed_via_query = true` (0028). Đối soát các dòng này với sao kê VNPay theo `vnp_TxnRef` và số tiền.
- **Khoản trễ và querydr** (T32 Phần 9a): khoản trễ dùng cùng `vnp_TxnRef` với top-up gốc, nên querydr có thể trả giao dịch đầu thay vì khoản trễ → mã khác → lỗi tạm thời, hết lượt thành `failed`. Trang VNPay ghi `vnp_TransactionNo` là trường request **tuỳ chọn** của querydr nhưng **không có trong chuỗi ký**; chưa gửi trường này.

  **Kết quả thử trên sandbox 24/11 (production chưa kiểm).** Thẻ NCB test, querydr gọi từ máy local:

  | Ca | Thao tác trên VNPay | querydr |
  |---|---|---|
  | A | Trả thành công (`15747269`), mở lại cùng URL bị chặn (`code=01`) | Không gửi / gửi mã A1 → A1, RC 00, TS 00 |
  | B (đường khoản trễ thật) | Lần 1 huỷ (RC 24, TS 02, mã `0`), lần 2 trả thành công (`15747271`) | Không gửi / gửi `0` / gửi mã B2 → B2, RC 00, TS 00 |
  | Hai tab | Tab 1 dừng ở OTP, tab 2 mở cùng URL bị chặn (`code=01`); về tab 1 nhập OTP báo "Đơn hàng không tồn tại hoặc đã được xử lý" | Không gửi → `15747275`, RC 00, **TS 01** (chưa hoàn tất) |

  Mọi response đều 01 (loại giao dịch), 50.000 VND, chữ ký khớp.

  - **Ca B đã kiểm:** querydr trả đúng giao dịch thành công, không trả lần huỷ trước đó.
  - **`vnp_TransactionNo` gửi `0` vẫn được nhận** và trả B2, nên field này có thể bị bỏ qua. Chưa chứng minh được nó chọn đúng giao dịch.
  - **Không tạo được hai giao dịch thành công cùng `vnp_TxnRef` qua cùng URL**, nên chưa biết querydr trả giao dịch đầu hay cuối trong ca đó. Nếu trả nhầm, mã không khớp → lỗi tạm thời → `failed`, Admin xem; không gửi hoàn thêm.
  - **Ca TS 01:** `classifyQuerydrResponse` xếp vào `unresolved`, không cộng tiền.
  - **Giới hạn:** hai tab dùng chung một phiên ẩn danh, chưa thử hai trình duyệt / thiết bị. Refund không chạy được trên sandbox, nên chưa biết querydr hiển thị gì sau khi hoàn.

  **Khang quyết định 24/11:** không thêm `vnp_TransactionNo` vào `queryRefundState`, giữ nguyên code.
- **Phần 10** (route retry refund của Admin, đường xử lý duy nhất cho refund `failed`) dự kiến 25/11/2026.
- Cách tạo `CreditAccount` + `LoyaltyAccount` khi tài xế đăng ký (WF-05 gọi billing hay billing nghe event).
- Chiều gọi `session_debit` và loyalty `earn` từ WF-01/03.
- **Đóng tài khoản khi còn phiên chưa quyết toán** (phát hiện ở T32 Phần 3): định nghĩa "chưa xong" ở D6 (c) — intent chưa kết thúc (gồm `pending` của BE-18), phiên (kể cả phiên thẻ RFID) chưa ở trạng thái cuối về tiền (kể cả `review` do hard cap), hoặc `charge_settlement_jobs.state = 'pending'`. Không chặn thì job quyết toán chạy sau khi đóng bị `CreditLedgerService.post` từ chối (`account_closed`) và kẹt `pending`. Thống nhất `SessionQuery.hasUnsettledSession(driverId)` với Sơn / Trí trước Phần 11.
