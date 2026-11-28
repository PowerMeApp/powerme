/**
 * Statistics of the home pages (screen 17 Operator, screen 27 Admin): the whole Operator or the
 * whole platform, not one station. Three requests, polled every minute:
 *   - T108 revenue by day over the last 30 days and last month (one span, at most 62 days) →
 *     today / 7 days / this month / last month with the change against the period before, the
 *     revenue per day and the sessions per day;
 *   - T108 revenue of this month by station (Operator) or by Operator (Admin) → the top 5;
 *   - fault stats of the last 30 days → faults per day by severity, by kind, the resolve time and
 *     the charge points with the most faults.
 * Colors (dataviz): revenue in one teal; severities in the status colors used everywhere
 * (red / amber / teal / grey) with a legend; the three fault kinds in a validated categorical set.
 * A block with nothing to show says so — never a chart of zeros (D36).
 */
import { AreaChart, BarChart } from '@mantine/charts';
import { SegmentedControl } from '@mantine/core';
import {
  IconAlertTriangle,
  IconBolt,
  IconChartBar,
  IconReportMoney,
  IconTrophy,
} from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { FaultKind, FaultStats, RevenueReport, RevenueRow } from '@powerme/shared';
import {
  errorMessage,
  useFaultStatsQuery,
  useRevenueQuery,
  type RevenueScope,
} from '../../core/api/api';
import { formatCount, formatDay, formatKwh, formatVnd } from '../revenue/revenueModel';
import {
  compactVnd,
  deltaPct,
  faultSeries,
  formatDuration,
  insightPeriods,
  revenueSeries,
  sumRange,
  type Span,
} from './insightsModel';
import { Section } from '../../ui/PageHeader';
import { Figure, StatCard } from '../../ui/StatCard';

export const INSIGHTS_POLL_MS = 60_000;
const POLL = { pollingInterval: INSIGHTS_POLL_MS, skipPollingIfUnfocused: true } as const;

/** Revenue series: one hue (the in-band teal of the validated set). */
const REVENUE_COLOR = '#00b39b';
const SESSIONS_COLOR = '#6b8cff';
/** Status colors (tokens.css): the same severity colors as badges and row accents. */
const SEVERITY_SERIES = [
  { name: 'critical', label: 'Nghiêm trọng', color: 'var(--danger)' },
  { name: 'major', label: 'Nặng', color: 'var(--warning)' },
  { name: 'minor', label: 'Nhẹ', color: 'var(--teal)' },
  { name: 'none', label: 'Khác', color: 'var(--muted)' },
];
/** Categorical, validated for dark mode on Graphite (L band, CVD ΔE ≥ 13). */
const KINDS: readonly (readonly [FaultKind, string, string])[] = [
  ['faulted', 'Trụ báo lỗi (OCPP)', '#00b39b'],
  ['offline', 'Mất kết nối', '#b98f25'],
  ['driver_report', 'Tài xế báo', '#6b8cff'],
];

const axis = {
  tickLine: 'none',
  gridAxis: 'y',
  strokeDasharray: '3 3',
  gridColor: 'var(--line-soft)',
  textColor: 'var(--muted)',
} as const;

export function HomeInsights({ scope }: { scope: RevenueScope }) {
  const p = insightPeriods();
  const byDay = useRevenueQuery({ scope, ...p.query, group_by: 'day' }, POLL);
  const topGroup = scope === 'operator' ? 'site' : 'operator';
  const top = useRevenueQuery({ scope, ...p.month, group_by: topGroup }, POLL);
  const faults = useFaultStatsQuery({ scope, ...p.trend }, POLL);
  const days = byDay.data?.group_by === 'day' ? byDay.data : undefined;
  const revenuePage = scope === 'operator' ? '/operator/revenue' : '/admin/revenue';

  return (
    <Section label="Doanh thu và sự cố" className="insights">
      <Status query={byDay} data={days}>
        {(d) => <RevenueKpis rows={d.rows} periods={p} to={revenuePage} />}
      </Status>
      <div className="insights-grid">
        {/* The KPI row above already says when this request failed. */}
        {days && (
          <>
            <RevenueTrend rows={days.rows} trend={p.trend} to={revenuePage} />
            <SessionsTrend rows={days.rows} trend={p.trend} />
          </>
        )}
        <Status query={top} data={top.data?.group_by === topGroup ? top.data : undefined}>
          {(d) => <TopRevenue report={d} scope={scope} month={p.month} />}
        </Status>
        <Status query={faults} data={faults.data}>
          {(d) => (
            <>
              <FaultTrend stats={d} trend={p.trend} scope={scope} />
              <FaultKinds stats={d} />
              <TopFaulty stats={d} scope={scope} />
            </>
          )}
        </Status>
      </div>
    </Section>
  );
}

/** Loading / error in place of a block; the block itself once its data is there. */
function Status<T>({
  query,
  data,
  children,
}: {
  query: { error?: unknown; isLoading: boolean };
  data: T | undefined;
  children: (data: T) => ReactNode;
}) {
  if (data) return <>{children(data)}</>;
  if (query.error)
    return (
      <p className="muted small" role="alert">
        Không tải được thống kê: {errorMessage(query.error)}
      </p>
    );
  return null;
}

function Delta({ cur, prev, against }: { cur: number; prev: number; against: string }) {
  const d = deltaPct(cur, prev);
  if (d === null) return <p className="muted small">Chưa có số liệu {against} để so sánh</p>;
  const arrow = d > 0 ? '▲' : d < 0 ? '▼' : '■';
  return (
    <p className="small delta" data-trend={d > 0 ? 'up' : d < 0 ? 'down' : 'flat'}>
      <span aria-hidden="true">{arrow}</span> {d > 0 ? '+' : ''}
      {d}% <span className="muted">so với {against}</span>
    </p>
  );
}

function RevenueKpis({
  rows,
  periods: p,
  to,
}: {
  rows: RevenueRow[];
  periods: ReturnType<typeof insightPeriods>;
  to: string;
}) {
  const cards: [string, Span, Span | null, string][] = [
    ['Hôm nay', p.today, p.yesterday, 'hôm qua'],
    ['7 ngày qua', p.week, p.prevWeek, '7 ngày trước đó'],
    ['Tháng này', p.month, p.monthBefore, 'cùng kỳ tháng trước'],
    ['Tháng trước', p.lastMonth, null, ''],
  ];
  return (
    <div className="tiles insight-kpis">
      {cards.map(([title, span, prev, against], i) => {
        const cur = sumRange(rows, span);
        const sessions = cur.csms_billed_session_count + cur.unattributed_session_count;
        return (
          <StatCard
            key={title}
            label={`Doanh thu ${title.toLowerCase()}`}
            title={title}
            icon={<IconReportMoney size={18} />}
            {...(i === 3 ? { to, linkText: 'Báo cáo doanh thu →' } : {})}
          >
            <Figure value={formatVnd(cur.csms_billed_revenue_vnd)} />
            <p className="muted small">
              {formatCount(sessions)} phiên ·{' '}
              {formatKwh(cur.csms_billed_energy_wh + cur.unattributed_energy_wh)}
              {span.from !== span.to && ` · ${formatDay(span.from)} – ${formatDay(span.to)}`}
            </p>
            {prev && (
              <Delta
                cur={cur.csms_billed_revenue_vnd}
                prev={sumRange(rows, prev).csms_billed_revenue_vnd}
                against={against}
              />
            )}
          </StatCard>
        );
      })}
    </div>
  );
}

/** The last 7 or 30 days of the trend span. */
function useRange(trend: Span) {
  const [n, setN] = useState('30');
  const span: Span = n === '7' ? { from: lastDays(trend.to, 7), to: trend.to } : trend;
  const control = (
    <SegmentedControl
      size="xs"
      value={n}
      onChange={setN}
      aria-label="Khoảng thời gian"
      data={[
        { value: '7', label: '7 ngày' },
        { value: '30', label: '30 ngày' },
      ]}
    />
  );
  return { span, control };
}
const lastDays = (to: string, n: number) =>
  new Date(Date.parse(`${to}T00:00:00Z`) - (n - 1) * 86_400_000).toISOString().slice(0, 10);

function RevenueTrend({ rows, trend, to }: { rows: RevenueRow[]; trend: Span; to: string }) {
  const { span, control } = useRange(trend);
  const data = revenueSeries(rows, span);
  const total = data.reduce((n, d) => n + d.revenue, 0);
  return (
    <StatCard
      label="Doanh thu theo ngày"
      icon={<IconChartBar size={18} />}
      wide
      to={to}
      linkText="Báo cáo doanh thu →"
    >
      <div className="chart-head">
        <p className="muted small">
          Tổng {formatVnd(total)} · {formatDay(span.from)} – {formatDay(span.to)}
        </p>
        {control}
      </div>
      {total === 0 ? (
        <p className="muted">Chưa có doanh thu trong khoảng này.</p>
      ) : (
        <AreaChart
          h={240}
          data={data}
          dataKey="label"
          series={[{ name: 'revenue', label: 'Doanh thu', color: REVENUE_COLOR }]}
          curveType="monotone"
          strokeWidth={2}
          fillOpacity={0.25}
          withDots={false}
          valueFormatter={formatVnd}
          yAxisProps={{ tickFormatter: compactVnd, width: 56 }}
          xAxisProps={{ minTickGap: 16 }}
          {...axis}
        />
      )}
    </StatCard>
  );
}

function SessionsTrend({ rows, trend }: { rows: RevenueRow[]; trend: Span }) {
  const { span, control } = useRange(trend);
  const data = revenueSeries(rows, span);
  const sessions = data.reduce((n, d) => n + d.sessions, 0);
  const kwh = data.reduce((n, d) => n + d.kwh, 0);
  return (
    <StatCard label="Phiên sạc theo ngày" icon={<IconBolt size={18} />}>
      <div className="chart-head">
        <p className="muted small">
          {formatCount(sessions)} phiên · {formatKwh(kwh * 1000)}
        </p>
        {control}
      </div>
      {sessions === 0 ? (
        <p className="muted">Chưa có phiên sạc nào trong khoảng này.</p>
      ) : (
        <BarChart
          h={200}
          data={data}
          dataKey="label"
          series={[{ name: 'sessions', label: 'Phiên sạc', color: SESSIONS_COLOR }]}
          valueFormatter={formatCount}
          maxBarWidth={18}
          barProps={{ radius: [4, 4, 0, 0] }}
          yAxisProps={{ allowDecimals: false, width: 32 }}
          xAxisProps={{ minTickGap: 16 }}
          {...axis}
        />
      )}
    </StatCard>
  );
}

/** Ranked list with a bar per row: names can link, long names wrap, values stay exact. */
function RankList({
  label,
  items,
}: {
  label: string;
  items: { key: string; name: ReactNode; sub?: ReactNode; value: number; text: string }[];
}) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <ol className="rank-list" aria-label={label}>
      {items.map((i) => (
        <li key={i.key}>
          <div className="rank-row">
            <span className="rank-name">
              {i.name}
              {i.sub && <span className="muted small"> · {i.sub}</span>}
            </span>
            <b className="nowrap">{i.text}</b>
          </div>
          <div className="rank-bar" aria-hidden="true">
            <span style={{ width: `${(i.value / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ol>
  );
}

function TopRevenue({
  report,
  scope,
  month,
}: {
  report: RevenueReport;
  scope: RevenueScope;
  month: Span;
}) {
  const rows = [...report.rows]
    .filter((r) => r.csms_billed_revenue_vnd > 0)
    .sort((a, b) => b.csms_billed_revenue_vnd - a.csms_billed_revenue_vnd)
    .slice(0, 5);
  const what = scope === 'operator' ? 'trạm sạc' : 'đơn vị vận hành';
  return (
    <StatCard label={`Top ${what} theo doanh thu`} icon={<IconTrophy size={18} />}>
      <p className="muted small">
        Tháng này · {formatDay(month.from)} – {formatDay(month.to)}
      </p>
      {rows.length === 0 ? (
        <p className="muted">Chưa có doanh thu trong tháng.</p>
      ) : (
        <RankList
          label={`Top ${what}`}
          items={rows.map((r) => ({
            key: r.key,
            name:
              scope === 'operator' && r.site_id ? (
                <Link to={`/operator/stations/${r.site_id}`}>{r.site_name ?? r.key}</Link>
              ) : (
                ((scope === 'operator' ? r.site_name : r.operator_name) ?? r.key)
              ),
            sub: `${formatCount(r.csms_billed_session_count)} phiên`,
            value: r.csms_billed_revenue_vnd,
            text: formatVnd(r.csms_billed_revenue_vnd),
          }))}
        />
      )}
    </StatCard>
  );
}

function FaultTrend({
  stats,
  trend,
  scope,
}: {
  stats: FaultStats;
  trend: Span;
  scope: RevenueScope;
}) {
  const { span, control } = useRange(trend);
  const data = faultSeries(stats.days, span);
  const shown = data.reduce((n, d) => n + d.critical + d.major + d.minor + d.none, 0);
  const t = stats.totals;
  return (
    <StatCard
      label="Sự cố theo ngày"
      icon={<IconAlertTriangle size={18} />}
      wide
      to={scope === 'operator' ? '/operator/faults' : '/admin/network'}
    >
      <div className="chart-head">
        <ul className="inline-stats" aria-label="Sự cố 30 ngày qua">
          <li>
            <b>{formatCount(t.raised)}</b> <span className="muted">phát sinh</span>
          </li>
          <li>
            <b>{formatCount(t.resolved)}</b> <span className="muted">đã xử lý xong</span>
          </li>
          <li>
            <b>
              {t.mean_time_to_resolve_s === null ? '—' : formatDuration(t.mean_time_to_resolve_s)}
            </b>{' '}
            <span className="muted">xử lý trung bình</span>
          </li>
        </ul>
        {control}
      </div>
      {shown === 0 ? (
        <p className="muted">Không có sự cố nào trong khoảng này.</p>
      ) : (
        <BarChart
          h={240}
          data={data}
          dataKey="label"
          type="stacked"
          series={SEVERITY_SERIES}
          withLegend
          legendProps={{ verticalAlign: 'bottom', height: 36 }}
          valueFormatter={formatCount}
          maxBarWidth={18}
          yAxisProps={{ allowDecimals: false, width: 32 }}
          xAxisProps={{ minTickGap: 16 }}
          {...axis}
        />
      )}
    </StatCard>
  );
}

function FaultKinds({ stats }: { stats: FaultStats }) {
  const total = stats.totals.raised;
  return (
    <StatCard label="Nguồn sự cố" title="Sự cố theo nguồn">
      <p className="muted small">30 ngày qua</p>
      {total === 0 ? (
        <p className="muted">Không có sự cố nào.</p>
      ) : (
        <>
          <div className="kind-bar" aria-hidden="true">
            {KINDS.filter(([k]) => stats.totals.by_kind[k] > 0).map(([k, , color]) => (
              <span key={k} style={{ flexGrow: stats.totals.by_kind[k], background: color }} />
            ))}
          </div>
          <ul className="kind-legend">
            {KINDS.map(([k, label, color]) => (
              <li key={k}>
                <span className="swatch" style={{ background: color }} aria-hidden="true" />
                <span>{label}</span>
                <b>{formatCount(stats.totals.by_kind[k])}</b>
                <span className="muted small">
                  {Math.round((stats.totals.by_kind[k] / total) * 100)}%
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </StatCard>
  );
}

function TopFaulty({ stats, scope }: { stats: FaultStats; scope: RevenueScope }) {
  const items = stats.top_charge_points;
  return (
    <StatCard label="Trụ sạc nhiều sự cố nhất">
      <p className="muted small">30 ngày qua</p>
      {items.length === 0 ? (
        <p className="muted">Không có sự cố nào.</p>
      ) : (
        <RankList
          label="Trụ sạc nhiều sự cố"
          items={items.map((c) => ({
            key: c.charge_point_id,
            name:
              scope === 'operator' ? (
                <Link to={`/operator/charge-points/${c.charge_point_id}`}>{c.serial_number}</Link>
              ) : (
                c.serial_number
              ),
            ...(c.station_name ? { sub: c.station_name } : {}),
            value: c.count,
            text: `${formatCount(c.count)} sự cố`,
          }))}
        />
      )}
    </StatCard>
  );
}
