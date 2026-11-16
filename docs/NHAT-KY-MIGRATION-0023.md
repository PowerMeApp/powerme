# Nhật ký migration 0023 — `0023_t134-do-lech-dong-ho-tru.sql`

**Ngày:** 16/11/2026 · **Task:** T134 (WP2, quyết định D-I ngày 14/11) · **Người chịu trách nhiệm:** Ngô Văn Minh Trí
**File:** `apps/csms/drizzle/0023_t134-do-lech-dong-ho-tru.sql` (áp lên DB đã có 0000 → 0022; một transaction `BEGIN … COMMIT`)
**Nguồn:** `docs/requirements/report3-srs.md` BR-P02 (bản 14/11): đồng hồ trụ lệch quá dung sai thì giờ trụ được cộng độ lệch đo trên các bản tin gửi lúc online trong cùng kết nối; không đo được thì cả phiên tính theo khung giá lúc CSMS nhận start; mỗi lần chỉnh được ghi lại cho Operator. Quy tắc đầy đủ: `docs/T101-TARIFF-CLOCK.md`.

**Vì sao là 0023:** migration mới nhất trên `main` lúc làm là `0022_anh-mau-xe.sql` (BE-38). PR nào merge sau phải đổi số (tên file, hằng `M0023` trong `test/migration-0023.integration.test.ts`, nhật ký này).

## 1. Thay đổi

| #   | Đối tượng                                                       | Thay đổi                                                                                                             | Use case                                                                                                                                                                             |
| --- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | enum `reconciliation_record_type`                               | Thêm giá trị `tariff_clock_offset` (đứng sau `tariff_clock_fallback`)                                                | Operator mở phiên của một trụ có đồng hồ chậm 10 phút và thấy dòng "Đồng hồ trụ lệch chậm 600 s: đã cộng độ lệch…" (BR-P02: mỗi lần chỉnh được ghi lại)                              |
| 2   | `sessions.priced_clock` (CHECK `sessions_priced_clock_check`)   | Viết lại CHECK: giá trị hợp lệ là `cp` · `cp_offset` · `csms` (trước: `cp` · `csms`); điều kiện đi kèm `priced_ended_at` giữ nguyên | Phiên sạc 11:55–12:05 trên trụ lệch 10 phút được chia đúng Normal / Peak và ghi `cp_offset`; báo cáo K3 phân biệt được phiên tính theo giờ trụ gốc, giờ đã chỉnh và giờ CSMS         |
| 3   | `charge_tariff_boundary_evidence.pricing_clock` (CHECK cùng tên) | Viết lại CHECK: `cp` · `cp_offset` · `csms`                                                                          | Operator xác nhận số đo lúc 12:00 cho phiên đã chỉnh giờ: bằng chứng nằm trên trục giờ đã chỉnh, không dùng nhầm bằng chứng nhập cho trục giờ trụ gốc của cùng phiên (UC-OPS-05)     |
| 4   | COMMENT                                                         | `sessions.priced_clock`, `sessions.priced_ended_at`, `charge_tariff_boundary_evidence.pricing_clock`                 |                                                                                                                                                                                      |

**Không sửa / xoá dữ liệu cũ:** phiên đã quyết toán giữ nguyên `priced_clock` (`cp`, `csms` hoặc NULL), bản ghi đối soát và bằng chứng biên giữ nguyên. Bằng chứng biên trục `csms` nhập trước 0023 còn trong bảng nhưng không còn được đọc: từ T134 phiên tính theo giờ CSMS chỉ có một khung giá.

**Vì sao thêm giá trị enum thay vì dùng tiền tố `resolution`:** `tariff_clock_fallback` (0020) đã là một loại riêng; hai kết quả chỉnh đồng hồ cần đếm tách nhau trong `reconciliation_by_type` của console mà không phải đọc chuỗi.

**Vì sao không thêm cột lưu độ lệch vào `sessions`:** độ lệch nằm trong bản ghi `tariff_clock_offset` (`offset_s=…`), và suy lại được từ `priced_ended_at − cp_stopped_at`. Thêm cột là thêm một chỗ phải giữ đồng bộ.

**`ALTER TYPE … ADD VALUE` trong transaction:** PostgreSQL cho thêm giá trị enum trong transaction nhưng cấm dùng giá trị đó trước khi commit. File này chỉ thêm, không ghi dòng nào mang `tariff_clock_offset` (cùng cách 0020 thêm `tariff_clock_fallback`); test tĩnh kiểm điều này.

## 2. Hệ quả cho mã khác (sửa cùng PR)

- `src/db/schema/enums.ts` (`reconciliationRecordTypeEnum`), `src/db/schema/sessions.ts` (`pricedClock`, CHECK).
- `src/reconciliation/tariff-clock.ts`: đo độ lệch (`measureClockOffset`), kiểm mốc đã chỉnh (`resolveTariffClock`).
- `src/sessions/charge-settlement.service.ts`: ghi `cp_offset` + bản ghi `tariff_clock_offset`; giờ CSMS tính một khung giá.
- `src/console/console.mappers.ts`, `console-page.ts`: loại hiển thị và câu diễn giải cho `tariff_clock_offset`.
- `test/migration-0001.integration.test.ts`: danh sách enum đầy đủ thêm giá trị mới.
- `docs/THIET-KE-CSDL-VAT-LY.md`, `docs/T101-TARIFF-CLOCK.md`, `docs/api/operator-admin-api.openapi.yaml`.

## 3. Cách kiểm

`test/migration-0023.integration.test.ts`: (1) tĩnh — một file số 0023 ngay sau 0022, file không dùng giá trị enum mới và không có lệnh sửa dữ liệu; (2) DB trước 0023 có seed + phiên đã quyết toán theo `cp` / `csms` / chưa quyết toán + bằng chứng biên hai trục + bản ghi `tariff_clock_fallback` và `meter_evidence_conflict` → trước migrate `cp_offset` và `tariff_clock_offset` bị từ chối (23514, 22P02) → migrate → mọi dòng giữ nguyên từng cột, seed chạy lại được, ba chỗ ghi mới dùng được; (3) DB sạch → CHECK nhận ba giá trị kèm mốc dừng, chặn giá trị khác và thiếu mốc dừng; một biên có được ở ba trục giờ; enum đúng thứ tự; (4) schema TS khớp DB.

Hành vi nghiệp vụ dùng các giá trị này: `test/wf01-driver-charging.integration.test.ts` (các ca `T134`).

Các test migration cũ dựng DB ở phiên bản của chúng rồi `migrate()` tiếp: `migration-0020`, `-0021`, `-0022` dùng danh sách `AFTER` nên tự nhận 0023; `demo/seed.sql` và `demo/seed-app.sql` không dùng cột hay giá trị nào của 0023 nên vẫn nạp được trên schema cũ.
