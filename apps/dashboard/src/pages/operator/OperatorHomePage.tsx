/**
 * Screen 17 — Operator Dashboard (hub, UC-OPS-02/03). Greeting from /me, then the Operator's counts
 * from GET /api/operator/v1/summary (FE-03): charge points online / offline, connectors grouped as
 * the driver app sees them (BR-P38), open faults by severity, and the work queues. A card only
 * shows when it has something to say — never a placeholder 0 (D36). Polled every 5 s (D5).
 *
 * Layout (redesign): what needs someone comes first and looks like an alert — the work queues and
 * the open faults are red / amber alert cards at the start of the grid; when there is nothing to
 * do, a teal "all clear" line says so. The status cards follow.
 */
import { Alert, Loader } from '@mantine/core';
import { IconCircleCheck, IconPlug, IconBolt } from '@tabler/icons-react';
import { Link } from 'react-router';
import type { OperatorSummary } from '@powerme/shared';
import { CountBadge } from '../../components/CountBadge';
import { errorMessage, useOperatorMeQuery, useOperatorSummaryQuery } from '../../core/api/api';
import { CountList } from '../../ui/CountList';
import { Notice } from '../../ui/Notice';
import { PageHeader } from '../../ui/PageHeader';
import { Figure, StatCard } from '../../ui/StatCard';
import { StatusBadge } from '../../ui/StatusBadge';

export const SUMMARY_POLL_MS = 5000;

const CONNECTOR_GROUPS = [
  ['available', 'Sẵn sàng', ''],
  ['in_use', 'Đang sạc', ''],
  ['freeing_soon', 'Sắp trống', ''],
  ['unavailable', 'Không dùng được', 'major'],
  ['offline', 'Mất kết nối', 'muted'],
] as const satisfies readonly (readonly [keyof OperatorSummary['connectors'], string, string])[];
const SEVERITIES = [
  ['critical', 'Nghiêm trọng', 'critical'],
  ['major', 'Nặng', 'major'],
  ['minor', 'Nhẹ', ''],
  ['none', 'Khác', 'muted'],
] as const satisfies readonly (readonly [keyof OperatorSummary['open_faults'], string, string])[];

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
  const faultTone =
    s && s.open_faults.critical > 0
      ? 'critical'
      : s && s.open_faults.major > 0
        ? 'major'
        : undefined;
  const allClear = s && queues.length === 0 && s.open_faults.total === 0;

  return (
    <>
      <PageHeader
        title="Tổng quan vận hành"
        subtitle={
          me.isLoading ? (
            'Đang tải…'
          ) : me.error ? (
            <span role="alert">{errorMessage(me.error)}</span>
          ) : me.data ? (
            <>
              Xin chào {me.data.full_name}. Bạn đang xem dữ liệu của Operator{' '}
              <b>{me.data.operator_name}</b>.
            </>
          ) : null
        }
      />
      {summary.isLoading && <Loader size="sm" aria-label="Đang tải số liệu" />}
      {summary.error && !s && <Notice tone="error">{errorMessage(summary.error)}</Notice>}
      {allClear && (
        <Alert
          className="all-clear"
          color="teal"
          variant="light"
          role="note"
          icon={<IconCircleCheck size={20} aria-hidden="true" />}
        >
          Không có việc chờ xử lý và không có sự cố đang mở.
        </Alert>
      )}
      {s && (
        <div className="tiles">
          {queues.length > 0 && (
            <StatCard label="Việc cần xử lý" tone="critical" urgent wide>
              <ul className="work-list">
                {queues.map(([n, label, to]) => (
                  <li key={label}>
                    <CountBadge count={n} label={label} size="lg" />
                    {to ? <Link to={to}>{label}</Link> : <span>{label}</span>}
                  </li>
                ))}
              </ul>
            </StatCard>
          )}
          <StatCard
            label="Cảnh báo sự cố"
            tone={faultTone}
            urgent={!!faultTone}
            to="/operator/faults"
          >
            {s.open_faults.total > 0 ? (
              <>
                <Figure value={`${s.open_faults.total} đang mở`} />
                <CountList rows={SEVERITIES} values={s.open_faults} />
              </>
            ) : (
              <p className="muted">Không có sự cố đang mở.</p>
            )}
          </StatCard>
          {s.charge_points.total > 0 ? (
            <StatCard label="Trụ sạc" icon={<IconPlug size={18} />} to="/operator/charge-points">
              <Figure
                value={s.charge_points.online}
                note={`/ ${s.charge_points.total} đang kết nối`}
              />
              {s.charge_points.offline > 0 && (
                <div>
                  <StatusBadge tone="muted">{s.charge_points.offline} mất kết nối</StatusBadge>
                </div>
              )}
            </StatCard>
          ) : (
            <StatCard label="Trụ sạc" icon={<IconPlug size={18} />}>
              <p className="muted">Đơn vị vận hành chưa có trụ sạc nào.</p>
            </StatCard>
          )}
          {s.charge_points.total > 0 && (
            <StatCard label="Súng sạc" icon={<IconBolt size={18} />} to="/operator/charge-points">
              <CountList rows={CONNECTOR_GROUPS} values={s.connectors} />
            </StatCard>
          )}
        </div>
      )}
    </>
  );
}
