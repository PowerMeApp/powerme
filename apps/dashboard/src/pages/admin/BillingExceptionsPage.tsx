/**
 * Screen 32 — Billing Exceptions (FE-09, UC-ADM-08, BR-P13, BR-P44), Admin only, on Khang's #212
 * routes (WF-02 D10): GET /api/admin/v1/billing/exceptions gives four work lists in one snapshot
 * (each ≤ 200 rows, no paging): late payments, e-invoices that need review, top-up exceptions,
 * payment conflicts. One tab each, kept in the URL (`?tab=`), with a count badge.
 * Actions (screen 33 sheets): retry an e-invoice; "Kiểm tra lại" then "Đã xem" on a top-up exception
 * (D10 order); resolve a payment conflict with a note. Refund actions and the customer-care refund
 * list come with T152 (manual refunds, D-AC).
 */
import { Button, Group, Loader, Table } from '@mantine/core';
import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import type {
  InvoiceNeedsReviewItem,
  PaymentConflictItem,
  TopUpExceptionItem,
} from '@powerme/shared';
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
import { DataTable, EmptyState } from '../../ui/DataTable';
import { Notice, type Note } from '../../ui/Notice';
import { PageHeader } from '../../ui/PageHeader';
import { QueueSwitch } from '../../ui/QueueSwitch';

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

function Driver({ d }: { d: { full_name: string; phone_number: string | null } }) {
  return (
    <>
      {d.full_name}
      {d.phone_number && <div className="muted small">{d.phone_number}</div>}
    </>
  );
}

function ListTable({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <DataTable minWidth={820}>
      <Table.Thead>
        <Table.Tr>
          {head.map((h) => (
            <Table.Th key={h} scope="col">
              {h}
            </Table.Th>
          ))}
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>{children}</Table.Tbody>
    </DataTable>
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
  const empty = <EmptyState>Không có mục nào.</EmptyState>;

  return (
    <>
      <PageHeader crumbs={[{ label: 'Ngoại lệ thanh toán' }]} title="Ngoại lệ thanh toán" />
      <QueueSwitch
        label="Danh sách"
        value={tab}
        onChange={switchTab}
        items={TABS.map(([key, label, total]) => ({
          key,
          label,
          count: data?.[total].total,
          countLabel: 'mục',
        }))}
      />
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      {isLoading ? (
        <Loader size="sm" aria-label="Đang tải…" />
      ) : error && !data ? (
        <Notice tone="error">{billingError(error)}</Notice>
      ) : !data ? null : tab === 'late' ? (
        <>
          <p className="muted small">
            Khoản trả sau khi lần nạp đã hết hạn hoặc thất bại: không cộng vào ví, Admin hoàn lại số
            đã trả (BR-P13). Nút hoàn tiền có khi luồng hoàn tiền thủ công (T152) xong.
          </p>
          {data.late_payments.items.length === 0 ? (
            empty
          ) : (
            <ListTable head={['Lần nạp', 'Tài xế', 'Số tiền trả muộn', 'Mã giao dịch', 'Lúc trả']}>
              {data.late_payments.items.map((l) => (
                <Table.Tr
                  data-tone="major"
                  key={l.top_up_id}
                  aria-label={`Trả muộn lần nạp #${l.top_up_id}`}
                >
                  <Table.Td>
                    <span className="cell-title">#{l.top_up_id}</span>
                    <div className="muted small">{l.gateway_reference}</div>
                  </Table.Td>
                  <Table.Td>
                    <Driver d={l.driver} />
                  </Table.Td>
                  <Table.Td className="nowrap">{vnd(l.late_amount_vnd)}</Table.Td>
                  <Table.Td>{l.late_gateway_ref}</Table.Td>
                  <Table.Td className="nowrap">{when(l.late_paid_at)}</Table.Td>
                </Table.Tr>
              ))}
            </ListTable>
          )}
        </>
      ) : tab === 'invoices' ? (
        data.invoices_needs_review.items.length === 0 ? (
          empty
        ) : (
          <ListTable head={['Lần nạp', 'Tài xế', 'Số tiền', 'Lỗi nhà cung cấp', 'Số lần', 'Xử lý']}>
            {data.invoices_needs_review.items.map((i) => (
              <Table.Tr
                data-tone="major"
                key={i.e_invoice_id}
                aria-label={`Hoá đơn lần nạp #${i.top_up_id}`}
              >
                <Table.Td className="cell-title">#{i.top_up_id}</Table.Td>
                <Table.Td>
                  <Driver d={i.driver} />
                </Table.Td>
                <Table.Td className="nowrap">{vnd(i.amount_vnd)}</Table.Td>
                <Table.Td className="small">
                  {i.last_error_kind && <b>{ERROR_KIND[i.last_error_kind]}: </b>}
                  {i.last_error_message ?? '—'}
                </Table.Td>
                <Table.Td>{i.attempt_count}</Table.Td>
                <Table.Td>
                  <Button
                    type="button"
                    size="compact-sm"
                    variant="light"
                    onClick={() => setSheet({ kind: 'retry', item: i })}
                  >
                    Thử lại
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </ListTable>
        )
      ) : tab === 'exceptions' ? (
        data.top_up_exceptions.items.length === 0 ? (
          empty
        ) : (
          <ListTable head={['Lần nạp', 'Tài xế', 'Ngoại lệ', 'Số tiền', 'Xử lý']}>
            {data.top_up_exceptions.items.map((x) => (
              <Table.Tr
                data-tone="major"
                key={x.top_up_id}
                aria-label={`Ngoại lệ lần nạp #${x.top_up_id}`}
              >
                <Table.Td>
                  <span className="cell-title">#{x.top_up_id}</span>
                  <div className="muted small">{x.gateway_reference}</div>
                </Table.Td>
                <Table.Td>
                  <Driver d={x.driver} />
                </Table.Td>
                <Table.Td className="small">{EXCEPTION_KIND[x.exception_kind]}</Table.Td>
                <Table.Td className="nowrap">{vnd(x.amount_paid_vnd)}</Table.Td>
                <Table.Td>
                  <Group gap={6} wrap="nowrap">
                    <Button
                      type="button"
                      size="compact-sm"
                      variant="light"
                      disabled={r.isLoading}
                      onClick={() => void doRecheck(x)}
                    >
                      Kiểm tra lại
                    </Button>
                    <Button
                      type="button"
                      size="compact-sm"
                      variant="default"
                      onClick={() => setSheet({ kind: 'reviewed', item: x })}
                    >
                      Đã xem
                    </Button>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </ListTable>
        )
      ) : data.payment_conflicts.items.length === 0 ? (
        empty
      ) : (
        <ListTable head={['Lần nạp', 'Tài xế', 'Số tiền', 'Lý do', 'Lúc trả', 'Xử lý']}>
          {data.payment_conflicts.items.map((c) => (
            <Table.Tr
              data-tone="critical"
              key={c.conflict_id}
              aria-label={`Trả mâu thuẫn lần nạp #${c.top_up_id}`}
            >
              <Table.Td>
                <span className="cell-title">#{c.top_up_id}</span>
                <div className="muted small">{c.gateway_transaction_no}</div>
              </Table.Td>
              <Table.Td>
                <Driver d={c.driver} />
              </Table.Td>
              <Table.Td className="nowrap">{vnd(c.amount_vnd)}</Table.Td>
              <Table.Td className="small">{c.reason}</Table.Td>
              <Table.Td className="nowrap">{when(c.paid_at)}</Table.Td>
              <Table.Td>
                <Button
                  type="button"
                  size="compact-sm"
                  variant="light"
                  onClick={() => setSheet({ kind: 'conflict', item: c })}
                >
                  Đã xử lý
                </Button>
              </Table.Td>
            </Table.Tr>
          ))}
        </ListTable>
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
