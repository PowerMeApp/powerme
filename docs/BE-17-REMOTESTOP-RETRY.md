# BE-17 — RemoteStop timeout: gửi lại có giới hạn

**Code của Sơn (WP3, `driver-charging.service.ts`) — cần Sơn review.** Không đổi STM-1, không migration.

## Lỗ hổng
`RemoteStopTransaction` timeout → `recordDispatch` ghi `driver_stop_intents.state='unknown'`, `remote_commands.status='timeout'` (`error='outcome_unknown'`), phiên giữ `stopping`. Không có gì gửi lại; chỉ operator (`recoverStop`, cần bằng chứng meter mới) mới cứu được.

## Quyết định
- `DriverChargingService.retryUnknownStops()` gọi từ `ChargeRecoveryService.tick()` (10 s). Trạng thái nằm hoàn toàn trong DB nên sống qua restart.
- Ứng viên: intent `unknown` + lệnh cuối `timeout`/`outcome_unknown` + phiên `stopping` chưa có StopTransaction, và `remote_commands.updated_at` cũ hơn `REMOTE_STOP_RETRY_INTERVAL_S` (mặc định 30 s).
- Mỗi lần gửi lại: khoá `sessions` `FOR UPDATE`, kiểm lại điều kiện, kiểm trụ online và epoch socket khớp `charge_points.current_epoch`, tạo `remote_commands` mới + `driver_stop_attempts` kind `auto_retry` (đã có trong CHECK của migration 0007; `previous_command_id` UNIQUE chặn trùng với operator recovery) trên cùng intent. Gửi qua `dispatch()` có sẵn (callConcurrency=1, `expectedEpoch`).
- Kết quả đi qua `recordDispatch` như cũ: Accepted → intent `accepted`, chờ StopTransaction; Rejected → STM-1 `stopping --REMOTE_STOP_REJECTED--> active`; timeout → `unknown` lại, đếm lượt kế. StopTransaction đến → phiên rời `stopping` nên không còn là ứng viên. Trụ offline/epoch đổi → bỏ qua (không tốn lượt).
- Tối đa `REMOTE_STOP_RETRY_MAX` (mặc định 3) lần gửi lại (đếm attempt `auto_retry` mà lệnh trước đó là `timeout`; `0` = tắt). Hết lượt: phiên vẫn `stopping`, intent vẫn `unknown`; lệnh cuối nhận `error='stop_retry_exhausted'` (một lần) + log JSON `remote_stop_retry_exhausted` (`sessionId`, `intentId`, `commandId`). Operator vẫn dùng `recoverStop`.
- Vì sao gửi lại an toàn: RemoteStop lên giao dịch đã dừng trả `Rejected` (không tác dụng phụ), nhánh Rejected đã được `recordDispatch` xử lý.

## Phương án bỏ
- Hạ phiên về `active` khi hết lượt: kết quả chưa biết, trái nguyên tắc "uncertain never releases".
- Thêm cột/trạng thái intent `exhausted`: cần migration; dùng `remote_commands.error` + log là đủ cho vận hành.
- Timer trong bộ nhớ: mất khi restart.

## Giới hạn đã biết
- Intent kẹt `sent` (tiến trình chết giữa lúc gọi RPC) chưa được quét — ngoài phạm vi.
- Lượt `auto_retry` do nhánh Rejected-có-bằng-chứng-meter (đã có) không tính vào hạn mức.

## Cách kiểm
`DATABASE_URL=…/powerme_test npm test -w @powerme/csms -- wf01-driver-charging -t BE-17` (7 ca) và `-- charge-policy`.
