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
| 4 | Loyalty (phần nạp) | `quoteRedemption` (≥ 500 điểm, ≤ 50% số tiền, 100 điểm = 1.000 VND), `redeemForTopUp` (lúc cộng tiền; điểm đã hết hạn thì `redeem` phần còn lại và ghi `adjust` `points = 0` cho phần thiếu, D3 ⊕), `restoreForTopUp` (giữ hạn cũ; trả −Σ `redeem` của top-up, không theo `points_redeemed`); hàm thuần tính điểm còn sống theo lô earn (FIFO) + `expireDue(now)` (D11) | Unit test các giới hạn; test điểm hết hạn trước lúc cộng tiền (`pointsBalance` không âm, không trừ hai lần); hoàn một top-up có điểm hết hạn → không trả dư điểm; test FIFO: redeem tiêu lô cũ nhất, restore về đúng hạn cũ, `expireDue` chỉ trừ phần còn sống | ☑ 10/11 (nhánh `wp5/t32-loyalty-nap-tien`) |
| 5 | SD-2a tạo top-up | `TopUpController.create/get`, `TopUpService.create`, Idempotency-Key, khoá `credit_accounts`, BR-P22 theo ADR-0013, chỉ `pending` chặn (409 kèm `paymentUrl` ⊕), hẹn timeout, `VnpayAdapter.buildPaymentUrl` (D2) | TC-STM4-01/11/16/18 pass; test idempotency và race hai request song song | ☐ |
| 6 | SD-2b IPN | `VnpayIpnController.handleIpn`, `TopUpService.applyPaymentResult`, verify chữ ký, mã 97/01/04/02/00, `requestForTopUp` và realtime sau commit (D3). **Migration mới** (số kế tiếp lúc làm): nới `top_ups_late_payment_status_check` thành `status IN ('expired','failed')`, sửa COMMENT `late_gateway_ref`, sửa COMMENT `credit_accounts.closure_refunded_at` theo D1 chốt 09/11 (0015 còn ghi "NULL = … không có gì để hoàn"; nay không tạo refund nào → `= closed_at`), test hợp lệ/bị chặn, Trí review (D4 ⊕). Log warn khi máy trả `conflicting_result`. ⊕ `redeemForTopUp` ném `LoyaltyLedgerCorrupt` → vẫn cộng tiền, chỉ catch đúng lỗi này (+ SAVEPOINT quanh redeem), ghi `adjust` 0 bằng hàm riêng (khoá `loyalty_accounts`, không phát lại sổ), log lỗi có cấu trúc, báo Admin, trả RspCode 00 (D3 ⊕, chốt 10/11 Ân) | TC-STM4-02/03/08/09/10, TC-STM5-03/05 pass; IPN gửi lặp không cộng hai lần; IPN với sổ điểm hỏng vẫn cộng tiền, trả 00, lỗi khác vẫn rollback, gửi lặp không cộng / không ghi `adjust` hai lần | ☐ |
| 7 | SD-2c hoá đơn | `EInvoiceService.requestForTopUp/issue`, `EInvoiceProviderAdapter` stub, retry 4 lượt qua `failed`, `needs_review` (D5) | TC-STM7-* pass; lỗi hoá đơn không ảnh hưởng top-up | ☐ |
| 8 | SD-2d timeout và trễ | `TopUpService.onPendingTimeout`, `VnpayAdapter.queryTransaction`, `expired`, cửa sổ trễ 1 giờ, ghi khoản trễ; ⊕ kiểm tra lại hạn mức, ⊕ querydr lỗi thì hẹn lại (D4) | TC-STM4-04/05/06/07/15 pass | ☐ |
| 9 | SD-2e hoàn tiền | `TopUpService.refund/refundLatePayment`, `RefundService.create/send/retry`, `VnpayAdapter.refund`, truy vấn trước khi gửi lại, `EInvoiceService.adjustForRefund` sau `done` (D1, D5). Guard hoàn top-up theo **số dư khả dụng** (`balance_vnd` − Σ `reserved_vnd` intent chưa kết thúc, như `card-eligibility.ts`) → `insufficient_available_balance`; tài khoản `closed` → `account_closed` 409; `refundLatePayment` vẫn cho phép trên `closed` (D1 ⊕) | TC-STM4-12/13/14, TC-STM10-* pass; test có intent đang giữ chỗ làm số dư khả dụng < số tiền → từ chối; tài khoản `closed` → `account_closed`; hoàn khoản trễ trên `closed` → được | ☐ |
| 10 | Admin | `AdminBillingController.refundTopUp/refundLatePayment/retryRefund/retryInvoice`, `BillingExceptionsQuery` (khoản trễ, hoá đơn `needs_review`, refund `failed` gồm cả `account_closure`) (D10); danh sách "top-up có thể hoàn" loại top-up của tài khoản `closed` (⊕, D10) | Test phân quyền Admin + từng hành động; top-up `credited` của tài khoản `closed` không xuất hiện trong danh sách có thể hoàn | ☐ |
| 11 | Đóng tài khoản (D6, theo SD-2f, chốt 09/11) | Một bước, một transaction: `AccountClosureService.requestClosure(driverId)` + route `POST /api/driver/v1/me/account/close`. Khoá `credit_accounts FOR UPDATE` trước mọi kiểm tra; đã `closed` → 200 kết quả cũ dựng từ dữ liệu đã ghi; điều kiện `active`, không top-up `pending`, `hasUnsettledSession = false` (stub, định nghĩa D6 (c)); hàm thuần chia newest-first (mỗi phần ≤ `amountPaidVnd`); `post(refund, −tổng)` + `post(adjustment, −phần dư)` khi còn `active`; refund `account_closure` (`requestedBy = null`); `LoyaltyService.forfeitOnClosure` (một dòng `expire`); `active → closed` + `closed_at` + `disableLogin` (stub); không có refund → `closure_refunded_at = closed_at`; trả 200 `{closed, refundIds, refundTotalVnd, nonRefundableVnd, pointsForfeited}`. `previewClosure` + route `GET …/me/account/close-preview` (chỉ đọc, cùng hàm chia). `earnForSession` từ chối tài khoản `closed`. `closureRefundedAt` khi refund `account_closure` cuối `done` | Test:<br>• điều kiện chặn: intent `pending`, phiên thẻ RFID chưa xong, phiên `review`, job settlement `pending`, top-up `pending`, `in_shortfall`<br>• khoá trước kiểm (đóng song song với start sạc xếp hàng đúng)<br>• chia newest-first; có phần dư thì số dư vẫn về 0<br>• số dư 0 → `closure_refunded_at = closed_at`<br>• điểm về 0 bằng một dòng `expire`<br>• gửi lại request → 200 cùng kết quả<br>• hai request đóng song song → ghi sổ đúng một lần, request kia nhận 200 cùng kết quả<br>• preview khớp kết quả đóng<br>• `earnForSession` từ chối tài khoản `closed`<br>• `closure_refunded_at` ghi khi refund cuối `done` | ☐ |
| 12 | Worker quét DB dùng chung (D7) | Interface `BackgroundWork`, vòng quét `next_attempt_at … FOR UPDATE SKIP LOCKED`, chạy sớm qua `Scheduler`, quét lúc khởi động. **Làm trước Phần 7** (Phần 5 có thể dùng tạm `Scheduler` cho timeout) | Test: dòng đến hạn được xử lý đúng một lần kể cả khi hai worker chạy song song; khởi động lại vẫn bắt được việc còn tồn | ☐ |
| 13 | Job hết hạn điểm (D11; BR-P36, SRS job #18) | Job hằng ngày gọi `LoyaltyService.expireDue(now)` (Phần 4): ghi `expire` cho phần còn sống của lô đã hết hạn; chống chạy chồng; bỏ qua tài khoản `closed` | Test: hai lượt chạy song song / chạy lại không trừ hai lần; tài khoản `closed` không bị đụng; chỉ trừ phần còn sống (lô đã redeem một phần) | ☐ |

### Tên nhánh cho từng phần

Thứ tự làm đề xuất: tài liệu → 1 → 2 → 3 → 4 → 12 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 13.

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
| 13 | `wp5/t32-het-han-diem` |

Một phần quá 400 dòng thay đổi thì tách thành `…-a`, `…-b`.

Việc nền viết theo D7 (quét DB). API admin bám D10. Đường dẫn theo bảng ở D8. HTTP viết vào router thuần của `src/console/` theo `docs/api/DRIVER-API-HOP-DONG.md`, không viết Nest controller (tên `…Controller` của CD-2 dùng cho lớp xử lý route).

## Phụ thuộc đang dùng stub

| Phụ thuộc | Bên sở hữu | Stub trong billing | Trạng thái bản thật |
|---|---|---|---|
| Xác thực tài xế (JWT, MB-02 của WP3; dev: header `X-Driver-Id` khi `DRIVER_API_DEV_AUTH=true`) và Admin (`/api/admin` chưa có xác thực, RolesGuard sau Review 3) | WP3 / chung | | |
| Màn hình admin billing (dùng hợp đồng D10) | WP4 (nhánh dashboard chưa merge) | | |
| `UserAccountService.disableLogin` | WF-05 | | |
| `RealtimeGateway.emit` | realtime | | |
| `SessionQuery.hasUnsettledSession` (định nghĩa ở decisions D6 (c), chờ thống nhất với Sơn / Trí) | WF-01/03 | | |
| Tạo `CreditAccount` (+ `LoyaltyAccount`; settlement WP3 đã tự tạo loyalty khi thiếu) | chưa có module `users` | | |
| Ghi `session_debit` + loyalty `earn` | WP3 (`charge-settlement.service.ts`, đang ghi thẳng) | | |
| VNPay sandbox (TMN code, hash secret, URL IPN public) | Khang / nhóm | | |

## Yêu cầu cho nhóm

- Sơn (WP3): đồng ý D9 (sau Phần 3, `charge-settlement` gọi `CreditLedgerService.post` / `earnForSession`); không mở rộng thêm SQL ghi bảng billing trong lúc chờ.
- ~~Nhóm: báo đã giữ số migration `0012` cho billing.~~ 0012 đã dùng cho BE-16; billing dùng `0015`.
- Người làm đăng ký tài xế: gọi `ensureAccounts(driverId)`.
- WP4: thống nhất bảng D10 (dạng trả về 202 của refund), thêm mục refund `failed` + retry.
- WP4 (Nghĩa, dashboard): bỏ nút hoàn tài khoản đóng và bộ lọc `closed_unrefunded` (hệ thống tự hoàn, D6 chốt 09/11); tab refund `failed` gồm cả `account_closure`, retry một lượt, không reset bộ đếm; hoàn top-up có thể bị từ chối với `insufficient_available_balance` hoặc `account_closed` (D1, D10).
- Khang + Ân (SRS): danh sách sửa ở mục "Còn mở" của decisions (BR-P21, BR-P22, BR-P44, UC-ADM-08 / §3.4.1, màn hình 31, Figure 14).
- Ân (SRS): BR-P35 thêm câu "điểm hết hạn giữa lúc báo giá và lúc IPN về: khoản giảm giữ nguyên, nền tảng chịu phần thiếu" (D3 ⊕, xác nhận 10/11).
- Ân (diagram): vẽ lại SD-2a, SD-2f, CD-2 theo danh sách ở mục "Còn mở" của decisions (Khang đã gửi 09/11).
- Sơn (app Flutter): gọi `GET /api/driver/v1/me/account/close-preview` rồi hiện màn hình xác nhận đóng (số được hoàn, số **không hoàn được**, số điểm bị huỷ, các lý do chặn) trước khi gọi `POST …/me/account/close` (D6).
- Sơn / Trí: thống nhất định nghĩa `SessionQuery.hasUnsettledSession(driverId)` theo D6 (c) (intent chưa kết thúc, phiên kể cả phiên thẻ chưa ở trạng thái cuối về tiền, job settlement `pending`).
- Trí / Sơn: G5 (tính tiền phiên thẻ RFID) dùng `CreditLedgerService.post` / `earnForSession`, không mở rộng SQL thô ghi bảng billing (D9).
- Ân (WF-05): đồng ý cài `UserAccountService.disableLogin` bằng `users.account_status = 'closed'` (D6 (h)).
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
  - Đóng tài khoản (Phần 11, D6 (c)): cần thống nhất `SessionQuery.hasUnsettledSession(driverId)` theo định nghĩa ở D6 (c). Không chặn thì job quyết toán chạy sau khi đóng bị `post` từ chối (`account_closed`) và kẹt `pending`.
- (Claude Code ghi thêm vào đây khi phát hiện cần gì từ module khác.)

## Ghi chú

(Phát hiện khi khảo sát repo, quyết định nhỏ trong lúc code, chỗ lệch tên so với CD-2.)

- 03/11: decisions viết lại theo diagram v2.0. Chỗ diagram lệch code / ADR (theo code, chờ sửa diagram): `reservation_fee` trong CD-2, kiểu tiền `number`, "monthly cap" ở SD-2a, đường dẫn không có tiền tố `/api/...` (D8).
- Class / method thêm ngoài CD-2 (CD-2 chỉ vẽ thành viên chính): `TopUpStateMachine`, `RefundStateMachine`, worker D7, `BillingExceptionsQuery`, `getBalance`, `ensureAccounts`, `quoteRedemption`, `earnForSession`, `expireDueForAccount`, `loyalty-lots.ts`.
- 04/11 (Phần 0, xác nhận lại trên `main` `f9f0975`): khác ghi chép ở hai chỗ, đều không chạm billing: `main` đã có `0009_bo-payment-mode-free.sql` (BE-11, đổi enum `payment_mode`) và refactor đổi tên trụ sang charge point (T90). Số `0012` vẫn trống.
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
  - ~~`closure_refunded_at` chốt cho cả ba trường hợp (D1, D6).~~ → thay bởi Q2 09/11.
  - ~~Đóng tài khoản theo SRS UC-ADM-08, không theo SD-2f: tài xế chỉ đóng, Admin hoàn (D6 viết lại, D10 sửa).~~ → thay bởi Q2 09/11.
  - Phần số dư vượt tổng `amountPaidVnd` thì không hoàn, ghi `adjustment` −phần dư.
  - ~~Refund `account_closure` có `requestedBy = adminId`. Code không còn dựa vào ngoại lệ null của `refunds_requested_by_check`.~~ → thay bởi Q2 09/11.
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
- 09/11 (tài liệu, Khang chốt với Ân; thay phần đóng tài khoản của ghi chú 06/11):
  - Q1: BR-P22 "top-up đang mở" chỉ là `pending` (giữ D2 ⊕); SRS sửa theo.
  - Q2: đóng tài khoản theo SD-2f — hệ thống tự hoàn ngay khi tài xế đóng, Admin không bấm hoàn. Bỏ bước 2 / `refundClosedAccount` / route `closure-refund`; refund `account_closure` có `requestedBy = null` (đúng CHECK 0015). D6 viết lại, D10 bỏ dòng tài khoản đóng chờ hoàn.
  - Q3: phần dư không hoàn được vẫn ghi `adjustment` −phần dư trong transaction đóng; thêm `close-preview`.
  - Q4: huỷ điểm khi đóng (BR-P36) bằng một dòng loyalty `expire` = −`points_balance`, cùng transaction đóng.
  - Q5: gửi lại request đóng → 200 với kết quả cũ, dựng lại từ dữ liệu đã ghi (không bảng/cột mới).
  - Q6: guard Admin hoàn top-up dùng số dư khả dụng (như `card-eligibility.ts`, BE-19); thêm lý do `insufficient_available_balance`, `account_closed`.
  - Q7: job hết hạn điểm hằng ngày (SRS job #18) do WP5 làm → D11, Phần 4 (hàm thuần) + Phần 13 (job).
  - `closure_refunded_at` còn hai trường hợp (D1). COMMENT của 0015 vẫn phải sửa ở migration Phần 6 (NULL chỉ = "chưa hoàn xong"); bỏ việc siết `refunds_requested_by_check`.
  - Diagram: Ân vẽ lại SD-2a, SD-2f, CD-2 (danh sách ở "Còn mở" của decisions); PR này không sửa diagram.
- 10/11 (Phần 4): `loyalty-lots.ts` (hàm thuần) + `LoyaltyService.quoteRedemption` / `redeemForTopUp` / `restoreForTopUp` / `expireDueForAccount`. Không migration.
  - **Nhận diện lô:** lô = các dòng `earn` cùng `expires_at` (trùng hạn gộp một). Mỗi dòng `redeem` / `restore` / `expire` theo hạn ghi đúng một lô, mang `expires_at` của lô (top-up tiêu 2 lô → 2 dòng redeem). `adjust` 0 và `expire` lúc đóng tài khoản (D6 g) để `expires_at` NULL. Earn của WP3 và `earnForSession` luôn có `expires_at`.
  - **Độ chính xác:** `expires_at` có µs, JS `Date` chỉ có ms. `lot_id` = `min(id)` của các dòng earn cùng `expires_at` (SQL so chính xác); khi ghi, `expires_at` **copy bằng SQL** từ dòng `lot_id`, không truyền timestamp từ JS. Dòng có hạn không khớp lô earn nào → `LoyaltyLedgerCorrupt('unknown_lot')`.
  - **Dòng sai dạng** (adjust ≠ 0, thiếu `expires_at`, lô không có, trừ quá lô, trả quá phần đã earn, sai dấu) và `points_balance ≠ Σ points` → `LoyaltyLedgerCorrupt(reason, entryNo)`, ném trước mọi câu ghi, không đoán cách sửa. Đảo điểm khi phiên bị sửa (BR-P37) cần quy tắc riêng (vd. `adjust` âm mang `expires_at` của lô): ai làm thì mở rộng `applyRow` trong `loyalty-lots.ts`.
  - **Thời gian:** hàm thuần nhận `asOf`; service nhận `asOf?`, bỏ trống thì dùng `now()` của DB (cùng đồng hồ với earn). Lô sống ⇔ `expires_at > asOf`.
  - **Quote:** `requestedPoints?` (trống = tối đa `min(điểm sống, floor(amountVnd / 20))`), không bắt bội số 100. Lỗi `RedemptionRejected`: `invalid_amount`, `invalid_points`, `below_minimum`, `insufficient_points`, `exceeds_cap`. Hằng số BR-P35 nằm trong `loyalty-lots.ts` (SRS: Admin cấu hình được, Must dùng mặc định).
  - **Gọi lặp:** redeem kiểm dòng `redeem`/`adjust` của top-up dưới khoá; restore trả Σ redeem − Σ restore đã có; expire phát lại nên lô đã expire không còn phần dư.
  - **Restore vào lô đã hết hạn** (chốt cùng Khang): trả về lô cũ rồi expire ngay trong cùng transaction (cùng hàm của `expireDueForAccount`, expire mọi lô chết còn dư của tài khoản). Không còn gì để trả → không chạy expire.
  - **Khoá:** redeem khoá `loyalty_accounts` trước, chỉ INSERT tài khoản khi thiếu. Nếu INSERT … ON CONFLICT chạy trước thì nó tự chờ transaction đang giữ dòng và che mất việc thiếu `FOR UPDATE` (đã gặp khi thử đột biến). Đã thử bỏ `FOR UPDATE`: test song song fail (B trùng `entry_no`).
  - **Lệch CD-2:** thêm `tx` / `exec` đầu tiên; `redeemForTopUp(topUp)` / `restoreForTopUp(topUp)` → `(tx, driverId, topUpId, asOf?)` (kiểm top-up thuộc tài xế → `reference_mismatch`; đọc lại dưới khoá thay vì tin object bên gọi); `quoteRedemption(driverId, points, amountVnd)` → `(exec, driverId, amountVnd, {requestedPoints?, asOf?})`; `expireDue(now)` tách: Phần 4 có `expireDueForAccount(tx, loyaltyAccountId, asOf?)`, Phần 13 thêm `expireDue(now)` lặp qua tài khoản. Lỗi mới: `RedemptionRejected`, `LoyaltyLedgerCorrupt`, `LoyaltyAccountNotFound`.
  - Hiển thị điểm (UC-PAY-04) phải dùng `livePoints` / `pointsExpiringBy` từ `replayLots`, không đọc `points_balance` (D11).
  - Sổ điểm đọc toàn bộ mỗi lần ghi (đủ cho quy mô hiện tại). Cần nhanh hơn thì thêm snapshot lô sau.
