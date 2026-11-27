# Nhật ký migration 0031 — RFID credit protection

Ngày 27/11/2026. File `0031_rfid-credit-protection.sql`, sau 0030 T150 (đã có 0029 T148); không sửa 0029.
Chỉ áp trên PostgreSQL test sở hữu trong lượt này; runtime/staging chưa áp.

Thêm `rfid_credit_holds`: một hàng/session, FK session/account, amount_vnd bigint không âm,
held/released, reason, created_at/updated_at/released_at. Released yêu cầu released_at và ngược lại.
Index account đầy đủ cho FK và partial outstanding(account,session).

Thêm `rfid_stop_jobs`: một hàng/session, reason, pending/inflight/awaiting_stop/retry/exhausted/completed,
attempts và attempt_limit dương, current_command FK, next_attempt_at, exhausted_at, last_error,
created_at/updated_at. Check attempts ≤ limit, exhausted cần timestamp. Index command FK và due partial.
Thêm partial sessions(driver_id,id) cho RFID csms_billed có chủ phục vụ query unpaid exposure.
Drizzle nằm ở `src/db/schema/rfid-credit.ts` và index tại `schema/sessions.ts`.

Không backfill tiền hoặc hold cho phiên lịch sử, không thay state/reason/attempts của settlement jobs,
không đổi account/ledger/loyalty/statement. Shared availability đọc phiên chưa có cặp debit/statement
để bảo thủ chặn start/refund; không miễn nợ hay phục hồi T158 account_closed.

Test `migration-0031.integration.test.ts` dựng qua 0030 T150 trên DB test mới, chụp các bảng tài chính,
áp 0031, migrate lại và chạy SQL lại; kiểm dữ liệu cũ giữ nguyên, không phân bổ tiền lịch sử,
FK/unique/nonnegative/integer/state/attempt constraints. Official runner đã đăng ký suite.
SQL CREATE IF NOT EXISTS hỗ trợ chạy lại, `_migrations` vẫn là lịch sử áp chuẩn.
Rollback vận hành cần đánh giá hold/job đang sống trước; không tự xóa bảng để rollback code.

## Tiền kiểm và lịch sử local

Trước tag/deploy, kiểm read-only dữ liệu 0029 theo session/account, ledger/statement, số tiền đã biết
và lý do pending/closed; lưu số lượng và đối chiếu không đổi sau nâng. Không suy amount khi còn
thiếu tariff/meter. 0031 không phân bổ hold lịch sử, không xóa nghĩa vụ hay phục hồi job T158.
Không có age cap ngầm: test giữ nguyên phiên review ba năm tuổi và account_closed terminal.

DB local từng dùng T148 chưa công bố mang số 0028, hoặc RFID chưa công bố mang số 0030,
cần được ghi vào inventory theo chủ/môi trường trước nâng. Hai loại lịch sử này đã xuất hiện
trong local development/manual QA; danh sách đầy đủ chưa được kiểm trên từng máy. Không sửa tay
_migrations để giả lịch sử chuẩn. Giữ backup/evidence tài chính, rồi chuẩn bị DB mới từ chuỗi
migration chuẩn theo phê duyệt của chủ dữ liệu; không tự reset hoặc xóa DB đang có phiên/ledger.
0030 T150 và nhật ký 0030 của main giữ nguyên. Lượt chuẩn bị publication không truy cập runtime
hoặc staging DB; inventory read-only trước tag vẫn là bước chưa thực hiện trong lượt này.

DB manual QA sở hữu được khởi tạo trước tích hợp T150 bằng `0030_rfid-credit-protection`
cũng thuộc nhóm lịch sử lệch này. Không resume bằng migration runner mới hoặc restart nó với
chuỗi migration mới; không sửa lịch sử. Giữ nguyên DB và tiến trình BE đang chạy. QA tiếp theo
cần cluster/DB mới áp đúng `0030_t150-kiem-the-offline` → `0031_rfid-credit-protection`,
đồng thời giữ cluster cũ và toàn bộ session/ledger/statement làm bằng chứng.
