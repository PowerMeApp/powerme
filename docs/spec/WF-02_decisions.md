# WF-02 – Quyết định thiết kế

> Đặt tại `docs/spec/WF-02_decisions.md`. Cập nhật: 12/11/2026 (D2 theo T32 Phần 5).
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
| `gatewayRefundNo` [0..1] | mã hoàn VNPay trả về |
| `nextAttemptAt` [0..1] | lịch chạy nền (D4) |
| `createdAt`, `completedAt` [0..1] | |

Ràng buộc / index đề xuất cho migration:
- Partial unique `(top_up_id, kind) WHERE kind IN ('top_up','late_payment')`.
- CHECK `kind = 'account_closure' OR requested_by IS NOT NULL` (đã có ở 0015, giữ nguyên).
- CHECK `(status = 'done') = (completed_at IS NOT NULL)`; `status <> 'done' OR gateway_refund_no IS NOT NULL`.
- Index `(status, next_attempt_at)` cho worker; index `(top_up_id)`.

Nghĩa của cột đã có:
- `top_ups.late_refunded_at` = lúc refund `late_payment` chuyển `done`.
- `credit_accounts.closure_refunded_at` = lúc tài khoản `closed` không còn refund `account_closure` nào chưa `done` (chốt 09/11, D6). Có hai trường hợp:
  - refund `account_closure` cuối cùng chuyển `done`;
  - lúc đóng không tạo refund nào (số dư 0, hoặc toàn bộ là phần dư) → `= closed_at`, ghi trong transaction đóng.
  - NULL chỉ còn nghĩa "chưa hoàn xong". COMMENT của 0015 còn ghi "NULL = … không có gì để hoàn" → sửa ở migration Phần 6 (mục "Còn mở").

## D2. Tạo top-up (SD-2a)

> **Viết lại theo T32 Phần 5 (Khang, 12/11).** Code: `billing/top-up.service.ts`, `billing/vnpay.adapter.ts`, route `driver/top-ups.http.ts`, migration 0019. Hợp đồng: `docs/api/DRIVER-API-HOP-DONG.md` §14, `driver-api.openapi.yaml`. **Chưa dùng cho app** tới khi Phần 6 (IPN, trang return) và Phần 8 (quét quá hạn) merge.

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
- Return URL chỉ hiển thị. Chỉ IPN có chữ ký (SD-2b) hoặc querydr sau `expires_at + 2 phút` (SD-2d) mới cộng tiền. Route return `/billing/vnpay/return` (D8) có từ Phần 6; trước đó thanh toán sandbox xong quay về 404. App poll `GET …/top-ups/{id}`.
- ⊕ "Top-up đang mở" chỉ tính `pending`; `expired` không chặn tạo mới. SRS BR-P22 sửa theo (chốt 09/11).
- ⊕ Khi bị chặn vì có top-up `pending` (T117 11/11), hai ca, app phân biệt bằng ~~`reason`~~ `error` (T32 Phần 5 12/11), **không** dựa vào việc có hay không có `payment_url`:
  - `pending` **chưa** quá `expires_at` → 409 `{error: 'top_up_pending', detail, top_up_id, payment_url}` để app hỏi "tiếp tục thanh toán?" (tên chốt ở Phần 5);
  - `pending` **đã** quá `expires_at` (đang chờ querydr chốt, D4 ⊕) → 409 `{error: 'pending_top_up_confirming', detail, top_up_id}`, báo "giao dịch trước đang được xác nhận, thử lại sau ít phút". **Không** trả `payment_url` cũ (`vnp_ExpireDate` đã qua).
  - ⊕ **Không tự chuyển pending đã quá hạn sang `expired`** khi tạo top-up (T32 Phần 5): theo D4 ⊕ ĐIỀU KIỆN chỉ querydr trả lời dứt khoát "chưa trả" (Phần 8) mới được. Tài xế chờ (thường ~2 phút sau `expires_at`, tối đa ~1 giờ) là hành vi cố ý.
- ⊕ **Không hẹn timeout ở Phần 5**: top-up quá hạn do vòng quét `top_ups (status, expires_at)` của Phần 8 xử lý (D7). Hệ quả tới khi Phần 8 merge: không có gì chuyển `pending` sang `expired`, tài xế bỏ dở thanh toán bị chặn `pending_top_up_confirming` mãi (staging dọn tay: `docs/NHAT-KY-MIGRATION-0019.md` mục 5); tới khi Phần 6 merge chưa có IPN để cộng tiền. Vì vậy route top-up chưa dùng cho app tới khi Phần 6 và 8 merge.

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
- Áp dụng cả khi điểm hết hạn **giữa lúc báo giá và lúc IPN về**: khoản giảm giữ nguyên, nền tảng chịu phần thiếu, ghi `adjust` 0. Ân xác nhận 10/11; SRS BR-P35 sẽ thêm câu tương ứng (Ân).

Áp dụng cho mọi đường cộng tiền (D4).
⊕ **`redeemForTopUp` ném `LoyaltyLedgerCorrupt` khi cộng tiền** (sổ điểm sai dạng hoặc lệch snapshot; chốt 10/11, Ân): **cộng tiền + log lỗi + ghi `adjust` + báo Admin**. Lý do: tài xế đã trả giá sau giảm trên VNPay; chặn cộng tiền không lấy lại được khoản giảm, chỉ làm kẹt tiền thật của tài xế. Yêu cầu cho Phần 6:
- lỗi phần điểm không được rollback việc cộng tiền. `redeemForTopUp` ném trước mọi câu ghi nên transaction vẫn dùng được; chỉ catch đúng `LoyaltyLedgerCorrupt` (lỗi khác vẫn rollback); vẫn bọc SAVEPOINT quanh lời gọi redeem làm lớp an toàn;
- vẫn trả VNPay RspCode 00 để VNPay dừng retry;
- ghi `adjust` 0 cho top-up bằng một hàm riêng (khoá `loyalty_accounts`, không phát lại sổ đang hỏng), log lỗi có cấu trúc, báo Admin. Dòng `adjust` này làm `redeemForTopUp` gọi lặp trả `created: false`;
- idempotent theo `topUpId`: IPN lặp không cộng tiền hai lần, không ghi `adjust` hai lần.
⊕ **`restoreForTopUp` (Admin hoàn top-up, D1) trả lại số điểm thực tế đã trừ** = −Σ `points` của các dòng `redeem` có `top_up_id` này (giữ hạn cũ). Không lấy theo `top_ups.points_redeemed`, vì như vậy sẽ trả dư phần điểm đã hết hạn.
Điểm "còn hiệu lực", "hạn cũ" ở trên tính theo lô earn FIFO của D11 (redeem tiêu lô cũ nhất; restore trả về đúng hạn cũ của lô).
⊕ Cách ghi (chốt 10/11, T32 Phần 4): mỗi dòng `redeem` / `restore` ghi đúng một lô và mang `expires_at` của lô đó, nên một top-up tiêu hai lô có hai dòng `redeem`. Dòng `adjust` `points = 0` để `expires_at` NULL. Restore vào lô **đã hết hạn** tới lúc hoàn: vẫn trả về lô cũ (= −Σ `redeem`), rồi expire ngay trong cùng transaction, nên ngay sau khi hoàn `points_balance` = điểm còn sống.
⊕ Kết quả thanh toán tới khi top-up đã có kết quả không đổi trạng thái (BR-P13), không ném lỗi (chốt 04/11, T32 Phần 2):
- `already_applied` → RspCode 02: thành công trên `credited` / `refunded` với `transactionNo` = `gateway_transaction_no` đã ghi; lỗi trên `failed` / `expired`.
- `conflicting_result` → không ghi gì, service log warn: thành công trên `credited` / `refunded` với `transactionNo` **khác** (có thể là lần trả thứ hai cho cùng top-up); lỗi trên `credited` / `refunded`.
- Timeout (`TIMEOUT_NOT_PAID`) tới khi đã rời `pending` → `stale`, bỏ qua (đua với IPN qua Scheduler).
- Chỉ Admin hoàn sai trạng thái mới ném `InvalidTransition`.
⊕ Realtime emit số dư mới sau commit.

## D4. Timeout và thanh toán trễ (SD-2d)

> **Bỏ cửa sổ trễ 1 giờ: Ân đề xuất 09/11, Khang đồng ý 10/11 kèm điều kiện (T117).** SRS (bản nộp 09/11), STM-4 v1.1, SD-2d đã sửa theo; còn lệch: `report3-srs.md` trên repo vẫn BR-P13/BR-P22 cũ, và STM-4 v1.1 `c1 --> expired : [else]` chưa thể hiện điều kiện querydr dứt khoát (xem Còn mở). `top-up-state-machine.ts` bỏ chuyển #5 và guard `withinLateWindow` / `limitsOk`, D7 bỏ `LATE_WINDOW` (T117 11/11).

- `expired` là **trạng thái cuối**. Kết quả thành công tới sau khi top-up đã `expired` → **khoản trễ** (#6): ghi `late_*`, top-up vẫn `expired`, không cộng, không hoá đơn, đưa lên Billing Exceptions để Admin hoàn (SD-2e, `late_payment`). Trả 00.
- `vnp_ExpireDate` = `expires_at`. Báo tài xế MSG26 khi top-up `expired`.
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
- ⊕ **Khoản trễ đã ghi rồi** (`late_gateway_ref` khác NULL, trên `expired` hoặc `failed`), có kết quả thành công mới:
  - cùng `transactionNo` → no-op `already_applied`, trả 02 (TC-STM4-15);
  - khác `transactionNo` → `conflicting_result`: không ghi gì, service log warn.
  - Kiểm khoản trễ đã ghi **trước**, để IPN lặp trả 02 thay vì ghi khoản trễ lần hai. ~~Kiểm **trước** guard cửa sổ, vì khoản trễ có thể đã ghi ngay trong cửa sổ khi vượt hạn mức.~~ → thay bởi T117 11/11.
- ⊕ **Cần migration mới** cho ý `failed` ở trên (số kế tiếp lúc làm Phần 6 — 0017 đã dùng cho BE-30, 0018 cho BE-34, 0019 cho Phần 5): CHECK `top_ups_late_payment_status_check` của 0003 đang là `late_gateway_ref IS NULL OR status = 'expired'`, sẽ chặn khoản trễ trên `failed`.
  - Nới thành `status IN ('expired','failed')`.
  - Sửa COMMENT của `late_gateway_ref` (0003 còn ghi "sau cửa sổ 1 giờ … cửa sổ 1 giờ do service kiểm").
  - Sửa COMMENT của `credit_accounts.closure_refunded_at` theo D1 (chốt 09/11).
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
   - không có top-up `pending` (D2 ⊕);
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

  Sập giữa chừng thì hết lease dòng tự đến hạn lại. Lease không tăng `attempt_count`. Các điều kiện đến hạn:
  - `refunds`: `status = 'requested' AND next_attempt_at <= now()` → `RefundService.send`.
  - `e_invoices`, `invoice_adjustments`: `status IN ('requested','failed') AND next_attempt_at <= now()` → `EInvoiceService.issue` / điều chỉnh.
  - `top_ups`: `status = 'pending' AND expires_at <= now()` → `TopUpService.onPendingTimeout` (dùng `expires_at` đã có; D4 09/11: chạy lúc `expires_at + 2 phút`). Không có `next_attempt_at`, nên cách giữ chỗ do Phần 5/8 chọn (interface `BackgroundWork.runDue` không ràng buộc).
- `Scheduler` (`src/common/scheduler.ts`) chỉ để **chạy sớm** (ngay sau commit, đúng `expires_at`); mất khi sập cũng được vì vòng quét bắt lại. Lúc khởi động mỗi worker quét một lần.
- Lịch retry: `next_attempt_at = now() + 5 phút / 30 phút / 2 giờ`; một helper dùng chung cho e-invoice và refund (`nextRetry` trong `retry-schedule.ts`). `RETRY_LIMIT = 4` là hằng số export ở `refund-state-machine.ts` (không phải biến môi trường). `PENDING_TIMEOUT = 15 phút`: hằng số export `PENDING_TIMEOUT_MS` ở `top-up.service.ts` (T32 Phần 5, `expires_at = now() + PENDING_TIMEOUT` bằng đồng hồ DB); Phần 5 không hẹn timeout, vòng quét Phần 8 xử lý. ~~`LATE_WINDOW = 1 giờ`~~ bỏ theo D4; đã bỏ trong code (T117).
- Viết sau interface `BackgroundWork` trong billing để sau đổi sang BullMQ mà không sửa service. ⊕ Runner `BackgroundWorkRunner` (Phần 12): các loại chạy song song, mỗi loại không chạy chồng; `kick` / `kickAt` để chạy sớm; cấu hình `BILLING_WORKER_*` (`infra/.env.example`).
- Index cần: `(status, next_attempt_at)` trên `e_invoices`, `invoice_adjustments`, `refunds`; `top_ups (status, expires_at)`.

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
  | `GET /billing/vnpay/ipn` | `/billing/vnpay/ipn` (công khai, không xác thực, chỉ dựa chữ ký); return URL `/billing/vnpay/return` |

  Sửa `infra/.env.example` trong cùng PR; báo người lo Caddy staging và app Flutter.
- **Chỗ CD-2 lệch code** (theo code, ghi vào `diagrams/README.md` mục "Known differences"):
  - ~~`CreditTransaction.transactionType` có `reservation_fee`; enum `credit_transaction_type` không có.~~ Hết lệch từ 0010 (BE-16): enum đã có `reservation_fee`, CD-2 đúng.
  - Tiền ghi `number`; code dùng `bigint` VND (Drizzle `mode: 'number'` ở tầng TS, không dùng số thực).
  - CD-2 chỉ có thành viên chính. Code thêm các class / method sau, không mâu thuẫn diagram: `TopUpStateMachine`, `RefundStateMachine`, worker của D7, `BillingExceptionsQuery`, `CreditLedgerService.getBalance`, `ensureAccounts`, `LoyaltyService.quoteRedemption` / `earnForSession` / `expireDueForAccount`.
- ~~SD-2a ghi "monthly cap": theo ADR-0013 thì BR-P22 không có hạn mức tháng. Code theo ADR-0013; chờ Ân sửa diagram (mục "Còn mở").~~ Đã vào diagram: SD-2a v2.1 (10/11) bỏ "monthly cap", ghi "no pending top-up".

## D9. Ranh giới với WP3 và tạo tài khoản ⊕

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
  - Ân / Nghĩa: `docs/UC-ADM-08-BILLING-EXCEPTIONS.md` (tab 2 ghi "after `LATE_WINDOW` (1 h)", lọc `status = expired`; dòng TC-STM4-06 "after window") → lọc `late_gateway_ref IS NOT NULL AND late_refunded_at IS NULL`, bỏ chữ cửa sổ.
- **Lịch querydr lại của D4 ⊕ ĐIỀU KIỆN** (hẹn querydr lại lùi dần khi chưa ngã ngũ) cần lưu lần hỏi kế tiếp cho từng top-up, nhưng `top_ups` chưa có `next_attempt_at` / `attempt_count` (D7, dòng điều kiện quét `top_ups`). Chốt trước khi viết migration của Phần 6/8 (~~0017~~: 0017 đã dùng cho BE-30, 0018 cho BE-34, 0019 cho Phần 5): thêm cột vào migration đó, hay suy lịch từ `expires_at`. Khi chốt thì sửa luôn điều kiện quét ở D7 thành `expires_at + 2 phút <= now()`.
- **COMMENT `credit_accounts.closure_refunded_at` của 0015** ghi "NULL = chưa xong / không có gì để hoàn", lệch D1 (không tạo refund nào → `= closed_at`). Sửa ở migration Phần 6, cùng migration nới `top_ups_late_payment_status_check` và COMMENT `late_gateway_ref`. Trí review.
- **Physical ERD v1.1 lệch 0015:** enum `refund_error_kind` riêng (0015 dùng lại `e_invoice_error_kind`); unique đầy đủ thay partial unique `(top_up_id, kind)`; `invoice_adjustments.refund_id` NOT NULL (0015 nullable); thiếu `next_attempt_at`; thiếu `refunds_requested_by_check`. Báo Ân.
- AD-9 và Physical ERD dẫn BR-P45 cho refund, trong khi BR-P45 là làm tròn tiền phiên. Hỏi Ân.
- **Lần trả thứ hai cho cùng top-up** (D3 ⊕: thành công với `transactionNo` khác trên `credited` / `refunded` → `conflicting_result`): tiền đã vào VNPay nhưng không có cột để ghi (`late_*` chỉ dành cho top-up chưa cộng, `gateway_transaction_no` đã có giá trị). Cần chốt cách ghi và cách Admin hoàn (cột mới? bảng riêng? `refunds.kind` mới?) trước Phần 6.
- **Billing Exceptions (Phần 10) phân biệt hai loại `adjust` 0 của top-up:** do sổ điểm hỏng (D3 ⊕, chốt 10/11) và do điểm hết hạn (D3 ⊕) — nhận ra bằng log riêng hay một dấu hiệu ghi trên dòng / bảng nào. Chốt trước Phần 6: cả hai cách đều phải ghi ngay lúc xảy ra ở Phần 6 (nếu chọn dấu hiệu trên dòng thì hàm ghi `adjust` cho sổ hỏng ghi luôn dấu hiệu đó).
- Đổi tên `lateGatewayRef` → `lateGatewayTransactionNo`?
- VNPay sandbox: refund có chống trùng không, có API tra trạng thái hoàn không (`VnpayAdapter.queryRefund`), thời hạn được hoàn, danh sách mã IPN.
- Cách tạo `CreditAccount` + `LoyaltyAccount` khi tài xế đăng ký (WF-05 gọi billing hay billing nghe event).
- Chiều gọi `session_debit` và loyalty `earn` từ WF-01/03.
- **Đóng tài khoản khi còn phiên chưa quyết toán** (phát hiện ở T32 Phần 3): định nghĩa "chưa xong" ở D6 (c) — intent chưa kết thúc (gồm `pending` của BE-18), phiên (kể cả phiên thẻ RFID) chưa ở trạng thái cuối về tiền (kể cả `review` do hard cap), hoặc `charge_settlement_jobs.state = 'pending'`. Không chặn thì job quyết toán chạy sau khi đóng bị `CreditLedgerService.post` từ chối (`account_closed`) và kẹt `pending`. Thống nhất `SessionQuery.hasUnsettledSession(driverId)` với Sơn / Trí trước Phần 11.
