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
| 5 | SD-2a tạo top-up | Viết lại 12/11 (D2). **Migration 0019**: UNIQUE `(credit_account_id, idempotency_key)` thay UNIQUE một cột, `idempotency_key` → `varchar(100)`, bỏ index một cột `credit_account_id` (UNIQUE mới phủ FK, A5), `request_hash varchar(64)` nullable, partial UNIQUE một `pending` mỗi tài khoản, tiền kiểm dừng khi dữ liệu cũ có > 1 pending. `TopUpService.quote/create/get` + `VnpayAdapter.buildPaymentUrl` (hàm thuần, URL dựng lại, không lưu DB); route `driver/top-ups.http.ts` (`GET …/quote`, `POST …/billing/top-ups` 201 / gửi lại 200, `GET …/{id}`), một schema `TopUp`. Idempotency theo tài khoản + `request_hash` (sha256 `[amount_vnd, points_to_redeem]`, cách băm của `driver-charging`); khoá `credit_accounts` trước mọi kiểm tra; BR-P22 theo ADR-0013 → 422 `amount_out_of_range` / `balance_limit_exceeded`; điểm → 422 `points_below_minimum` / `points_unavailable` / `points_exceed_cap` (không trừ điểm); 409 `idempotency_conflict` / `account_closed` / `top_up_pending` (+ `top_up_id`, `payment_url`) / `pending_top_up_confirming` (+ `top_up_id`, không tự expire); 503 `payment_unconfigured`. **Không hẹn timeout** (Phần 8). **Route chưa dùng cho app tới khi Phần 6 và 8 merge** (chưa có IPN / trang return → sandbox quay về 404; không có gì chuyển `pending` sang `expired`) | `test/billing-top-up.integration.test.ts` (TC-STM4-01; BR-P22; điểm; pending chưa / đã quá hạn, không tự expire; `request_hash`; idempotency; race hai connection thật; GET; quote), `test/driver-top-ups.integration.test.ts` (201/200, 409 kèm trường thêm, 422, 401, 400 key / body, 413, 415, 405, 503, preflight), `test/migration-0019.integration.test.ts`, `src/billing/vnpay.adapter.spec.ts`; A5 không cần ngoại lệ | ☑ 12/11 (nhánh `wp5/t32-tao-top-up`) |
| 6 | SD-2b IPN | Viết lại 13/11 theo prompt T32 Phần 6 (Khang + Ân chốt 12–13/11; D3, D4, D7, D8). ~~**Trước khi bắt đầu:** chốt dấu hiệu `adjust` do sổ hỏng và lần trả thứ hai cho cùng top-up; nới CHECK thành `status IN ('expired','failed')`; ghi `adjust` 0 bằng hàm riêng khi sổ hỏng; log warn khi `conflicting_result`~~ → thay bởi T32 Phần 6 13/11. **Migration 0021** (`0021_top-up-ipn-ngoai-le.sql`, Trí review): CHECK `top_ups_late_payment_status_check` → `late_gateway_ref IS NULL OR status <> 'pending'` (T116); COMMENT `late_*` (`late_gateway_ref` = `vnp_TransactionNo`, bỏ cửa sổ 1 giờ); `top_ups.next_attempt_at` (T127, backfill pending = `expires_at + 2 phút`, partial index `top_ups_pending_next_attempt_idx`); enum `top_up_exception_kind` + `exception_kind` / `exception_reviewed_at` + hai CHECK; partial UNIQUE `loyalty_transactions_one_adjust_per_top_up` (tiền kiểm); COMMENT `closure_refunded_at` (D1) và `completed_at`. `TopUpStateMachine`: thành công trên `credited` / `refunded` → `already_applied` / khoản trễ / `conflicting_result` (guard `recordedLateRef`). `TopUpService.applyPaymentResult` (97 / 99 / 01 / 04; chưa ngã ngũ 07 / 01 / 04 / một mã `00` → giữ `pending`, 00; khoá `top_ups` → `credit_accounts`; #2 / #3 / khoản trễ / 02; `conflicting_result` log error; sổ điểm hỏng → SAVEPOINT + `exception_kind = 'loyalty_error'`, vẫn cộng, 00; lỗi khác → 99), `create` ghi `next_attempt_at`, `completed_at` khi rời `pending`. Route `billing/vnpay-ipn.http.ts` (`GET /billing/vnpay/ipn`, `GET /billing/vnpay/return` trang tĩnh), gắn trước console; Caddy staging + `VNPAY_*` cho csms staging. Không gọi e-invoice (Phần 7, điểm gọi `afterPaymentCommitted`), không realtime (chưa có kênh) | TC-STM4-02 (thành công, lặp → 02, lần trả thứ hai → khoản trễ, khoản thứ ba → 02 + log error), TC-STM4-03 (thất bại; 07, `TransactionStatus` 01 / 04 / 07, một mã `00` → vẫn `pending`), TC-STM4-04 (bước IPN: pending quá `expires_at` → credited), TC-STM4-05 (`failed` → khoản trễ); khoản trễ trên `expired` (#6) / `refunded`; 97 / 01 / 04 / 99; ký tự đặc biệt; điểm (redeem, `adjust` 0, sổ hỏng → `loyalty_error` 00 rồi lặp 02, lỗi khác → 99 vẫn `pending`); race hai connection; `late_paid_at`; route (chỉ hai đường, `/billing…` khác 404, 405). File: `test/billing-ipn.integration.test.ts`, `test/vnpay-ipn-route.integration.test.ts`, `test/migration-0021.integration.test.ts`, `src/billing/top-up-state-machine.spec.ts`, `src/billing/vnpay.adapter.spec.ts` | ☑ 13/11 (nhánh `wp5/t32-vnpay-ipn`) |
| 7 | SD-2c hoá đơn | `EInvoiceService.requestForTopUp/issue`, `EInvoiceProviderAdapter` stub, retry 4 lượt qua `failed`, `needs_review` (D5) | TC-STM7-* pass; lỗi hoá đơn không ảnh hưởng top-up | ☐ |
| 8 | SD-2d timeout và trễ | Viết lại 14/11 theo prompt T32 Phần 8 (Khang + Ân chốt 12–14/11; D3, D4, D7). Không migration (dùng cột 0021). `VnpayAdapter.queryTransaction` (querydr POST JSON tới `VNPAY_API_URL`, timeout 10 s, `vnp_IpAddr` = `VNPAY_SERVER_IP` hoặc `127.0.0.1`; hàm thuần `querydrRequest` / `classifyQuerydrResponse`, chuỗi ký `\|` theo thứ tự tài liệu, kiểu kết quả `paid` / `failed` / `not_found` / `unresolved`). Vòng quét `top-up-timeout` (`TopUpService` tự cài `BackgroundWork`, `runLeasedBatch` trên `top_ups`, điều kiện hằng `status = 'pending'`); `onPendingTimeout`: querydr ngoài tx → `lockLeased` → `credit_accounts` → bảng 3.1 (D4); chưa ngã ngũ → mốc kế `expires_at` + 2 / 5 / 10 / 20 / 40 / 60 phút tính theo `now()`; hết lịch → `expired` (+ `unresolved_04/07` khi lần cuối TS 04 / 07). Đường áp kết quả dùng chung IPN / querydr / recheck (`applyLockedResult`), `afterPaymentCommitted` cho cả querydr (`outcome` thêm `expired`). `TopUpService.recheckTopUp` (chưa có route, Phần 10). MSG26 chưa phát (chưa có kênh) | `src/billing/vnpay-querydr.spec.ts` (chuỗi ký request, từng dòng bảng 3.1, sai chữ ký / TmnCode / TxnRef / TransactionType / thiếu trường / sai số tiền → `unresolved`; adapter: timeout 10 s, HTTP ≠ 200, JSON hỏng, abort, chưa cấu hình không gọi HTTP; `VNPAY_API_URL` / `VNPAY_SERVER_IP`), `src/billing/top-up-timeout.spec.ts` (đăng ký `top-up-timeout`, thiếu cấu hình worker → `top_up_timeout_missing_config`, chưa cấu hình VNPay → 0, warn một lần), `test/billing-top-up-timeout.integration.test.ts`: TC-STM4-04 (bước querydr: `paid` → `credited`, điểm, `loyalty_error`, `afterPaymentCommitted`), `failed` / `not_found`, `unresolved` từng mốc + đánh thức trễ, hết lịch 04 / 07 / lỗi mạng / TS 01, IPN sau hết lịch → khoản trễ, chọn dòng đến hạn, chưa cấu hình, sập sau tx1, đua với IPN (3 ca), giữ chỗ chồng nhau, hai runner song song, `recheckTopUp` (từng dòng bảng, `not_eligible`, đổi điều kiện giữa đọc và khoá, IPN đua, chưa cấu hình); test Phần 6 không sửa assertion | ☑ 14/11 (nhánh `wp5/t32-timeout-thanh-toan-tre`) |
| 9 | SD-2e hoàn tiền | ⊕ 13/11: `refundLatePayment` hoàn cả khoản trễ trên `credited` / `refunded` (T116; gửi `late_gateway_ref` = `vnp_TransactionNo`, cùng `vnp_TxnRef` với top-up gốc — rủi ro VNPay trả 94 vì trùng mã, thử trên sandbox). `TopUpService.refund/refundLatePayment`, `RefundService.create/send/retry`, `VnpayAdapter.refund`, truy vấn trước khi gửi lại, `EInvoiceService.adjustForRefund` sau `done` (D1, D5). Guard hoàn top-up theo **số dư khả dụng** (`balance_vnd` − Σ `reserved_vnd` intent chưa kết thúc, như `card-eligibility.ts`) → `insufficient_available_balance`; tài khoản `closed` → `account_closed` 409; `refundLatePayment` vẫn cho phép trên `closed` (D1 ⊕) | TC-STM4-12/13/14, TC-STM10-* pass; test có intent đang giữ chỗ làm số dư khả dụng < số tiền → từ chối; tài khoản `closed` → `account_closed`; hoàn khoản trễ trên `closed` → được | ☐ |
| 10 | Admin | `AdminBillingController.refundTopUp/refundLatePayment/retryRefund/retryInvoice`, `BillingExceptionsQuery` (khoản trễ, hoá đơn `needs_review`, refund `failed` gồm cả `account_closure`) (D10); ⊕ 13/11: mục ngoại lệ top-up (`exception_kind` `loyalty_error` / `unresolved_04` / `unresolved_07`, chưa `exception_reviewed_at`) + route Admin đánh dấu đã xem (`exception_reviewed_at`) và "Kiểm tra lại" (⊕ 14/11: gọi `TopUpService.recheckTopUp(topUpId)` của Phần 8, trả `not_eligible` / `late_payment_recorded` / `already_recorded` / `conflicting_result` / `not_paid` / `still_unresolved`, `payment_unconfigured` → 503; thêm phân quyền + audit); khoản trễ gồm cả trên `credited` / `refunded`; danh sách "top-up có thể hoàn" loại top-up của tài khoản `closed` (⊕, D10) | Test phân quyền Admin + từng hành động; top-up `credited` của tài khoản `closed` không xuất hiện trong danh sách có thể hoàn | ☐ |
| 11 | Đóng tài khoản (D6, theo SD-2f, chốt 09/11) | Một bước, một transaction: `AccountClosureService.requestClosure(driverId)` + route `POST /api/driver/v1/me/account/close`. Khoá `credit_accounts FOR UPDATE` trước mọi kiểm tra; đã `closed` → 200 kết quả cũ dựng từ dữ liệu đã ghi; điều kiện `active`, không top-up `pending`, `hasUnsettledSession = false` (stub, định nghĩa D6 (c)); hàm thuần chia newest-first (mỗi phần ≤ `amountPaidVnd`); `post(refund, −tổng)` + `post(adjustment, −phần dư)` khi còn `active`; refund `account_closure` (`requestedBy = null`); `LoyaltyService.forfeitOnClosure` (một dòng `expire`); `active → closed` + `closed_at` + `disableLogin` (stub); không có refund → `closure_refunded_at = closed_at`; trả 200 `{closed, refundIds, refundTotalVnd, nonRefundableVnd, pointsForfeited}`. `previewClosure` + route `GET …/me/account/close-preview` (chỉ đọc, cùng hàm chia). `earnForSession` từ chối tài khoản `closed`. `closureRefundedAt` khi refund `account_closure` cuối `done` | Test:<br>• điều kiện chặn: intent `pending`, phiên thẻ RFID chưa xong, phiên `review`, job settlement `pending`, top-up `pending`, `in_shortfall`<br>• khoá trước kiểm (đóng song song với start sạc xếp hàng đúng)<br>• chia newest-first; có phần dư thì số dư vẫn về 0<br>• số dư 0 → `closure_refunded_at = closed_at`<br>• điểm về 0 bằng một dòng `expire`<br>• gửi lại request → 200 cùng kết quả<br>• hai request đóng song song → ghi sổ đúng một lần, request kia nhận 200 cùng kết quả<br>• preview khớp kết quả đóng<br>• `earnForSession` từ chối tài khoản `closed`<br>• `closure_refunded_at` ghi khi refund cuối `done` | ☐ |
| 12 | Worker quét DB dùng chung (D7) | Interface `BackgroundWork`, vòng quét `next_attempt_at … FOR UPDATE SKIP LOCKED`, chạy sớm qua `Scheduler`, quét lúc khởi động. **Làm trước Phần 7** (~~Phần 5 có thể dùng tạm `Scheduler` cho timeout~~ — Phần 5 không hẹn timeout, chốt 12/11; Phần 8 quét ~~`top_ups (status, expires_at)`~~ `top_ups (next_attempt_at) WHERE status = 'pending'` bằng `runLeasedBatch`, 14/11) | Test: dòng đến hạn được xử lý đúng một lần kể cả khi hai worker chạy song song; khởi động lại vẫn bắt được việc còn tồn | ☑ 10/11 (nhánh `wp5/t32-worker-quet-db`) |
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

Việc nền viết theo D7 (quét DB). API admin bám D10. Đường dẫn theo bảng ở D8. Route tài xế nằm ở `src/driver/` theo mẫu `charges.http.ts` (Phần 5: `driver/top-ups.http.ts`, gắn vào `driver.http.ts`, `TopUpService` truyền qua `createDriverListener` / `ConsoleServer`), theo `docs/api/DRIVER-API-HOP-DONG.md`; không viết Nest controller (tên `…Controller` của CD-2 dùng cho lớp xử lý route).

## Phụ thuộc đang dùng stub

| Phụ thuộc | Bên sở hữu | Stub trong billing | Trạng thái bản thật |
|---|---|---|---|
| Xác thực Admin (`/api/admin` chưa có xác thực, RolesGuard sau Review 3). ~~Xác thực tài xế (JWT, MB-02 của WP3; dev: header `X-Driver-Id`)~~ → tài xế đã là JWT thật (`authenticateDriver`, BE-21); `X-Driver-Id` chỉ còn là đường dev của `driver-auth.ts` khi `DRIVER_API_DEV_AUTH=true`, billing không dựa vào | WP3 / chung | | tài xế: có (12/11) |
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
- ~~Trí (chủ DB): review migration của Phần 6 nới `top_ups_late_payment_status_check` cho khoản trễ trên top-up `failed` (D4 ⊕).~~ → thay bởi T32 Phần 6 13/11: mục Trí review 0021 ở dưới.
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
- Ân (SRS, T117): `report3-srs.md` trên repo còn BR-P13 / BR-P22 bản cũ (cửa sổ trễ 1 giờ); cập nhật theo bản nộp 09/11.
- Ân (diagram, T117): STM-4 v1.1 `c1 --> expired : [else]` tách thành `[chưa trả, dứt khoát] → expired` và `[chưa ngã ngũ]` → ở lại `pending`, hẹn querydr lại (D4 ⊕ ĐIỀU KIỆN).
- Ân / Nghĩa (T117): `docs/UC-ADM-08-BILLING-EXCEPTIONS.md` tab 2 ("after `LATE_WINDOW` (1 h)", lọc `status = expired`) và dòng TC-STM4-06 ("after window") → lọc `late_gateway_ref IS NOT NULL AND late_refunded_at IS NULL`, bỏ chữ cửa sổ (cùng ý mục WP4 tab 2 ở trên).
- Trí (chủ DB, T32 Phần 5): review migration 0019 (Trí đồng ý trước mục 2–5 ngày 12/11 khi file còn là 0018; đổi số lúc rebase vì BE-34 lấy 0018). Kết quả test A5 sau khi bỏ `top_ups_credit_account_id_idx`: không có `top_ups_credit_account_id_fkey` (UNIQUE `(credit_account_id, idempotency_key)` phủ FK), không thêm ngoại lệ. Seed đổi sang `ON CONFLICT DO NOTHING` (lý do: `docs/NHAT-KY-MIGRATION-0019.md` mục 4).
- Sơn (app Flutter, T32 Phần 5): route top-up (`GET …/billing/top-ups/quote`, `POST …/billing/top-ups`, `GET …/billing/top-ups/{id}`) **chưa dùng cho app tới khi ~~Phần 6 và~~ Phần 8 merge** (IPN / trang return có từ Phần 6; vẫn chưa có gì chuyển `pending` sang `expired`). Review hợp đồng phần top-up: `DRIVER-API-HOP-DONG.md` §14, `driver-api.openapi.yaml`.
- Ân (diagram, T32 Phần 5): sửa SD-2a — `open_top_up` → `top_up_pending`, thêm ca `pending_top_up_confirming`, thêm quote (`GET …/quote`, `TopUpService.quote`), body `{amount_vnd, points_to_redeem?}`, 201 tạo mới / 200 gửi lại.
- Trí / Sơn (đề xuất, T32 Phần 5): tách helper `requestHash(values)` dùng chung cho `driver-charging.service.ts` (WP3, đang băm inline) và `top-up.service.ts` (`topUpRequestHash`). Phần 5 không sửa file của WP3.
- Trí (chủ DB, T32 Phần 6): review migration 0021 (`docs/NHAT-KY-MIGRATION-0021.md`): CHECK khoản trễ `status <> 'pending'`, `next_attempt_at` + partial index `top_ups_pending_next_attempt_idx` (đề xuất; không đồng ý thì bỏ), enum `top_up_exception_kind` + hai CHECK, partial UNIQUE `loyalty_transactions_one_adjust_per_top_up` + tiền kiểm, COMMENT `closure_refunded_at` / `completed_at`; ba test cũ sửa theo (nhật ký mục 4). Duyệt route Caddy staging `/billing/vnpay/ipn`, `/billing/vnpay/return` và `VNPAY_*` trong `infra/staging/docker-compose.yml`.
- Người lo staging (T32 Phần 6): điền `VNPAY_TMN_CODE` / `VNPAY_HASH_SECRET` / `VNPAY_RETURN_URL` (`https://<DOMAIN>/billing/vnpay/return`) trong `.env` trên VM; khai URL IPN `https://<DOMAIN>/billing/vnpay/ipn` trên cổng merchant VNPay sandbox.
- Ân (diagram, T32 Phần 6): sửa SD-2b / STM-4 — khoản trễ trên `credited` / `refunded` (lần trả thứ hai, T116); 07 / `TransactionStatus` 01 / 04 / một mã `00` giữ `pending` (trả 00); sổ điểm hỏng → `exception_kind` (không `adjust`); `conflicting_result` chỉ còn khoản thứ ba / lỗi trên top-up đã cộng. CD-2: `VnpayIpnController` là hàm (`diagrams/README.md` dòng 10), `VnpayAdapter.verifyIpn`.
- Ân (SRS, T124): BR-P13 theo T116 (khoản trễ trên mọi trạng thái trừ `pending`).
- Ân (T32 Phần 6): đối chiếu nghĩa `vnp_TransactionStatus` 01 / 04 / 07 trên sandbox (đang coi là chưa ngã ngũ).
- Ân / Nghĩa (UC-ADM-08, T32 Phần 6): Billing Exceptions thêm mục lỗi sổ điểm (`loyalty_error`) và ca 04 / 07 chưa ngã ngũ (`unresolved_04` / `unresolved_07`); khoản trễ gồm cả trên `credited` / `refunded`.
- Sơn (app Flutter, T32 Phần 6): sau Phần 6 route top-up **vẫn chưa dùng cho app tới khi Phần 8 merge**. Trang return `/billing/vnpay/return` chỉ báo "đang xác nhận"; app poll `GET /api/driver/v1/billing/top-ups/{id}`.
- Ân (diagram, T32 Phần 8): sửa SD-2d / STM-4 — lịch querydr lại (mốc `expires_at` + 2 / 5 / 10 / 20 / 40 / 60 phút, chưa ngã ngũ thì ở lại `pending`), nhánh `[chưa ngã ngũ]` của `c1`, hết lịch → `expired` (+ `unresolved_04` / `unresolved_07` khi lần cuối TS 04 / 07); `onPendingTimeout` chạy qua vòng quét có lease; CD-2 thêm `TopUpService.recheckTopUp`, `queryTransaction` trả kiểu phân loại (`diagrams/README.md` dòng 11).
- Sơn (app Flutter, T32 Phần 8): route top-up (`GET …/quote`, `POST …/billing/top-ups`, `GET …/{id}`) **dùng được cho app từ Phần 8** (pending quá hạn được querydr chốt; tài xế chờ ~2 phút, tối đa ~1 giờ sau `expires_at`, `pending_top_up_confirming`). Còn thiếu: e-invoice (Phần 7), chưa thử sandbox VNPay thật.
- Người lo staging (T32 Phần 8): điền `VNPAY_SERVER_IP` (IP ra ngoài của VM) khi thử querydr trên sandbox; `VNPAY_API_URL` để trống = sandbox. Caddy không đổi (querydr là gọi ra ngoài).
- Khang (T32 Phần 8): thử querydr trên sandbox thật — encode chuỗi ký, `vnp_Amount` ×100, trường tuỳ chọn thiếu, response 91 / lỗi có ký không, VNPay có kiểm `vnp_IpAddr` không (decisions "Còn mở").
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
  - STM-4: event `PAYMENT_SUCCEEDED`, `PAYMENT_FAILED`, `TIMEOUT_NOT_PAID`, `ADMIN_REFUND`. Guard truyền vào: `transactionNo`, `recordedLateRef`, ~~`withinLateWindow`~~, ~~`limitsOk`~~ (→ bỏ ở T117 11/11), `balanceCoversAmount`. `outcome` là `transition`, `already_applied`, `late_payment`, `conflicting_result`, `stale` (timeout sau khi đã rời `pending`) hoặc `rejected` (số dư không đủ ở #7, không ném). Guard thêm `appliedTransactionNo` (= `gateway_transaction_no`) cho thành công trên `credited`/`refunded`.
  - Số chuyển STM-4: #1 tạo, #2–#4 từ `pending`, ~~#5 trả trễ trong cửa sổ~~, #6 thành công sau khi đã `expired` (khoản trễ, vẫn `expired`), #7 Admin hoàn (→ T117 11/11).
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
- 10/11 (Phần 12): worker quét DB dùng chung, chỉ hạ tầng; chưa đăng ký loại việc nghiệp vụ nào. Không migration, không thêm `LATE_WINDOW`.
  - **Lệch chữ D7 (đã sửa D7):** D7 ghi "xử lý từng dòng trong transaction riêng", nhưng không được gọi HTTP trong transaction. Làm bằng **giữ chỗ có hạn**:
    - tx ngắn giữ chỗ **một** dòng (SKIP LOCKED + `next_attempt_at = now() + lease`, có `updated_at = now()`);
    - gọi ngoài transaction;
    - tx2 `lockLeased`.
    - Lý do chỉ giữ một dòng mỗi lần: giữ cả lô thì dòng cuối có thể hết lease trước khi tới lượt.
  - **Lease kiêm token:** `leaseToken` = `next_attempt_at::text` (đủ µs). `lockLeased` khoá `WHERE id AND next_attempt_at = token`; `null` = runner khác đã lấy lại sau khi hết lease → bỏ kết quả.
  - **Hợp đồng:** `BackgroundWork { name; runDue(limit, signal): Promise<number> }`. Mỗi loại tự lấy dòng, tự quản transaction, nên `top_ups` (theo `expires_at`) dùng được; cách giữ chỗ cho top-up để Phần 5/8.
    - `BackgroundWorkRunner.register` (gọi trong `onModuleInit`), `kick(name)`, `kickAt(name, at)`, `sweep()`.
    - Các loại chạy song song (`Promise.allSettled`). Mỗi loại có cờ đang chạy + cờ chạy lại: kick lúc đang chạy thì chạy thêm một lượt, không chồng.
    - Lô đầy thì gọi tiếp, tối đa 10 lô một lượt. Vòng sau hẹn khi vòng trước xong (không `setInterval`).
    - Bootstrap không chờ vòng quét đầu (không chặn app khởi động).
    - Dừng ở `beforeApplicationShutdown` (trước khi `DbModule` đóng pool): abort signal, huỷ hẹn giờ, chờ việc đang làm xong.
  - **`runLeasedBatch`:**
    - kiểm `signal` trước mỗi lần giữ chỗ;
    - `handle` ném thì log warn và sang dòng kế; dòng đó giữ lease rồi tự quay lại; vẫn tính vào số trả về để lô toàn dòng lỗi không lặp mãi.
  - **Rủi ro đã biết:** lease không tăng `attempt_count`, nên dòng làm tiến trình sập mỗi lần (không kịp ghi lỗi) sẽ được thử lại sau mỗi lease mà không bị đếm. Phần 7/9 cân nhắc nếu cần.
  - **Config** (`background-work.config.ts`, `infra/.env.example`):
    - `BILLING_WORKER_ENABLED=true`;
    - `BILLING_WORKER_INTERVAL_MS=30000` (1000–3600000; `setTimeout` quá 2^31−1 ms sẽ chạy sau 1 ms). `kickAt` kẹp độ trễ vào [0, `intervalMs`], vì xa hơn một vòng quét thì vòng quét bắt được;
    - `BILLING_WORKER_BATCH_SIZE=20` (1–100);
    - `BILLING_WORKER_LEASE_MS=120000` (≥ 30000; > querydr + refund 2 × 10 s).
    - Test dựng `AppModule` (vd. `charging-runtime`) hiện không bị ảnh hưởng (chưa có loại việc nào; timer `unref`, huỷ khi `app.close()`). Khi Phần 7/9 đăng ký việc thật, test đó có thể đặt `BILLING_WORKER_ENABLED=false`.
  - **Lịch retry:** `nextRetry(attemptCount)` trong `retry-schedule.ts`: 1 → 5 phút, 2 → 30 phút, 3 → 2 giờ, ≥ `RETRY_LIMIT` (import từ STM-10) → hết lượt. Bên gọi ghi `now() + delay` bằng đồng hồ DB.
  - **Lệch CD-2:** không có (CD-2 không vẽ worker). Chưa có mã TC của Report 5 cho phần này nên tên test không gắn mã; bổ sung khi T112 có.
  - **Đột biến** (`test/billing-worker.integration.test.ts`):
    - bỏ `SKIP LOCKED` → ca "giữ chỗ chồng nhau" fail (B chờ khoá);
    - bỏ `FOR UPDATE` → ca đó fail, và ca "hai runner song song" xử lý một dòng hai lần.
    - Đã khôi phục.
- 11/11 (T117): bỏ cửa sổ nạp muộn 1 giờ (Ân đề xuất 09/11, Khang đồng ý 10/11 kèm điều kiện). Không migration, không code service.
  - `TopUpStateMachine`: bỏ chuyển #5 (`expired → credited`) và guard `withinLateWindow` / `limitsOk`. Thành công trên `expired` chưa có khoản trễ → luôn `late_payment` #6. Giữ số #6, #7, không đánh số lại. Bộ 20 cặp vẫn 16 nhận / 4 ném (`expired × PAYMENT_SUCCEEDED` đổi từ `transition` sang `late_payment`).
  - Điều kiện của Khang cho Phần 8 (D4 ⊕ ĐIỀU KIỆN): chỉ `expired` khi querydr trả lời dứt khoát; chưa ngã ngũ thì giữ `pending`, hẹn querydr lại lùi dần ≤ ~1 giờ. Chỗ lưu lịch hẹn chốt trước 0017 (decisions "Còn mở").
  - D2: 409 hai lý do `top_up_pending` (kèm `paymentUrl`) / `pending_top_up_confirming` (pending đã quá `expires_at`, không kèm `paymentUrl`).
  - Bỏ "kiểm tra lại hạn mức trước khi cộng tiền trễ": tiền chỉ cộng khi còn `pending`, lúc đó tài khoản không đóng được (D6) và hạn mức đã kiểm lúc tạo.
  - Sửa JSDoc `billing.ts` (`lateGatewayRef`, CHECK `top_ups_late_payment_status_check`), `THIET-KE-CSDL-VAT-LY.md` mục `top_ups`, summary `listLatePayments` trong `operator-admin-api.openapi.yaml`.
- 12/11 (T32 Phần 5, tạo top-up):
  - Số TC-STM4-11/16/18 trong bảng tra cũ thuộc bộ WP5 v0.4 (24/10); Report 5 bản nộp chỉ có TC-STM4-01…08. Test Phần 5 gắn TC-STM4-01, còn lại đặt tên theo nội dung.
  - Phần 5 không tách nhánh dù vượt 400 dòng (Khang quyết).
  - Migration 0019 (0017 đã dùng cho BE-30; 0018 cho BE-34 #127, merge trước nên giữ số). File này được viết là 0018 và đổi sang 0019 lúc rebase 12/11 (tên file, test, nhật ký, tài liệu), rồi chạy lại toàn bộ test gồm bộ MB03.
  - Lệch CD-2: route là hàm trong `driver/top-ups.http.ts` thay `TopUpController`; thêm `TopUpService.quote` + `GET …/quote`; `VnpayAdapter.buildPaymentUrl(topUp, cfg, ip)` là hàm thuần (lớp `VnpayAdapter` bọc cấu hình) thay `buildPaymentUrl(topUp, amountVnd)` — số tiền lấy từ `topUp.amountPaidVnd`. Ghi ở `diagrams/README.md`.
  - Thêm ngoài CD-2: `LoyaltyService.livePoints(exec, driverId, asOf?)` (tách từ `quoteRedemption`, cho `points_available` của quote); `TopUpRejected` trong `billing-errors.ts`; `topUpRequestHash`; cấu hình `VNPAY_CONFIG` (`billing/vnpay.config.ts`, cùng mẫu `loyalty-policy.config.ts`).
  - Ngoài billing: `driver/charges.http.ts` chỉ thêm `export` cho `headerKey`, `safeId` (không đổi logic); `console/console.module.ts` import `BillingModule`; `console.server.ts` nhận `TopUpService` (`@Optional`).
  - Seed (`demo/seed.sql`, `demo/seed-app.sql`) đổi sang `ON CONFLICT DO NOTHING`: tên constraint đổi ở 0019 mà seed còn chạy trên DB trước 0019 (test `migration-0017`).
  - `vnp_IpAddr` = IP socket (chưa tin `X-Forwarded-For`; sau Caddy / tunnel là IP proxy — D2, cần chốt nếu VNPay bắt IP thật). Quy tắc encode / `vnp_OrderType` / độ dài: đối chiếu trang VNPay 2.1.0, chờ Khang kiểm với sandbox thật.
  - Đột biến (`billing-top-up.integration.test.ts`): bỏ `FOR UPDATE` trên `credit_accounts` → hai ca song song fail. Đã khôi phục.
  - Fixture `billing-loyalty`, `migration-0003` đổi sang `credited` vì partial UNIQUE một pending (chi tiết: nhật ký 0019 mục 4).
- 13/11 (T32 Phần 6, IPN VNPay; Khang + Ân chốt 12–13/11):
  - Nhánh `wp5/t32-vnpay-ipn` theo bảng "Tên nhánh" (prompt ghi `ipn-vnpay`; Khang chọn tên trong bảng).
  - **Migration 0021** (0020 thuộc T101): xem dòng Phần 6 và `docs/NHAT-KY-MIGRATION-0021.md`. Thay ý cũ của D4 "nới CHECK thành `status IN ('expired','failed')`" bằng `status <> 'pending'` (T116).
  - **Bốn chốt thêm lúc plan (Khang 13/11):**
    1. Đúng một trong hai mã (`vnp_ResponseCode`, `vnp_TransactionStatus`) là `00` → chưa ngã ngũ (giữ `pending`, 00), log warn kèm hai mã. Code mẫu VNPay dùng HOẶC; coi là thất bại sẽ đẩy top-up có thể đã trừ tiền sang `failed` (trạng thái cuối).
    2. `VNPAY_*` thêm vào `infra/staging/docker-compose.yml` + `infra/staging/.env.example` (trước đó compose ghi "code không đọc", IPN staging sẽ luôn 99).
    3. `completed_at = now()` khi rời `pending` (#2, #3 ở Phần 6; #4 ở Phần 8); không đổi khi `credited → refunded` / ghi khoản trễ; chỉ COMMENT, chưa CHECK.
    4. Chưa ngã ngũ tới khi top-up đã rời `pending` → không ghi gì, 00, log info (status, hai mã, `top_up_id`).
  - Tài liệu VNPay (trang PAY 2.1.0): IPN là GET, gọi lại tối đa 10 lần cách 5 phút khi nhận 01 / 04 / 97 / 99 hoặc timeout; code mẫu chỉ ký tham số `vnp_*` (làm theo), không kiểm `vnp_TmnCode` (Phần 6 vẫn kiểm → 97 theo prompt, không mâu thuẫn); múi giờ `vnp_PayDate` không ghi (đọc GMT+7 như `vnp_CreateDate`). Bảng `vnp_TransactionStatus` không đọc được nguyên văn → Ân đối chiếu.
  - Kiểm trường bắt buộc sau chữ ký: thiếu / sai dạng `vnp_TxnRef` / `vnp_Amount` / (`vnp_TransactionNo` ở ca thành công) → 99, log error (không thể xảy ra với VNPay thật; để VNPay gọi lại). Tham số `vnp_*` lặp trong query → 97 (route).
  - `parseVnpDate` sai dạng / ngày không có → coi như thiếu (`late_paid_at = now()`).
  - **Lệch CD-2:** `VnpayIpnController` → hàm `createVnpayListener` trong `billing/vnpay-ipn.http.ts`; `applyPaymentResult(params)` nhận query thô, tự kiểm chữ ký như SD-2b, trả `{RspCode, Message}`; thêm `VnpayAdapter.verifyIpn` + hàm thuần `verifyIpnSignature`, `classifyIpn`, `parseVnpDate`; `afterPaymentCommitted` (điểm gọi sau commit cho Phần 7). Ghi ở `diagrams/README.md` dòng 10.
  - Realtime: repo chưa có kênh realtime cho tài xế → không phát, không dựng (ghi D3).
  - `afterPaymentCommitted` lỗi → log error `ipn_after_commit_failed` (`top_up_id`, `outcome`, `error`), vẫn trả RspCode đã commit (trả 99 sẽ làm VNPay gọi lại IPN đã áp dụng). Có test.
  - Test cũ sửa theo 0021: `migration-0003` (bỏ ca "khoản muộn trên credited bị chặn"), `migration-0019` (thêm `top_ups_pending_next_attempt_idx` vào danh sách index của `billing.ts`); `top-up-state-machine.spec.ts` gắn lại nhãn TC (bỏ TC-STM4-15 / nhãn TC-STM4-04 ở dòng #4 / TC-STM4-06; thêm TC-STM4-04 bước IPN, TC-STM4-05). TC-STM4-06 ghi theo nội dung (#6) chờ Khang đối chiếu Report 5.
  - Đột biến (`billing-ipn.integration.test.ts`): bỏ `FOR UPDATE` trên `top_ups` → ca race fail (không còn ai chờ khoá). Đã khôi phục ngay, chạy lại ca race pass, `git diff` không còn đột biến.
- 14/11 (T32 Phần 8, timeout và thanh toán trễ; Khang + Ân chốt 12–14/11):
  - Nhánh `wp5/t32-timeout-thanh-toan-tre` từ `main` `4011386`. Không migration (cột 0021).
  - **Trang VNPay querydr** (`truy-van-hoan-tien/querydr&refund.html`, đọc 14/11): endpoint `https://sandbox.vnpayment.vn/merchant_webapi/api/transaction`, POST JSON. Thứ tự chuỗi ký request / response **khớp** thứ tự trong prompt; trang thiếu dấu `+` giữa `vnp_Amount` và `vnp_BankCode` (lỗi đánh máy). Trang không ghi encode (làm: không encode), không ghi `vnp_Amount` ×100 (làm: ×100 như IPN), trường tuỳ chọn thiếu → chuỗi rỗng. Chờ thử sandbox (decisions "Còn mở").
  - **Thay ý cũ:** D4 "lần thứ mấy suy từ `next_attempt_at − expires_at`" → mốc kế tính theo `now()` (lease ghi đè cột này); D7 / dòng Phần 12 "quét `top_ups (status, expires_at)`"; D2 / §14 / OpenAPI "chưa dùng cho app tới khi Phần 8 merge"; dòng Phần 8 cũ (TC-STM4-05 / 06 / 07 / 15 chưa đối chiếu Report 5 → chỉ gắn TC-STM4-04 bước querydr, còn lại theo nội dung).
  - **Chốt lúc plan (Khang 14/11):** `TopUpService` tự cài `BackgroundWork` (không tách lớp); `VNPAY_SERVER_IP` (trống = `127.0.0.1`); warn "chưa cấu hình" một lần mỗi tiến trình; `recheckTopUp` chưa cấu hình → `TopUpRejected('payment_unconfigured')`, `late_payment_recorded` cũng gọi `afterPaymentCommitted`; điều kiện hằng `status = 'pending'` cho `top_ups`; đánh thức trễ quá +60 → hỏi một lần rồi hết lịch. Thêm: test không assert index planner chọn (ghi EXPLAIN dưới đây); thiếu `workConfig` → `runDue` ném `top_up_timeout_missing_config` (có unit test).
  - **Cấu hình querydr tách khỏi `VnpayConfig`:** `loadVnpayApiConfig` + token `VNPAY_API_CONFIG` trong `vnpay.config.ts`, vì `vnpay.adapter.spec.ts` so cả object `loadVnpayConfig({})` bằng `toEqual` (thêm trường vào đó sẽ phải sửa assertion của Phần 5). Constructor `VnpayAdapter` / `TopUpService` thêm tham số tuỳ chọn ở cuối: test cũ dựng bằng tham số cũ vẫn chạy.
  - **Index:** generic plan với `status = ANY($1::top_up_status[])` không dùng được partial index (rơi về `top_ups_status_expires_at_idx`). Sau khi đổi sang hằng, `EXPLAIN ANALYZE` câu giữ chỗ trên `powerme_test` (20.000 dòng không pending + 50 pending trên một tài khoản, `ANALYZE`; trong transaction tạm bỏ `top_ups_one_pending_per_account_key` để seed, rồi ROLLBACK):
    ```
    Update on top_ups r (actual rows=1 loops=1)
      CTE due
        ->  Limit (actual rows=1 loops=1)
              ->  LockRows (actual rows=1 loops=1)
                    ->  Incremental Sort (actual rows=1 loops=1)
                          Sort Key: top_ups.next_attempt_at, top_ups.id
                          Presorted Key: top_ups.next_attempt_at
                          ->  Index Scan using top_ups_pending_next_attempt_idx on top_ups (actual rows=20 loops=1)
                                Index Cond: (next_attempt_at <= now())
                                Filter: (status = 'pending'::top_up_status)
      ->  Nested Loop (actual rows=1 loops=1)
            ->  CTE Scan on due (actual rows=1 loops=1)
            ->  Index Scan using top_ups_pkey on top_ups r (actual rows=1 loops=1)
    ```
  - **Bỏ kiểm `status` sau `lockLeased`:** khi còn kiểm token thì thừa (mọi đường rời `pending` đặt `next_attempt_at = NULL`), và nó che mất đột biến bỏ token. Dựa vào token như prompt (`null` → bỏ kết quả).
  - **Thứ tự khoá:** mọi đường Phần 8 khoá `top_ups` → `credit_accounts` (→ `loyalty_accounts`). `create` khoá `credit_accounts` rồi INSERT `top_ups` (không khoá dòng có sẵn) → không deadlock. Ghi ở billing/CLAUDE.md: Phần 9 / 11 không được khoá `credit_accounts` rồi mới `SELECT … FOR UPDATE` `top_ups`.
  - **Test dựng `AppModule`** (`charging-runtime`): không đặt `VNPAY_*` → `runDue` trả 0, không chạm DB; không cần `BILLING_WORKER_ENABLED=false` (full suite pass).
  - **File test** gộp so với plan: unit querydr + cấu hình API ở `src/billing/vnpay-querydr.spec.ts` (không sửa `vnpay.adapter.spec.ts`); vòng quét + `recheckTopUp` chung `test/billing-top-up-timeout.integration.test.ts` (dùng chung fixture).
  - **Lệch CD-2** (`diagrams/README.md` dòng 11): `onPendingTimeout(row: LeasedRow, signal?)` chạy qua `BackgroundWork` + lease thay vì `(topUpId)`; `queryTransaction(topUp, signal?)` nhận dòng top-up (cần `created_at`, `amount_paid_vnd`) và trả kiểu phân loại thay `GatewayStatus`; thêm `recheckTopUp`, `runDue`, `applyLockedResult`.
  - **Đột biến** (`billing-top-up-timeout.integration.test.ts`, khôi phục ngay bằng bản sao lưu, `cmp` khớp):
    - bỏ `SKIP LOCKED` ở câu giữ chỗ → ca "giữ chỗ chồng nhau" fail (B chờ khoá của A);
    - bỏ cả `FOR UPDATE SKIP LOCKED` → cùng ca đó fail (UPDATE của B chờ khoá dòng);
    - bỏ điều kiện token trong `lockLeased` → ca "IPN cộng trong lúc querydr đang chạy" fail (querydr ghi thành khoản trễ).
  - MSG26 (báo tài xế khi `expired`): chưa có kênh realtime / thông báo cho tài xế → không dựng; điểm gọi `afterPaymentCommitted` (`outcome: 'expired'`).
