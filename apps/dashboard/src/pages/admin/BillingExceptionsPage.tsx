/**
 * Screen 32 — Billing Exceptions (FE-09, UC-ADM-08, BR-P13, BR-P44), Admin only, on Khang's #212
 * routes (WF-02 D10): GET /api/admin/v1/billing/exceptions gives four work lists in one snapshot
 * (each ≤ 200 rows, no paging): late payments, e-invoices that need review, top-up exceptions,
 * payment conflicts. One tab each, kept in the URL (`?tab=`), with a count badge.
 * Actions (screen 33 sheets): retry an e-invoice; "Kiểm tra lại" then "Đã xem" on a top-up exception
 * (D10 order); resolve a payment conflict with a note.
 * Manual refunds (D-AC, BR-P51, Khang's #257): a fifth tab lists the refunds customer service still
 * has to make (GET /api/admin/v1/billing/refunds, oldest first) with "Đã hoàn" (gateway refund
 * number), "Cổng từ chối" (reason) and "Làm lại"; a late payment gets "Hoàn"; "Tạo yêu cầu hoàn" asks
 * for a top-up refund by its number. Error codes show as plain Vietnamese (`billingError`).
 */
import { Button, Group, Loader, Table } from '@mantine/core';
import { Children, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import type {
  InvoiceNeedsReviewItem,
  LatePaymentItem,
  PaymentConflictItem,
  RefundQueue,
  RefundQueueItem,
  TopUpExceptionItem,
} from '@powerme/shared';
import {
  useBillingExceptionsQuery,
  useRecheckTopUpMutation,
  useRefundQueueQuery,
} from '../../core/api/api';
import {
  ConfirmRefundSheet,
  ConflictReviewSheet,
  CreateTopUpRefundSheet,
  FailRefundSheet,
  LateRefundSheet,
  RedoRefundSheet,
  RetryInvoiceSheet,
  ReviewedSheet,
} from '../../features/billing/BillingSheets';
import {
  billingError,
  ERROR_KIND,
  EXCEPTION_KIND,
  recheckText,
  REFUND_KIND,
  vnd,
  when,
} from '../../features/billing/format';
import { DataTable, EmptyState } from '../../ui/DataTable';
import { Notice, type Note } from '../../ui/Notice';
import { Pager, useClientPage } from '../../ui/Pager';
import { PageHeader } from '../../ui/PageHeader';
import { QueueSwitch } from '../../ui/QueueSwitch';

const TABS = [
  ['late', 'Trả muộn', 'late_payments'],
  ['invoices', 'Hoá đơn cần xem lại', 'invoices_needs_review'],
  ['exceptions', 'Ngoại lệ nạp tiền', 'top_up_exceptions'],
  ['conflicts', 'Trả mâu thuẫn', 'payment_conflicts'],
  ['refunds', 'Hoàn tiền', null],
] as const;
type Tab = (typeof TABS)[number][0];
type Sheet =
  | { kind: 'retry'; item: InvoiceNeedsReviewItem }
  | { kind: 'reviewed'; item: TopUpExceptionItem }
  | { kind: 'conflict'; item: PaymentConflictItem }
  | { kind: 'create-refund' }
  | { kind: 'late-refund'; item: LatePaymentItem }
  | { kind: 'confirm-refund'; item: RefundQueueItem }
  | { kind: 'fail-refund'; item: RefundQueueItem }
  | { kind: 'redo-refund'; item: RefundQueueItem };

function Driver({ d }: { d: { full_name: string; phone_number: string | null } }) {
  return (
    <>
      {d.full_name}
      {d.phone_number && <div className="muted small">{d.phone_number}</div>}
    </>
  );
}

/** One list, 20 rows a page (the API returns each list whole). */
function ListTable({ head, children }: { head: string[]; children: ReactNode }) {
  const { pageRows, paged, pagerProps } = useClientPage(Children.toArray(children));
  return (
    <DataTable minWidth={820} footer={paged ? <Pager {...pagerProps} /> : undefined}>
      <Table.Thead>
        <Table.Tr>
          {head.map((h) => (
            <Table.Th key={h} scope="col">
              {h}
            </Table.Th>
          ))}
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>{pageRows}</Table.Tbody>
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
  const refunds = useRefundQueueQuery(undefined, {
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
      <PageHeader
        crumbs={[{ label: 'Ngoại lệ thanh toán' }]}
        title="Ngoại lệ thanh toán"
        actions={
          <Button type="button" onClick={() => setSheet({ kind: 'create-refund' })}>
            Tạo yêu cầu hoàn
          </Button>
        }
      />
      <QueueSwitch
        label="Danh sách"
        value={tab}
        onChange={switchTab}
        items={TABS.map(([key, label, total]) => ({
          key,
          label,
          count: total ? data?.[total].total : refunds.data?.total,
          countLabel: 'mục',
        }))}
      />
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      {tab === 'refunds' ? (
        <RefundTab
          queue={refunds}
          onConfirm={(item) => setSheet({ kind: 'confirm-refund', item })}
          onFail={(item) => setSheet({ kind: 'fail-refund', item })}
          onRedo={(item) => setSheet({ kind: 'redo-refund', item })}
        />
      ) : isLoading ? (
        <Loader size="sm" aria-label="Đang tải…" />
      ) : error && !data ? (
        <Notice tone="error">{billingError(error)}</Notice>
      ) : !data ? null : tab === 'late' ? (
        <>
          <p className="muted small">
            Khoản trả sau khi lần nạp đã hết hạn hoặc thất bại: không cộng vào tín dụng sạc, quản
            trị viên tạo yêu cầu hoàn, CSKH hoàn trên cổng VNPay.
          </p>
          {data.late_payments.items.length === 0 ? (
            empty
          ) : (
            <ListTable
              key={tab}
              head={['Lần nạp', 'Tài xế', 'Số tiền trả muộn', 'Mã giao dịch', 'Lúc trả', 'Xử lý']}
            >
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
                  <Table.Td>
                    <Button
                      type="button"
                      size="compact-sm"
                      variant="light"
                      onClick={() => setSheet({ kind: 'late-refund', item: l })}
                    >
                      Hoàn
                    </Button>
                  </Table.Td>
                </Table.Tr>
              ))}
            </ListTable>
          )}
        </>
      ) : tab === 'invoices' ? (
        data.invoices_needs_review.items.length === 0 ? (
          empty
        ) : (
          <ListTable
            key={tab}
            head={['Lần nạp', 'Tài xế', 'Số tiền', 'Lỗi nhà cung cấp', 'Số lần', 'Xử lý']}
          >
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
          <ListTable key={tab} head={['Lần nạp', 'Tài xế', 'Ngoại lệ', 'Số tiền', 'Xử lý']}>
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
        <ListTable key={tab} head={['Lần nạp', 'Tài xế', 'Số tiền', 'Lý do', 'Lúc trả', 'Xử lý']}>
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
      {sheet?.kind === 'create-refund' && (
        <CreateTopUpRefundSheet onDone={done} onCancel={() => setSheet(null)} />
      )}
      {sheet?.kind === 'late-refund' && (
        <LateRefundSheet item={sheet.item} onDone={done} onCancel={() => setSheet(null)} />
      )}
      {sheet?.kind === 'confirm-refund' && (
        <ConfirmRefundSheet item={sheet.item} onDone={done} onCancel={() => setSheet(null)} />
      )}
      {sheet?.kind === 'fail-refund' && (
        <FailRefundSheet item={sheet.item} onDone={done} onCancel={() => setSheet(null)} />
      )}
      {sheet?.kind === 'redo-refund' && (
        <RedoRefundSheet item={sheet.item} onDone={done} onCancel={() => setSheet(null)} />
      )}
    </>
  );
}

/** Customer-service work list (BR-P51): requested and failed refunds, oldest first. */
function RefundTab({
  queue: { data, error, isLoading },
  onConfirm,
  onFail,
  onRedo,
}: {
  queue: { data?: RefundQueue | undefined; error?: unknown; isLoading: boolean };
  onConfirm: (item: RefundQueueItem) => void;
  onFail: (item: RefundQueueItem) => void;
  onRedo: (item: RefundQueueItem) => void;
}) {
  if (isLoading) return <Loader size="sm" aria-label="Đang tải…" />;
  if (error && !data) return <Notice tone="error">{billingError(error)}</Notice>;
  if (!data) return null;
  return (
    <>
      <p className="muted small">
        CSKH hoàn đúng số tiền trên cổng merchant VNPay trong 7 ngày làm việc, rồi Admin ghi nhận mã
        hoàn. Cũ nhất ở trên.
      </p>
      {data.items.length === 0 ? (
        <EmptyState>Không có yêu cầu hoàn nào đang chờ.</EmptyState>
      ) : (
        <ListTable
          head={[
            'Ngày tạo',
            'Tài xế',
            'Lần nạp',
            'Loại',
            'Số tiền cần hoàn',
            'Trạng thái',
            'Xử lý',
          ]}
        >
          {data.items.map((f) => (
            <Table.Tr
              data-tone={f.status === 'failed' ? 'critical' : 'major'}
              key={f.refund_id}
              aria-label={`Hoàn tiền lần nạp #${f.top_up_id}`}
            >
              <Table.Td className="nowrap">{when(f.created_at)}</Table.Td>
              <Table.Td>
                <Driver d={f.driver} />
              </Table.Td>
              <Table.Td>
                <span className="cell-title">#{f.top_up_id}</span>
                <div className="muted small">{f.gateway_reference}</div>
                {f.gateway_transaction_no && (
                  <div className="muted small">GD {f.gateway_transaction_no}</div>
                )}
              </Table.Td>
              <Table.Td className="small">
                {REFUND_KIND[f.kind]}
                {f.requested_by === null && <div className="muted small">Hệ thống tạo</div>}
              </Table.Td>
              <Table.Td className="nowrap">{vnd(f.amount_vnd)}</Table.Td>
              <Table.Td className="small">
                {f.status === 'failed' ? <b>Cổng từ chối</b> : 'Chờ hoàn'}
                {f.failure_reason && <div className="muted small">{f.failure_reason}</div>}
              </Table.Td>
              <Table.Td>
                {f.status === 'requested' ? (
                  <Group gap={6} wrap="nowrap">
                    <Button
                      type="button"
                      size="compact-sm"
                      variant="light"
                      onClick={() => onConfirm(f)}
                    >
                      Đã hoàn
                    </Button>
                    <Button
                      type="button"
                      size="compact-sm"
                      variant="default"
                      onClick={() => onFail(f)}
                    >
                      Cổng từ chối
                    </Button>
                  </Group>
                ) : (
                  <Button type="button" size="compact-sm" variant="light" onClick={() => onRedo(f)}>
                    Làm lại
                  </Button>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </ListTable>
      )}
    </>
  );
}
