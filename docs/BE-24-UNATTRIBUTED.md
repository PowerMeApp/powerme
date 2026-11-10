# BE-24 — Gán / đóng phiên `unattributed` (F-12, FR-13) và route giải quyết phiên `review`

T102 (Trí, hạn 14/11). Cam kết BM04 **F-12**: _"Unknown/free-vend tag → unattributed, not billed; operator assigns or closes it, logged"_ (TC-F12-01..03). SRS: FR-13, UC-OPS-05, BR-P06, BR-P08, BR-P20, BR-P34. **Không migration.**

## 1. Phiên nào là `unattributed`

Do `SessionsService.classifyIdTag` / `onStartTransaction` quyết lúc StartTransaction (ADR-0012, BE-19):

| Trường hợp | `origin` | Bản ghi đối soát | Gán được? |
| --- | --- | --- | --- |
| idTag không có trong `rfid_cards` | `rfid` | `unknown_id_tag: id_tag=…` | Có |
| Thẻ có trong sổ nhưng `blocked`/`unlinked` | `rfid` (hoặc `free_vend` nếu thẻ free vend) | `unknown_id_tag … card_status=…` | Có nếu thẻ `online`; thẻ ví / free vend: không |
| Thẻ `online` active thiếu tài xế / ví (BE-19) | `rfid` | `unknown_id_tag … card_denied=…` | Có |
| Free vend (thẻ `free_vend` hoặc `charge_points.free_vend_tag`) | `free_vend` | không có | **Không** — chỉ đóng |
| App tag đã gắn phiên khác | `app_qr` | `conflict app_intent_reused` | Có |

Sau T110 (bỏ `station_wallet` → `unattributed`, bỏ thẻ `wallet`) sẽ có thêm phiên unattributed từ dữ liệu cũ. Code so sánh `rfid_cards.card_kind::text <> 'online'` (không nhắc tên giá trị enum) nên vẫn chạy khi enum đổi; phiên cũ của thẻ ví còn `rfid_card_id` trỏ thẻ không phải `online` sẽ bị chặn gán (tiền đã thu ở trụ). Phiên cũ không còn dấu thẻ thì không phân biệt được — xem câu hỏi Q3.

## 2. Quy tắc

Điều kiện chung cho cả gán và đóng:

- `payment_mode = 'unattributed'` → nếu không: `not_unattributed`.
- Đã có StopTransaction: `received_stopped_at IS NOT NULL` và `status ∈ {closed, review, reconciled}` → nếu không: `session_not_stopped`. Trước đó chưa biết năng lượng cuối.
- Chưa có quyết định (không có dòng history `UNATTRIBUTED_ASSIGNED`/`UNATTRIBUTED_CLOSED`) → xem §4 idempotent.

**Gán** `assign(sessionId, operatorUserId, driverId, note)`:

1. Free vend → `free_vend_not_billable`; thẻ không phải `online` (thẻ ví) → `wallet_card_not_billable`. BR-P08: free vend không có người trả; phiên thẻ ví đã trả ở trụ, không được trừ hai lần.
2. Tài xế phải là `drivers` + `users.role='driver'` + `account_status='active'` + có `credit_accounts` chưa `closed` → nếu không: `driver_not_eligible`. Số dư thấp vẫn gán được: phiên đã diễn ra, BR-P20 cho số dư âm (như phiên thẻ `card_denied=below_start_minimum`).
3. `sessions.driver_id = driverId`, `payment_mode = 'csms_billed'`. Mở lại `charge_settlement_jobs` (`state=pending`, `reason=operator_assigned`) vì trigger 0005 chỉ xếp job khi `status`/`received_stopped_at` đổi.
4. Sau commit gọi `ChargeSettlementService.settle()` có sẵn. `settle()` được mở rộng đúng một nhánh: ngoài `origin='app_qr'` có intent, nhận thêm phiên `origin <> 'free_vend'` **có dòng history `UNATTRIBUTED_ASSIGNED`**. Mọi điều kiện khác giữ nguyên (chỉ `reconciled` mới trừ; giá theo đồng hồ trụ; một `session_debit` + `earn` + `charging_statements`; idempotent theo `session_id`). Phiên thẻ RFID `csms_billed` thông thường vẫn chưa được tính (G5, PR riêng).
5. Phiên còn `review`: gán được, `settle()` trả `pending` (`awaiting_reconciliation`); khi operator giải quyết review (`resolve-review`) thì `resolveReview` gọi `settle()` và lúc đó mới trừ tiền. Quyết định "ai trả" (F-12) và quyết định "bao nhiêu kWh" (STM-1 #17) độc lập.

**Đóng** `close(sessionId, operatorUserId, reason, note)`: giữ `unattributed`, không gọi quyết toán, không có dòng tiền. `reason` là mã `[a-z0-9_]{1,40}` (vd `free_vend_ok`, `test_session`, `owner_unknown`), `note` 1–500 ký tự.

**Mâu thuẫn với BR-P08** ("payment_mode resolved once at session start"): gán là ngoại lệ duy nhất, chỉ do operator, chỉ từ `unattributed` sang `csms_billed`, luôn có dấu vết. Đề nghị Ân sửa câu chữ (Q1).

## 3. Quyền

Dùng chung `lockOperatorSession` (`apps/csms/src/sessions/operator-session-access.ts`) với `SessionReviewService` — cùng một câu kiểm, không nhân đôi: người gọi phải là `operator_staff` có `users.role='operator_staff'`, `account_status='active'`, của operator `active` **sở hữu site của trụ**. Không thoả → `forbidden`; phiên của operator khác hoặc không tồn tại → `not_found` (không lộ dữ liệu liên-operator). Dòng `sessions` khoá `FOR UPDATE`.

## 4. Dấu vết và idempotent

Chọn **`session_status_history`** làm dấu vết chính, không phải `reconciliation_records`:

- append-only bằng trigger (0001) — không sửa/xoá được;
- có sẵn đủ cột: ai (`actor` = users.id operator), lúc nào (`occurred_at`, đồng hồ CSMS), quyết định (`event` = `UNATTRIBUTED_ASSIGNED` / `UNATTRIBUTED_CLOSED`), ghi chú (`note` = `driver=<id>: <note>` hoặc `<reason>: <note>`); `from_status = to_status` = trạng thái hiện tại vì đây không phải chuyển STM-1;
- phiên free vend **không có** `reconciliation_records` nào, nên chỉ đóng record thì free vend không có dấu vết;
- `ReconciliationService` không ghi record khi tắt đối soát (ablation G6), còn quyết định của operator thì phải luôn được ghi.

Thêm vào đó, các `reconciliation_records` loại `unknown_id_tag` chưa duyệt của phiên được đặt `reviewed_by` (operator_staff, B2), `reviewed_at` và nối ` | operator_assigned(driver=<id>): <note>` hoặc ` | operator_closed(<reason>): <note>` — cùng cách `resolveReview` đóng record, để hàng đợi đối soát cũng hết mục.

Idempotent: gán lại **cùng** tài xế → trả `already_resolved: true`, không thêm dấu vết, gọi lại `settle()` (trả `already_posted` hoặc thử lại job đang chờ); đóng lần hai → `already_resolved: true` với lý do cũ; quyết định **khác** quyết định đã có → `already_resolved` (409). Hai lệnh đồng thời: khoá dòng làm chúng chạy nối tiếp, đúng một dấu vết.

## 5. Route console

Cùng listener, cùng mức bảo vệ với các lệnh có sẵn (bind loopback, CORS chỉ localhost, POST có `Origin` lạ → 403); thêm: POST quyết định bắt buộc `Content-Type: application/json` (cross-origin không gửi được kiểu này mà không preflight) và thân ≤ 8 KB.

| Method | Đường dẫn | Thân JSON | Gọi |
| --- | --- | --- | --- |
| GET | `/api/admin/unattributed?limit=50` | — | `UnattributedSessionService.listPending` (đã đóng, chưa quyết định; `not_assignable_reason` cho phiên chỉ đóng được) |
| GET | `/api/admin/review?limit=50` | — | `SessionReviewService.listInReview` |
| POST | `/api/admin/sessions/:id/assign-driver` | `{operator_user_id, driver_id, note}` | `assign` |
| POST | `/api/admin/sessions/:id/close-unattributed` | `{operator_user_id, reason, note}` | `close` |
| POST | `/api/admin/sessions/:id/resolve-review` | `{operator_user_id, resolution, note}` | `SessionReviewService.resolveReview` (#94) |

Mã HTTP: 400 tham số sai (`invalid_input`, thân không phải JSON) · 403 `forbidden` / `forbidden_origin` · 404 `not_found` · 409 `not_unattributed`, `session_not_stopped`, `free_vend_not_billable`, `wallet_card_not_billable`, `already_resolved`, `not_in_review` · 413 thân quá lớn · 415 không phải JSON · 422 `driver_not_eligible` · 503 service chưa nạp.

### Giới hạn — bắt buộc đọc

**Console chưa có xác thực (ADR-0011).** `operator_user_id` lấy từ thân request là **tạm thời**: ai gọi được cổng console (loopback / SSH tunnel) có thể tự nhận là bất kỳ nhân viên vận hành nào. BE-18 từng cố ý không mở endpoint vì lý do này; BE-24 mở theo yêu cầu T102 với cùng mức bảo vệ của các lệnh console đang có (disconnect, remote-stop, Reset), **không mở rộng hơn** (không bind ngoài loopback, không thêm CORS). Mọi kiểm tra quyền vẫn nằm ở service, nên khi có đăng nhập operator (F-13 / RolesGuard) chỉ cần thay nguồn `operatorUserId` bằng phiên đăng nhập, không sửa service. Hai GET hàng đợi chưa lọc theo operator (cùng mức `GET /api/admin/sessions`); mỗi dòng có `operator_id`.

## 6. Cách kiểm

- `npm run typecheck -w @powerme/csms`
- Unit (không DB): `node scripts/run-jest.cjs src/console` trong `apps/csms`.
- Tích hợp (DB test riêng — test DROP SCHEMA): `DATABASE_URL=postgresql://…/powerme_test node scripts/run-jest.cjs test/be24-unattributed test/be18-operator-resolve`.
- Tay, với CSMS chạy local (cổng console mặc định 3000):

```sh
curl localhost:3000/api/admin/unattributed
curl -X POST localhost:3000/api/admin/sessions/1/assign-driver -H 'Content-Type: application/json' \
  -d '{"operator_user_id":2,"driver_id":1,"note":"Tài xế gọi tổng đài xác nhận thẻ"}'
curl -X POST localhost:3000/api/admin/sessions/2/close-unattributed -H 'Content-Type: application/json' \
  -d '{"operator_user_id":2,"reason":"free_vend_ok","note":"Khuyến mãi khai trương"}'
curl -X POST localhost:3000/api/admin/sessions/3/resolve-review -H 'Content-Type: application/json' \
  -d '{"operator_user_id":2,"resolution":"meter_confirmed","note":"Đã xem ảnh công tơ"}'
```

Seed demo (`demo/seed.sql`) chưa có `operator_staff`; muốn chạy tay phải thêm một user `operator_staff` + dòng `operator_staff` cho operator của trụ (xem `test/be24-unattributed.integration.test.ts`).

Test truy vết BM04: `TC-F12-01` (gán → `csms_billed`, trừ đúng 10.000 VND cho 2.000 Wh × 5.000 VND/kWh, 10 điểm, dấu vết; và gán khi còn `review` → trừ tiền sau `resolve-review`), `TC-F12-02` (free vend không gán được và `settle()` không trừ kể cả khi dữ liệu bị sửa tay; thẻ ví; phiên không unattributed / chưa dừng; tài xế không hợp lệ; tham số sai), `TC-F12-03` (operator khác → `not_found`; tài xế/admin/user lạ/nhân viên bị khoá → `forbidden`; ánh xạ mã HTTP qua console).

## 7. Câu hỏi mở

- **Q1 (Ân):** sửa BR-P08 thành "…resolved once at session start; an unattributed session may later be assigned to a driver by the owning operator (UC-OPS-05), which is logged and is the only change allowed"?
- **Q2 (Ân):** UC-OPS-05 có cần trạng thái "đã xem, chưa quyết" không? Hiện chỉ có hai quyết định cuối (gán / đóng).
- **Q3 (Ân, T110):** migration T110 có giữ dấu phiên `station_wallet` cũ (vd `rfid_card_id` trỏ thẻ ví, hay một record) không? Nếu không, sau T110 operator có thể vô tình gán — và trừ tiền lần hai — một phiên đã trả ở trụ.
- **Q4 (Nghĩa, F-13):** đăng nhập operator cho console/dashboard dự kiến khi nào, để thay `operator_user_id` trong thân?
