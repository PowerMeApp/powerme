/**
 * Transaction list of screen 35 Transactions & Revenue (Admin, UC-ADM-10), on T108b's
 * GET /api/admin/v1/transactions and transactions.csv (Khang, contract §4.1). One row is one stopped
 * session. The period is the `from` / `to` of the revenue report above it (same URL parameters), so
 * both parts always show the same period; the list's own filters (Operator, kind, origin) live in
 * the URL as `tx_operator`, `tx_kind`, `tx_origin`. Paged by the server; the totals line covers the
 * whole filtered set. Admin has no station / charge point pages yet, so names are plain text.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import type {
  TransactionKind,
  TransactionOrigin,
  TransactionQuery,
  TransactionRow,
} from '@powerme/shared';
import {
  errorMessage,
  TRANSACTION_PAGE_SIZE,
  useAdminTransactionsCsvMutation,
  useAdminTransactionsQuery,
  useRevenueQuery,
} from '../../core/api/api';
import {
  defaultPeriod,
  formatCount,
  formatGenerated,
  formatKwh,
  formatVnd,
  periodDays,
  reasonLabel,
} from './revenueModel';
import { saveCsv } from './saveCsv';

export const KIND_LABEL: Record<TransactionKind, string> = {
  csms_billed: 'Đã tính tiền',
  unsettled: 'Chưa trừ tiền',
  pending_reconciliation: 'Chờ đối soát',
  unattributed: 'Không định danh',
};
export const ORIGIN_LABEL: Record<TransactionOrigin, string> = {
  app_qr: 'Ứng dụng (QR)',
  rfid: 'Thẻ RFID',
  hmi_password: 'Mật khẩu trên trụ',
  free_vend: 'Sạc miễn phí',
};
const KINDS = Object.keys(KIND_LABEL) as TransactionKind[];
const ORIGINS = Object.keys(ORIGIN_LABEL) as TransactionOrigin[];

function KindCell({ row }: { row: TransactionRow }) {
  return (
    <td>
      <span className={`tx-kind tx-kind-${row.kind}`}>{KIND_LABEL[row.kind] ?? row.kind}</span>
      {row.kind === 'unsettled' && row.unsettled_reason && (
        <div className="muted small">
          {row.unsettled_reason === 'ineligible'
            ? 'Chưa đủ điều kiện trừ tiền'
            : reasonLabel(row.unsettled_reason)}
        </div>
      )}
    </td>
  );
}

export function TransactionList() {
  const [params, setParams] = useSearchParams();
  const period = defaultPeriod();
  const from = params.get('from') ?? period.from;
  const to = params.get('to') ?? period.to;
  const valid = periodDays(from, to) !== null;
  const operatorId = params.get('tx_operator') ?? '';
  const kindParam = params.get('tx_kind') as TransactionKind | null;
  const kind = kindParam && KINDS.includes(kindParam) ? kindParam : undefined;
  const originParam = params.get('tx_origin') as TransactionOrigin | null;
  const origin = originParam && ORIGINS.includes(originParam) ? originParam : undefined;
  const query: TransactionQuery = {
    from,
    to,
    ...(operatorId ? { operator_id: operatorId } : {}),
    ...(kind ? { kind } : {}),
    ...(origin ? { origin } : {}),
  };

  // Back to page 1 whenever the period or a filter changes (also from the revenue filters above).
  const filterKey = JSON.stringify(query);
  const [paging, setPaging] = useState({ key: filterKey, page: 1 });
  const page = paging.key === filterKey ? paging.page : 1;
  const setPage = (p: number) => setPaging({ key: filterKey, page: p });

  const { data, error, isFetching } = useAdminTransactionsQuery(
    { ...query, page },
    { skip: !valid },
  );
  // Operators of the period for the filter: same request as the revenue report "by Operator".
  const { data: byOperator } = useRevenueQuery(
    { scope: 'admin', from, to, group_by: 'operator' },
    { skip: !valid },
  );
  const operators = (byOperator?.rows ?? []).filter((r) => r.operator_id);
  const [csv, csvState] = useAdminTransactionsCsvMutation();
  const [exportError, setExportError] = useState<string | null>(null);

  const update = (changes: Record<string, string>) =>
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

  async function download() {
    setExportError(null);
    const r = await csv(query);
    if ('error' in r) return setExportError(errorMessage(r.error));
    saveCsv(r.data, `transactions_${from}_${to}.csv`);
  }

  // A stale response for another page or filter is not shown.
  const current = valid && data && data.page === page ? data : undefined;
  const pages = current ? Math.max(1, Math.ceil(current.total / TRANSACTION_PAGE_SIZE)) : 1;
  const first = (page - 1) * TRANSACTION_PAGE_SIZE;

  return (
    <section className="transactions" aria-labelledby="transactions-title">
      <div className="page-head">
        <h2 id="transactions-title">Danh sách giao dịch</h2>
        <p>Mỗi dòng là một phiên sạc đã dừng trong kỳ đã chọn ở trên</p>
      </div>
      <section className="card revenue-filters" aria-label="Lọc giao dịch">
        <label className="field">
          Đơn vị vận hành
          <select
            className="input"
            value={operatorId}
            onChange={(e) => update({ tx_operator: e.target.value })}
          >
            <option value="">Tất cả</option>
            {operators.map((o) => (
              <option key={o.operator_id} value={o.operator_id!}>
                {o.operator_name ?? o.operator_id}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Loại
          <select
            className="input"
            value={kind ?? ''}
            onChange={(e) => update({ tx_kind: e.target.value })}
          >
            <option value="">Tất cả</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Nguồn
          <select
            className="input"
            value={origin ?? ''}
            onChange={(e) => update({ tx_origin: e.target.value })}
          >
            <option value="">Tất cả</option>
            {ORIGINS.map((o) => (
              <option key={o} value={o}>
                {ORIGIN_LABEL[o]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn small revenue-export"
          disabled={!valid || csvState.isLoading}
          onClick={() => void download()}
        >
          {csvState.isLoading ? 'Đang tải tệp…' : 'Tải tệp giao dịch (CSV)'}
        </button>
      </section>
      {exportError && <p role="alert">{exportError}</p>}
      {!valid ? null : !current && isFetching ? (
        <p className="muted">Đang tải…</p>
      ) : error && !current ? (
        <p role="alert">{errorMessage(error)}</p>
      ) : current ? (
        current.total === 0 ? (
          <div className="card">
            <p className="muted">Không có giao dịch nào khớp bộ lọc trong kỳ.</p>
          </div>
        ) : (
          <div className="card table-card">
            <p className="muted small tx-summary" aria-label="Tổng giao dịch">
              {formatCount(current.total)} phiên · đã tính tiền{' '}
              {formatCount(current.totals.csms_billed_session_count)} phiên,{' '}
              {formatKwh(current.totals.csms_billed_energy_wh)},{' '}
              {formatVnd(current.totals.csms_billed_revenue_vnd)} · tính đến{' '}
              {formatGenerated(current.generated_at)}
            </p>
            <div className="table-wrap">
              <table className="data-table revenue-table">
                <thead>
                  <tr>
                    <th scope="col">Phiên</th>
                    <th scope="col">Thời điểm</th>
                    <th scope="col">Đơn vị vận hành</th>
                    <th scope="col">Trạm · trụ sạc</th>
                    <th scope="col">Nguồn</th>
                    <th scope="col">Loại</th>
                    <th scope="col" className="revenue-num">
                      Năng lượng
                    </th>
                    <th scope="col" className="revenue-num">
                      Số tiền
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {current.items.map((r) => (
                    <tr key={r.session_id} aria-label={`Phiên #${r.session_id}`}>
                      <td>
                        <span className="cell-title">#{r.session_id}</span>
                        {r.delivered_offline && (
                          <div className="muted small">Trụ gửi bù sau khi nối lại</div>
                        )}
                      </td>
                      <td>{formatGenerated(r.period_at)}</td>
                      <td>{r.operator_name}</td>
                      <td>
                        <span className="cell-title">{r.site_name}</span>
                        <div className="muted small">
                          {r.serial_number} · Súng {r.connector_no}
                        </div>
                      </td>
                      <td>{ORIGIN_LABEL[r.origin] ?? r.origin}</td>
                      <KindCell row={r} />
                      <td className="revenue-num">
                        {r.energy_wh === null ? (
                          <span className="muted">Thiếu số đo</span>
                        ) : (
                          formatKwh(r.energy_wh)
                        )}
                      </td>
                      <td className="revenue-num">
                        {r.amount_vnd === null ? '—' : formatVnd(r.amount_vnd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <nav className="pager" aria-label="Phân trang giao dịch">
              <span className="muted">
                Hiển thị {first + 1}–{first + current.items.length} / {current.total} · Trang {page}{' '}
                / {pages}
              </span>
              <div className="btn-row">
                <button
                  type="button"
                  className="btn small ghost"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  ‹ Trước
                </button>
                <button
                  type="button"
                  className="btn small ghost"
                  disabled={page >= pages}
                  onClick={() => setPage(page + 1)}
                >
                  Sau ›
                </button>
              </div>
            </nav>
          </div>
        )
      ) : null}
    </section>
  );
}
