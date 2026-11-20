/**
 * Revenue report (FE-07) shared by screen 25 Station Revenue (Operator, UC-OPS-09) and the revenue
 * part of screen 35 Transactions & Revenue (Admin, UC-ADM-10), on T108's
 * GET /api/{operator|admin}/v1/revenue[.csv] (Khang). BR-P46: revenue only counts `csms_billed`
 * sessions that are `reconciled`; unattributed sessions are a separate line without money; sessions
 * not yet reconciled (`pending_reconciliation`) or reconciled but not debited (`unsettled`) are
 * shown as notes, outside revenue. Rows only hold groups with sessions; by day, the empty days are
 * filled here. State lives in the URL (?from=&to=&group_by=&site_id|operator_id=&name=).
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import type { RevenueGroupBy, RevenueQuery, RevenueReport, RevenueRow } from '@powerme/shared';
import {
  errorMessage,
  useRevenueCsvMutation,
  useRevenueQuery,
  type RevenueScope,
} from '../../core/api/api';
import {
  defaultPeriod,
  fillDays,
  formatCount,
  formatGenerated,
  formatKwh,
  formatVnd,
  GROUP_LABEL,
  periodDays,
  reasonLabel,
  rowLabel,
} from './revenueModel';

interface ScopeConfig {
  groups: readonly RevenueGroupBy[];
  defaultGroup: RevenueGroupBy;
  /** The filter a drill-down sets, and the grouping that has it. */
  filter: 'site_id' | 'operator_id';
  drillFrom: RevenueGroupBy;
  drillTo: RevenueGroupBy;
}
const SCOPES: Record<RevenueScope, ScopeConfig> = {
  operator: {
    groups: ['charge_point', 'site', 'day'],
    defaultGroup: 'charge_point',
    filter: 'site_id',
    drillFrom: 'site',
    drillTo: 'charge_point',
  },
  admin: {
    groups: ['operator', 'site', 'charge_point', 'day'],
    defaultGroup: 'operator',
    filter: 'operator_id',
    drillFrom: 'operator',
    drillTo: 'site',
  },
};

/** CSV keeps its UTF-8 BOM so Excel reads Vietnamese (fetch's text() drops it). */
function saveCsv(text: string, filename: string) {
  const blob = new Blob([text.startsWith('﻿') ? text : `﻿${text}`], {
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

function Notes({ report }: { report: RevenueReport }) {
  const pending = report.pending_reconciliation.session_count;
  const unsettled = report.unsettled;
  const reasons = Object.entries(unsettled?.by_reason ?? {}).filter(([, n]) => n > 0);
  return (
    <ul className="revenue-notes">
      {pending > 0 && (
        <li>
          <b>{formatCount(pending)}</b> phiên chưa đối soát xong — chưa tính vào doanh thu, số có
          thể còn tăng.
        </li>
      )}
      {unsettled && unsettled.session_count > 0 && (
        <li>
          <b>{formatCount(unsettled.session_count)}</b> phiên đã đối soát nhưng chưa trừ tiền —
          không tính vào doanh thu
          {reasons.length > 0 &&
            `: ${reasons.map(([code, n]) => `${reasonLabel(code)} (${formatCount(n)})`).join(', ')}`}
          .
        </li>
      )}
      <li className="muted">
        Tính đến lúc {formatGenerated(report.generated_at)} — phiên đối soát muộn được tính vào kỳ
        của giờ sạc, nên số của kỳ cũ có thể đổi.
      </li>
    </ul>
  );
}

export function RevenueReportView({ scope }: { scope: RevenueScope }) {
  const cfg = SCOPES[scope];
  const [params, setParams] = useSearchParams();
  const period = defaultPeriod();
  const from = params.get('from') ?? period.from;
  const to = params.get('to') ?? period.to;
  const groupParam = params.get('group_by') as RevenueGroupBy | null;
  const groupBy = groupParam && cfg.groups.includes(groupParam) ? groupParam : cfg.defaultGroup;
  const filterId = params.get(cfg.filter);
  const filterName = params.get('name');
  const valid = periodDays(from, to) !== null;
  const query: RevenueQuery = {
    from,
    to,
    group_by: groupBy,
    ...(filterId ? { [cfg.filter]: filterId } : {}),
  };
  const { data, error, isFetching } = useRevenueQuery({ scope, ...query }, { skip: !valid });
  const [csv, csvState] = useRevenueCsvMutation();
  const [csvError, setCsvError] = useState<string | null>(null);
  const report = valid ? data : undefined;

  const update = (changes: Record<string, string | null>) =>
    setParams(
      (p) => {
        for (const [k, v] of Object.entries(changes)) {
          if (v === null || v === '') p.delete(k);
          else p.set(k, v);
        }
        return p;
      },
      { replace: true },
    );

  async function download() {
    setCsvError(null);
    const r = await csv({ scope, ...query });
    if ('error' in r) return setCsvError(errorMessage(r.error));
    const who = filterId ? `-${cfg.filter === 'site_id' ? 'tram' : 'operator'}-${filterId}` : '';
    saveCsv(r.data, `doanh-thu_${from}_${to}_${groupBy}${who}.csv`);
  }

  const rows: RevenueRow[] = report
    ? groupBy === 'day'
      ? fillDays(report.rows, report.from, report.to)
      : report.rows
    : [];
  const drill = groupBy === cfg.drillFrom && !filterId;

  return (
    <>
      <div className="filters revenue-filters">
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
            {cfg.groups.map((g) => (
              <option key={g} value={g}>
                {GROUP_LABEL[g]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn small revenue-csv"
          disabled={!report || csvState.isLoading}
          onClick={() => void download()}
        >
          {csvState.isLoading ? 'Đang tải CSV…' : 'Tải CSV'}
        </button>
      </div>
      {filterId && (
        <p className="revenue-filter">
          Đang xem:{' '}
          <b>{filterName ?? `${cfg.filter === 'site_id' ? 'Trạm' : 'Operator'} #${filterId}`}</b>{' '}
          <button
            type="button"
            className="btn small ghost"
            onClick={() => update({ [cfg.filter]: null, name: null, group_by: cfg.drillFrom })}
          >
            ‹ Bỏ lọc
          </button>
        </p>
      )}
      {csvError && <p role="alert">{csvError}</p>}
      {!valid ? (
        <p role="alert">
          Kỳ báo cáo không hợp lệ: ngày đầu phải trước ngày cuối và dài tối đa 366 ngày.
        </p>
      ) : !report && isFetching ? (
        <p className="muted">Đang tải…</p>
      ) : error && !report ? (
        <p role="alert">{errorMessage(error)}</p>
      ) : report ? (
        <>
          <Totals report={report} />
          <Notes report={report} />
          {rows.length === 0 ? (
            <div className="card">
              <p className="muted">Không có phiên nào trong kỳ.</p>
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
                    {rows.map((r) => {
                      const label = rowLabel(r, groupBy);
                      const empty =
                        r.csms_billed_session_count === 0 && r.unattributed_session_count === 0;
                      return (
                        <tr key={r.key} aria-label={label} className={empty ? 'muted' : undefined}>
                          <td>
                            {drill ? (
                              <button
                                type="button"
                                className="link-button"
                                onClick={() =>
                                  update({
                                    [cfg.filter]: r.key,
                                    name: label,
                                    group_by: cfg.drillTo,
                                  })
                                }
                              >
                                {label}
                              </button>
                            ) : (
                              label
                            )}
                            {groupBy === 'charge_point' && r.site_name && (
                              <div className="muted small">{r.site_name}</div>
                            )}
                            {scope === 'admin' && groupBy !== 'operator' && r.operator_name && (
                              <div className="muted small">{r.operator_name}</div>
                            )}
                          </td>
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
                      <th scope="row">Tổng</th>
                      <td className="revenue-num">
                        {formatCount(report.totals.csms_billed_session_count)}
                      </td>
                      <td className="revenue-num">
                        {formatKwh(report.totals.csms_billed_energy_wh)}
                      </td>
                      <td className="revenue-num">
                        {formatVnd(report.totals.csms_billed_revenue_vnd)}
                      </td>
                      <td className="revenue-num">
                        {formatCount(report.totals.unattributed_session_count)}
                      </td>
                      <td className="revenue-num">
                        {formatKwh(report.totals.unattributed_energy_wh)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}
        </>
      ) : null}
    </>
  );
}
