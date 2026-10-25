# BM02 — Team response (Fixed / Kept / Planned)

Phản hồi của nhóm cho từng điểm trong báo cáo gốc `BM02-SELF-REVIEW-review-2.md`. **Báo cáo gốc không bị chỉnh sửa**; mọi phản hồi nằm trong file này.

Ngày hạn và người chịu trách nhiệm là **đề xuất của Trí (WP2)**, cần xác nhận trong họp nhóm trước khi nộp. Các điểm mức High còn Kept/Planned đã được liệt kê lại trong Known Gaps (G1, G2, G11, G12, G16, G17) của `docs/DESIGN-BRIEF-WP2-INPUT.md`, theo quy định mục 5 hướng dẫn Review 2.

| ID | Mức | Phản hồi | Người chịu trách nhiệm | Hạn | Lý do / việc làm / commit |
|---|---|---|---|---|---|
| F01 | High | Planned | Ân (WP1) | 26/10 | Phiếu đăng ký, SRS, SDD nằm ngoài repo (Drive của WP1). Ân đưa bản sao vào `docs/requirements/`. Cũng nằm ở Known Gap G12. |
| F02 | Medium | Planned | Ân + Trí | 26/10 | Gắn mã FR từ phiếu v1.2 vào bảng tính năng bắt buộc của Design Brief §6. |
| F03 | Medium | Planned | Ân (WP1) | 26/10 | Cần SRS trong repo mới kiểm được; tiêu chí chấp nhận của 8 tính năng WP2 đã có. |
| F04 | Medium | Planned | Trí + Khang | 20/11 | Dựng công cụ đo (prom-client, k6) ở Iteration 2. Known Gap G15. |
| F05 | Medium | Fixed + Planned | Trí | 14/11 | Đã rút lại câu "≤ 60 s khi mất ping" khỏi Design Brief, chốt một nghĩa duy nhất (socket đóng = đã làm; 900 s = chưa có timer) — [fa21e54](https://github.com/PowerMeApp/powerme/commit/fa21e54e65939f913d0edb26ca4be83a171354d9). Cài timer 900 s ở Iteration 2. |
| F06 | Medium | Fixed + Planned | Trí | 31/10 | Sửa khẳng định sai "DB từ chối Wh không nguyên" — [fa21e54](https://github.com/PowerMeApp/powerme/commit/fa21e54e65939f913d0edb26ca4be83a171354d9). Chốt chính sách làm tròn cho ADR-0009 quy ước 3 (phụ lục). |
| F07 | Medium | Planned | Ân (WP1) | 26/10 | Logical ERD (T10) đưa vào `diagrams/erd/` trong repo. |
| F08 | Medium | Fixed + Planned | Trí | 14/11 | Bảng `remote_commands` đã có trong migration 0001 — [e56d51a](https://github.com/PowerMeApp/powerme/commit/e56d51a801546ebed91c7c4a8c7d289a931db109). Code phát lệnh (BE-04) vẫn Planned. |
| F09 | Medium | Fixed | Trí | — | Thêm `sessions.orphaned_at`, `meter_values.replayed/epoch`, `ocpp_message_log.replayed`, ghi từ ReplayVerdict — [e56d51a](https://github.com/PowerMeApp/powerme/commit/e56d51a801546ebed91c7c4a8c7d289a931db109). |
| F10 | Medium | Fixed | Trí | — | Enum `record_type` có `conflict` và `late_sample`; code và console đã chuyển (vẫn đọc bản ghi cũ) — [e56d51a](https://github.com/PowerMeApp/powerme/commit/e56d51a801546ebed91c7c4a8c7d289a931db109). |
| F11 | Low | Kept | Trí | — | Không làm FK: `ocpp_message_log` là bảng partition, khoá chính phải chứa `received_at`, không FK chỉ bằng `id` được. Lý do ghi ở mục 9 `docs/THIET-KE-CSDL-VAT-LY.md` — [e56d51a](https://github.com/PowerMeApp/powerme/commit/e56d51a801546ebed91c7c4a8c7d289a931db109). |
| F12 | Medium | Planned | Trí | 14/11 | Lưu MeterValues mồ côi (transactionId lạ/thiếu) vào bảng riêng thay vì chỉ cảnh báo. |
| F13 | Medium | Fixed | Trí | — | Bảng `session_status_history` ghi một dòng cho mỗi chuyển trạng thái trong cùng transaction, có test rollback — [e56d51a](https://github.com/PowerMeApp/powerme/commit/e56d51a801546ebed91c7c4a8c7d289a931db109). |
| F14 | Low | Fixed | Trí | — | Số CHECK sửa 36 → 24 (đếm trên văn bản migration); TypeScript 7.0.2 → 5.9.3 — [fa21e54](https://github.com/PowerMeApp/powerme/commit/fa21e54e65939f913d0edb26ca4be83a171354d9). |
| F15 | Low | Planned | Trí + Ân | 31/10 | Đồng bộ tên cột trong tài liệu kiến trúc với schema thật sau khi đóng băng schema. |
| F16 | Low | Planned | Trí | 31/12 | Job tạo partition tháng (hoặc partition tạo sẵn tới 2028) trước 2027-02. |
| F17 | Medium | Kept | Trí | — | Iteration 1 có chủ đích chỉ gồm gateway, sessions, reconciliation; 21/32 bảng thuộc module của WP3/4/5 sẽ có code ở Iteration 2. Bảng vẫn có trong migration để ERD khớp script. |
| F18 | High | Planned | Trí | 07/11 | Đường giải quyết `review` do operator (OPERATOR_RESOLVED). Known Gap G2. |
| F19 | High | Planned | Trí | 14/11 | RemoteStart/Stop, start timeout, hard cap 24 h. Known Gap G2. |
| F20 | Low | Kept | Trí | — | Xác nhận nhất quán, không cần hành động. |
| F21 | High | Planned | Trí + Nghĩa | 14/11 | Luồng onboarding và disable của trụ. Known Gap G11. |
| F22 | Medium | Planned | Trí | 31/10 | `classifyIdTag` và Authorize phải xét `card.status` (unlinked/blocked). |
| F23 | Medium | Planned | Trí | 31/10 | Đối chiếu bảng chuyển trạng thái connector với OCPP 1.6 §4.9 bản gốc; hiện viết theo hiểu biết. |
| F24 | Low | Planned | Ân (WP1) | 26/10 | Gắn UC/FR cho chuyển #9a, #18, #19 của STM-1. |
| F25 | Medium | Planned | Ân (WP1) | 26/10 | Activity diagram AD-1…AD-8 đưa vào `diagrams/` dạng mã nguồn. Known Gap G12. |
| F26 | High | Planned | Khang (WP5) | 21/11 | Tính giá, trừ ví, cộng điểm, statement. Known Gap G17. |
| F27 | High | Planned | Trí | 14/11 | Phát lệnh RemoteStart/Reset/Unlock/Change/GetConfiguration từ sản phẩm. Known Gap G17. |
| F28 | Medium | Planned | Nghĩa + Trí | 21/11 | Luồng fault_events / fault_reports. |
| F29 | Medium | Planned | Trí | 31/10 | Test cho nhánh `reconciled → review`, pause/resume, Authorize/phân loại thẻ, `unexpected_transition` được lưu. |
| F30 | Medium | Fixed + Planned | Trí | 31/10 | Đây là khẳng định quá tay của chính Design Brief: đã sửa để không ghi "exists" cho test chưa có — [fa21e54](https://github.com/PowerMeApp/powerme/commit/fa21e54e65939f913d0edb26ca4be83a171354d9). Viết test subprotocol, đóng phiên cũ, trigger append-only. |
| F31 | High | Planned | Cả nhóm | 26/10 | Thêm chú giải "đã có / đích" vào package diagram; phần đích nằm ở Known Gap G1, G16, G17. |
| F32 | Medium | Planned | Trí | 26/10 | Thêm console, HMI, bộ demo vào sơ đồ kiến trúc (hiện chỉ có trong repo). |
| F33 | Medium | Planned | Trí | 31/10 | Luật 1 của package diagram không còn đúng (gateway import SessionsModule); viết lại luật theo thực tế hoặc tách qua interface. |
| F34 | Medium | Planned | Trí | 14/11 | Công tắc bật/tắt đối soát cho thí nghiệm ablation. Known Gap G14. |
| F35 | Low | Planned | Trí | 31/10 | Đổi cổng mặc định của console khỏi 3000 (trùng cổng REST dự kiến). |
| F36 | Medium | Kept | Trí | 26/10 | Báo cáo ghi ngày là ảnh chụp tại thời điểm viết; thêm dòng "Superseded" đầu file thay vì sửa lịch sử. |
| F37 | High | Planned | Trí | 14/11 | Security Profile 2 (Basic Auth từng trụ). Known Gap G16. |
| F38 | Medium | Planned | Trí | 14/11 | Các biến timeout đã đọc vào config nhưng chưa dùng; nối vào job/timer. |
| F39 | Medium | Planned | Trí | 31/10 | T13 #12a và WF-03 mâu thuẫn về `gap_detected`; chọn một và sửa tài liệu kia. |
| F40 | Medium | Fixed | Trí | — | `payment_mode` có `unattributed`; idTag lạ gán `unattributed` thay vì `station_wallet` — [e56d51a](https://github.com/PowerMeApp/powerme/commit/e56d51a801546ebed91c7c4a8c7d289a931db109). Còn mở: ADR-0012 quyết định 3 nói free vend cũng là `unattributed`, schema dùng `free`; Trí chưa quyết. |
| F41 | Medium | Planned | Trí | 31/10 | Cửa sổ dung sai cho `before_epoch` + test biên. Known Gap G9. |
| F42 | Medium | Fixed + Planned | Trí | 14/11 | Sửa khẳng định "100 % frame" trong Design Brief — [fa21e54](https://github.com/PowerMeApp/powerme/commit/fa21e54e65939f913d0edb26ca4be83a171354d9). Móc `strictValidationFailure`/`badMessage` vào logger. Known Gap G13. |
| F43 | Medium | Planned | Trí | 07/11 | Console gửi RemoteStop phải phát STOP_REQUESTED / REMOTE_STOP_REJECTED vào state machine. |
| F44 | Medium | Planned | Trí | 14/11 | RolesGuard cho `/api/admin/*`; hiện chỉ giảm nhẹ bằng bind 127.0.0.1 và chặn Origin. |
| F45 | Low | Planned | Trí | 14/11 | BootNotification cập nhật model/firmware, đọc ConnectionTimeOut, endpoint onboarding. |
| F46 | Low | Planned | Trí | 20/11 | Đo p95 thật bằng k6; gộp truy vấn SELECT+INSERT theo lô nếu vượt ngưỡng. |

## Thống kê

- Tổng số điểm: **46**. Theo phản hồi: **Fixed** = 5, **Fixed + Planned** = 5, **Kept** = 4, **Planned** = 32 (cập nhật 25/10/2026 sau migration 0001; trước đó Fixed = 5, Kept = 3, Planned = 38).
- Điểm mức **High**: F01, F18, F19, F21, F26, F27, F31, F37 — không điểm nào ở trạng thái Fixed; tất cả là việc chưa làm hoặc tài liệu nằm ngoài repo, và đều đã vào Known Gaps.
- Commit sửa tài liệu theo báo cáo này: [fa21e54](https://github.com/PowerMeApp/powerme/commit/fa21e54e65939f913d0edb26ca4be83a171354d9) (merge sau khi gắn tag `review-2`; tag không bị di chuyển).
