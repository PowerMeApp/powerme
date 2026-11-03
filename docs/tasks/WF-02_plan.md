# WF-02 – Kế hoạch implement

> Đặt tại `docs/tasks/WF-02_plan.md`. Claude Code cập nhật cột Trạng thái và mục Ghi chú sau mỗi phần.
> Mỗi phiên làm một phần. Plan mode → duyệt → test trước → code → chạy test.

## Phần 0 – Khảo sát repo (đã làm sơ bộ 03/11, commit `ce3902c`)

Kết quả đã ghi vào mục "Bối cảnh repo" của `apps/csms/src/billing/CLAUDE.md` và D8 của decisions. Phiên đầu chỉ cần **xác nhận lại** trên `main` mới nhất (có thể đã có commit mới), đọc `src/db/schema/billing.ts`, `drizzle/0003_billing-wf02.sql`, `test/migration-0003.integration.test.ts`, `src/sessions/charge-settlement.service.ts`, `src/console/console.router.ts`, rồi báo chỗ nào khác với ghi chép.

## Các phần

| # | Phần | Nội dung | Xong khi | Trạng thái |
|---|---|---|---|---|
| 1 | Schema bổ sung | Các bảng billing đã có (0003). Viết migration mới (D8): enum + bảng `refunds` (D1), cột mới cho `invoice_adjustments` (D5), `next_attempt_at` + index quét cho `e_invoices`, `refunds`, `invoice_adjustments`, index `top_ups (status, expires_at)` (D4). Cập nhật `billing.ts`, `enums.ts`, `relations.ts`; thêm `NHAT-KY-MIGRATION-0010.md`, cập nhật `THIET-KE-CSDL-VAT-LY.md` | `migrate.mjs` áp được trên DB sạch và trên DB đã có 0000–0009; `test/migration-0010.integration.test.ts` kiểm từng ràng buộc mới (cả nhánh vi phạm) | ☐ |
| 2 | State machine | `TopUpStateMachine` + `TopUpEvent`, `RefundStateMachine` (STM-8). Thuần logic | Unit test mọi chuyển hợp lệ và không hợp lệ | ☐ |
| 3 | Sổ cái | `CreditLedgerService.post` / `getBalance`: entryNo, `balanceAfterVnd`, snapshot, `active ↔ in_shortfall`; `ensureAccounts(driverId)`; `LoyaltyService.earnForSession` để WP3 thay SQL thô (D9). Báo Sơn khi merge | Test bất biến số dư = Σ sổ cái; test unique `(top_up_id, transaction_type)` | ☐ |
| 4 | Loyalty (phần nạp) | `quoteRedemption` (≥ 500 điểm, ≤ 50% số tiền, 100 điểm = 1.000 VND), `redeemForTopUp`, `restoreForTopUp` (giữ hạn cũ) | Unit test các giới hạn | ☐ |
| 5 | SD-2a tạo top-up | `TopUpController.create/get`, Idempotency-Key, khoá `credit_accounts`, BR-P22, chỉ `pending` chặn (409 kèm `paymentUrl`, D2), job `topup.timeout`, `VnpayAdapter.buildPaymentUrl` | TC-STM4-01/11/16/18 pass; test idempotency và race hai request song song | ☐ |
| 6 | SD-2b A IPN | `VnpayIpnController`, `verifySignature`, `applyPaymentResult`, `credit()`, mã 97/01/02/04/00, job và realtime sau commit | TC-STM4-02/03/08/09/10, TC-STM5-03/05 pass; IPN gửi lặp không cộng hai lần | ☐ |
| 7 | SD-2b B hoá đơn | `EInvoiceService`, `EInvoiceJobProcessor`, stub provider (D6), retry `RETRY_LIMIT = 4` (D3), `needs_review` | TC-STM7-* pass; lỗi hoá đơn không ảnh hưởng top-up | ☐ |
| 8 | SD-2c timeout và trễ | `TopUpTimeoutProcessor`, `queryTransaction`, `expired`, re-queue khi VNPay lỗi, LATE_WINDOW, kiểm tra lại hạn mức (D2), `recordLatePayment` | TC-STM4-04/05/06/07/15 pass | ☐ |
| 9 | Hoàn tiền (R8) | `RefundService.request/execute/retryByAdmin`, `RefundJobProcessor`, hoàn top-up (E) và hoàn khoản trễ (F), `einvoice.adjust` sau `done` | TC-STM4-12/13/14, TC-STM8-* pass | ☐ |
| 10 | Admin | `AdminBillingController`, `BillingExceptionsQuery` (khoản trễ, hoá đơn `needs_review`, refund `failed`), retry hoá đơn, retry refund | Test phân quyền Admin + từng hành động | ☐ |
| 11 | Đóng tài khoản (SD-2e) | `AccountClosureController/Service`, điều kiện BR-P21, `allocateNewestFirst`, refund `closure_part`, `closureRefundedAt` | Test điều kiện chặn đóng và phân bổ newest-first | ☐ |
| 12 | Worker quét DB dùng chung (D4) | Interface `BackgroundWork`, vòng quét `next_attempt_at … FOR UPDATE SKIP LOCKED`, chạy sớm qua `Scheduler`, quét lúc khởi động. **Làm trước Phần 7** (Phần 5 có thể dùng tạm `Scheduler` cho timeout) | Test: dòng đến hạn được xử lý đúng một lần kể cả khi hai worker chạy song song; khởi động lại vẫn bắt được việc còn tồn | ☐ |

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

Các quyết định cần cho Phần 3 và Phần 5 đã chốt ở D4, D9. Việc nền viết theo D4 (quét DB). API admin bám D10. HTTP viết vào router thuần của `src/console/` theo `docs/api/DRIVER-API-HOP-DONG.md`, không viết Nest controller.

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
- Nhóm: báo đã giữ số migration `0010` cho billing.
- Người làm đăng ký tài xế: gọi `ensureAccounts(driverId)`.
- WP4: thống nhất bảng D10, thêm mục refund `failed` + retry.
- Người lo Caddy staging / app Flutter: đường dẫn `/payment/vnpay/ipn`, `/payment/vnpay/return`.
- (Claude Code ghi thêm vào đây khi phát hiện cần gì từ module khác.)

## Ghi chú

(Phát hiện khi khảo sát repo, quyết định nhỏ trong lúc code, chỗ lệch tên so với CD-2.)
