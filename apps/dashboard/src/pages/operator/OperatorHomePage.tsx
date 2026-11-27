/**
 * Screen 17 — Operator Dashboard (hub, UC-OPS-02/03). Greeting from /me, then the Operator's counts
 * from GET /api/operator/v1/summary (FE-03): charge points online / offline, connectors grouped as
 * the driver app sees them (BR-P38), open faults by severity, and the work queues. A tile only
 * shows when it has something to say — never a placeholder 0 (D36). Polled every 5 s (D5).
 */
import { Link } from 'react-router';
import { CountBadge } from '../../components/CountBadge';
import type { OperatorSummary } from '@powerme/shared';
import { errorMessage, useOperatorMeQuery, useOperatorSummaryQuery } from '../../core/api/api';

export const SUMMARY_POLL_MS = 5000;

const CONNECTOR_GROUPS: [keyof OperatorSummary['connectors'], string, string][] = [
  ['available', 'Sẵn sàng', ''],
  ['in_use', 'Đang sạc', ''],
  ['freeing_soon', 'Sắp trống', ''],
  ['unavailable', 'Không dùng được', 'major'],
  ['offline', 'Mất kết nối', 'muted'],
];
const SEVERITIES: [keyof OperatorSummary['open_faults'], string, string][] = [
  ['critical', 'Nghiêm trọng', 'critical'],
  ['major', 'Nặng', 'major'],
  ['minor', 'Nhẹ', ''],
  ['none', 'Khác', 'muted'],
];

function Tile({
  title,
  children,
  to,
  urgent,
}: {
  title: string;
  children: React.ReactNode;
  to?: string;
  /** Pending work: red border, shown first. */
  urgent?: boolean;
}) {
  return (
    <section className={`card tile${urgent ? ' tile-urgent' : ''}`} aria-label={title}>
      <h2>{title}</h2>
      {children}
      {to && (
        <Link className="tile-link" to={to}>
          Xem chi tiết →
        </Link>
      )}
    </section>
  );
}

export function OperatorHomePage() {
  const me = useOperatorMeQuery();
  const summary = useOperatorSummaryQuery(undefined, {
    pollingInterval: SUMMARY_POLL_MS,
    skipPollingIfUnfocused: true,
  });
  const s = summary.data;
  const queues = s
    ? (
        [
          [s.sessions_to_review, 'phiên cần xem lại (đối soát)', '/operator/sessions?queue=review'],
          [s.unattributed_sessions, 'phiên chưa gắn tài xế', '/operator/sessions'],
          [s.uncertain_starts, 'lệnh bắt đầu chưa rõ kết quả', null],
        ] as const
      ).filter(([n]) => n > 0)
    : [];

  return (
    <>
      <div className="page-head">
        <h1>Tổng quan vận hành</h1>
        {me.data && <p>{me.data.operator_name}</p>}
      </div>
      <div className="card">
        {me.isLoading && <p className="muted">Đang tải…</p>}
        {me.error && <p role="alert">{errorMessage(me.error)}</p>}
        {me.data && (
          <p>
            Xin chào {me.data.full_name}. Bạn đang xem dữ liệu của Operator{' '}
            <b>{me.data.operator_name}</b>.
          </p>
        )}
      </div>
      {summary.error && !s && <p role="alert">{errorMessage(summary.error)}</p>}
      {s && (
        <div className="tiles">
          {queues.length > 0 && (
            <Tile title="Việc cần xử lý" urgent>
              <ul className="tile-list">
                {queues.map(([n, label, to]) => (
                  <li key={label}>
                    <CountBadge count={n} label={label} />{' '}
                    {to ? <Link to={to}>{label}</Link> : label}
                  </li>
                ))}
              </ul>
            </Tile>
          )}
          {s.charge_points.total > 0 ? (
            <Tile title="Trụ sạc" to="/operator/charge-points">
              <p className="tile-number">
                {s.charge_points.online}
                <span className="muted"> / {s.charge_points.total} đang kết nối</span>
              </p>
              {s.charge_points.offline > 0 && (
                <span className="pill muted">{s.charge_points.offline} mất kết nối</span>
              )}
            </Tile>
          ) : (
            <Tile title="Trụ sạc">
              <p className="muted">Đơn vị vận hành chưa có trụ sạc nào.</p>
            </Tile>
          )}
          {s.charge_points.total > 0 && (
            <Tile title="Súng sạc" to="/operator/charge-points">
              <ul className="tile-list">
                {CONNECTOR_GROUPS.filter(([k]) => s.connectors[k] > 0).map(([k, label, tone]) => (
                  <li key={k}>
                    <span className={`pill ${tone}`}>{label}</span> <b>{s.connectors[k]}</b>
                  </li>
                ))}
              </ul>
            </Tile>
          )}
          <Tile title="Cảnh báo sự cố" to="/operator/faults">
            {s.open_faults.total > 0 ? (
              <>
                <p className="tile-number">{s.open_faults.total} đang mở</p>
                <ul className="tile-list">
                  {SEVERITIES.filter(([k]) => s.open_faults[k] > 0).map(([k, label, tone]) => (
                    <li key={k}>
                      <span className={`pill ${tone}`}>{label}</span> <b>{s.open_faults[k]}</b>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="muted">Không có sự cố đang mở.</p>
            )}
          </Tile>
        </div>
      )}
    </>
  );
}
