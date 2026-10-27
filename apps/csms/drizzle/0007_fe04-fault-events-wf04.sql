-- =============================================================================
-- PowerMe CSMS — migration 0007_fe04-fault-events-wf04 (WF-04 xử lý lỗi trụ, FE-04, WP4)
--
-- Migration VIẾT TAY (ADR-0008), áp LÊN DB đã có 0000 … 0002. Schema Drizzle
-- (apps/csms/src/db/schema/ops.ts) phải khớp từng cột với file này.
--
-- Vì sao số 0007: các nhánh WP3 đang mở đã dùng 0003–0006 (T31, T72, station search, stop
-- attempts). Helper `migrate` áp mọi file CHƯA có trong `_migrations` theo thứ tự tên, nên 0007 lên
-- main trước hay sau 0003–0006 đều áp được; hai nhóm không đụng cùng bảng.
--
-- Nội dung:
--   A. fault_events.reset_command_id → remote_commands(id), null được. STM-6 `resetting` cần biết
--      lệnh Reset nào đang chờ để (a) hết hạn chờ chỉ áp cho đúng lệnh đó, (b) kết quả CALLRESULT
--      của lệnh cũ tới muộn không làm sai sự cố mới, (c) quét khởi động dựng lại hẹn giờ từ
--      remote_commands.requested_at (hẹn giờ trong RAM mất khi CSMS chết).
--   B. Chỉ MỘT sự cố mở cho mỗi connector (bất biến của WF-04 / STM-6). Connector 0 = cả trụ
--      (connector_id null) nên dùng COALESCE(connector_id, 0) trong chỉ mục. FaultService đã khoá
--      dòng bằng SELECT … FOR UPDATE; chỉ mục này là rào cuối ở DB.
--
-- Không thêm giá trị enum nên cả file nằm trong một transaction.
-- Áp dụng: node apps/csms/scripts/migrate.mjs (hoặc helper test/helpers/apply-migrations.ts).
-- =============================================================================

BEGIN;

ALTER TABLE fault_events
  ADD COLUMN reset_command_id bigint REFERENCES remote_commands (id);

COMMENT ON COLUMN fault_events.reset_command_id IS
  'Lệnh Reset đang chờ khi status = resetting (STM-6 t4); giữ lại sau đó để truy vết.';

CREATE UNIQUE INDEX fault_events_one_open_per_connector_key
  ON fault_events (charge_point_id, COALESCE(connector_id, 0))
  WHERE status <> 'resolved';

COMMIT;
