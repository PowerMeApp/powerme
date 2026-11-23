/**
 * The connectors (súng) of one charge point: raw OCPP status (D21), Offline overriding it (D20),
 * error code when Faulted, "possibly out of date" when stale (D22, BR-P39), the session charging.
 * Shared by screen 18 and the station page.
 */
import type { OperatorChargePoint } from '@powerme/shared';
import { connectorTone } from './format';

export function ConnectorList({ cp }: { cp: OperatorChargePoint }) {
  if (cp.connectors.length === 0) return <span className="muted">—</span>;
  return (
    <ul className="connector-list">
      {cp.connectors.map((c) => (
        <li key={c.connector_id}>
          <span className="muted small">Súng {c.connector_no}</span>{' '}
          <span className={`pill ${connectorTone(c)}`}>
            {c.status_quality === 'offline' ? 'Offline' : c.status}
            {c.status === 'Faulted' && c.error_code ? ` · ${c.error_code}` : ''}
          </span>
          {c.status_quality === 'stale' && (
            <span className="muted small" title="Không có bản tin quá 2 nhịp Heartbeat">
              {' '}
              · có thể đã cũ
            </span>
          )}
          {c.active_session_id && (
            <span className="muted small"> · phiên {c.active_session_id}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Offline overrides every connector status (D20). */
export const isOffline = (cp: OperatorChargePoint) =>
  !cp.is_online || cp.connectors.some((c) => c.status_quality === 'offline');
