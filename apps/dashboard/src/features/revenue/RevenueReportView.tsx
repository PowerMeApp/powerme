/**
 * Revenue report (FE-07) shared by screen 25 Station Revenue (Operator, UC-OPS-09), the revenue
 * part of screen 35 Transactions & Revenue (Admin, UC-ADM-10) and the station page, on T108's
 * GET /api/{operator|admin}/v1/revenue (Khang). BR-P46: revenue only counts `csms_billed`
 * sessions that are `reconciled`; unattributed sessions are a separate line without money; sessions
 * not yet reconciled (`pending_reconciliation`) or reconciled but not debited (`unsettled`) are
 * shown as notes, outside revenue. Rows only hold groups with sessions; by day, the empty days are
 * filled here.
 *
 * Layout (Nghĩa 20/11): filter card on top → totals → table, paged here (the API returns
 * every group at once), with the period total on every page. Names link to their own pages
 * (operator scope): trụ sạc → screen 20, trạm sạc → station page. Export: T108's revenue.csv with
 * the same query (SRS UC-ADM-10). Period and grouping live in the URL (?from=&to=&group_by=).
 */
import { Button, Card, Group, Loader, NativeSelect, Table, TextInput } from '@mantine/core';
import { IconDownload, IconSearch } from '@tabler/icons-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { RevenueGroupBy, RevenueQuery, RevenueReport, RevenueRow } from '@powerme/shared';
import {
  errorMessage,
  useRevenueCsvMutation,
  useRevenueQuery,
  type RevenueScope,
} from '../../core/api/api';
import { matchesSearch, MAX_SEARCH } from '../../core/search/search';
import {
  defaultPeriod,
  fillDays,
  formatCount,
  formatDay,
  formatKwh,
  formatVnd,
  GROUP_LABEL,
  periodDays,
  rowLabel,
} from './revenueModel';
import { saveCsv } from './saveCsv';
import { DataTable, EmptyState } from '../../ui/DataTable';
import { Notice } from '../../ui/Notice';
import { Pager } from '../../ui/Pager';
import { Figure, StatCard } from '../../ui/StatCard';

export const REVENUE_PAGE_SIZE = 20;

/** One search box of the filter card: its URL parameter and the row values it looks in. */
interface SearchField {
  param: 'cp_search' | 'site_search' | 'search';
  label: string;
  hint: string;
  values: (r: RevenueRow) => (string | null)[];
}
const CP_SEARCH: SearchField = {
  param: 'cp_search',
  label: 'Tìm trụ sạc',
  hint: 'Số seri hoặc ID trụ',
  values: (r) => [r.serial_number, r.charge_point_id],
};
const SITE_SEARCH: SearchField = {
  param: 'site_search',
  label: 'Tìm trạm sạc',
  hint: 'Tên hoặc ID trạm',
  values: (r) => [r.site_name, r.site_id],
};
/**
 * Separate boxes for charge points and stations (Nghĩa 20/11). On the station page the report is
 * already one station, so only the charge point box.
 */
function searchFields(groupBy: RevenueGroupBy, inStation: boolean): SearchField[] {
  switch (groupBy) {
    case 'charge_point':
      return inStation ? [CP_SEARCH] : [CP_SEARCH, SITE_SEARCH];
    case 'site':
      return [SITE_SEARCH];
    case 'operator':
      return [
        {
          param: 'search',
          label: 'Tìm đơn vị vận hành',
          hint: 'Tên hoặc ID đơn vị vận hành',
          values: (r) => [r.operator_name, r.operator_id],
        },
      ];
    case 'day':
      return [
        {
          param: 'search',
          label: 'Tìm ngày',
          hint: 'Ví dụ 05/11',
          values: (r) => [r.day ? formatDay(r.day) : null, r.day],
        },
      ];
  }
}

const GROUPS: Record<RevenueScope, readonly RevenueGroupBy[]> = {
  operator: ['charge_point', 'site', 'day'],
  admin: ['operator', 'site', 'charge_point', 'day'],
};

function Totals({ report }: { report: RevenueReport }) {
  const t = report.totals;
  return (
    <div className="tiles revenue-tiles">
      <StatCard label="Doanh thu">
        <Figure value={formatVnd(t.csms_billed_revenue_vnd)} />
        <p className="muted small">Từ các phiên đã đối soát và đã trừ tiền</p>
      </StatCard>
      <StatCard label="Phiên tính tiền">
        <Figure value={formatCount(t.csms_billed_session_count)} />
        <p className="muted small">{formatKwh(t.csms_billed_energy_wh)}</p>
      </StatCard>
      <StatCard label="Phiên không định danh">
        <Figure value={formatCount(t.unattributed_session_count)} />
        <p className="muted small">{formatKwh(t.unattributed_energy_wh)} · không tính tiền</p>
      </StatCard>
    </div>
  );
}

/** Name cell: a link to the item's own page when there is one (operator scope only). */
function NameCell({
  row,
  groupBy,
  scope,
}: {
  row: RevenueRow;
  groupBy: RevenueGroupBy;
  scope: RevenueScope;
}) {
  const label = rowLabel(row, groupBy);
  // Admin has no station / charge point pages yet (screen 29 not built): names stay plain text.
  const linkable = scope === 'operator';
  const station =
    row.site_id && row.site_name ? (
      linkable ? (
        <Link to={`/operator/stations/${row.site_id}`}>{row.site_name}</Link>
      ) : (
        row.site_name
      )
    ) : null;
  return (
    <Table.Td>
      {groupBy === 'charge_point' && linkable && row.charge_point_id ? (
        <Link className="cell-title" to={`/operator/charge-points/${row.charge_point_id}`}>
          {label}
        </Link>
      ) : groupBy === 'site' && linkable && row.site_id ? (
        <Link className="cell-title" to={`/operator/stations/${row.site_id}`}>
          {label}
        </Link>
      ) : (
        <span className="cell-title">{label}</span>
      )}
      {groupBy === 'charge_point' && station && <div className="muted small">{station}</div>}
      {scope === 'admin' && groupBy !== 'operator' && row.operator_name && (
        <div className="muted small">{row.operator_name}</div>
      )}
    </Table.Td>
  );
}

export function RevenueReportView({
  scope,
  siteId,
}: {
  scope: RevenueScope;
  /** Station page: the report of this station only (operator scope); no "by station" grouping. */
  siteId?: string;
}) {
  const groups = siteId ? GROUPS[scope].filter((g) => g !== 'site') : GROUPS[scope];
  const [params, setParams] = useSearchParams();
  const period = defaultPeriod();
  const from = params.get('from') ?? period.from;
  const to = params.get('to') ?? period.to;
  const groupParam = params.get('group_by') as RevenueGroupBy | null;
  const groupBy = groupParam && groups.includes(groupParam) ? groupParam : groups[0]!;
  const valid = periodDays(from, to) !== null;
  /** Client-side search over every row of the period (the API returns all groups at once). */
  const fields = searchFields(groupBy, Boolean(siteId));
  const searching = fields.some((f) => (params.get(f.param) ?? '').trim());
  const query: RevenueQuery = {
    from,
    to,
    group_by: groupBy,
    ...(siteId ? { site_id: siteId } : {}),
  };
  const { data, error, isFetching } = useRevenueQuery({ scope, ...query }, { skip: !valid });
  const report = valid ? data : undefined;
  const [page, setPage] = useState(1);
  const [csv, csvState] = useRevenueCsvMutation();
  const [exportError, setExportError] = useState<string | null>(null);

  const update = (changes: Record<string, string>) => {
    setPage(1);
    setParams(
      (p) => {
        for (const [k, v] of Object.entries(changes)) {
          if (v) p.set(k, v);
          else p.delete(k);
        }
        return p;
      },
      { replace: true },
    );
  };

  async function download() {
    setExportError(null);
    const r = await csv({ scope, ...query });
    if ('error' in r) return setExportError(errorMessage(r.error));
    saveCsv(r.data, `doanh-thu_${from}_${to}_${groupBy}${siteId ? `-tram-${siteId}` : ''}.csv`);
  }

  // Rows of the report actually shown (a stale response for other parameters is not shown).
  const current = report && report.group_by === groupBy ? report : undefined;
  const allRows: RevenueRow[] = current
    ? groupBy === 'day'
      ? fillDays(current.rows, current.from, current.to)
      : current.rows
    : [];
  const rows = allRows.filter((r) =>
    fields.every((f) => matchesSearch(params.get(f.param) ?? '', f.values(r))),
  );
  const pages = Math.max(1, Math.ceil(rows.length / REVENUE_PAGE_SIZE));
  const shownPage = Math.min(page, pages);
  const first = (shownPage - 1) * REVENUE_PAGE_SIZE;
  const pageRows = rows.slice(first, first + REVENUE_PAGE_SIZE);

  return (
    <>
      <Card component="section" className="revenue-filters" aria-label="Bộ lọc" padding="md">
        <Group gap="sm" align="flex-end" wrap="wrap" className="filters">
          <TextInput
            label="Từ ngày"
            type="date"
            value={from}
            max={to}
            onChange={(e) => update({ from: e.currentTarget.value })}
          />
          <TextInput
            label="Đến ngày"
            type="date"
            value={to}
            min={from}
            onChange={(e) => update({ to: e.currentTarget.value })}
          />
          <NativeSelect
            className="select-field"
            label="Nhóm theo"
            value={groupBy}
            onChange={(e) => update({ group_by: e.currentTarget.value })}
            data={groups.map((g) => ({ value: g, label: GROUP_LABEL[g] }))}
          />
          {fields.map((f) => (
            <TextInput
              key={f.param}
              className="search-field"
              label={f.label}
              type="search"
              value={params.get(f.param) ?? ''}
              maxLength={MAX_SEARCH}
              placeholder={f.hint}
              leftSection={<IconSearch size={16} aria-hidden="true" />}
              onChange={(e) => update({ [f.param]: e.currentTarget.value })}
            />
          ))}
          <Button
            type="button"
            variant="default"
            className="revenue-export"
            leftSection={<IconDownload size={16} aria-hidden="true" />}
            disabled={!current || csvState.isLoading}
            onClick={() => void download()}
          >
            {csvState.isLoading ? 'Đang tải tệp…' : 'Tải tệp bảng tính (CSV)'}
          </Button>
        </Group>
      </Card>
      {exportError && <Notice tone="error">{exportError}</Notice>}
      {!valid ? (
        <Notice tone="error">
          Kỳ báo cáo không hợp lệ: ngày đầu phải trước ngày cuối và dài tối đa 366 ngày.
        </Notice>
      ) : !current && isFetching ? (
        <Loader size="sm" aria-label="Đang tải…" />
      ) : error && !current ? (
        <Notice tone="error">{errorMessage(error)}</Notice>
      ) : current ? (
        <>
          <Totals report={current} />
          {rows.length === 0 ? (
            <EmptyState>
              {allRows.length > 0 && searching
                ? 'Không có dòng nào khớp ô tìm kiếm.'
                : 'Không có phiên nào trong kỳ.'}
            </EmptyState>
          ) : (
            <DataTable
              className="revenue-card"
              minWidth={860}
              footer={
                <Pager
                  first={first + 1}
                  last={first + pageRows.length}
                  total={rows.length}
                  note={rows.length < allRows.length ? `(lọc từ ${allRows.length})` : undefined}
                  page={shownPage}
                  pages={pages}
                  onPage={setPage}
                />
              }
            >
              <Table.Thead>
                <Table.Tr>
                  <Table.Th scope="col">{GROUP_LABEL[groupBy]}</Table.Th>
                  <Table.Th scope="col" className="revenue-num">
                    Phiên tính tiền
                  </Table.Th>
                  <Table.Th scope="col" className="revenue-num">
                    Năng lượng
                  </Table.Th>
                  <Table.Th scope="col" className="revenue-num">
                    Doanh thu
                  </Table.Th>
                  <Table.Th scope="col" className="revenue-num">
                    Phiên không định danh
                  </Table.Th>
                  <Table.Th scope="col" className="revenue-num">
                    Năng lượng không định danh
                  </Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {pageRows.map((r) => {
                  const empty =
                    r.csms_billed_session_count === 0 && r.unattributed_session_count === 0;
                  return (
                    <Table.Tr
                      key={r.key}
                      aria-label={rowLabel(r, groupBy)}
                      className={empty ? 'muted' : undefined}
                    >
                      <NameCell row={r} groupBy={groupBy} scope={scope} />
                      <Table.Td className="revenue-num">
                        {formatCount(r.csms_billed_session_count)}
                      </Table.Td>
                      <Table.Td className="revenue-num">
                        {formatKwh(r.csms_billed_energy_wh)}
                      </Table.Td>
                      <Table.Td className="revenue-num">
                        {formatVnd(r.csms_billed_revenue_vnd)}
                      </Table.Td>
                      <Table.Td className="revenue-num">
                        {formatCount(r.unattributed_session_count)}
                      </Table.Td>
                      <Table.Td className="revenue-num">
                        {formatKwh(r.unattributed_energy_wh)}
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
              <Table.Tfoot>
                <Table.Tr aria-label="Tổng">
                  <Table.Th scope="row">Tổng cả kỳ</Table.Th>
                  <Table.Td className="revenue-num">
                    {formatCount(current.totals.csms_billed_session_count)}
                  </Table.Td>
                  <Table.Td className="revenue-num">
                    {formatKwh(current.totals.csms_billed_energy_wh)}
                  </Table.Td>
                  <Table.Td className="revenue-num">
                    {formatVnd(current.totals.csms_billed_revenue_vnd)}
                  </Table.Td>
                  <Table.Td className="revenue-num">
                    {formatCount(current.totals.unattributed_session_count)}
                  </Table.Td>
                  <Table.Td className="revenue-num">
                    {formatKwh(current.totals.unattributed_energy_wh)}
                  </Table.Td>
                </Table.Tr>
              </Table.Tfoot>
            </DataTable>
          )}
        </>
      ) : null}
    </>
  );
}
