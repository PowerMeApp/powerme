# T153 — Kiểm kê migration 0029 trước NEXT tag

Kiểm toán SELECT-only hoàn tất trên clone pre-reset `powerme_t153`,
lúc **27/11/2026 09:54:35.317 UTC / 16:54:35.317 ICT**, role `app_ro`,
PostgreSQL 16.4; `repeatable read`, `read_only=on`, kết thúc bằng `ROLLBACK`.
Bộ kết quả này phục vụ nhóm duyệt trước tag; chưa đẩy tag triển khai.

Bằng chứng tổng hợp: [summary.json](../testing/evidence/t153-20261127/summary.json).
[SQL kiểm kê](../testing/t153-migration-0029-inventory.sql) giữ bảy SELECT thực tế,
thêm vỏ giao dịch chỉ đọc. Queue/age/posted-pair summaries được thu riêng trong
cùng snapshot; SQL đính kèm không tái tạo các truy vấn bổ sung đó. Không chạy lại
DB khi chuẩn bị tài liệu này. Snapshot chi tiết và CSV tài khoản giữ local,
không đưa vào Git; các báo cáo blocked cũ là lịch sử, kết luận này thay thế chúng.

## R1 — Candidate hiện tại, tài khoản và tiền

Predicate của [0029](../../apps/csms/drizzle/0029_t148-rfid-settlement-recovery.sql)
cho **0 candidate / 0 tài khoản / 0 VND đã biết / 0 khoản tiền chưa biết**;
danh sách candidate rỗng. Migration đã áp dụng **25/11/2026 10:06:28.595 UTC**.
Đây là inventory hiện tại trước NEXT tag, không tái dựng lần chạy 0029 ban đầu.
Pre-reset clone không phải backup trước 0029; tác động lịch sử **chưa xác định**,
không phải blocker restore cho phạm vi đã hoàn tất.

Trong 448 phiên RFID đã dừng, có chủ và CSMS-billed: 2 có cả debit/statement,
0 chỉ có một phía; cả 448 job đều ngoài selector. **446 phiên còn lại đã có job
quyết toán pending trên 236 tài khoản**, không phải candidate mới hoặc tác động
mới của migration. Không có tài khoản unpaid bị thiếu hoặc đóng.

| Session status / job reason (đều pending) | Phiên | Tiền chưa biết | Wh |
|---|---:|---:|---:|
| review / awaiting_reconciliation | 65 | 65 | 41.823 |
| reconciled / tariff_coverage_or_boundary_meter_required | 381 | 381 | 1.056.876 |
| Tổng | 446 | 446 | 1.098.699 |

Cả 446 khoản tiền đều NULL: tổng tiền unpaid **chưa xác định**, không phải 0.
Subtotal phần đã biết là 0 vì không có khoản nào đã biết; không định giá lại,
không suy diễn nợ tương lai. Pending là trạng thái **job quyết toán**,
không đồng nghĩa cả 446 phiên đang chờ đối soát.

RFID đã ghi sổ có 2 cặp khớp: statement cộng **4.488 VND**, debit **−4.488 VND**.
Toàn DB: 459 phiên, 448 RFID, 241 tài khoản, 0 đóng; tổng số dư 344.185.706 VND,
debit đã ghi sổ −294.294 VND, statement 294.294 VND. Các tổng này là bối cảnh,
không phải tác động 0029. Rollback migration không hoàn tác ledger đã ghi.

## R3 — Tuổi dữ liệu và age cap

Toàn RFID: start sớm nhất **09/11/2026 14:07:38.240 UTC**, stop muộn nhất
**25/11/2026 18:02:23.776 UTC**; 446 phiên quá 7 ngày, 0 quá 30 ngày,
0 quá một năm. Bucket toàn RFID không phải tập candidate.
Giữ selector **không age cap cho dữ liệu test hiện tại**, không sửa 0029.
Nếu chính sách cần giới hạn tuổi sau này, dùng migration bổ sung, review riêng.

## R5 — Account đóng và phạm vi bản sửa

[PR237](https://github.com/PowerMeApp/powerme/pull/237) đã merge commit
`051498788a5701545b960af05c75debc328dc6e7` lúc **27/11/2026 08:26:40 UTC**:
account đóng chuyển terminal `ineligible/account_closed`, Admin hiển thị reason.
Đây là bằng chứng nguồn đã được kiểm tra trước đó, **không xác nhận triển khai**.
Clone có 0 account đóng, 0 job trên account đóng, 0 pending/account_closed:
không quan sát lỗi này và chưa kiểm chứng runtime fix/deployed SHA.
Một snapshot không chứng minh retry/churn. Sửa account_closed không tự giải quyết
phiên review hoặc thiếu meter/bằng chứng định giá.

## R7 — Hai lịch sử local đã ghi nhận của Sơn

`powerme_rfid_local:5546` có T148 dưới tên 0028 chưa công bố; bằng chứng
24/11 ghi một phiên đã trả **2.276 VND / 2 điểm**. Lịch sử manual QA cổng 5547
(`powerme_rfid_credit_manual_20261127`) có 0030 cũ, 2 phiên, 2 debit, 2 statement;
snapshot lịch sử lúc **27/11/2026 08:31:43.906 UTC**. Đây không phải kết quả
trên clone hiện tại. Phạm vi local của owner khác chưa xác định.

Nếu cần dọn drift, đề xuất backup rồi tạo DB mới từ lịch sử chuẩn:
**chưa reset/rebuild**, không vá lịch sử migration hay ledger.
0029 giữ nguyên; không thay đổi runtime, mobile, dependency hoặc dữ liệu DB.
