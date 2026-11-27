# T158 — Dừng quyết toán tài khoản đã đóng

Hạn 01/12/2026, trước deployment staging 0029. Lỗi: ledger từ chối tài khoản
closed nhưng job giữ pending và hẹn lại 30 giây, recovery quét mỗi 10 giây.

Dùng trạng thái hiện có `ineligible`, reason `account_closed`: chuyển một lần
trong transaction khóa phiên → credit, trước pricing/policy. Không debit, earn,
statement hay xóa nợ. Giữ `next_attempt_at` NOT NULL; job terminal không được
recovery chọn. Lần gọi lặp/đồng thời và kết quả pending đến trễ không đổi reason,
ngày hẹn hay attempts của job terminal; job posted vẫn được bảo vệ.

Admin API hiện có: `GET /api/admin/v1/transactions?from=YYYY-MM-DD&to=YYYY-MM-DD&kind=unsettled`
và bản `.csv`; JSON trả `unsettled_reason=account_closed`, `amount_vnd=null`.
Revenue report và tổng `unsettled.by_reason` dùng cùng projection. Các reason
ineligible khác vẫn là `ineligible`; không thêm endpoint hay metadata, chỉ thêm
nhãn lý do trên màn có sẵn: “Tài khoản đã đóng, đã dừng tự động quyết toán”.

Regression nằm trong `rfid-settlement.integration.test.ts` và
`fe16-transactions-route.integration.test.ts`: closed app/RFID, job pending cũ,
thiếu tariff/policy, gọi lặp/đồng thời, late writer, transient recover và HTTP/JWT,
CSV/revenue. Chạy mỗi suite trên DB test mới riêng; không dùng DB runtime/staging.
Nhãn Admin có assertion tại `apps/dashboard/test/transactions.test.tsx`; chạy
`npm run test -w @powerme/dashboard -- test/transactions.test.tsx`.

Không đổi migration 0029, D6 closure/refund guard hay RFID reservation/cutoff.
Giới hạn RFID BR-P19 trong [T148](t148-rfid-settlement.md) vẫn giữ nguyên.
