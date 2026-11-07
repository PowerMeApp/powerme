# BE-18 — STM-1: START_TIMEOUT, REMOTE_START_ACCEPTED, HARD_CAP_EXCEEDED, OPERATOR_RESOLVED

Đóng G2 của `DESIGN-BRIEF-WP2-INPUT.md`: ba chuyển STM-1 trước đây chưa có nơi kích hoạt. **Không đổi bảng chuyển** (`session-state-machine.ts`), không migration.

PR 1 (tài liệu này, phần 1–2): `REMOTE_START_ACCEPTED` (#1), `START_TIMEOUT` (#4), `HARD_CAP_EXCEEDED` (#16a).
PR 2 xếp tầng (phần 3): `OPERATOR_RESOLVED` (#17).

## 1. REMOTE_START_ACCEPTED / START_TIMEOUT (`pending`)

**`pending` không có dòng trong `sessions`.** `sessions` bắt buộc `meter_start_wh`/`cp_started_at`, chỉ có khi trụ gửi StartTransaction (đã ghi ở `onStartTransaction`: "pending belongs to the command intent"). Vì vậy `pending` = **intent `accepted` chưa có `session_id`** trong `driver_charge_intents`; dấu vết nằm ở `driver_charge_intent_events` (không phải `session_status_history`, vì bảng đó cần `session_id`). Đích của chuyển lấy từ bảng STM-1 (`apply(null,'REMOTE_START_ACCEPTED')`, `apply('pending','START_TIMEOUT')`), không viết cứng.

- **#1**: `recordDispatch` ghi event `REMOTE_START_ACCEPTED` (note `stm1 #1 ●→pending`) khi lệnh RemoteStart Accepted và intent đúng từ `sent` sang `accepted`.
- **#4**: `DriverChargingService.expireStaleStarts(timeoutS)`, gọi mỗi 10 s từ `ChargeRecoveryService.tick()` qua `SessionTimersService`. Intent `accepted`, `session_id IS NULL`, chưa nhả connector, lệnh `RemoteStartTransaction` ở trạng thái `accepted` và **`remote_commands.responded_at` cũ hơn `SESSION_START_TIMEOUT_S`** → `state='released'`, `reserved_vnd=0`, `connector_released_at=now()`, `rejection_reason='start_timeout'` (app đọc ra `outcome=start_timeout`), event `START_TIMEOUT`. Cùng hiệu ứng nhánh `rejected` của `recordDispatch` (hoàn giữ chỗ, nhả connector); khác ở trạng thái `released` vì trụ không từ chối.
- **Mốc đếm**: `responded_at` = lúc CSMS nhận Accepted = lúc vào `pending` (#1). Không dùng `sent_at` (gồm cả thời gian chờ trụ trả lời, tối đa `commandTimeoutMs`). T13 mục 1.3 khuyến nghị 120 s = `ConnectionTimeOut` + 30 s; đọc `ConnectionTimeOut` thật qua GetConfiguration vẫn chưa làm.
- **Chỉ `accepted`.** Intent `sent`/`unknown` (RemoteStart timeout, chưa biết trụ có chạy không) **không** tự nhả — nguyên tắc "uncertain never releases" của WP3; vẫn dùng `beginStartRecovery` (fence ChangeAvailability).
- **Chống trùng/đua**: chọn ứng viên, rồi mỗi intent `FOR UPDATE` + kiểm lại điều kiện trong transaction. StartTransaction đến trước → `session_id` đã có, bộ quét bỏ qua; đến sau → `onStartTransaction` vẫn nhận (intent còn khớp `id_tag`), đặt `billing_review_required` vì `connector_released_at` có giá trị và ghi `late_start_after_release` (đường T72 có sẵn, đã có test).
- Quét theo DB nên sống qua restart; không timer trong bộ nhớ.

## 2. HARD_CAP_EXCEEDED (#16a nhánh thứ hai)

`SessionTimersService.expireHardCapped()`: phiên `orphaned` quá `SESSION_HARD_CAP_H` → `review`. Mỗi phiên: `FOR UPDATE`, kiểm lại, `apply('orphaned','HARD_CAP_EXCEEDED')`, UPDATE `sessions`, một dòng `session_status_history` (`event=HARD_CAP_EXCEEDED`, `actor=system`, note `orphaned_since=… cap_h=…`), một `reconciliation_records` loại `conflict` với `resolution='hard_cap_exceeded: orphaned_since=… cap_h=… no_stop_transaction'` (hiện trong hàng đợi review; không ghi khi đối soát tắt — ablation G6, nhưng phiên vẫn sang `review`) và log JSON `session_hard_cap_exceeded`.

**Mốc đếm — CHỜ ÂN XÁC NHẬN.** Hàm riêng `orphanedSinceSql()` trong `session-timers.service.ts`; đổi mốc chỉ sửa hàm này.

| Phương án | Nhận xét |
| --- | --- |
| `sessions.orphaned_at` (đề xuất ban đầu của Trí) | Cột này giữ lần **đầu** sang orphaned và không đổi khi #18 orphaned→active. Phiên orphaned 30 h trước, sống lại, orphaned lại 1 phút trước sẽ bị hard cap ngay. |
| **Lần vào orphaned gần nhất** (đã chọn): `max(session_status_history.occurred_at)` với `to_status='orphaned'`, dự phòng `orphaned_at`, rồi `updated_at` | Đúng ý "orphaned quá 24 h" của bảng STM-1; ghi cùng transaction với UPDATE status nên khớp. |
| `started_at + 24 h` (đúng chữ T13 mục 1.3: "24 h kể từ `started_at`") | Phiên hợp lệ dài (không orphaned) cũng không bị ảnh hưởng, nhưng phiên mới orphaned 1 phút sau 23 h 59 sẽ bị đẩy sang review gần như ngay. Khác bảng STM-1 ("orphaned quá…"). |

Sau khi sang `review`, StopTransaction đến muộn của phiên đó đi `orphan_stop` (đường có sẵn cho phiên không còn mở) — operator xử lý bằng #17.

## Biến môi trường

| Biến | Mặc định | Ghi chú |
| --- | --- | --- |
| `SESSION_START_TIMEOUT_S` | 120 | số nguyên > 0; khởi động từ chối giá trị 0/âm/lẻ/không phải số |
| `SESSION_HARD_CAP_H` | 24 | số giờ > 0 (cho phép lẻ, vd `0.5`); từ chối 0/âm |

Đã có trong `infra/staging/.env.example` và truyền vào container `csms` ở `infra/staging/docker-compose.yml` (kiểm: `SESSION_START_TIMEOUT_S`, `SESSION_HARD_CAP_H`) — không cần sửa.

## Phương án bỏ

- Timer trong bộ nhớ (`setTimeout` theo phiên): mất khi restart.
- Tạo dòng `sessions` `pending` lúc RemoteStart Accepted: cần nới `NOT NULL` của `meter_start_wh`/`cp_started_at` (migration + ảnh hưởng mọi truy vấn "phiên mở") — to hơn nhiều so với G2.
- Thêm giá trị `intent.state='expired'`: cần migration CHECK; `released` + `rejection_reason` + event là đủ.
- Nhả cả intent `unknown`: trái nguyên tắc WP3.

## Giới hạn đã biết

- `ConnectionTimeOut` của trụ chưa được đọc; 120 s là cấu hình tĩnh.
- Intent kẹt `sent` (tiến trình chết giữa lúc gọi RPC) vẫn chưa được quét (như BE-17).
- Phiên hard cap chưa có StopTransaction: khi operator giải quyết (#17) sẽ không có gì để quyết toán (`received_stopped_at` rỗng).

## Cách kiểm

```
DATABASE_URL=…/powerme_test npm test -w @powerme/csms -- be18-hard-cap
DATABASE_URL=…/powerme_test npm test -w @powerme/csms -- wf01-driver-charging -t BE-18
npm test -w @powerme/csms -- config.spec
```
