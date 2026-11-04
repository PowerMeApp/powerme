# WF-02 – Kế hoạch implement

> Đặt tại `docs/tasks/WF-02_plan.md`. Claude Code cập nhật cột Trạng thái và mục Ghi chú sau mỗi phần.
> Mỗi phiên làm một phần. Plan mode → duyệt → test trước → code → chạy test.
> Nguồn chính: diagram `diagrams/wf02/` (CD-2, SD-2a…2f v2.0); tóm tắt và bổ sung ở `docs/spec/WF-02_decisions.md`.

## Phần 0 – Khảo sát repo (đã làm sơ bộ 03/11, commit `ce3902c`)

Kết quả đã ghi vào mục "Bối cảnh repo" của `apps/csms/src/billing/CLAUDE.md` và D8 của decisions. Phiên đầu chỉ cần **xác nhận lại** trên `main` mới nhất (có thể đã có commit mới), đọc `src/db/schema/billing.ts`, `drizzle/0003_billing-wf02.sql`, `test/migration-0003.integration.test.ts`, `src/sessions/charge-settlement.service.ts`, `src/console/console.router.ts`, rồi báo chỗ nào khác với ghi chép.

## Các phần

| # | Phần | Nội dung | Xong khi | Trạng thái |
|---|---|---|---|---|
| 1 | Schema bổ sung | Các bảng billing đã có (0003). Viết migration `0012` (D8): enum `refund_kind`, `refund_status` + bảng `refunds` (D1), cột mới cho `invoice_adjustments` (D5), `next_attempt_at` + index quét cho `e_invoices`, `invoice_adjustments`, `refunds`, index `top_ups (status, expires_at)` (D7). Cập nhật `billing.ts`, `enums.ts`, `relations.ts`; thêm `NHAT-KY-MIGRATION-0012.md`, cập nhật `THIET-KE-CSDL-VAT-LY.md` | `migrate.mjs` áp được trên DB sạch và trên DB đã có các migration trước; `test/migration-0012.integration.test.ts` kiểm từng ràng buộc mới (cả nhánh vi phạm) | ☑ 04/11 (nhánh `wp5/t32-migration-refunds`, chờ PR) |
| 2 | State machine | `TopUpStateMachine` + `TopUpEvent` (STM-4), `RefundStateMachine` (STM-10). Thuần logic | Unit test mọi chuyển hợp lệ và không hợp lệ | ☐ |
| 3 | Sổ cái | `CreditLedgerService.post` / `getBalance`: entryNo, `balanceAfterVnd`, snapshot, `active ↔ in_shortfall`; `ensureAccounts(driverId)`; `LoyaltyService.earnForSession` để WP3 thay SQL thô (D9). Báo Sơn khi merge | Test bất biến số dư = Σ sổ cái; test unique `(top_up_id, transaction_type)` | ☐ |
| 4 | Loyalty (phần nạp) | `quoteRedemption` (≥ 500 điểm, ≤ 50% số tiền, 100 điểm = 1.000 VND), `redeemForTopUp` (lúc cộng tiền), `restoreForTopUp` (giữ hạn cũ) | Unit test các giới hạn | ☐ |
| 5 | SD-2a tạo top-up | `TopUpController.create/get`, `TopUpService.create`, Idempotency-Key, khoá `credit_accounts`, BR-P22 theo ADR-0013, chỉ `pending` chặn (409 kèm `paymentUrl` ⊕), hẹn timeout, `VnpayAdapter.buildPaymentUrl` (D2) | TC-STM4-01/11/16/18 pass; test idempotency và race hai request song song | ☐ |
| 6 | SD-2b IPN | `VnpayIpnController.handleIpn`, `TopUpService.applyPaymentResult`, verify chữ ký, mã 97/01/04/02/00, `requestForTopUp` và realtime sau commit (D3) | TC-STM4-02/03/08/09/10, TC-STM5-03/05 pass; IPN gửi lặp không cộng hai lần | ☐ |
| 7 | SD-2c hoá đơn | `EInvoiceService.requestForTopUp/issue`, `EInvoiceProviderAdapter` stub, retry 4 lượt qua `failed`, `needs_review` (D5) | TC-STM7-* pass; lỗi hoá đơn không ảnh hưởng top-up | ☐ |
| 8 | SD-2d timeout và trễ | `TopUpService.onPendingTimeout`, `VnpayAdapter.queryTransaction`, `expired`, cửa sổ trễ 1 giờ, ghi khoản trễ; ⊕ kiểm tra lại hạn mức, ⊕ querydr lỗi thì hẹn lại (D4) | TC-STM4-04/05/06/07/15 pass | ☐ |
| 9 | SD-2e hoàn tiền | `TopUpService.refund/refundLatePayment`, `RefundService.create/send/retry`, `VnpayAdapter.refund`, truy vấn trước khi gửi lại, `EInvoiceService.adjustForRefund` sau `done` (D1, D5) | TC-STM4-12/13/14, TC-STM10-* pass | ☐ |
| 10 | Admin | `AdminBillingController.refundTopUp/refundLatePayment/retryRefund/retryInvoice`, `BillingExceptionsQuery` (khoản trễ, hoá đơn `needs_review`, refund `failed`, tài khoản đóng chờ hoàn) (D10) | Test phân quyền Admin + từng hành động | ☐ |
| 11 | SD-2f đóng tài khoản | `AccountClosureController/Service.requestClosure`, điều kiện đóng, ghi sổ `−balance`, chia newest-first, refund `account_closure` (`requestedBy = null`), khoá đăng nhập (stub), `closureRefundedAt` (D6) | Test điều kiện chặn đóng, phân bổ newest-first, số dư về 0 | ☐ |
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
| `SessionQuery.hasRunningSession` | WF-01/03 | | |
| Tạo `CreditAccount` (+ `LoyaltyAccount`; settlement WP3 đã tự tạo loyalty khi thiếu) | chưa có module `users` | | |
| Ghi `session_debit` + loyalty `earn` | WP3 (`charge-settlement.service.ts`, đang ghi thẳng) | | |
| VNPay sandbox (TMN code, hash secret, URL IPN public) | Khang / nhóm | | |

## Yêu cầu cho nhóm

- Sơn (WP3): đồng ý D9 (sau Phần 3, `charge-settlement` gọi `CreditLedgerService.post` / `earnForSession`); không mở rộng thêm SQL ghi bảng billing trong lúc chờ.
- Nhóm: báo đã giữ số migration `0012` cho billing.
- Người làm đăng ký tài xế: gọi `ensureAccounts(driverId)`.
- WP4: thống nhất bảng D10 (dạng trả về 202 của refund, đóng tài khoản không cần Admin hoàn), thêm mục refund `failed` + retry.
- Người lo Caddy staging / app Flutter: đường dẫn `/billing/vnpay/ipn`, `/billing/vnpay/return`, `/api/driver/v1/billing/top-ups`, `/api/driver/v1/me/account/close`.
- Trí (chủ DB, đã làm 0003): review migration 0012, nhất là việc dùng lại `e_invoice_status` / `e_invoice_error_kind` và đổi `invoice_adjustments.issued_at` thành nullable (`docs/NHAT-KY-MIGRATION-0012.md` mục 2).
- Nhóm: 0012 không chặn ai, nhưng code mới INSERT `e_invoices` / `invoice_adjustments` phải để `next_attempt_at` theo DEFAULT (hoặc ghi giá trị) khi `status` là `requested`/`failed`; ghi NULL sẽ bị CHECK từ chối.
- (Claude Code ghi thêm vào đây khi phát hiện cần gì từ module khác.)

## Ghi chú

(Phát hiện khi khảo sát repo, quyết định nhỏ trong lúc code, chỗ lệch tên so với CD-2.)

- 03/11: decisions viết lại theo diagram v2.0. Chỗ diagram lệch code / ADR (theo code, chờ sửa diagram): `reservation_fee` trong CD-2, kiểu tiền `number`, "monthly cap" ở SD-2a, đường dẫn không có tiền tố `/api/...` (D8).
- Class / method thêm ngoài CD-2 (CD-2 chỉ vẽ thành viên chính): `TopUpStateMachine`, `RefundStateMachine`, worker D7, `BillingExceptionsQuery`, `getBalance`, `ensureAccounts`, `quoteRedemption`, `earnForSession`.
- 04/11 (Phần 0, xác nhận lại trên `main` `f9f0975`): khác ghi chép ở hai chỗ, đều không chạm billing: `main` đã có `0009_bo-payment-mode-free.sql` (BE-11, đổi enum `payment_mode`) và refactor đổi tên pillar → charge point (T90). Số `0012` vẫn trống.
- 04/11 (Phần 1): `refunds.last_error_kind` và `invoice_adjustments.last_error_kind` dùng lại enum `e_invoice_error_kind`; `invoice_adjustments.status` dùng lại `e_invoice_status` (lý do: D8 đã cập nhật, nhật ký 0012 mục 2). `next_attempt_at` có DEFAULT `now()` trên cả ba bảng, kèm CHECK chặn NULL khi dòng còn chờ. `invoice_adjustments.refund_id` để nullable. Tiền kiểm: 0012 dừng nếu `invoice_adjustments` đã có hàng.
- 04/11 (Phần 1): đối chiếu máy SQL ↔ Drizzle phát hiện index `loyalty_transactions_one_earn_per_session` (từ `0004` của WP3) chưa có trong `billing.ts`. **Phần 3** thêm vào schema TS khi viết `earnForSession`.
