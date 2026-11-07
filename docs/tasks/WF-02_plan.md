# WF-02 – Kế hoạch implement

> Đặt tại `docs/tasks/WF-02_plan.md`. Claude Code cập nhật cột Trạng thái và mục Ghi chú sau mỗi phần.
> Mỗi phiên làm một phần. Plan mode → duyệt → test trước → code → chạy test.
> Nguồn chính: diagram `diagrams/report4/class/CD-2/` + `diagrams/report4/sequence/SD-2a…2f/` (CD-2, SD-2a…2f v2.0); tóm tắt và bổ sung ở `docs/spec/WF-02_decisions.md`.

## Phần 0 – Khảo sát repo (đã làm sơ bộ 03/11, commit `ce3902c`)

Kết quả đã ghi vào mục "Bối cảnh repo" của `apps/csms/src/billing/CLAUDE.md` và D8 của decisions. Phiên đầu chỉ cần **xác nhận lại** trên `main` mới nhất (có thể đã có commit mới), đọc `src/db/schema/billing.ts`, `drizzle/0003_billing-wf02.sql`, `test/migration-0003.integration.test.ts`, `src/sessions/charge-settlement.service.ts`, `src/console/console.router.ts`, rồi báo chỗ nào khác với ghi chép.

## Các phần

| # | Phần | Nội dung | Xong khi | Trạng thái |
|---|---|---|---|---|
| 1 | Schema bổ sung | Các bảng billing đã có (0003). Viết migration `0015` (D8; 0010–0012 và 0014 đã dùng cho BE-16, 0013 cho BE-07): enum `refund_kind`, `refund_status` + bảng `refunds` (D1), cột mới cho `invoice_adjustments` (D5), `next_attempt_at` + index quét cho `e_invoices`, `invoice_adjustments`, `refunds`, index `top_ups (status, expires_at)` (D7). Cập nhật `billing.ts`, `enums.ts`, `relations.ts`; thêm `NHAT-KY-MIGRATION-0015.md`, cập nhật `THIET-KE-CSDL-VAT-LY.md` | `migrate.mjs` áp được trên DB sạch và trên DB đã có các migration trước; `test/migration-0015.integration.test.ts` kiểm từng ràng buộc mới (cả nhánh vi phạm) | ☑ 04/11 (nhánh `wp5/t32-migration-refunds-0013`, PR #85; thay PR #83) |
| 2 | State machine | `TopUpStateMachine` + `TopUpEvent` (STM-4), `RefundStateMachine` (STM-10). Thuần logic | Unit test mọi chuyển hợp lệ và không hợp lệ | ☑ 04/11 (nhánh `wp5/t32-state-machine-billing`) |
| 3 | Sổ cái | `CreditLedgerService.post` / `getBalance`: entryNo, `balanceAfterVnd`, snapshot, `active ↔ in_shortfall`; `ensureAccounts(driverId)`; `LoyaltyService.earnForSession` để WP3 thay SQL thô (D9). Báo Sơn khi merge | Test bất biến số dư = Σ sổ cái; test unique `(top_up_id, transaction_type)` | ☑ 06/11 (nhánh `wp5/t32-so-cai-credit`) |
| 4 | Loyalty (phần nạp) | `quoteRedemption` (≥ 500 điểm, ≤ 50% số tiền, 100 điểm = 1.000 VND), `redeemForTopUp` (lúc cộng tiền; điểm đã hết hạn thì `redeem` phần còn lại và ghi `adjust` `points = 0` cho phần thiếu, D3 ⊕), `restoreForTopUp` (giữ hạn cũ; trả −Σ `redeem` của top-up, không theo `points_redeemed`) | Unit test các giới hạn; test điểm hết hạn trước lúc cộng tiền (`pointsBalance` không âm, không trừ hai lần); hoàn một top-up có điểm hết hạn → không trả dư điểm | ☐ |
| 5 | SD-2a tạo top-up | `TopUpController.create/get`, `TopUpService.create`, Idempotency-Key, khoá `credit_accounts`, BR-P22 theo ADR-0013, chỉ `pending` chặn (409 kèm `paymentUrl` ⊕), hẹn timeout, `VnpayAdapter.buildPaymentUrl` (D2) | TC-STM4-01/11/16/18 pass; test idempotency và race hai request song song | ☐ |
| 6 | SD-2b IPN | `VnpayIpnController.handleIpn`, `TopUpService.applyPaymentResult`, verify chữ ký, mã 97/01/04/02/00, `requestForTopUp` và realtime sau commit (D3). **Migration mới** (số kế tiếp lúc làm): nới `top_ups_late_payment_status_check` thành `status IN ('expired','failed')`, sửa COMMENT `late_gateway_ref`, sửa COMMENT `credit_accounts.closure_refunded_at` theo D6 (0015 còn ghi "hệ thống tự hoàn"; schema TS đã sửa ở Phần 3), test hợp lệ/bị chặn, Trí review (D4 ⊕). Log warn khi máy trả `conflicting_result` | TC-STM4-02/03/08/09/10, TC-STM5-03/05 pass; IPN gửi lặp không cộng hai lần | ☐ |
| 7 | SD-2c hoá đơn | `EInvoiceService.requestForTopUp/issue`, `EInvoiceProviderAdapter` stub, retry 4 lượt qua `failed`, `needs_review` (D5) | TC-STM7-* pass; lỗi hoá đơn không ảnh hưởng top-up | ☐ |
| 8 | SD-2d timeout và trễ | `TopUpService.onPendingTimeout`, `VnpayAdapter.queryTransaction`, `expired`, cửa sổ trễ 1 giờ, ghi khoản trễ; ⊕ kiểm tra lại hạn mức, ⊕ querydr lỗi thì hẹn lại (D4) | TC-STM4-04/05/06/07/15 pass | ☐ |
| 9 | SD-2e hoàn tiền | `TopUpService.refund/refundLatePayment`, `RefundService.create/send/retry`, `VnpayAdapter.refund`, truy vấn trước khi gửi lại, `EInvoiceService.adjustForRefund` sau `done` (D1, D5) | TC-STM4-12/13/14, TC-STM10-* pass | ☐ |
| 10 | Admin | `AdminBillingController.refundTopUp/refundLatePayment/retryRefund/retryInvoice`, `BillingExceptionsQuery` (khoản trễ, hoá đơn `needs_review`, refund `failed`, tài khoản đóng chờ hoàn) (D10). Route `closure-refund` làm ở Phần 11 | Test phân quyền Admin + từng hành động | ☐ |
| 11 | Đóng tài khoản (D6; SD-2f vẽ sai) | Bước 1 `AccountClosureService.requestClosure`: điều kiện đóng (không có phiên đang chạy **và** không có phiên đã dừng mà `charge_settlement_jobs.state = 'pending'`, decisions "Còn mở"), `closed` + `closed_at` + khoá đăng nhập (stub), không ghi sổ, không tạo refund. Bước 2 `refundClosedAccount(accountId, adminId)` + route admin `closure-refund`: chia newest-first, ghi sổ `refund −tổng` + `adjustment −phần dư`, refund `account_closure` (`requestedBy = adminId`), trả 202; guard `FOR UPDATE` + `closed` + `balance > 0`; `post` trên tài khoản `closed` chỉ nhận `refund` / `adjustment`; `closureRefundedAt` khi không còn refund `account_closure` nào chưa `done` | Test:<br>• điều kiện chặn đóng, kể cả phiên đã dừng chưa quyết toán; bước 1 không ghi sổ<br>• số dư 0 lúc đóng → `closure_refunded_at = closed_at`<br>• phân bổ newest-first; có phần dư thì số dư vẫn về 0<br>• toàn bộ là phần dư → không tạo refund, `closure_refunded_at` ghi ngay<br>• hai request `closure-refund` song song → đúng một lần, request kia nhận 409<br>• `post` loại khác trên tài khoản `closed` bị từ chối<br>• `closure_refunded_at` ghi khi refund cuối `done` | ☐ |
| 12 | Worker quét DB dùng chung (D7) | Interface `BackgroundWork`, vòng quét `next_attempt_at … FOR UPDATE SKIP LOCKED`, chạy sớm qua `Scheduler`, quét lúc khởi động. **Làm trước Phần 7** (Phần 5 có thể dùng tạm `Scheduler` cho timeout) | Test: dòng đến hạn được xử lý đúng một lần kể cả khi hai worker chạy song song; khởi động lại vẫn bắt được việc còn tồn | ☐ |

### Tên nhánh cho từng phần

Thứ tự làm đề xuất: tài liệu → 1 → 2 → 3 → 4 → 12 → 5 → 6 → 7 → 8 → 9 → 10 → 11.

| Phần | Nhánh |
|---|---|
| Tài liệu (CLAUDE.md, decisions, plan, diagram) | `wp5/t32-tai-lieu-va-diagram-wf02` |
| 1 | `wp5/t32-migration-refunds` |
| 2 | `wp5/t32-state-machine-billing` |
| 3 | `wp5/t32-so-cai-credit` |
| 4 | `wp5/t32-loyalty-nap-tien` |
| 5 | `wp5/t32-tao-top-up` |
| 6 | `wp5/t32-vnpay-ipn` |
| 7 | `wp5/t32-hoa-don-stub` |
| 8 | `wp5/t32-timeout-thanh-toan-tre` |
| 9 | `wp5/t32-hoan-tien` |
| 10 | `wp5/t32-api-admin-billing` |
| 11 | `wp5/t32-dong-tai-khoan` |
| 12 | `wp5/t32-worker-quet-db` |

Một phần quá 400 dòng thay đổi thì tách thành `…-a`, `…-b`.

Việc nền viết theo D7 (quét DB). API admin bám D10. Đường dẫn theo bảng ở D8. HTTP viết vào router thuần của `src/console/` theo `docs/api/DRIVER-API-HOP-DONG.md`, không viết Nest controller (tên `…Controller` của CD-2 dùng cho lớp xử lý route).

## Phụ thuộc đang dùng stub

| Phụ thuộc | Bên sở hữu | Stub trong billing | Trạng thái bản thật |
|---|---|---|---|
| Xác thực tài xế (JWT, MB-02 của WP3; dev: header `X-Driver-Id` khi `DRIVER_API_DEV_AUTH=true`) và Admin (`/api/admin` chưa có xác thực, RolesGuard sau Review 3) | WP3 / chung | | |
| Màn hình admin billing (dùng hợp đồng D10) | WP4 (nhánh dashboard chưa merge) | | |
| `UserAccountService.disableLogin` | WF-05 | | |
| `RealtimeGateway.emit` | realtime | | |
| `SessionQuery.hasRunningSession` (+ `hasUnsettledSession`, chờ thống nhất với Sơn) | WF-01/03 | | |
| Tạo `CreditAccount` (+ `LoyaltyAccount`; settlement WP3 đã tự tạo loyalty khi thiếu) | chưa có module `users` | | |
| Ghi `session_debit` + loyalty `earn` | WP3 (`charge-settlement.service.ts`, đang ghi thẳng) | | |
| VNPay sandbox (TMN code, hash secret, URL IPN public) | Khang / nhóm | | |

## Yêu cầu cho nhóm

- Sơn (WP3): đồng ý D9 (sau Phần 3, `charge-settlement` gọi `CreditLedgerService.post` / `earnForSession`); không mở rộng thêm SQL ghi bảng billing trong lúc chờ.
- ~~Nhóm: báo đã giữ số migration `0012` cho billing.~~ 0012 đã dùng cho BE-16; billing dùng `0015`.
- Người làm đăng ký tài xế: gọi `ensureAccounts(driverId)`.
- WP4: thống nhất bảng D10 (dạng trả về 202 của refund và `closure-refund`), thêm mục refund `failed` + retry.
- WP4 (dashboard, hộp thoại hoàn tài khoản đóng): hiện số **không hoàn được** (phần số dư vượt tổng `amountPaidVnd` của các top-up `credited` chưa hoàn; ghi `adjustment` −phần dư, D6) trước khi Admin xác nhận. Mock đang có `uncoveredVnd`; theo D6 trường này tên là `nonRefundableVnd`.
- Khang (SRS): sửa BR-P21 cho phần dư không hoàn được khi đóng tài khoản (D6); báo người vẽ SD-2f vẽ lại theo D6.
- Trí (chủ DB): migration Phần 6 có thể siết thêm `refunds_requested_by_check` thành `requested_by IS NOT NULL` (D6, mục "Còn mở" của decisions).
- Người lo Caddy staging / app Flutter: đường dẫn `/billing/vnpay/ipn`, `/billing/vnpay/return`, `/api/driver/v1/billing/top-ups`, `/api/driver/v1/me/account/close`.
- Trí (chủ DB): review migration 0015 — dùng lại `e_invoice_status` / `e_invoice_error_kind`, `invoice_adjustments.issued_at` thành nullable, B5 (bỏ `top_ups.refunded_by`), `refunds.requested_by` → `admins`, và hai chỗ sửa trong `erd-alignment.integration.test.ts` (`docs/NHAT-KY-MIGRATION-0015.md` mục 4). Cập nhật B5 "đã làm" ở `NHAT-KY-ERD-ALIGNMENT.md` mục 4 và `DESIGN-BRIEF-WP2-INPUT.md` G19.
- Nhóm: nơi nào tạo user Admin phải chèn thêm dòng `admins` (0011), nếu không thì Admin đó không ghi được `refunds.requested_by`.
- Nhóm: 0015 không chặn ai, nhưng code mới INSERT `e_invoices` / `invoice_adjustments` phải để `next_attempt_at` theo DEFAULT (hoặc ghi giá trị) khi `status` là `requested`/`failed`; ghi NULL sẽ bị CHECK từ chối.
- Trí (chủ DB): review migration của Phần 6 nới `top_ups_late_payment_status_check` cho khoản trễ trên top-up `failed` (D4 ⊕).
- WP4 (dashboard tab 2) và `BillingExceptionsQuery` (Phần 10): lọc khoản trễ theo `late_gateway_ref IS NOT NULL AND late_refunded_at IS NULL`, **không** lọc `status = 'expired'`. TC-ADM08-16 (`docs/UC-ADM-08-BILLING-EXCEPTIONS.md`) đang lọc theo status ở client, sẽ bỏ sót khoản trễ trên top-up `failed`.
- Sơn (WP3), sau khi Phần 3 merge (D9): `BillingModule` export `CreditLedgerService` và `LoyaltyService`; `SessionsModule` import `BillingModule`. Thay SQL thô trong `charge-settlement.service.ts`:
  - `ledger.post(c, accountId, 'session_debit', -Number(amount), { sessionId })` → dùng `.id` cho `debit_id`;
  - `loyalty.earnForSession(c, driverId, sessionId, Number(points))` → dùng `.id` cho `loyalty_entry_id`.
  - Hai hàm nhận `number`, không nhận `BigInt`. WP3 đã chặn `amount > MAX_SAFE_INTEGER`; `post` kiểm safe integer thêm lần nữa và ném `LedgerPostRejected('invalid_amount')` nếu sai.
  - `c` là `PoolClient` của `chargeTransaction`; hai hàm không tự BEGIN. Gọi `post` trước `earnForSession` (thứ tự khoá).
  - `accountId` vẫn tra theo `driver_id` như hiện tại; `post` khoá lại cùng dòng trong cùng transaction, không sao.
  - Phiên ghi lặp: `post` ném `LedgerEntryExists` (`err.existing`), không có lỗi 23505. `earnForSession` lặp trả `{ created: false }` cùng dòng cũ.
  - Phiên không thuộc tài xế của tài khoản: cả hai hàm ném `LedgerPostRejected('reference_mismatch')`.
  - Khác SQL hiện tại: `post` đưa `in_shortfall → active` khi số dư về ≥ 0, và từ chối `session_debit` trên tài khoản `closed` (`account_closed`).
  - `post` không đụng `charge_settlement_jobs.reason`; ánh xạ lỗi sang `reason` vẫn do WP3 làm.
  - Đóng tài khoản (Phần 11, D6 bước 1): cần thống nhất `SessionQuery.hasUnsettledSession(driverId)` (hoặc mở rộng `hasRunningSession`), trả true khi còn phiên đang chạy **hoặc** phiên đã dừng mà `charge_settlement_jobs.state = 'pending'`. Không chặn thì job quyết toán chạy sau khi đóng bị `post` từ chối (`account_closed`) và kẹt `pending`.
- (Claude Code ghi thêm vào đây khi phát hiện cần gì từ module khác.)

## Ghi chú

(Phát hiện khi khảo sát repo, quyết định nhỏ trong lúc code, chỗ lệch tên so với CD-2.)

- 03/11: decisions viết lại theo diagram v2.0. Chỗ diagram lệch code / ADR (theo code, chờ sửa diagram): `reservation_fee` trong CD-2, kiểu tiền `number`, "monthly cap" ở SD-2a, đường dẫn không có tiền tố `/api/...` (D8).
- Class / method thêm ngoài CD-2 (CD-2 chỉ vẽ thành viên chính): `TopUpStateMachine`, `RefundStateMachine`, worker D7, `BillingExceptionsQuery`, `getBalance`, `ensureAccounts`, `quoteRedemption`, `earnForSession`.
- 04/11 (Phần 0, xác nhận lại trên `main` `f9f0975`): khác ghi chép ở hai chỗ, đều không chạm billing: `main` đã có `0009_bo-payment-mode-free.sql` (BE-11, đổi enum `payment_mode`) và refactor đổi tên pillar → charge point (T90). Số `0012` vẫn trống.
- 04/11 (Phần 1): `refunds.last_error_kind` và `invoice_adjustments.last_error_kind` dùng lại enum `e_invoice_error_kind`; `invoice_adjustments.status` dùng lại `e_invoice_status` (lý do: D8 đã cập nhật, nhật ký 0015 mục 2). `next_attempt_at` có DEFAULT `now()` trên cả ba bảng, kèm CHECK chặn NULL khi dòng còn chờ. `invoice_adjustments.refund_id` để nullable. Tiền kiểm: 0015 dừng nếu `invoice_adjustments` đã có hàng hoặc đã có top-up `refunded`.
- 04/11 (Phần 1): đối chiếu máy SQL ↔ Drizzle phát hiện index `loyalty_transactions_one_earn_per_session` (từ `0004` của WP3) chưa có trong `billing.ts`. **Phần 3** thêm vào schema TS khi viết `earnForSession`.
- 04/11 (Phần 1, sau BE-16): Trí merge `0010`–`0012` (ERD alignment, PR #84) trước. Billing làm lại trên nhánh mới `wp5/t32-migration-refunds-0013` (PR #85, đóng PR #83); sau đó BE-07 (#82) lấy `0013`, nên rebase và đổi thành `0015` trên cùng nhánh. Theo quyết định cùng Khang: `refunds.requested_by` → `admins (user_id)` (ISA 0011); làm luôn **B5** (bỏ `top_ups.refunded_by` + hai CHECK) trong 0015; thêm `refunds_requested_by_idx` theo quy ước A5; FK của `refunds` giữ NO ACTION theo C3. `reservation_fee` đã có trong enum (0010), nên D8 hết lệch CD-2 ở điểm này.
- 04/11 (Phần 1): sửa test của người khác vì B5 và vì danh sách migration ghi cứng: `migration-0003` (bỏ các ca `refunded_by`), `erd-alignment` (xoá ngoại lệ A5 `top_ups_refunded_by_fkey`; phần danh sách migration ghi cứng đã được #82 sửa). Lý do từng chỗ: nhật ký 0015 mục 4.
- 04/11 (Phần 1, sau BE-16 đợt 2 #86): `0014` bị chiếm lần nữa → đổi thành `0015`, rebase trên cùng nhánh. Theo C1/C2 của đợt 2: `gateway_refund_no`, `provider_adjustment_no` là `varchar(20)`; `refunds` thêm `updated_at`, `invoice_adjustments` thêm `created_at` + `updated_at` (`$onUpdate` ở schema TS). **Code billing sau này:** mọi `UPDATE` thô lên `refunds`, `invoice_adjustments`, `top_ups`, `e_invoices` phải ghi `updated_at = now()` (test quét mã nguồn của 0014 sẽ bắt).
- 04/11 (Phần 2): `TopUpStateMachine` (STM-4) và `RefundStateMachine` (STM-10) là lớp thuần trong `src/billing/`, cùng mẫu `FaultStateMachine`. Lỗi chung ở `invalid-transition.ts`: `InvalidTransition` (sai trạng thái → 409) và `MissingGuard` (service quên truyền guard; lỗi lập trình).
  - STM-4: event `PAYMENT_SUCCEEDED`, `PAYMENT_FAILED`, `TIMEOUT_NOT_PAID`, `ADMIN_REFUND`. Guard truyền vào: `transactionNo`, `recordedLateRef`, `withinLateWindow`, `limitsOk`, `balanceCoversAmount`. `outcome` là `transition`, `already_applied`, `late_payment`, `conflicting_result`, `stale` (timeout sau khi đã rời `pending`) hoặc `rejected` (số dư không đủ ở #7, không ném). Guard thêm `appliedTransactionNo` (= `gateway_transaction_no`) cho thành công trên `credited`/`refunded`.
  - Số chuyển STM-4: #1 tạo, #2–#4 từ `pending`, #5 trả trễ trong cửa sổ, #6 trả trễ ngoài cửa sổ (khoản trễ, vẫn `expired`), #7 Admin hoàn.
  - STM-10: event `GATEWAY_CONFIRMED`, `ATTEMPT_FAILED` (`errorKind`, `attemptCount` sau lượt vừa thử), `ADMIN_RETRY`; `RETRY_LIMIT = 4` export để Phần 12 dùng. Số chuyển theo thứ tự mũi tên của file: #1 tạo, #2 tự vòng, #3 done, #4 failed, #5 Admin retry.
  - Lệch CD-2: CD-2 không vẽ `TopUpEvent` / `RefundEvent`; tên event do code đặt. `canApply(from, event)` không nhận guard (chỉ cho biết event có được nhận ở trạng thái đó).
  - Quyết định cùng Khang (ghi ở D3, D4 ⊕): kết quả thanh toán lặp là no-op, kết quả mâu thuẫn (lỗi sau khi đã cộng, thành công khác `transactionNo`) là `conflicting_result`, timeout muộn là `stale`; chỉ `ADMIN_REFUND` sai trạng thái mới ném; thành công sau `failed` là khoản trễ; khoản trễ trùng `transactionNo` là no-op, khác là `conflicting_result`. Mâu thuẫn với CHECK 0003 → migration ở Phần 6.
  - Commit `diagrams/report4/state/STM-10/STM-10.puml` (trước đó chưa có trong repo).
- 06/11 (tài liệu, cùng Khang):
  - Điểm đã dùng hết hạn trước lúc cộng tiền: vẫn cộng đủ, ghi loyalty `adjust` `points = 0` cho phần thiếu (D2/D3/D4 ⊕).
  - `restoreForTopUp` trả theo tổng dòng `redeem`.
  - `closure_refunded_at` chốt cho cả ba trường hợp (D1, D6).
  - Đóng tài khoản theo SRS UC-ADM-08, không theo SD-2f: tài xế chỉ đóng, Admin hoàn (D6 viết lại, D10 sửa).
  - Phần số dư vượt tổng `amountPaidVnd` thì không hoàn, ghi `adjustment` −phần dư.
  - Refund `account_closure` có `requestedBy = adminId`. Code không còn dựa vào ngoại lệ null của `refunds_requested_by_check`.
- 06/11 (Phần 3): `CreditLedgerService` (`post`, `getBalance`, `ensureAccounts`), `LoyaltyService.earnForSession`, `BillingModule` (đăng ký trong `app.module.ts`).
  - `credit_transactions` **không có CHECK dấu tiền** (chỉ có CHECK tham chiếu `session_debit`/`top_up`/`reservation_fee`), nên `post` kiểm ở app: `top_up` > 0, `session_debit` ≤ 0 (cho phép 0 như WP3), `refund` < 0, `reservation_fee` < 0, `adjustment` ≠ 0.
  - Lệch chữ ký: `ref` có thêm `reservationId?` (CHECK `reservation_fee` ⇔ `reservation_id`). Trùng `reservation_id` kiểm trước INSERT → `LedgerEntryExists` (`credit_transactions_reservation_id_key`). Chưa kiểm reservation thuộc tài khoản (chưa có bên gọi); vì unique `reservation_id` là toàn bảng, hai ví khác nhau ghi phí cho cùng một reservation chỉ bị unique của DB chặn (23505).
  - `post` kiểm `top_ups.credit_account_id = accountId` và `sessions.driver_id` = tài xế của tài khoản; sai → `reference_mismatch`. `earnForSession` cũng kiểm `sessions.driver_id`.
  - Trùng `(top_up_id, transaction_type)` / `one_debit_per_session`: kiểm trước dưới khoá ví, ném `LedgerEntryExists` kèm dòng cũ. Không để 23505 xảy ra, vì 23505 làm hỏng transaction bên gọi. `earnForSession` lặp thì trả dòng cũ.
  - Tài khoản `closed`: chỉ `refund`/`adjustment`, số âm, số dư sau ghi ≥ 0 (`closed_account_overdraw`); `status` giữ `closed`.
  - Ngoài `closed`: số dư < 0 → `in_shortfall`, ≥ 0 → `active` (WP3 hiện không đưa về `active`).
  - Hạn điểm earn: `LOYALTY_POLICY` đọc cùng biến `CHARGE_POINTS_EXPIRY_MONTHS` (mặc định 12) với WP3, không import `sessions/`.
  - `billing.ts`: thêm `loyalty_transactions_one_earn_per_session` (đã có từ 0004). Sửa JSDoc `closureRefundedAt` theo D6; `COMMENT ON COLUMN` của 0015 sửa ở migration Phần 6.
  - Test song song ép hai transaction chồng nhau (chờ `pg_stat_activity.wait_event_type = 'Lock'`). Đã thử bỏ `FOR UPDATE`: cả hai test fail.
