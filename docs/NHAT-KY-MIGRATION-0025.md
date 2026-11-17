# Nhật ký migration 0025 — `0025_e-invoice-vat-rate.sql`

**Ngày:** 17/11/2026 · **Task:** T32 Phần 7 (WP5, e-invoice cho top-up `credited`) · **Người chịu trách nhiệm:** Lê Bảo Khang · **Review:** Trí (chủ DB)
**File:** `apps/csms/drizzle/0025_e-invoice-vat-rate.sql` (áp lên DB đã có 0000 → 0024; một transaction `BEGIN … COMMIT`)
**Nguồn:** Khang chốt 17/11 (prompt T32 Phần 7, mục 3–4).

**Vì sao là 0025:** `0023` để cho T134 của Trí (#154, chưa merge), `0024` là T32 Phần 8b bổ sung. `scripts/migrate.mjs` không đòi số liên tiếp (đã kiểm ở 8b); 0023 và 0025 độc lập (khác bảng).

## 1. Thay đổi

| #   | Đối tượng | Thay đổi | Use case |
| --- | --- | --- | --- |
| 1 | cột `e_invoices.vat_rate` | `smallint`, phần trăm | Lưu thuế suất GTGT đã dùng cho hoá đơn. Hoá đơn điều chỉnh khi hoàn tiền (Phần 9, `adjustForRefund`) phải dùng đúng thuế suất của hoá đơn gốc |
| 2 | backfill | dòng có sẵn: `8` nếu `COALESCE(top_ups.completed_at, e_invoices.created_at) < 2027-01-01 00:00+07`, ngược lại `10`; `RAISE NOTICE` số dòng | Cùng quy tắc với `vatRateAt` (`apps/csms/src/billing/e-invoice.ts`) |
| 3 | `NOT NULL`, **không DEFAULT** | | Code quên truyền thuế suất thì DB chặn ngay, không âm thầm ghi một mức (Khang chốt 17/11) |
| 4 | CHECK `e_invoices_vat_rate_check` | `vat_rate IN (0, 5, 8, 10)` | Các mức thuế suất GTGT hiện hành. Đổi tập này phải viết migration, và đó là việc nên làm có chủ đích |
| 5 | COMMENT cột | | |

## 2. Vì sao lưu cột, không suy ngược

- `vat_amount_vnd = round(amount_vnd × r / (100 + r))` làm tròn nên mất thông tin. Với số nhỏ, hai thuế suất có thể cho cùng `vat_amount_vnd`.
- Thuế suất theo **thời điểm thu tiền** (`top_ups.completed_at`, ghi cùng transaction cộng tiền), không theo lúc gọi nhà cung cấp: retry có thể vắt qua 31/12.
  - Trước 2027-01-01 00:00 giờ Việt Nam → 8% (Nghị quyết 204/2025/QH15, Nghị định 174/2025/NĐ-CP, hết hiệu lực 31/12/2026).
  - Từ mốc đó → 10%.
  - Giả định: dịch vụ sạc xe điện thuộc nhóm 10% được giảm (chưa tra Phụ lục I–III Nghị định 174/2025; decisions "Còn mở").
- Kiểu `smallint` phần trăm, không dùng `numeric(4,2)`: phép tách VAT tính bằng số nguyên (BigInt), các mức hiện hành đều nguyên.

## 3. Dữ liệu có sẵn

- Trên `main` trước 0025 **chưa có code nào ghi `e_invoices`**, seed demo (`demo/seed.sql`, `seed-app.sql`) cũng không có. DB demo và staging gần như chắc chắn có 0 dòng. Khang kiểm `SELECT count(*) FROM e_invoices` trên staging trước deploy.
- Vẫn backfill thay vì dừng migration khi có dòng: test nâng cấp `migration-0003` và `migration-0015` có dòng `e_invoices` trước khi áp tới mới nhất.
- Không suy từ `vat_amount_vnd` (mục 2). Mọi dòng đều có `top_up_id` (FK NOT NULL), nên phép UPDATE … FROM `top_ups` phủ hết dòng trước `SET NOT NULL`.

## 4. Test của người khác / test cũ phải sửa

Chỉ đổi câu INSERT, **không đổi assertion**:

- `apps/csms/test/erd-alignment.integration.test.ts:593` (test của Trí, ca "e_invoices có invoice_adjustments: không xoá được"): thêm `vat_rate = 10`.
- `apps/csms/test/billing-worker.integration.test.ts:104–106` (T32 Phần 12, helper dựng hoá đơn giả): thêm `vat_rate = 10` (9091 là 10% của 100000).
- `apps/csms/test/migration-0015.integration.test.ts:588–594` (T32 Phần 1, helper `invoice()` chạy trên schema mới nhất): thêm `vat_rate: 10` vào cột mặc định. Phát hiện khi chạy test, Khang duyệt 17/11.

Các INSERT `e_invoices` khác trong `migration-0003` và `migration-0015` chạy trên DB trước 0025 rồi được backfill, không phải sửa.

## 5. Cách kiểm

- `apps/csms/test/migration-0025.integration.test.ts`:
  - nâng cấp DB có hoá đơn hai phía mốc: `23:59:59.999+07` ngày 31/12 → 8, `00:00+07` ngày 01/01 → 10, `17:30Z` ngày 31/12 → 10, thiếu `completed_at` → theo `created_at`;
  - các cột khác giữ nguyên; chạy lại không áp gì;
  - NOT NULL, không DEFAULT, kiểu `smallint`;
  - CHECK (0 / 5 / 8 / 10 được; 7, 100, −8 bị chặn);
  - COMMENT; schema TS khớp.
- Code ghi cột: `EInvoiceService.requestForTopUp` (T32 Phần 7), cùng transaction cộng tiền.
