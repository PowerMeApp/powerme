# RFID hold và bảo vệ credit

Triển khai local 27/11/2026 theo kế hoạch đã duyệt; phụ thuộc T148/T158.
[ADR 0020](../adr/0020-rfid-credit-protection.md) ghi quyết định, nguồn nghiên cứu và giới hạn.
Không phải một task số mới, không bao gồm D6 đóng tài khoản, phần cứng hay staging.

- Authorize chỉ kiểm điều kiện; Start mới giữ credit trong transaction cùng phiên và chủ thẻ đã chụp.
- RFID online hợp lệ giữ toàn bộ available; QR vẫn dùng app intent. Một account lock ngăn hai thẻ,
  QR và refund dùng lại cùng khoản. Start vật lý thiếu tiền vẫn được ghi/gán đúng chủ và yêu cầu dừng.
- Replay giữ nghĩa vụ 0, không tự giữ tiền vì còn active. Meter live hợp lệ trong epoch hiện tại mới
  có thể cấp ngân sách lần đầu. Stop thắng khóa trước thì không cấp; ngân sách đã cấp không tăng.
- Credit cutoff dùng min(ngân sách đầu, account coverage trừ hold khác) − reserve cấu hình,
  so với năng lượng hợp lệ × giá cao nhất ngày. Tạm tính này khác số quyết toán BR-P45.
- Thiếu/mâu thuẫn meter hoặc giá không phải chi phí 0. Job an toàn giữ reason, attempts và last command.
  Mỗi phiên có tổng lượt hữu hạn qua Rejected/timeout/Accepted chưa Stop, restart và reconnect.
- Accepted chưa giải phóng hold; Stop chưa đối soát/giá chưa đủ cũng giữ. Chỉ posted cùng debit,
  loyalty và statement mới nhả. T158 account_closed dừng thử lại và giữ nghĩa vụ nhìn thấy được.
- RFID public Stop vẫn 404/can_stop=false. Flutter hiển thị held/available đã có; không đổi UI hay
  capability tạm tính QR. Free vend/unattributed không debit/hold/cutoff.

`GET /api/driver/v1/credit`: held_vnd gồm hold QR còn mở + RFID held; available_vnd luôn bằng
balance_vnd − held_vnd. `unresolved_rfid_sessions` đếm mọi phiên chưa có cặp statement/debit;
`blocking_rfid_sessions` chỉ đếm nghĩa vụ chưa được bảo vệ bởi hold dương. Trường thứ hai >0
chặn start/Authorize và refund dù available_vnd dương; không bịa số tiền chưa xác định thành hold.
Nghĩa vụ vẫn được đếm khi phiên closed/review hoặc settlement pending/account_closed.

Operator `GET /api/operator/v1/charge-points/{id}` và Admin `GET /api/admin/v1/summary` bổ sung
`rfid_credit_protection`: total, exhausted_stops, held_vnd (chuỗi bigint), limit=50, items.
Mỗi item có session_id, charge_point_id, connector_no, session_status, credit_status,
held_vnd/hold_state/hold_reason, stop_state/stop_reason, attempts/attempt_limit,
current_command_id, last_error, next_attempt_at, exhausted_at và settlement_reason.
Operator scope qua site/operator; trụ khác trả 404. Exhausted ưu tiên trong collection, tồn tại
sau nhiều lệnh mới, không gộp các phiên đang chạy vào báo cáo doanh thu/unsettled.

Recovery quét tối đa 50 ứng viên theo vòng, chạy tối đa 4 tác vụ RFID trong nền, không chờ RPC
trong tick settlement/timers và không giữ SQL lock khi gọi trụ. Retry interval/timeout lấy policy.
Review chưa có Stop vẫn được dừng an toàn khi có live proof, giữ nguyên financial review.

[Migration 0031](../NHAT-KY-MIGRATION-0031.md) chỉ thêm bảng/index, không sửa 0029 hoặc ghi sổ lịch sử.
Kiểm tra chạy bằng official runner `apps/csms/scripts/test-driver-discovery.mjs` trên PG test mới.
Kiểm chứng sau tích hợp T150: protection 37/37, T150 offline-auth 7/7, RFID settlement 26/26
(gồm WebSocket thật), QR charging 27/27, migration 0031 1/1, operator monitoring 9/9,
admin summary 3/3 và dashboard 20/20. Typecheck và build CSMS/dashboard pass.
Hồi quy đầy đủ trước tích hợp T150: WF-01 179/179, CSMS unit 986/986 và dashboard 76/76;
các suite đầy đủ này không được chạy lại chỉ vì đổi số migration.

First Stop trong review lưu received_stopped_at và meter hợp lệ (meter sai giữ null), ghi lịch sử
và đối soát, nhưng giữ financial review. Callback không có Stop đã lưu không hoàn tất job.
Duplicate không thay timestamp/meter đầu; hold giữ đến posted. Recovery hoàn tất job từ Stop
đã lưu nếu callback bị mất khi restart. Không có runtime/staging, reader/hardware hoặc thanh toán thật.

## Chờ meter sau mất mạng

Mất kết nối hoặc đang chờ số đo live của epoch mới không tự tạo job `meter_evidence_unavailable`.
Nhánh an toàn cho meter chỉ xét khi registry và DB cùng xác nhận kết nối hiện tại đang online,
đúng epoch và chưa đóng. Thời hạn thiếu số đo tính từ mốc mới nhất giữa Start, mở kết nối và
số đo năng lượng live của epoch đó; không dùng riêng tuổi phiên trước reconnect. Mẫu phát bù
không được dùng làm bằng chứng live trong nhánh fallback; mẫu gần epoch không gắn replay vẫn
qua kiểm meteredProgress/T134. Meter live không hợp lệ/mâu thuẫn hoặc thật sự quá hạn vẫn tạo
job an toàn; cutoff credit, job đã tồn tại và ngân sách retry hữu hạn giữ nguyên.
