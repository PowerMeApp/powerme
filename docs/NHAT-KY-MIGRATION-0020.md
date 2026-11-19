# Nhật ký migration 0020 — `0020_t101_tariff_clock.sql`

**Ngày migration:** 13/11/2026 · **Task:** T101 (WP3, PR #120) · **Người làm:** Lý Hoàng Sơn
**Nhật ký viết bổ sung:** 16/11/2026 trong T134 (WP2), cùng `test/migration-0020.integration.test.ts`. Migration đã merge mà chưa có nhật ký và test riêng (quy ước migration viết tay của repo, ADR-0008, cần cả hai). Nội dung dưới đây đọc lại từ file SQL và mã của #120; file SQL **không bị sửa**.
**File:** `apps/csms/drizzle/0020_t101_tariff_clock.sql` (áp lên DB đã có 0000 → 0019; một transaction `BEGIN … COMMIT`)
**Nguồn:** `docs/requirements/report3-srs.md` BR-P02 (bản 09/11: tính giá theo giờ của trụ sau khi đã kiểm với đồng hồ CSMS và connection epoch); `docs/T101-TARIFF-CLOCK.md`.

## 1. Thay đổi

| #   | Đối tượng                                       | Thay đổi                                                                                                                                                         | Use case                                                                                                                                                                         |
| --- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | enum `reconciliation_record_type`               | Thêm giá trị `tariff_clock_fallback`                                                                                                                             | Operator thấy phiên nào đã phải tính giá theo giờ CSMS vì không tin được đồng hồ trụ, kèm lý do (BR-P02)                                                                         |
| 2   | `sessions.priced_clock text`                    | Cột mới, nullable: đồng hồ đã dùng khi quyết toán (`cp` · `csms`)                                                                                                | Đối chiếu một hoá đơn bị khiếu nại: biết các phần giá của phiên được cắt theo giờ trụ hay giờ CSMS                                                                               |
| 3   | `sessions.priced_ended_at timestamptz`          | Cột mới, nullable: mốc dừng dùng khi tính giá                                                                                                                    | Báo cáo doanh thu K3 (T108) nhóm phiên theo ngày ICT của mốc này; phiên offline phát bù qua nửa đêm được tính vào ngày điện thật sự được giao                                    |
| 4   | CHECK `sessions_priced_clock_check`             | Hai cột trên cùng NULL, hoặc `priced_clock IN ('cp','csms')` và `priced_ended_at` có giá trị                                                                     | Chặn phiên có đồng hồ tính giá mà không có mốc dừng (báo cáo K3 sẽ bỏ sót phiên đó)                                                                                              |
| 5   | `charge_tariff_boundary_evidence.pricing_clock` | Cột mới `text NOT NULL DEFAULT 'cp'`, CHECK `IN ('cp','csms')`; khoá chính đổi từ `(session_id, boundary_at)` sang `(session_id, boundary_at, pricing_clock)`    | Operator xác nhận số đo lúc 12:00 cho một phiên: cùng một mốc 12:00 trên trục giờ trụ và trên trục giờ CSMS là hai thời điểm thật khác nhau, phải lưu tách (UC-OPS-05)           |
| 6   | COMMENT                                         | `sessions.priced_clock`, `sessions.priced_ended_at`                                                                                                              |                                                                                                                                                                                  |

**Dữ liệu cũ:**

- Phiên đã quyết toán trước 0020 giữ `priced_clock` và `priced_ended_at` là NULL. Migration không đoán đồng hồ đã dùng; báo cáo K3 phải coi NULL là "không biết".
- Bằng chứng biên nhập trước 0020 (T72) nhận `pricing_clock = 'cp'`. Lý do ghi trong file SQL: bằng chứng T72 được ghi trước khi T101 chuyển sang giờ trụ. Lưu ý khi đọc lại: T72 cắt phần giá theo giờ nhận của CSMS, nên các dòng này về bản chất nằm trên trục CSMS. Trên `main` chưa có route hay UI nhập bằng chứng biên (chỉ có ở service), nên khó có dòng thật nào; chưa kiểm trên staging, nếu có thì cần rà lại tay.
- Bản ghi đối soát không đổi.

**`ALTER TYPE … ADD VALUE` trong transaction:** file thêm giá trị enum trong cùng transaction với các lệnh khác nhưng không dùng giá trị đó (PostgreSQL cấm dùng trước khi commit). Bản ghi `tariff_clock_fallback` đầu tiên do `ChargeSettlementService` ghi lúc quyết toán, sau khi migration đã commit.

**Tên ràng buộc:** CHECK của `pricing_clock` khai báo inline nên mang tên PostgreSQL tự đặt, `charge_tariff_boundary_evidence_pricing_clock_check`; khoá chính mới giữ tên `charge_tariff_boundary_evidence_pkey`. Migration 0023 dựa vào tên CHECK này để viết lại.

## 2. Hệ quả cho mã khác (đã sửa trong #120)

- `src/db/schema/enums.ts`, `src/db/schema/sessions.ts` (hai cột, CHECK). Bảng `charge_tariff_boundary_evidence` chỉ được đọc / ghi bằng SQL thô trong `ChargeSettlementService`, không có trong schema Drizzle.
- `src/reconciliation/tariff-clock.ts`, `src/sessions/charge-settlement.service.ts`, `src/sessions/sessions.service.ts`.
- `src/console/console.mappers.ts`, `console-page.ts`: loại hiển thị `tariff_clock_fallback`.

## 3. Sau 0020

Migration 0023 (T134) thêm `cp_offset` vào hai CHECK và thêm loại bản ghi `tariff_clock_offset`; xem `docs/NHAT-KY-MIGRATION-0023.md`.

## 4. Cách kiểm

`test/migration-0020.integration.test.ts`: (1) tĩnh — một file số 0020 ngay sau 0019; (2) DB trước 0020 có seed demo + seed-app + một phiên đã dừng, một bản ghi đối soát, một bằng chứng biên → trước migrate giá trị enum mới bị từ chối (22P02) → migrate → phiên giữ nguyên từng cột, hai cột mới NULL cho mọi phiên, bản ghi giữ nguyên, bằng chứng cũ nhận `cp`, seed chạy lại được; (3) DB dừng đúng ở 0020 → CHECK của `sessions` nhận `cp` / `csms` kèm mốc dừng và chặn thiếu mốc dừng, thừa mốc dừng, `cp_offset`, chuỗi rỗng, chữ hoa; bằng chứng biên mặc định `cp`, cùng biên có được ở hai trục, trùng trục bị chặn (23505), giá trị lạ bị chặn (23514), khoá chính đúng ba cột; `tariff_clock_fallback` ghi được và đứng cuối enum; (4) DB mới nhất → schema TS khớp DB.

Hành vi nghiệp vụ: các ca `T101` trong `test/wf01-driver-charging.integration.test.ts`.
