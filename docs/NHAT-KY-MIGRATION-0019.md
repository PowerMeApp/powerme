# Nhật ký migration 0019 — `0019_top-up-idempotency-theo-tai-khoan.sql`

**Ngày:** 12/11/2026 · **Task:** T32 Phần 5 (WP5, WF-02 SD-2a) · **Người làm:** Lê Bảo Khang · **Trí review** (chủ DB; đã đồng ý trước mục 2–5 ngày 12/11)
**File:** `apps/csms/drizzle/0019_top-up-idempotency-theo-tai-khoan.sql` (áp lên DB đã có 0000 → 0018; một transaction `BEGIN … COMMIT`)
**Nguồn:** `docs/spec/WF-02_decisions.md` D2 (tạo top-up), D7 (`PENDING_TIMEOUT`); `docs/tasks/WF-02_plan.md` Phần 5.

**Vì sao là 0019:** lúc bắt đầu làm, migration mới nhất trên `main` là `0017_sdt-tai-xe-duy-nhat.sql` (BE-30, #121) nên file này được viết là 0018. BE-34 (#127, xoá mềm xe, `0018_go-xe-tai-xe.sql`) merge trước nên giữ 0018; khi rebase 12/11 file này đổi sang **0019** (tên file, `test/migration-0019`, nhật ký này, comment trong code, tài liệu) và chạy lại toàn bộ test, gồm cả bộ MB03. 0018 của BE-34 chỉ đụng `vehicles` (cột `removed_at`, unique index biển số `vehicles_plate_key_active`, CHECK `vehicles_removed_not_default`): không đụng `top_ups`, `credit_accounts` hay index nào của 0019. Đã kiểm trên DB có cả hai: truy vấn A5 chỉ trả hai ngoại lệ có sẵn (`charging_statements_driver_id_fkey`, `sessions_connector_fk`); seed top-up chạy hai lần không lỗi (mục 2); `test/migration-0019` dựng DB ngay trước 0019 (đã có 0018) rồi nâng cấp.

## 1. Thay đổi

| # | Đối tượng | Thay đổi | Use case |
|---|---|---|---|
| 1 | (kiểm tra) | Tài khoản nào có > 1 top-up `pending` → `RAISE EXCEPTION` liệt kê `credit_account_id <id> (<n> dòng)`, ROLLBACK cả file | Dữ liệu cũ (seed tay / lỗi trước đây) có hai lệnh nạp chờ trả cùng tài khoản: migration không tự chọn dòng nào "đúng" vì có thể tài xế đã trả một trong hai — người vận hành tra cổng VNPay rồi sửa tay |
| 2 | `top_ups_idempotency_key_key` | Bỏ (UNIQUE một cột của 0000) | Hai tài xế cùng sinh key `retry-0001` sẽ chặn nhau nếu UNIQUE toàn bảng |
| 3 | `top_ups.idempotency_key` | `varchar(64)` → `varchar(100)` | Hợp đồng driver cho key 8–100 ký tự (như `POST /charges`); nới varchar chỉ đổi metadata, không ghi lại bảng |
| 4 | `top_ups_account_idempotency_key_key` | `UNIQUE (credit_account_id, idempotency_key)` | App gửi lại cùng key → cùng top-up. Vì `credit_accounts_driver_id_key` (mỗi tài xế một tài khoản) nên phạm vi này tương đương "theo tài xế", như `driver_charge_intents` |
| 5 | index `top_ups_credit_account_id_idx` | Bỏ | UNIQUE dòng 4 có cột đầu `credit_account_id` nên đã phủ FK `top_ups_credit_account_id_fkey` (test A5, xem mục 4) |
| 6 | `top_ups.request_hash` | Cột mới `varchar(64)` nullable + COMMENT | Cùng key khác body (`amount_vnd` / `points_to_redeem`) → 409 `idempotency_conflict`. NULL = dòng không tạo qua API (seed / trước 0019); gửi key của dòng như vậy cũng → `idempotency_conflict` |
| 7 | `top_ups_one_pending_per_account_key` | Partial UNIQUE `ON top_ups (credit_account_id) WHERE status = 'pending'` + COMMENT | D2: mỗi tài khoản tối đa một top-up chờ trả. `TopUpService` khoá `credit_accounts FOR UPDATE` trước khi kiểm; index này chặn cả đường ghi ngoài API (SQL tay, code sau này quên khoá) |
| 8 | COMMENT `top_ups.idempotency_key` | Ghi rõ 8–100 ký tự, UNIQUE theo tài khoản | |

**Cách băm `request_hash`:** `sha256(JSON.stringify([amount_vnd, points_to_redeem]))` dạng hex — đúng cách `sessions/driver-charging.service.ts` băm `driver_charge_intents.request_hash` (inline, không export). Chỉ băm giá trị tài xế gửi sau chuẩn hoá (`points_to_redeem` bỏ trống / `null` → 0); không băm giá trị server tính (`points_redeemed`, `points_discount_vnd`, `amount_paid_vnd`), nên gửi lại sau khi điểm của tài xế đổi vẫn trả top-up cũ.

**Không làm ở DB:** CHECK `amount_vnd` 50.000–2.000.000 và số dư ≤ 5.000.000 (BR-P22 theo ADR-0013) — hạn mức là chính sách, ghi cứng thì đổi phải viết migration (cùng lý do 0003 không đặt CHECK cửa sổ LATE_WINDOW, xem `NHAT-KY-MIGRATION-0003.md` mục 2); `TopUpService` kiểm.

## 2. Chạy thật

**Đường nâng cấp trên bản sao DB dev** (Postgres 16.4 trong `powerme-postgres`): `CREATE DATABASE powerme_0019_check TEMPLATE powerme` (DB dev đang ở 0015, chưa có top-up nào), `scripts/migrate.mjs` của nhánh áp 0016 → 0017 → 0018 (BE-34) → 0019 (`xong — áp 4 migration`), rồi chạy `demo/seed.sql` + `demo/seed-app.sql` hai lần:

| | Lần 1 | Lần 2 |
|---|---|---|
| Seed | không lỗi | không lỗi |
| `count(*)` top_ups | 5 (2 demo + 3 app, đều `credited`) | 5 (không thêm dòng) |
| `count(request_hash)` | 0 (seed không qua API) | 0 |

Sau đó `DROP DATABASE powerme_0019_check`; DB dev `powerme` giữ nguyên 0015.

**Test `migration-0019`** (`powerme_test`):
- DB ngay trước 0019 (đã có 0018 của BE-34) có seed demo + seed-app → migrate: áp 0019 rồi các migration sau; dữ liệu top-up cũ giữ nguyên, `request_hash` NULL; constraint / index / kiểu cột / COMMENT đúng; seed chạy lại không lỗi, không thêm dòng; migrate lần hai không áp gì.
- Có tài khoản 2 pending → migrate ném `0019: tài khoản có hơn một top-up pending (credit_account_id <id> (2 dòng)). Không sửa gì; …` (SQLSTATE 23505), tài khoản chỉ có 1 pending + 1 expired không bị nêu; dữ liệu, `_migrations` và index cũ giữ nguyên; sửa tay dòng thừa thì migrate chạy được.
- DB sạch: cùng key khác tài khoản → được; cùng key cùng tài khoản → 23505 `top_ups_account_idempotency_key_key`; key 100 ký tự → được (101 → 22001); hai pending cùng tài khoản → 23505 `top_ups_one_pending_per_account_key`; một pending + nhiều `expired` / `credited` / `failed` → được.

## 3. Số liệu

Đếm bằng truy vấn của `THIET-KE-CSDL-VAT-LY.md` mục 1, Postgres 16.4, trên DB dựng từ 0000 → 0018 rồi áp 0019: trạng thái 0018 (BE-34) là 44 bảng / 32 enum (124) / 163 index (17 partial) / 67 CHECK / 84 FK / 443 cột (0017: 16 partial, 66 CHECK, 442 cột — BE-34 thêm 1 cột, 1 index partial, 1 CHECK); sau 0019: **163 index (18 partial), 444 cột**, còn lại không đổi. Index: bỏ 2 (`top_ups_idempotency_key_key`, `top_ups_credit_account_id_idx`), thêm 2 (`top_ups_account_idempotency_key_key`, partial `top_ups_one_pending_per_account_key`).

**Đối chiếu SQL ↔ Drizzle:** test `migration-0019` kiểm `getTableConfig(topUps)`: ba UNIQUE (`top_ups_account_idempotency_key_key` hai cột, `gateway_reference`, `late_gateway_ref`), ba index (`gateway_transaction_no` partial, `one_pending_per_account` partial UNIQUE, `status_expires_at`), không còn index một cột; `request_hash` nullable.

## 4. Code, seed và test đi cùng

- **Test A5 (`erd-alignment.integration.test.ts`, mọi FK có index):** sau khi bỏ `top_ups_credit_account_id_idx`, truy vấn A5 chỉ còn hai ngoại lệ có sẵn (`charging_statements_driver_id_fkey`, `sessions_connector_fk`), **không** có `top_ups_credit_account_id_fkey`: truy vấn so tiền tố `indkey[0 : số cột FK − 1]`, nên FK một cột được UNIQUE hai cột (cột đầu `credit_account_id`) thoả. Không nới truy vấn, không thêm ngoại lệ.
- **`erd-alignment-2.integration.test.ts`** (C1 của 0014, độ dài varchar sau khi migrate hết): `['top_ups','idempotency_key',64]` → `100`, kèm chú thích 0019.
- **Fixture tạo nhiều top-up `pending` trên cùng tài khoản** bị partial UNIQUE mới chặn (23505 `top_ups_one_pending_per_account_key`), đổi sang `status = 'credited'`, không đổi ý của test:
  - `billing-loyalty.integration.test.ts` (T32 Phần 4): `newTopUp` — `redeemForTopUp` / `restoreForTopUp` không đọc `status`, và chạy lúc / sau khi cộng tiền;
  - `migration-0003.integration.test.ts` (T73): ca "điểm ⇔ giảm giá (BR-P35)" chỉ kiểm CHECK `top_ups_points_check` / `top_ups_points_redeemed_check`.
- **Seed:** `demo/seed.sql` và `demo/seed-app.sql` đổi `ON CONFLICT ON CONSTRAINT top_ups_idempotency_key_key DO NOTHING` → `ON CONFLICT DO NOTHING` (không chỉ constraint). Lý do: tên constraint đổi ở 0019, mà seed hiện tại còn được chạy trên DB **trước** 0019 — `migration-0017.integration.test.ts` dựng DB ở 0016 rồi chạy seed của nhánh. Chỉ tên constraint mới thì test đó hỏng; chỉ tên cũ thì `./seed.sh` trên staging (sau 0019) hỏng. Không chỉ constraint thì chạy được mọi phiên bản schema. Hệ quả: trùng `gateway_reference` của chính các dòng seed cũng được bỏ qua thay vì báo lỗi — vô hại với các dòng cố định này.
- `src/db/schema/billing.ts`: `idempotencyKey` length 100, `requestHash`, `unique('top_ups_account_idempotency_key_key')`, `uniqueIndex('top_ups_one_pending_per_account_key')…where(status = 'pending')`, bỏ `index('top_ups_credit_account_id_idx')`; JSDoc mới.
- `src/billing/top-up.service.ts` (Phần 5) dùng ba ràng buộc này; 23505 trên hai ràng buộc chống trùng → đọc lại, không trả 500.
- `docs/THIET-KE-CSDL-VAT-LY.md`: dòng Cập nhật 12/11, số liệu sau 0019, mục `top_ups`, dòng 3a, một dòng partial UNIQUE ở 4.2.

## 5. Dọn staging (cho tới khi Phần 8 merge)

Phần 5 không chuyển `pending` sang `expired` (chỉ querydr trả lời dứt khoát "chưa trả" ở Phần 8 mới được, D4 ⊕ ĐIỀU KIỆN). Tài xế bỏ dở thanh toán trên staging sẽ bị chặn (`pending_top_up_confirming`) mãi. Nếu cần, dọn tay — **chỉ staging/sandbox, sau khi tra trên cổng VNPay sandbox là giao dịch chưa trả**:

```sql
UPDATE top_ups SET status = 'expired', updated_at = now()
WHERE status = 'pending' AND expires_at < now() - interval '1 hour' AND late_gateway_ref IS NULL;
```

## 6. Không làm (có chủ ý)

- `next_attempt_at` / `attempt_count` cho `top_ups` (lịch querydr lại của D4 ⊕): chốt ở Phần 6 / 8, migration của phần đó.
- Nới `top_ups_late_payment_status_check`, sửa COMMENT `late_gateway_ref`, `credit_accounts.closure_refunded_at`: migration của Phần 6.
- CHECK hạn mức BR-P22 (mục 1).
- Không sửa migration đã merge, các nhật ký cũ, dòng "Cập nhật 27/10" và ghi chú của Trí trong `THIET-KE-CSDL-VAT-LY.md`.
