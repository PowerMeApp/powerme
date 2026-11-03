# Billing module (WF-02) – hướng dẫn cho Claude Code

> Đặt file này tại `apps/csms/src/billing/CLAUDE.md` (module NestJS mới, cùng cấp `sessions/`, `stations/`).
> Chủ sở hữu: Khang (WP5). Phạm vi: nạp Charging Credit qua VNPay, sổ cái credit, loyalty point khi nạp, hoàn tiền, đóng tài khoản, e-invoice.

## Bối cảnh repo (khảo sát ngày 03/11/2026, commit `ce3902c`)

- **ORM:** Drizzle (`drizzle-orm`). Schema TS ở `apps/csms/src/db/schema/` (bảng billing: `billing.ts`, enum: `enums.ts`).
- **Migration:** SQL **viết tay** trong `apps/csms/drizzle/NNNN_<ten>.sql`, áp tuần tự bởi `apps/csms/scripts/migrate.mjs` (bảng `_migrations`). **Không dùng `drizzle-kit generate`** (ADR-0008). Mỗi migration đi kèm: sửa schema TS cho khớp, một test `test/migration-NNNN.integration.test.ts`, một nhật ký `docs/NHAT-KY-MIGRATION-NNNN.md`, cập nhật `docs/THIET-KE-CSDL-VAT-LY.md`. Sửa `scripts/migrate.mjs` thì sửa cả `test/helpers/apply-migrations.ts`.
- **Bảng billing đã có từ migration 0003 (T73):** `credit_accounts`, `credit_transactions`, `top_ups`, `e_invoices`, `invoice_adjustments`, `loyalty_accounts`, `loyalty_transactions`, kèm nhiều CHECK. Đọc `billing.ts` trước khi đề xuất thay đổi schema. **Chưa có** bảng `refunds`.
- **Chưa có HTTP qua Nest:** `main.ts` dùng `createApplicationContext`. Route HTTP viết kiểu thuần trong `src/console/` (`console.http.ts`, `console.router.ts`, cổng 3000): tài xế `/api/driver/v1/*`, admin `/api/admin/*`. Theo `docs/api/DRIVER-API-HOP-DONG.md`: chưa thêm Nest controller cho đến khi có RolesGuard; xác thực dev bằng header `X-Driver-Id` khi `DRIVER_API_DEV_AUTH=true`.
- **Chưa có** module `users`, `realtime`, BullMQ. Redis có trong `infra/docker-compose.yml` nhưng chưa dùng. Hẹn giờ hiện dùng `Scheduler` (`src/common/scheduler.ts`, `setTimeout`, mỗi service tự quét DB lúc khởi động để dựng lại).
- **WP3 đã ghi vào bảng billing:** `src/sessions/charge-settlement.service.ts` tự INSERT `credit_transactions` (`session_debit`), UPDATE `credit_accounts.balance_vnd`/`status = in_shortfall`, tạo `loyalty_accounts` và ghi điểm `earn` bằng SQL thô. `driver-charging.service.ts` và `reconciliation.service.ts` đọc `credit_accounts`/`credit_transactions`. **Không sửa các file này**; xem mục Còn mở trong decisions.
- **Lệnh:** `npm run infra:up` (Postgres + Redis) · `DATABASE_URL=postgresql://powerme:powerme@localhost:5432/powerme node apps/csms/scripts/migrate.mjs` · `npm run test -w @powerme/csms` (unit `src/**/*.spec.ts` không cần DB; integration `test/**/*.test.ts` tự skip khi thiếu `DATABASE_URL`, chạy tuần tự vì DROP SCHEMA) · `npm run typecheck`, `npm run lint`.
- **Quy ước nhóm (`CONTRIBUTING.md`):** mỗi task có mã, đi theo nhánh → commit → PR; Conventional Commits kèm mã task; squash merge; PR ≤ 400 dòng; test cả nhánh lỗi; biến môi trường mới thêm vào `infra/.env.example` với giá trị giả; không commit credential VNPay.

## Đọc trước khi làm bất cứ task nào

1. `docs/spec/WF-02_decisions.md` – các quyết định sau review 2. **Ưu tiên hơn diagram** nếu khác nhau.
2. `docs/tasks/WF-02_plan.md` – thứ tự các phần và tiêu chí xong.
3. Diagram của luồng đang làm (bảng tra bên dưới).

Nếu spec, decisions và code mâu thuẫn nhau: **dừng lại, nêu chỗ mâu thuẫn và hỏi**. Không tự chọn một bên.

## Ba nguyên tắc

1. **Chỉ IPN có chữ ký hợp lệ, hoặc kết quả querydr, mới được cộng tiền.** Return URL chỉ để hiển thị, không bao giờ ghi gì vào DB.
2. **Mỗi khoản tiền chỉ ghi một lần.** Ba lớp: Idempotency-Key khi tạo; khoá dòng + `TopUpStateMachine`; ràng buộc unique trong DB.
3. **Hệ thống bên ngoài lỗi không làm hỏng việc cộng tiền.** E-invoice và VNPay refund chạy bất đồng bộ (worker quét DB), sau commit.

## Bất biến (phải có test bảo vệ)

- `credit_accounts.balance_vnd` = Σ `credit_transactions.amount_vnd`. Snapshot được cập nhật cùng transaction với dòng sổ cái.
- `credit_transactions` là append-only. Trong billing, **chỉ `CreditLedgerService.post`** được INSERT; không UPDATE, không DELETE. (Ngoại lệ hiện tại: `charge-settlement.service.ts` của WP3 ghi `session_debit` trực tiếp, chờ nhóm chốt.) Mọi nơi ghi sổ phải khoá `credit_accounts ... FOR UPDATE` trước khi tính `entry_no` và `balance_after_vnd`.
- Mọi chuyển trạng thái top-up đi qua `TopUpStateMachine`. Chuyển không hợp lệ → ném `InvalidTransition`.
- **VNPay refund chỉ được gọi từ `RefundService.execute`** (trong `RefundJobProcessor`), không gọi trong DB transaction.
- Job (`einvoice.*`, `refund.execute`, realtime emit) chỉ được đẩy **sau khi commit**. Việc nền chạy bằng **quét DB** (`status` + `next_attempt_at`, `FOR UPDATE SKIP LOCKED`), `Scheduler` chỉ để chạy sớm; không thêm BullMQ (decisions D4).
- Thứ tự khoá dòng khi cần nhiều bảng: **`top_ups` trước, `credit_accounts` sau** (tránh deadlock).
- Tiền là `bigint` VND, không dùng số thực.

## Ai được ghi bảng nào

| Service | Bảng / cột |
|---|---|
| `TopUpService` | `top_ups` |
| `CreditLedgerService` | `credit_transactions` (INSERT), `credit_accounts.balance_vnd`, `active ↔ in_shortfall` |
| `AccountClosureService` | `credit_accounts.account_status → closed`, `closed_at`, `closure_refunded_at` |
| `LoyaltyService` | `loyalty_accounts`, `loyalty_transactions` |
| `EInvoiceService` | `e_invoices`, `invoice_adjustments` |
| `RefundService` | `refunds` |

## Ranh giới module

- Không sửa code của `sessions`, `stations`, `reconciliation`, `ocpp-gateway` hay module khác. Ngoại lệ có chủ đích: thêm nhánh route billing vào `src/console/console.router.ts` theo kiểu đang có, đăng ký `BillingModule` trong `app.module.ts`. Không có module `users`/`realtime` thì dùng interface + stub trong billing. Cần gì từ họ thì dùng interface + stub trong billing và ghi vào mục "Yêu cầu cho nhóm" của `docs/tasks/WF-02_plan.md`.
- Không sửa migration đã merge của người khác. Chỉ tạo migration mới.
- E-invoice provider là **stub** (`EInvoiceProviderAdapter` giả lập), có cấu hình để giả lập lỗi `transient` và `data`.

## Bảng tra

| Luồng | Diagram | State machine | Test |
|---|---|---|---|
| Tạo top-up | SD-2a | STM-4 #1 | TC-STM4-01/11/16/18 |
| IPN cộng tiền | SD-2b phần A | STM-4 #2 #3, STM-5 | TC-STM4-02/03/08/09/10, TC-STM5-* |
| Xuất hoá đơn | SD-2b phần B | STM-7 | TC-STM7-* |
| Timeout, thanh toán trễ | SD-2c | STM-4 #4–#6 | TC-STM4-04/05/06/07/15 |
| Admin hoàn / retry | SD-2d | STM-4 #7, STM-8 | TC-STM4-12/13/14, TC-STM8-* |
| Đóng tài khoản | SD-2e | STM-5 | (theo test case của nhóm) |
| Job hoàn tiền, quét outbox | SD-2f (chưa vẽ) – xem decisions | STM-8 | TC-STM8-* |

Diagram: `diagrams/wf02/` (SD-2a/2b/2c, CD-2) và `diagrams/erd/LERD-1_Charging-Billing.puml`. Lưu ý: bản trên repo là bản cũ (SD v0.1, CD-2 v0.2), chưa có SD-2d/2e; decisions được ưu tiên. Nguồn sự thật cho tên cột là `src/db/schema/billing.ts` (vd. cột là `status`, không phải `topUpStatus`).

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
