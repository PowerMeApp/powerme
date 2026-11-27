/**
 * Screen 32 — Billing Exceptions (FE-09, UC-ADM-08, BR-P13, BR-P44), Admin only, on Khang's #212
 * routes (WF-02 D10): GET /api/admin/v1/billing/exceptions gives four work lists in one snapshot
 * (each ≤ 200 rows, no paging): late payments, e-invoices that need review, top-up exceptions,
 * payment conflicts. One tab each, kept in the URL (`?tab=`), with a count badge.
 * Actions (screen 33 sheets): retry an e-invoice; "Kiểm tra lại" then "Đã xem" on a top-up exception
 * (D10 order); resolve a payment conflict with a note. Refund actions and the customer-care refund
 * list come with T152 (manual refunds, D-AC).
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import type {
  InvoiceNeedsReviewItem,
  PaymentConflictItem,
  TopUpExceptionItem,
} from '@powerme/shared';
import { Breadcrumbs } from '../../components/Breadcrumbs';
import { CountBadge } from '../../components/CountBadge';
import { useBillingExceptionsQuery, useRecheckTopUpMutation } from '../../core/api/api';
import {
  ConflictReviewSheet,
  RetryInvoiceSheet,
  ReviewedSheet,
} from '../../features/billing/BillingSheets';
import {
  billingError,
  ERROR_KIND,
  EXCEPTION_KIND,
  recheckText,
  vnd,
  when,
} from '../../features/billing/format';

const TABS = [
  ['late', 'Trả muộn', 'late_payments'],
  ['invoices', 'Hoá đơn cần xem lại', 'invoices_needs_review'],
  ['exceptions', 'Ngoại lệ nạp tiền', 'top_up_exceptions'],
  ['conflicts', 'Trả mâu thuẫn', 'payment_conflicts'],
] as const;
type Tab = (typeof TABS)[number][0];
type Sheet =
  | { kind: 'retry'; item: InvoiceNeedsReviewItem }
  | { kind: 'reviewed'; item: TopUpExceptionItem }
  | { kind: 'conflict'; item: PaymentConflictItem };
type Note = { tone: 'ok' | 'error'; text: string } | null;

function Driver({ d }: { d: { full_name: string; phone_number: string | null } }) {
  return (
    <>
      {d.full_name}
      {d.phone_number && <div className="muted small">{d.phone_number}</div>}
    </>
  );
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="card table-card">
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              {head.map((h) => (
                <th key={h} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  );
}

export function BillingExceptionsPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = (TABS.find(([id]) => id === params.get('tab'))?.[0] ?? 'late') as Tab;
  const { data, error, isLoading } = useBillingExceptionsQuery(undefined, {
    pollingInterval: 30_000,
    skipPollingIfUnfocused: true,
  });
  const [recheck, r] = useRecheckTopUpMutation();
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [note, setNote] = useState<Note>(null);

  const switchTab = (next: Tab) => {
    setNote(null);
    setParams(
      (p) => {
        if (next === 'late') p.delete('tab');
        else p.set('tab', next);
        return p;
      },
      { replace: true },
    );
  };
  async function doRecheck(item: TopUpExceptionItem) {
    setNote(null);
    const res = await recheck(item.top_up_id);
    setNote(
      'error' in res
        ? { tone: 'error', text: billingError(res.error) }
        : { tone: 'ok', text: `Lần nạp #${item.top_up_id}: ${recheckText(res.data)}` },
    );
  }
  const done = (text: string) => {
    setSheet(null);
    setNote({ tone: 'ok', text });
  };
  const empty = <p className="muted">Không có mục nào.</p>;

  return (
    <>
      <Breadcrumbs items={[{ label: 'Ngoại lệ thanh toán' }]} />
      <div className="page-head">
        <h1>Ngoại lệ thanh toán</h1>
      </div>
      <div className="filters">
        <div className="queue-switch" role="group" aria-label="Danh sách">
          {TABS.map(([id, label, key]) => (
            <button
              key={id}
              type="button"
              className={`btn small ${tab === id ? '' : 'ghost'}`}
              aria-pressed={tab === id}
              onClick={() => switchTab(id)}
            >
              {label}
              <CountBadge count={data?.[key].total} label="mục" />
            </button>
          ))}
        </div>
      </div>
      {note && (
        <p className={`queue-note ${note.tone}`} role={note.tone === 'ok' ? 'status' : 'alert'}>
          {note.text}
        </p>
      )}
      {isLoading ? (
        <p className="muted">Đang tải…</p>
      ) : error && !data ? (
        <p role="alert">{billingError(error)}</p>
      ) : !data ? null : tab === 'late' ? (
        <>
          <p className="muted small">
            Khoản trả sau khi lần nạp đã hết hạn hoặc thất bại: không cộng vào ví, Admin hoàn lại số
            đã trả (BR-P13). Nút hoàn tiền có khi luồng hoàn tiền thủ công (T152) xong.
          </p>
          {data.late_payments.items.length === 0 ? (
            <div className="card">{empty}</div>
          ) : (
            <Table head={['Lần nạp', 'Tài xế', 'Số tiền trả muộn', 'Mã giao dịch', 'Lúc trả']}>
              {data.late_payments.items.map((l) => (
                <tr key={l.top_up_id} aria-label={`Trả muộn lần nạp #${l.top_up_id}`}>
                  <td>
                    <span className="cell-title">#{l.top_up_id}</span>
                    <div className="muted small">{l.gateway_reference}</div>
                  </td>
                  <td>
                    <Driver d={l.driver} />
                  </td>
                  <td className="nowrap">{vnd(l.late_amount_vnd)}</td>
                  <td>{l.late_gateway_ref}</td>
                  <td className="nowrap">{when(l.late_paid_at)}</td>
                </tr>
              ))}
            </Table>
          )}
        </>
      ) : tab === 'invoices' ? (
        data.invoices_needs_review.items.length === 0 ? (
          <div className="card">{empty}</div>
        ) : (
          <Table head={['Lần nạp', 'Tài xế', 'Số tiền', 'Lỗi nhà cung cấp', 'Số lần', 'Xử lý']}>
            {data.invoices_needs_review.items.map((i) => (
              <tr key={i.e_invoice_id} aria-label={`Hoá đơn lần nạp #${i.top_up_id}`}>
                <td className="cell-title">#{i.top_up_id}</td>
                <td>
                  <Driver d={i.driver} />
                </td>
                <td className="nowrap">{vnd(i.amount_vnd)}</td>
                <td className="small">
                  {i.last_error_kind && <b>{ERROR_KIND[i.last_error_kind]}: </b>}
                  {i.last_error_message ?? '—'}
                </td>
                <td>{i.attempt_count}</td>
                <td>
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => setSheet({ kind: 'retry', item: i })}
                  >
                    Thử lại
                  </button>
                </td>
              </tr>
            ))}
          </Table>
        )
      ) : tab === 'exceptions' ? (
        data.top_up_exceptions.items.length === 0 ? (
          <div className="card">{empty}</div>
        ) : (
          <Table head={['Lần nạp', 'Tài xế', 'Ngoại lệ', 'Số tiền', 'Xử lý']}>
            {data.top_up_exceptions.items.map((x) => (
              <tr key={x.top_up_id} aria-label={`Ngoại lệ lần nạp #${x.top_up_id}`}>
                <td>
                  <span className="cell-title">#{x.top_up_id}</span>
                  <div className="muted small">{x.gateway_reference}</div>
                </td>
                <td>
                  <Driver d={x.driver} />
                </td>
                <td className="small">{EXCEPTION_KIND[x.exception_kind]}</td>
                <td className="nowrap">{vnd(x.amount_paid_vnd)}</td>
                <td>
                  <div className="btn-row">
                    <button
                      type="button"
                      className="btn small"
                      disabled={r.isLoading}
                      onClick={() => void doRecheck(x)}
                    >
                      Kiểm tra lại
                    </button>
                    <button
                      type="button"
                      className="btn small ghost"
                      onClick={() => setSheet({ kind: 'reviewed', item: x })}
                    >
                      Đã xem
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )
      ) : data.payment_conflicts.items.length === 0 ? (
        <div className="card">{empty}</div>
      ) : (
        <Table head={['Lần nạp', 'Tài xế', 'Số tiền', 'Lý do', 'Lúc trả', 'Xử lý']}>
          {data.payment_conflicts.items.map((c) => (
            <tr key={c.conflict_id} aria-label={`Trả mâu thuẫn lần nạp #${c.top_up_id}`}>
              <td>
                <span className="cell-title">#{c.top_up_id}</span>
                <div className="muted small">{c.gateway_transaction_no}</div>
              </td>
              <td>
                <Driver d={c.driver} />
              </td>
              <td className="nowrap">{vnd(c.amount_vnd)}</td>
              <td className="small">{c.reason}</td>
              <td className="nowrap">{when(c.paid_at)}</td>
              <td>
                <button
                  type="button"
                  className="btn small"
                  onClick={() => setSheet({ kind: 'conflict', item: c })}
                >
                  Đã xử lý
                </button>
              </td>
            </tr>
          ))}
        </Table>
      )}
      {sheet?.kind === 'retry' && (
        <RetryInvoiceSheet item={sheet.item} onDone={done} onCancel={() => setSheet(null)} />
      )}
      {sheet?.kind === 'reviewed' && (
        <ReviewedSheet item={sheet.item} onDone={done} onCancel={() => setSheet(null)} />
      )}
      {sheet?.kind === 'conflict' && (
        <ConflictReviewSheet item={sheet.item} onDone={done} onCancel={() => setSheet(null)} />
      )}
    </>
  );
}
