/** Labels and formatting shared by screens 18 and 20 (FE-03, FE-05). */
import { useEffect, useState } from 'react';
import type { ChargePointLifecycle, ConnectorLive, OfflineCardRiskReason } from '@powerme/shared';

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
  not_checked: 'chưa kiểm cấu hình thẻ offline (trụ chưa khởi động lại từ khi có bước kiểm)',
  no_response: 'trụ không trả lời GetConfiguration / ChangeConfiguration',
  key_missing: 'trụ không có key cấu hình thẻ offline',
  rejected: 'trụ từ chối tắt authorize offline (Rejected)',
  not_supported: 'trụ không cho đổi key cấu hình thẻ offline (NotSupported)',
  reboot_required: 'trụ cần khởi động lại để tắt authorize offline',
  change_failed: 'lệnh tắt authorize offline lỗi',
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
