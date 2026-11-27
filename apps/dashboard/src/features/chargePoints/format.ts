/** Labels and formatting shared by screens 18 and 20 (FE-03, FE-05). */
import { useEffect, useState } from 'react';
import type { ChargePointLifecycle, ConnectorLive, OfflineCardRiskReason } from '@powerme/shared';

/**
 * Vietnamese label of each raw OCPP 1.6 connector status; the raw value stays in the tooltip for
 * technicians (D21).
 */
export const CONNECTOR_STATUS: Record<string, string> = {
  Available: 'Sẵn sàng',
  Preparing: 'Đang chuẩn bị',
  Charging: 'Đang sạc',
  SuspendedEV: 'Xe tạm dừng',
  SuspendedEVSE: 'Trụ tạm dừng',
  Finishing: 'Đang kết thúc',
  Reserved: 'Đã đặt chỗ',
  Unavailable: 'Không dùng được',
  Faulted: 'Lỗi',
};
export const statusLabel = (s: string) => CONNECTOR_STATUS[s] ?? s;

export const LIFECYCLE: Record<ChargePointLifecycle, string> = {
  registered: 'Đã đăng ký',
  awaiting_connection: 'Chờ kết nối',
  in_service: 'Đang hoạt động',
  disabled: 'Tạm ngừng',
  decommissioned: 'Đã gỡ',
};

/**
 * T150 / BR-P52: why the CSMS could not confirm that the charge point stopped authorising cards on
 * its own while offline (a blocked or unknown card could then charge and leave a shortfall).
 */
export const OFFLINE_CARD_RISK: Record<OfflineCardRiskReason, string> = {
  not_checked:
    'chưa kiểm cấu hình thẻ khi mất kết nối (trụ chưa khởi động lại từ khi có bước kiểm)',
  no_response: 'trụ không trả lời lệnh đọc / đổi cấu hình',
  key_missing: 'trụ không có mục cấu hình thẻ khi mất kết nối',
  rejected: 'trụ từ chối tắt chấp nhận thẻ khi mất kết nối',
  not_supported: 'trụ không cho đổi cấu hình thẻ khi mất kết nối',
  reboot_required: 'trụ cần khởi động lại để tắt chấp nhận thẻ khi mất kết nối',
  change_failed: 'lệnh tắt chấp nhận thẻ khi mất kết nối bị lỗi',
};

/** Pill tone for a connector's raw OCPP status; Offline overrides it (D20). */
export function connectorTone(c: ConnectorLive): string {
  if (c.status_quality === 'offline') return 'muted';
  if (c.status === 'Faulted') return 'critical';
  if (c.status === 'Unavailable' || c.status === 'Reserved') return 'major';
  return '';
}

/** "12 s", "5 phút", "3 giờ" ago — D22 "last seen". */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return 'chưa từng kết nối';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s trước`;
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
  return `${Math.floor(s / 86400)} ngày trước`;
}

/** Re-renders every `ms` so "… ago" keeps counting between polls. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
