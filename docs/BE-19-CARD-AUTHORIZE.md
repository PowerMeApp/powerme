# BE-19 — Authorize / StartTransaction với thẻ RFID: thẻ gắn tài xế và số dư tối thiểu (G8)

**Chạm vào luồng của Trí (WP2) và dùng ngưỡng của Sơn (WP3, `ChargePolicy`).** Không đổi STM-1, không migration.

## Lỗ hổng (G8, BM02 F29)
Thẻ chỉ bị kiểm `rfid_cards.status` (#56). Thẻ `online` `active` **chưa gắn tài xế** hoặc gắn tài xế **không đủ tiền / ví đóng** vẫn được `Authorize` = `Accepted`, và `StartTransaction` gán `csms_billed` kể cả khi `driver_id` rỗng (phiên "tính tiền" cho không ai). Trái BR-P23 ("thẻ online cần tài xế đã liên kết với Charging Credit đủ") và BR-P18. Chỉ tag của app được kiểm (`authorizeAppTag`, #58). Test tái hiện: `test/card-authorize.integration.test.ts` chạy trên code cũ → 14/23 đỏ.

## Quy tắc (một nơi: `src/sessions/card-eligibility.ts`)
Chỉ áp cho thẻ `card_kind = 'online'` đã qua kiểm `status = 'active'`. Thẻ `free_vend` không có tài xế để kiểm (thẻ `wallet` / `station_wallet` bỏ ở migration 0016, BE-23 / T110: thẻ ví cũ thành `online`, nên cũng qua đúng các kiểm dưới đây — chưa gắn tài xế thì `Invalid`); `charge_points.free_vend_tag` (không nằm trong sổ thẻ) giữ nguyên.

Số dư khả dụng = `credit_accounts.balance_vnd` trừ phần giữ chỗ (`reserved_vnd`) của các `driver_charge_intents` chưa kết thúc của cùng tài xế — cùng cách `authorizeAppTag` tính. Ngưỡng dùng chung hàm `meetsStartMinimum` (`charge-start-policy.ts`, `CHARGE_MINIMUM_START_VND`, mặc định 50.000) với `startCreditPolicy` của app.

| Lý do (`CardDenyReason`) | Điều kiện | `Authorize` | `StartTransaction` (phiên đã diễn ra) |
|---|---|---|---|
| thẻ lạ (không trong sổ) | không có dòng `rfid_cards` | `Invalid` | `unattributed` + `unknown_id_tag` (như cũ) |
| thẻ `blocked` | `status = blocked` | `Blocked` | `unattributed` + `card_status=blocked` (như cũ) |
| thẻ `unlinked` | `status = unlinked` | `Invalid` | `unattributed` + `card_status=unlinked` (như cũ) |
| `no_driver` | active nhưng `driver_id` rỗng (BR-P23) | `Invalid` | `unattributed`, `driver_id` rỗng, record `card_denied=no_driver` |
| `no_credit_account` | tài xế chưa có ví | `Invalid` | `unattributed`, record `card_denied=no_credit_account` |
| `driver_inactive` | `users.account_status` ≠ active | `Blocked` | `unattributed`, record `card_denied=driver_inactive` |
| `credit_closed` | ví `closed` | `Blocked` | `unattributed`, record `card_denied=credit_closed` |
| `credit_in_shortfall` | ví `in_shortfall` (âm sau phiên trước) | `Blocked` | `csms_billed` gắn tài xế, record `card_denied=credit_in_shortfall` |
| `below_start_minimum` | khả dụng < mức tối thiểu (BR-P18) | `Blocked` | `csms_billed` gắn tài xế, record `card_denied=below_start_minimum` |
| đủ điều kiện | — | `Accepted` | `csms_billed` gắn tài xế, không record |

Chọn mã OCPP: `Invalid` = "không xác định được người được phép" (thẻ lạ, chưa gắn, chưa có ví); `Blocked` = "biết ai nhưng hiện không được phép" (thẻ khoá, tài khoản khoá, ví đóng/âm, thiếu tiền). Tag của app vẫn trả `Invalid` cho mọi lý do (đường riêng, không đổi).

## StartTransaction: không bao giờ từ chối
`StartTransaction` luôn trả `Accepted` (ADR-0012, BR-P06: phiên đã diễn ra thì ghi, nhất là khi trụ tự chấp nhận lúc offline với `LocalAuthorizeOffline`). Chỉ phân loại và đánh dấu để đối soát:
- **Không thu được** (chưa gắn tài xế, tài khoản khoá, ví đóng, chưa có ví) → `payment_mode = unattributed`, `driver_id` rỗng; `rfid_card_id` giữ để lần ra thẻ.
- **Thu được nhưng thiếu tiền** (dưới mức tối thiểu, ví đang âm) → vẫn `csms_billed` gắn tài xế: BR-P18..P23 nói rõ thiếu hụt sau phiên offline làm số dư âm và chặn phiên mới tới khi nạp tiền.
- Cả hai có một `reconciliation_records` kiểu `unknown_id_tag` với `resolution` chứa `card_denied=<lý do>` (enum `record_type` chưa có loại riêng; cùng cách `card_status=`).

## Phương án bỏ
- Từ chối `StartTransaction` khi không đạt điều kiện: mất dữ liệu phiên thật, trái BR-P06/ADR-0012.
- Gọi lại `authorizeAppTag` cho thẻ: hàm đó gắn chặt với intent/RemoteStart/epoch socket; chỉ dùng chung ngưỡng và cách tính khả dụng.
- Cột mới trên `sessions` (`card_denied`) hoặc enum đối soát mới: cần migration; `resolution` đủ cho vận hành.
- Coi `in_shortfall` là unattributed: sẽ làm mất khoản nợ đáng ra thu được.

## Giữ nguyên
`free_vend_tag` của trụ và thẻ `free_vend` (→ `free_vend`/`unattributed`); tag của app (đường `authorizeAppTag`); bảng chuyển STM-1; thẻ chưa active/lạ khi StartTransaction.

## G5 (không làm trong PR này)
Sau G8, phiên thẻ `csms_billed` luôn có `driver_id` hợp lệ (nếu không đã thành `unattributed`), nên `charge-settlement.service.ts` (hiện chỉ `origin='app_qr'`) có thể tính tiền phiên thẻ trong một PR riêng. Điều kiện cần: (1) mở rộng điều kiện chọn phiên sang `origin='rfid' AND payment_mode='csms_billed' AND driver_id IS NOT NULL`; (2) không có `driver_charge_intents` để lấy giá/giữ chỗ → tính giá theo biểu giá tại `cp_started_at` như app, không có reserve trước, nên số dư có thể âm (chuyển ví `in_shortfall`); (3) phiên có record `card_denied=below_start_minimum|credit_in_shortfall` là ứng viên thu nợ; (4) idempotency theo `session_id` như app; (5) phiên `delivered_offline` tính theo giờ trụ (G18).

## Cách kiểm
- Unit/đơn: `npm run typecheck -w @powerme/csms`.
- Tích hợp (cần `DATABASE_URL` tới Postgres test, chạy `-i`): `node scripts/run-jest.cjs -i test/card-authorize test/session-history` trong `apps/csms`.
- Demo: seed gắn `DEMO-CARD-0001` với tài xế có Charging Credit 500.000 VND → vẫn `Accepted`; `DEMO-CARD-0002` (tài xế mẫu 2, thay `DEMO-WALLET-0001` từ T110) cũng vậy. DB demo cũ còn `DEMO-WALLET-0001` thì sau 0016 thẻ này là online chưa gắn tài xế → `Invalid`. Thử: hạ `credit_accounts.balance_vnd` của tài xế demo xuống 0 rồi quẹt `DEMO-CARD-0001` trên HMI → `Authorize` = `Blocked`.
