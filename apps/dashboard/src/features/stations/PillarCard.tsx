/**
 * Thẻ trụ: HAI súng hiện trạng thái ĐỘC LẬP trong cùng một thẻ (ràng buộc của apps/dashboard
 * README — gộp thành một trạng thái là sai mô hình; M3).
 */
import { Link } from 'react-router';
import { ConnectorPill, Pill } from '../../components/ui';
import type { Pillar } from '../../types/domain';
import { formatKwh, timeAgo } from '../../utils/format';

const LIFECYCLE: Record<
  Pillar['lifecycle'],
  { label: string; tone: 'teal' | 'gold' | 'muted' | 'danger' }
> = {
  registered: { label: 'Đã đăng ký', tone: 'muted' },
  awaiting_connection: { label: 'Chờ kết nối', tone: 'gold' },
  in_service: { label: 'Đang hoạt động', tone: 'teal' },
  disabled: { label: 'Tạm ngưng', tone: 'danger' },
  decommissioned: { label: 'Đã gỡ', tone: 'muted' },
};

export function PillarCard({ pillar }: { pillar: Pillar }) {
  const lc = LIFECYCLE[pillar.lifecycle];
  return (
    <Link
      to={`/operator/pillars/${pillar.id}`}
      className="card pillar-card"
      aria-label={`Trụ ${pillar.displayCode}`}
    >
      <div className="pillar-head">
        <span className="code">{pillar.displayCode}</span>
        <span className="mono muted">{pillar.serial}</span>
        <span className="ml">
          {pillar.isOnline ? <Pill tone="teal">Online</Pill> : <Pill tone="danger">Offline</Pill>}
        </span>
      </div>
      <div className="muted" style={{ fontSize: 13 }}>
        {pillar.model} · {pillar.siteName} · <Pill tone={lc.tone}>{lc.label}</Pill>
      </div>
      <div className="connectors">
        {pillar.connectors.map((c) => (
          <div className="connector" key={c.connectorNo} data-testid={`connector-${c.connectorNo}`}>
            <span className="gun">Súng {c.connectorNo === 1 ? 'A' : 'B'}</span>
            <ConnectorPill status={c.status} />
            <span className="meta">
              {c.activeSession
                ? `#${c.activeSession.transactionNo} · ${formatKwh(c.activeSession.energyWh)}`
                : c.errorCode && c.errorCode !== 'NoError'
                  ? c.errorCode
                  : `từ ${timeAgo(c.statusChangedAt)}`}
            </span>
          </div>
        ))}
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        Bản tin cuối: {timeAgo(pillar.lastSeenAt)}
      </div>
    </Link>
  );
}
