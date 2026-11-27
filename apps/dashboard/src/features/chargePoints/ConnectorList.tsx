/**
 * The connectors (súng) of one charge point: raw OCPP status (D21), Offline overriding it (D20),
 * error code when Faulted, "possibly out of date" when stale (D22, BR-P39), the session charging.
 * Shared by screen 18 and the station page.
 */
import type { OperatorChargePoint } from '@powerme/shared';
import { StatusBadge } from '../../ui/StatusBadge';
import { onlineBadge } from '../../ui/tones';
import { ago, connectorTone, statusLabel } from './format';

export function ConnectorList({ cp }: { cp: OperatorChargePoint }) {
  if (cp.connectors.length === 0) return <span className="muted">—</span>;
  return (
    <ul className="connector-list">
      {cp.connectors.map((c) => (
        <li key={c.connector_id}>
          <span className="muted small">Súng {c.connector_no}</span>
          <StatusBadge tone={connectorTone(c)} title={c.status}>
            {c.status_quality === 'offline' ? 'Mất kết nối' : statusLabel(c.status)}
            {c.status === 'Faulted' && c.error_code ? ` · ${c.error_code}` : ''}
          </StatusBadge>
          {c.status_quality === 'stale' && (
            <span className="muted small" title="Không có bản tin quá 2 nhịp báo sống">
              · có thể đã cũ
            </span>
          )}
          {c.active_session_id && (
            <span className="muted small">· phiên {c.active_session_id}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Online / offline badge with "last seen" under it (screens 18, 31 and the station page). */
export function OnlineCell({ cp, now }: { cp: OperatorChargePoint; now: number }) {
  const [label, tone] = onlineBadge(isOffline(cp));
  return (
    <>
      <StatusBadge tone={tone}>{label}</StatusBadge>
      <div className="muted small">{ago(cp.last_message_at, now)}</div>
    </>
  );
}

/** Offline overrides every connector status (D20). */
export const isOffline = (cp: OperatorChargePoint) =>
  !cp.is_online || cp.connectors.some((c) => c.status_quality === 'offline');
