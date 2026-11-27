# Billing module (WF-02) – hướng dẫn cho Claude Code

> Đặt file này tại `apps/csms/src/billing/CLAUDE.md` (module NestJS mới, cùng cấp `sessions/`, `stations/`).
> Chủ sở hữu: Khang (WP5). Phạm vi: nạp Charging Credit qua VNPay, sổ cái credit, loyalty point khi nạp, hoàn tiền, đóng tài khoản, e-invoice.

## Bối cảnh repo (khảo sát ngày 03/11/2026, commit `ce3902c`)

- **ORM:** Drizzle (`drizzle-orm`). Schema TS ở `apps/csms/src/db/schema/` (bảng billing: `billing.ts`, enum: `enums.ts`).
- **Migration:** SQL **viết tay** trong `apps/csms/drizzle/NNNN_<ten>.sql`, áp tuần tự bởi `apps/csms/scripts/migrate.mjs` (bảng `_migrations`). **Không dùng `drizzle-kit generate`** (ADR-0008). Mỗi migration đi kèm: sửa schema TS cho khớp, một test `test/migration-NNNN.integration.test.ts`, một nhật ký `docs/NHAT-KY-MIGRATION-NNNN.md`, cập nhật `docs/THIET-KE-CSDL-VAT-LY.md`. Sửa `scripts/migrate.mjs` thì sửa cả `test/helpers/apply-migrations.ts`.
- **Bảng billing đã có từ migration 0003 (T73):** `credit_accounts`, `credit_transactions`, `top_ups`, `e_invoices`, `invoice_adjustments`, `loyalty_accounts`, `loyalty_transactions`, kèm nhiều CHECK. **Migration 0015 (T32 Phần 1):** bảng `refunds` (`requested_by` → `admins`), cột trạng thái/lịch quét cho `invoice_adjustments`, `e_invoices.next_attempt_at` (DEFAULT `now()`, CHECK không NULL khi còn chờ), index quét D7, bỏ `top_ups.refunded_by` (B5: Admin hoàn nằm ở `refunds.requested_by`); xem `docs/NHAT-KY-MIGRATION-0015.md`. **Migration 0021 (T32 Phần 6):** `top_ups.next_attempt_at`, `exception_kind`, `exception_reviewed_at`. **Migration 0024 (T32 Phần 8b bổ sung):** bảng `top_up_payment_conflicts` (lần trả thành công mâu thuẫn; `docs/NHAT-KY-MIGRATION-0024.md`). **Migration 0025 (T32 Phần 7):** `e_invoices.vat_rate` (thuế suất % theo thời điểm thu tiền, NOT NULL không DEFAULT; `docs/NHAT-KY-MIGRATION-0025.md`). **Migration 0027 (T32 Phần 8c):** `unfinished_claims` trên `top_ups`, `e_invoices`, `invoice_adjustments`, `refunds` (bộ đếm lease), enum `top_up_exception_kind` thêm `retry_exhausted` (hai transaction trong một file: enum commit trước CHECK; `docs/NHAT-KY-MIGRATION-0027.md`). **Migration 0028 (T32 Phần 9a):** `refunds.confirmed_via_query` (done nhờ querydr, không có mã lệnh hoàn; `docs/NHAT-KY-MIGRATION-0028.md`). **Từ BE-16 (0010–0012):** bảng `admins` (ISA), `credit_transactions.reservation_id` + `reservation_fee`, mọi FK phải có index (test A5), FK sổ cái → ví là `ON DELETE RESTRICT` (test C3); FK mới để NO ACTION trừ khi vào danh sách C3. Đọc `billing.ts` trước khi đề xuất thay đổi schema.
- **Chưa có HTTP qua Nest:** `main.ts` dùng `createApplicationContext`. HTTP viết kiểu thuần, cùng cổng 3000 do `ConsoleServer` (`src/console/console.server.ts`) chọn handler. **Route tài xế** `/api/driver/v1/*` ở `src/driver/` (`driver.http.ts`; sạc/credit `charges.http.ts`; top-up `top-ups.http.ts`, T32 Phần 5), xác thực **JWT thật** (`authenticateDriver`, `driver-auth.ts`); `X-Driver-Id` chỉ còn là đường dev của `driver-auth.ts` khi `DRIVER_API_DEV_AUTH=true`, billing không dựa vào. Service billing truyền vào route qua `createDriverListener` (`ConsoleModule` import `BillingModule`). Admin `/api/admin/*` (chưa xác thực) vẫn ở `src/console/`. **Route Admin billing** (T32 Phần 10a, D10) ở `src/operator-api/admin-billing.ts` dưới `/api/admin/v1/billing/*` (JWT dashboard + `rolesGuard('admin')`, cùng router `operator-api.http.ts` với T108): `GET …/exceptions` (`billing-exceptions.query.ts`, chỉ đọc, bốn mục), retry hoá đơn, recheck, đánh dấu ngoại lệ đã xem, review lần trả mâu thuẫn. `EInvoiceService` / `TopUpService` truyền qua `ConsoleServer` → `createOperatorApiListener`. Chưa có bảng audit: hành động Admin ghi log có cấu trúc kèm `admin_id`. **Hoàn tiền làm thủ công** (D-AC, SRS BR-P51, chốt 26/11): CSKH hoàn trên cổng merchant VNPay, Admin ghi nhận kết quả trong PowerMe (`requested` → `done` khi nhập mã hoàn của cổng, `failed` kèm lý do); PowerMe không gửi refund sang VNPay. Luồng ghi nhận (tạo yêu cầu hoàn, confirm / fail / redo, danh sách chờ CSKH, gỡ worker `refund-send`) làm ở PR sau; không có route retry refund. Theo `docs/api/DRIVER-API-HOP-DONG.md`: chưa thêm Nest controller cho đến khi có RolesGuard.
- **Chưa có** module `users`, `realtime`, BullMQ. Redis có trong `infra/docker-compose.yml` nhưng chưa dùng. Hẹn giờ hiện dùng `Scheduler` (`src/common/scheduler.ts`, `setTimeout`, mỗi service tự quét DB lúc khởi động để dựng lại).
- **WP3 đã ghi vào bảng billing:** `src/sessions/charge-settlement.service.ts` tự INSERT `credit_transactions` (`session_debit`), UPDATE `credit_accounts.balance_vnd`/`status = in_shortfall`, tạo `loyalty_accounts` và ghi điểm `earn` bằng SQL thô. `driver-charging.service.ts` và `reconciliation.service.ts` đọc `credit_accounts`/`credit_transactions`. **Không sửa các file này**; xem mục Còn mở trong decisions.
- **Lệnh:**
  - `npm run infra:up` (Postgres + Redis).
  - Hai database, **không dùng lẫn**: `powerme` cho demo/dev, `powerme_test` cho test (giống CI). Test integration DROP SCHEMA, nên không trỏ test vào `powerme`; vài test (vd. `migration-wp3`) còn từ chối chạy nếu không phải `powerme_test`.
  - Migrate DB dev: `DATABASE_URL=postgresql://powerme:powerme@localhost:5432/powerme node apps/csms/scripts/migrate.mjs`.
  - Test: `DATABASE_URL=postgresql://powerme:powerme@localhost:5432/powerme_test npm run test -w @powerme/csms`. Unit `src/**/*.spec.ts` không cần DB; integration `test/**/*.test.ts` tự skip khi thiếu `DATABASE_URL`, chạy tuần tự vì DROP SCHEMA.
  - `npm run typecheck`, `npm run format:check` (Prettier toàn repo, như CI). `npm run lint` hiện chưa kiểm gì vì chưa workspace nào có script `lint`.
- **Quy ước nhóm (`CONTRIBUTING.md`):** mỗi task có mã, đi theo nhánh → commit → PR; Conventional Commits kèm mã task; squash merge; PR ≤ 400 dòng; test cả nhánh lỗi; biến môi trường mới thêm vào `infra/.env.example` với giá trị giả; không commit credential VNPay.

## Đọc trước khi làm bất cứ task nào

1. Diagram của luồng đang làm trong `diagrams/report4/class/CD-2/` + `diagrams/report4/sequence/SD-2a…2f/` (bảng tra bên dưới) – **nguồn chính**, bản đã chia sẻ vào tài liệu chung của nhóm.
2. `docs/spec/WF-02_decisions.md` – tóm tắt diagram, cách khớp với repo, và các bổ sung ⊕ chưa có trong diagram.
3. `docs/tasks/WF-02_plan.md` – thứ tự các phần và tiêu chí xong.

Decisions khác diagram thì theo diagram và sửa decisions. Diagram mâu thuẫn với code, SRS hoặc ADR: **dừng lại, nêu chỗ mâu thuẫn và hỏi**. Không tự chọn một bên.

## Ba nguyên tắc

1. **Chỉ IPN có chữ ký hợp lệ, hoặc kết quả querydr, mới được cộng tiền.** Return URL chỉ để hiển thị, không bao giờ ghi gì vào DB.
2. **Mỗi khoản tiền chỉ ghi một lần.** Ba lớp: Idempotency-Key khi tạo; khoá dòng + `TopUpStateMachine`; ràng buộc unique trong DB.
3. **Hệ thống bên ngoài lỗi không làm hỏng việc cộng tiền.** E-invoice và VNPay refund chạy bất đồng bộ (worker quét DB): dòng việc tạo trong transaction, gọi bên ngoài sau commit.

## Bất biến (phải có test bảo vệ)

- `credit_accounts.balance_vnd` = Σ `credit_transactions.amount_vnd`. Snapshot được cập nhật cùng transaction với dòng sổ cái.
- `credit_transactions` là append-only. Trong billing, **chỉ `CreditLedgerService.post`** được INSERT; không UPDATE, không DELETE. (Ngoại lệ hiện tại: `charge-settlement.service.ts` của WP3 ghi `session_debit` trực tiếp, chờ nhóm chốt.) Mọi nơi ghi sổ phải khoá `credit_accounts ... FOR UPDATE` trước khi tính `entry_no` và `balance_after_vnd`.
- Mọi chuyển trạng thái top-up đi qua `TopUpStateMachine`. Chuyển không hợp lệ → ném `InvalidTransition`.
- **VNPay refund chỉ được gọi từ `RefundService.send`** (do worker refund gọi), không gọi trong DB transaction. Lượt nào không phải lượt đầu thật sự thì querydr trước; querydr thấy 01 / 00 chỉ được gửi ở lượt ngay sau Admin retry (`planRound`, D1). Refund `done` = VNPay đã nhận yêu cầu hoàn (RC 00 + TS 00 / 05 / 06, hoặc querydr thấy lệnh hoàn); không có nghĩa tiền đã về tài khoản tài xế (VNPay / ngân hàng chuyển sau, ta không có kênh báo về).
- Việc nền (e-invoice, gửi refund, realtime emit): **tạo dòng việc trong transaction** của quyết định (hoá đơn cùng transaction cộng tiền — T32 Phần 7; refund cùng transaction quyết định hoàn — D1), **gọi bên ngoài chỉ sau khi commit** (worker / `kick`). Không INSERT dòng việc sau commit: sập giữa commit và việc sau commit thì mất việc mà không gì quét lại. Việc nền chạy bằng **quét DB** (`status` + `next_attempt_at`, `FOR UPDATE SKIP LOCKED`), `Scheduler` chỉ để chạy sớm; không thêm BullMQ (decisions D7).
- **Việc nền gọi bên ngoài đi theo lease, không giữ transaction qua HTTP** (T32 Phần 12):
  - cài `BackgroundWork.runDue(limit, signal)` (`background-work.ts`); bảng có `next_attempt_at` dùng `runLeasedBatch` (`due-rows.ts`): tx ngắn giữ chỗ một dòng → gọi ngoài tx → tx2 `lockLeased` (trả `null` = mất lease, bỏ kết quả) rồi ghi qua state machine;
  - đăng ký bằng `BackgroundWorkRunner.register(this)` trong `onModuleInit`, sau commit gọi `kick(name)` / `kickAt(name, at)`. **Luôn register trong `onModuleInit`, kể cả khi `BILLING_WORKER_ENABLED=false`**: `kick` một tên chưa đăng ký sẽ ném sau commit. Có test kiểm việc đăng ký;
  - lịch retry dùng `nextRetry` (`retry-schedule.ts`), không tự viết 5 phút / 30 phút / 2 giờ;
  - **bộ đếm lần giữ chỗ** (T32 Phần 8c, 0027): `claimDue` tăng `unfinished_claims`, `lockLeased` đặt về 0 (chỉ có hiệu lực khi tx2 COMMIT). Vượt `UNFINISHED_CLAIM_LIMIT = 5` thì `runLeasedBatch` không gọi `handle` mà gọi `spec.onExhausted` (tx riêng, không gọi bên ngoài, trả hàm chạy sau commit). Bảng mới dùng lease **phải có `onExhausted`** (`refunds` có từ Phần 9a; `invoice_adjustments`: Phần 9b); đường hết lượt chỉ dùng chuyển trạng thái có sẵn của state machine. tx2 phải khoá lại bằng `lockLeased`, không tự `SELECT … FOR UPDATE`, nếu không bộ đếm không về 0.
- Thứ tự khoá dòng khi cần nhiều bảng: **`top_ups` → `credit_accounts` → `loyalty_accounts`** (tránh deadlock; WP3 cũng khoá `credit_accounts` trước `loyalty_accounts`). `CreditLedgerService.post` chỉ khoá `credit_accounts`, nên luồng nào cần khoá `top_ups` (IPN, timeout, hoàn) thì phải khoá **trước** khi gọi `post`. `LoyaltyService` khoá `loyalty_accounts`, nên gọi **sau** `post`.
  - Đã theo thứ tự này: IPN, vòng quét querydr và `recheckTopUp` (T32 Phần 8: `top_ups` → `credit_accounts` → `loyalty_accounts`). `TopUpService.create` khoá `credit_accounts` rồi INSERT `top_ups` (không khoá dòng `top_ups` có sẵn) nên hiện không deadlock.
  - Refund (Phần 9a): quyết định hoàn khoá `top_ups` → `credit_accounts` rồi INSERT `refunds`; tx2 của worker khi `done` khoá `top_ups` (`late_payment`) hoặc `credit_accounts` (`account_closure`) **trước** `lockLeased(refunds)`.
  - **Phần 9 (Admin hoàn) và Phần 11 (đóng tài khoản) không được khoá `credit_accounts` rồi mới `SELECT … FOR UPDATE` `top_ups`**: đi ngược thứ tự với IPN / querydr → deadlock. Cần khoá top-up thì khoá `top_ups` trước.
- `post` / `earnForSession` nhận client của transaction bên gọi (`LedgerClient = Pick<PoolClient, 'query'>`) và **không tự BEGIN/COMMIT**. Lỗi nghiệp vụ (`LedgerPostRejected`, `LedgerEntryExists`, `CreditAccountNotFound` trong `billing-errors.ts`) ném ra trước khi có câu SQL lỗi, nên transaction bên gọi vẫn dùng được. DB không có CHECK dấu tiền: `post` kiểm dấu theo loại dòng.
- Tiền là `bigint` VND, không dùng số thực.
- **Lần trả mâu thuẫn ghi bảng, không ghi đè** (T32 Phần 8b bổ sung): `conflicting_result` từ `PAYMENT_SUCCEEDED` ghi một dòng `top_up_payment_conflicts` (`INSERT … ON CONFLICT (top_up_id, gateway_transaction_no) DO NOTHING`) trong nhánh `conflicting_result` của `applyLockedResult`, **không** đụng `top_ups.late_*` / `exception_kind` / `exception_reviewed_at` / `status`. Không dùng `exception_kind` cho mâu thuẫn (mỗi top-up chỉ có một).
- **Sổ điểm** (T32 Phần 4, decisions D3/D11):
  - `loyalty_accounts.points_balance` = Σ `loyalty_transactions.points` ≥ 0, cập nhật cùng transaction.
  - Mọi nơi ghi loyalty khoá `loyalty_accounts … FOR UPDATE` trước khi tính `entry_no`. Khoá trước, chỉ INSERT tài khoản khi thiếu.
  - Điểm tính theo lô earn (`loyalty-lots.ts`, lô = `expires_at`):
    - mỗi dòng `redeem` / `restore` / `expire` theo hạn mang `expires_at` của đúng một lô, **copy bằng SQL** từ dòng earn của lô (không truyền timestamp từ JS, `Date` mất µs);
    - chỉ `adjust` 0 và `expire` lúc đóng tài khoản để `expires_at` NULL;
    - dòng sai dạng → `LoyaltyLedgerCorrupt`.
  - Hiển thị / kiểm điểm khả dụng dùng `livePoints` của `replayLots`, **không** dùng `points_balance` (lô hết hạn còn nằm trong đó tới khi job hết hạn chạy). Route app `GET /loyalty`, `/loyalty/transactions` (T149, `driver/loyalty.http.ts`) đọc qua `LoyaltyService.summary` / `history` trong một transaction REPEATABLE READ READ ONLY.

## Ai được ghi bảng nào

| Service | Bảng / cột |
|---|---|
| `TopUpService` | `top_ups` (trừ `late_refunded_at`; `exception_reviewed_at` qua `markExceptionReviewed` / `recheckTopUp`); `top_up_payment_conflicts` (INSERT, Phần 8b; `reviewed_*` qua `markConflictReviewed`, Phần 10a) |
| `CreditLedgerService` | `credit_transactions` (INSERT), `credit_accounts.balance_vnd`, `credit_accounts.status`: `active ↔ in_shortfall` |
| `AccountClosureService` | `credit_accounts.status`: `active → closed`, `closed_at`, `closure_refunded_at` (khi không tạo refund nào) |
| `LoyaltyService` | `loyalty_accounts`, `loyalty_transactions` |
| `EInvoiceService` | `e_invoices`, `invoice_adjustments` |
| `RefundService` | `refunds`; `top_ups.late_refunded_at` và `credit_accounts.closure_refunded_at` khi refund chuyển `done` (= VNPay đã nhận yêu cầu hoàn, chưa chắc tiền đã về tài xế; Phần 9a, cùng tx2) |

## Ranh giới module

- Không sửa code của `sessions`, `stations`, `reconciliation`, `ocpp-gateway` hay module khác. Ngoại lệ có chủ đích: thêm nhánh route billing vào `src/console/console.router.ts` theo kiểu đang có, đăng ký `BillingModule` trong `app.module.ts`. Không có module `users`/`realtime` thì dùng interface + stub trong billing. Cần gì từ họ thì dùng interface + stub trong billing và ghi vào mục "Yêu cầu cho nhóm" của `docs/tasks/WF-02_plan.md`.
- Không sửa migration đã merge của người khác. Chỉ tạo migration mới.
- E-invoice provider chọn bằng `EINVOICE_PROVIDER` (T144): **stub** mặc định (`EInvoiceProviderAdapter` giả lập, cấu hình để giả lập lỗi `transient` và `data`; test / CI / máy dev dùng bản này) hoặc **SePay eInvoice** (`sepay-einvoice.provider.ts`, biến `SEPAY_EINVOICE_*`, chỉ `createInvoice`). Không ghi mã SePay thật vào repo, log hay message.

## Bảng tra

| Luồng | Diagram | Decisions | State machine | Test |
|---|---|---|---|---|
| Tạo top-up | SD-2a | D2 | STM-4 #1 | TC-STM4-01 + test theo nội dung: `test/billing-top-up.integration.test.ts`, `test/driver-top-ups.integration.test.ts`, `test/migration-0019.integration.test.ts`, `src/billing/vnpay.adapter.spec.ts` |
| IPN cộng tiền | SD-2b | D3 | STM-4 #2 #3 #8, STM-5 | TC-STM4-02/03/04 (bước IPN)/05 + test theo nội dung (khoản trễ trên `expired` / `refunded`, kiểm request, điểm, race, route; T32 Phần 8b: đã trả mà không cộng được — sai số tiền / tài khoản `closed` → `failed` + khoản trễ, 00; cùng giao dịch khác số tiền → 02; log `ipn_applied`; bổ sung: lần trả mâu thuẫn → dòng `top_up_payment_conflicts`, gửi lại không thêm, hai IPN đồng thời → 1 dòng): `test/billing-ipn.integration.test.ts`, `test/vnpay-ipn-route.integration.test.ts`, `test/migration-0021.integration.test.ts`, `test/migration-0024.integration.test.ts`, `src/billing/top-up-state-machine.spec.ts`, `src/billing/vnpay.adapter.spec.ts` |
| Xuất hoá đơn, retry | SD-2c | D5 | STM-7 | Test theo nội dung (T32 Phần 7; TC-STM7-* gắn ở PR riêng): tạo trong transaction cộng tiền, chỉ `credited`, rollback / sau commit lỗi, thuế suất theo `completed_at`, worker (issued, transient +5 phút / +30 phút / +2 giờ → `needs_review`, `data`, timeout 10 s, mất lease → gọi lại cùng khoá, hai worker), Admin retry, đăng ký `e-invoice-issue`: `src/billing/e-invoice-state-machine.spec.ts`, `src/billing/e-invoice.spec.ts`, `test/billing-e-invoice.integration.test.ts`, `test/billing-ipn.integration.test.ts`, `test/billing-top-up-timeout.integration.test.ts`, `test/migration-0025.integration.test.ts`; T32 Phần 8c: hết lượt giữ chỗ → `needs_review`, Admin retry đặt bộ đếm về 0 (`billing-e-invoice`), `test/billing-worker.integration.test.ts`, `test/migration-0027.integration.test.ts`. Code: `e-invoice.service.ts`, `e-invoice-state-machine.ts`, `e-invoice-provider.ts` (interface + stub + `callProvider`), `e-invoice.ts` (`vatRateAt`, `splitVat`). T144 SePay: `sepay-einvoice.provider.ts`, `sepay-einvoice.config.ts`, test `src/billing/sepay-einvoice.*.spec.ts`, live test `test/sepay-einvoice.live.test.ts` (chỉ chạy khi `SEPAY_EINVOICE_LIVE=1`) |
| Timeout, thanh toán trễ | SD-2d | D4, D7 | STM-4 #2 #3 #4, #6, #8 | TC-STM4-04 (bước querydr) + test theo nội dung (bảng querydr 3.1, lịch hẹn lại, hết lịch `unresolved_04/07`, đua IPN, hai runner, sập sau tx1, `recheckTopUp`; T32 Phần 8b: querydr `paid` mà không cộng được → `failed` + khoản trễ ngay, không giữ chỗ lại; recheck sai số tiền → khoản trễ số thực trừ; log `querydr_applied`, RC chưa xác thực; bổ sung: recheck mâu thuẫn → dòng `source = recheck`, querydr không sinh mâu thuẫn; T32 Phần 8c: hết lượt giữ chỗ → `expired` + `retry_exhausted`, staging không tích luỹ bộ đếm, lịch 2/15/30/45/60 + mốc 75 khi RC 94): `test/billing-top-up-timeout.integration.test.ts`, `src/billing/vnpay-querydr.spec.ts`, `src/billing/top-up-timeout.spec.ts` |
| Admin hoàn, gửi refund (worker `refund-send`), retry | SD-2e | D1 | STM-4 #7, STM-10 | TC-STM4-12/13/14, TC-STM10-* (T32 Phần 9a): `test/billing-refund.integration.test.ts`, `src/billing/vnpay-refund.spec.ts`, `test/migration-0028.integration.test.ts`. Code: `refund.service.ts`, `vnpay.adapter.ts` |
| Billing Exceptions, route Admin (T32 Phần 10a) | UC-ADM-08 | D10 | STM-7 #7, STM-10 #5 | `test/admin-billing-route.integration.test.ts`, `test/billing-exceptions.integration.test.ts`; `refund_status` cho app: `test/driver-top-ups.integration.test.ts`. Code: `billing-exceptions.query.ts`, `operator-api/admin-billing.ts` |
| Đóng tài khoản (tài xế đóng, hệ thống tự hoàn) | SD-2f | D6 | STM-5, STM-10 | (theo test case của nhóm) |
| Worker quét DB | (không vẽ) | D7 | | |
| Hết hạn điểm | (không vẽ) | D11 | | |

Diagram: `diagrams/report4/class/CD-2/` + `diagrams/report4/sequence/SD-2a…2f/` (CD-2, SD-2a…2f v2.0, 01/11/2026) và `diagrams/report4/erd-logical/erd-logical-clean.svg`. STM-10 Refund: `diagrams/report4/state/STM-10/STM-10.puml` (STM-8 là RfidCard). State machine trong code: `top-up-state-machine.ts`, `e-invoice-state-machine.ts` (STM-7, T32 Phần 7), `refund-state-machine.ts`, lỗi chung `invalid-transition.ts`. Tên class/method theo CD-2; nguồn sự thật cho tên cột là `src/db/schema/billing.ts` (vd. cột là `status`, không phải `topUpStatus`).

## Cách làm việc

- Mỗi phiên làm **một phần** trong plan. Bắt đầu bằng plan mode, chờ duyệt rồi mới code.
- Viết test từ test case trước, rồi mới implement.
- Xong phần nào: chạy lint + toàn bộ test của billing, cập nhật trạng thái trong `docs/tasks/WF-02_plan.md`, ghi chú quyết định nhỏ phát sinh vào đó.
- Đặt tên class/method theo CD-2. Nếu cần lệch, ghi lý do vào plan.

## Git (theo `CONTRIBUTING.md`, mã task T32)

- **Đầu mỗi phần:** `git fetch origin`, rồi tạo nhánh từ `origin/main` mới nhất với **đúng tên trong bảng "Tên nhánh" của `docs/tasks/WF-02_plan.md`**. Đang ở nhánh khác mà còn thay đổi chưa commit thì dừng lại hỏi.
- **Commit:** `<loại>(csms): <mô tả không dấu>  [T32]`, loại là `feat` / `fix` / `test` / `refactor` / `docs` / `chore`. Ví dụ: `feat(csms): them bang refunds va next_attempt_at cho billing  [T32]`.
- Đồng bộ với `main` bằng `git rebase origin/main`, không merge ngược.
- **Không bao giờ** commit hay push thẳng lên `main`; không `push --force` lên nhánh của người khác; không commit `.env` hay credential VNPay.
- **Hỏi trước khi push.** Trước khi push: chạy `npm run lint`, `npm run typecheck`, `npm run test -w @powerme/csms`, báo kết quả và số dòng thay đổi (`git diff --stat origin/main`). Quá 400 dòng thì đề xuất tách.
- Mô tả PR ghi "T32 – Phần N: <tên phần>", tóm tắt thay đổi, cách test, và các mục "Yêu cầu cho nhóm" mới phát sinh.
