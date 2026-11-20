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
  hint: 'Serial hoặc ID trụ',
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
          label: 'Tìm Operator',
          hint: 'Tên hoặc ID Operator',
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

/** CSV keeps its UTF-8 BOM so Excel reads Vietnamese (fetch's text() drops it). */
function saveCsv(text: string, filename: string) {
  const blob = new Blob([text.startsWith('\uFEFF') ? text : `\uFEFF${text}`], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const GROUPS: Record<RevenueScope, readonly RevenueGroupBy[]> = {
  operator: ['charge_point', 'site', 'day'],
  admin: ['operator', 'site', 'charge_point', 'day'],
};

function Totals({ report }: { report: RevenueReport }) {
  const t = report.totals;
  return (
    <div className="tiles revenue-tiles">
      <section className="card tile" aria-label="Doanh thu">
        <h2>Doanh thu</h2>
        <p className="tile-number">{formatVnd(t.csms_billed_revenue_vnd)}</p>
        <p className="muted small">Phiên đã đối soát và đã trừ tiền (BR-P46)</p>
      </section>
      <section className="card tile" aria-label="Phiên tính tiền">
        <h2>Phiên tính tiền</h2>
        <p className="tile-number">{formatCount(t.csms_billed_session_count)}</p>
        <p className="muted small">{formatKwh(t.csms_billed_energy_wh)}</p>
      </section>
      <section className="card tile" aria-label="Phiên không định danh">
        <h2>Phiên không định danh</h2>
        <p className="tile-number">{formatCount(t.unattributed_session_count)}</p>
        <p className="muted small">{formatKwh(t.unattributed_energy_wh)} · không tính tiền</p>
      </section>
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
    <td>
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
    </td>
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
      <section className="card revenue-filters" aria-label="Bộ lọc">
        <label className="field">
          Từ ngày
          <input
            className="input"
            type="date"
            value={from}
            max={to}
            onChange={(e) => update({ from: e.target.value })}
          />
        </label>
        <label className="field">
          Đến ngày
          <input
            className="input"
            type="date"
            value={to}
            min={from}
            onChange={(e) => update({ to: e.target.value })}
          />
        </label>
        <label className="field">
          Nhóm theo
          <select
            className="input"
            value={groupBy}
            onChange={(e) => update({ group_by: e.target.value })}
          >
            {groups.map((g) => (
              <option key={g} value={g}>
                {GROUP_LABEL[g]}
              </option>
            ))}
          </select>
        </label>
        {fields.map((f) => (
          <label key={f.param} className="field search-field">
            {f.label}
            <input
              className="input"
              type="search"
              value={params.get(f.param) ?? ''}
              maxLength={MAX_SEARCH}
              placeholder={f.hint}
              onChange={(e) => update({ [f.param]: e.target.value })}
            />
          </label>
        ))}
        <button
          type="button"
          className="btn small revenue-export"
          disabled={!current || csvState.isLoading}
          onClick={() => void download()}
        >
          {csvState.isLoading ? 'Đang tải CSV…' : 'Tải CSV'}
        </button>
      </section>
      {exportError && <p role="alert">{exportError}</p>}
      {!valid ? (
        <p role="alert">
          Kỳ báo cáo không hợp lệ: ngày đầu phải trước ngày cuối và dài tối đa 366 ngày.
        </p>
      ) : !current && isFetching ? (
        <p className="muted">Đang tải…</p>
      ) : error && !current ? (
        <p role="alert">{errorMessage(error)}</p>
      ) : current ? (
        <>
          <Totals report={current} />
          {rows.length === 0 ? (
            <div className="card">
              <p className="muted">
                {allRows.length > 0 && searching
                  ? 'Không có dòng nào khớp ô tìm kiếm.'
                  : 'Không có phiên nào trong kỳ.'}
              </p>
            </div>
          ) : (
            <div className="card table-card">
              <div className="table-wrap">
                <table className="data-table revenue-table">
                  <thead>
                    <tr>
                      <th scope="col">{GROUP_LABEL[groupBy]}</th>
                      <th scope="col" className="revenue-num">
                        Phiên tính tiền
                      </th>
                      <th scope="col" className="revenue-num">
                        Năng lượng
                      </th>
                      <th scope="col" className="revenue-num">
                        Doanh thu
                      </th>
                      <th scope="col" className="revenue-num">
                        Phiên không định danh
                      </th>
                      <th scope="col" className="revenue-num">
                        Năng lượng không định danh
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((r) => {
                      const empty =
                        r.csms_billed_session_count === 0 && r.unattributed_session_count === 0;
                      return (
                        <tr
                          key={r.key}
                          aria-label={rowLabel(r, groupBy)}
                          className={empty ? 'muted' : undefined}
                        >
                          <NameCell row={r} groupBy={groupBy} scope={scope} />
                          <td className="revenue-num">
                            {formatCount(r.csms_billed_session_count)}
                          </td>
                          <td className="revenue-num">{formatKwh(r.csms_billed_energy_wh)}</td>
                          <td className="revenue-num">{formatVnd(r.csms_billed_revenue_vnd)}</td>
                          <td className="revenue-num">
                            {formatCount(r.unattributed_session_count)}
                          </td>
                          <td className="revenue-num">{formatKwh(r.unattributed_energy_wh)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr aria-label="Tổng">
                      <th scope="row">Tổng cả kỳ</th>
                      <td className="revenue-num">
                        {formatCount(current.totals.csms_billed_session_count)}
                      </td>
                      <td className="revenue-num">
                        {formatKwh(current.totals.csms_billed_energy_wh)}
                      </td>
                      <td className="revenue-num">
                        {formatVnd(current.totals.csms_billed_revenue_vnd)}
                      </td>
                      <td className="revenue-num">
                        {formatCount(current.totals.unattributed_session_count)}
                      </td>
                      <td className="revenue-num">
                        {formatKwh(current.totals.unattributed_energy_wh)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <nav className="pager" aria-label="Phân trang">
                <span className="muted">
                  Hiển thị {first + 1}–{first + pageRows.length} / {rows.length}
                  {rows.length < allRows.length && ` (lọc từ ${allRows.length})`}
                </span>
                <div className="btn-row">
                  <button
                    type="button"
                    className="btn small ghost"
                    disabled={shownPage <= 1}
                    onClick={() => setPage(shownPage - 1)}
                  >
                    ‹ Trước
                  </button>
                  <span className="pager-page">
                    Trang {shownPage} / {pages}
                  </span>
                  <button
                    type="button"
                    className="btn small ghost"
                    disabled={shownPage >= pages}
                    onClick={() => setPage(shownPage + 1)}
                  >
                    Sau ›
                  </button>
                </div>
              </nav>
            </div>
          )}
        </>
      ) : null}
    </>
  );
}
