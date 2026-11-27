/**
 * Transaction list of screen 35 Transactions & Revenue (Admin, UC-ADM-10), on T108b's
 * GET /api/admin/v1/transactions and transactions.csv (Khang, contract §4.1). One row is one stopped
 * session. The period is the `from` / `to` of the revenue report above it (same URL parameters), so
 * both parts always show the same period; the list's own filters (Operator, kind, origin) live in
 * the URL as `tx_operator`, `tx_kind`, `tx_origin`. Paged by the server; the totals line covers the
 * whole filtered set. Admin has no station / charge point pages yet, so names are plain text.
 */
import { Button, Card, Group, Loader, NativeSelect, Table, Text, Title } from '@mantine/core';
import { IconDownload } from '@tabler/icons-react';
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
import { DataTable, EmptyState } from '../../ui/DataTable';
import { Notice } from '../../ui/Notice';
import { Pager } from '../../ui/Pager';
import { StatusBadge } from '../../ui/StatusBadge';
import { saveCsv } from './saveCsv';

/** Badge tone of each transaction kind. */
const KIND_TONE: Record<TransactionKind, string> = {
  csms_billed: '',
  unsettled: 'major',
  pending_reconciliation: 'major',
  unattributed: 'muted',
};

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
    <Table.Td>
      <StatusBadge tone={KIND_TONE[row.kind] ?? 'muted'}>
        {KIND_LABEL[row.kind] ?? row.kind}
      </StatusBadge>
      {row.kind === 'unsettled' && row.unsettled_reason && (
        <div className="muted small">
          {row.unsettled_reason === 'ineligible'
            ? 'Chưa đủ điều kiện trừ tiền'
            : reasonLabel(row.unsettled_reason)}
        </div>
      )}
    </Table.Td>
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
    <section className="transactions page-section" aria-labelledby="transactions-title">
      <div className="section-head">
        <div>
          <Title order={2} id="transactions-title" className="section-title">
            Danh sách giao dịch
          </Title>
          <Text size="sm" c="dimmed">
            Mỗi dòng là một phiên sạc đã dừng trong kỳ đã chọn ở trên
          </Text>
        </div>
      </div>
      <Card component="section" className="revenue-filters" aria-label="Lọc giao dịch" padding="md">
        <Group gap="sm" align="flex-end" wrap="wrap" className="filters">
          <NativeSelect
            className="select-field"
            label="Đơn vị vận hành"
            value={operatorId}
            onChange={(e) => update({ tx_operator: e.currentTarget.value })}
            data={[
              { value: '', label: 'Tất cả' },
              ...operators.map((o) => ({
                value: o.operator_id!,
                label: o.operator_name ?? o.operator_id!,
              })),
            ]}
          />
          <NativeSelect
            className="select-field"
            label="Loại"
            value={kind ?? ''}
            onChange={(e) => update({ tx_kind: e.currentTarget.value })}
            data={[
              { value: '', label: 'Tất cả' },
              ...KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] })),
            ]}
          />
          <NativeSelect
            className="select-field"
            label="Nguồn"
            value={origin ?? ''}
            onChange={(e) => update({ tx_origin: e.currentTarget.value })}
            data={[
              { value: '', label: 'Tất cả' },
              ...ORIGINS.map((o) => ({ value: o, label: ORIGIN_LABEL[o] })),
            ]}
          />
          <Button
            type="button"
            variant="default"
            className="revenue-export"
            leftSection={<IconDownload size={16} aria-hidden="true" />}
            disabled={!valid || csvState.isLoading}
            onClick={() => void download()}
          >
            {csvState.isLoading ? 'Đang tải tệp…' : 'Tải tệp giao dịch (CSV)'}
          </Button>
        </Group>
      </Card>
      {exportError && <Notice tone="error">{exportError}</Notice>}
      {!valid ? null : !current && isFetching ? (
        <Loader size="sm" aria-label="Đang tải…" />
      ) : error && !current ? (
        <Notice tone="error">{errorMessage(error)}</Notice>
      ) : current ? (
        current.total === 0 ? (
          <EmptyState>Không có giao dịch nào khớp bộ lọc trong kỳ.</EmptyState>
        ) : (
          <DataTable
            minWidth={1040}
            toolbar={
              <p className="muted small tx-summary" aria-label="Tổng giao dịch">
                {formatCount(current.total)} phiên · đã tính tiền{' '}
                {formatCount(current.totals.csms_billed_session_count)} phiên,{' '}
                {formatKwh(current.totals.csms_billed_energy_wh)},{' '}
                {formatVnd(current.totals.csms_billed_revenue_vnd)} · tính đến{' '}
                {formatGenerated(current.generated_at)}
              </p>
            }
            footer={
              <Pager
                label="Phân trang giao dịch"
                first={first + 1}
                last={first + current.items.length}
                total={current.total}
                page={page}
                pages={pages}
                onPage={setPage}
              />
            }
          >
            <Table.Thead>
              <Table.Tr>
                <Table.Th scope="col">Phiên</Table.Th>
                <Table.Th scope="col">Thời điểm</Table.Th>
                <Table.Th scope="col">Đơn vị vận hành</Table.Th>
                <Table.Th scope="col">Trạm · trụ sạc</Table.Th>
                <Table.Th scope="col">Nguồn</Table.Th>
                <Table.Th scope="col">Loại</Table.Th>
                <Table.Th scope="col" className="revenue-num">
                  Năng lượng
                </Table.Th>
                <Table.Th scope="col" className="revenue-num">
                  Số tiền
                </Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {current.items.map((r) => (
                <Table.Tr
                  key={r.session_id}
                  aria-label={`Phiên #${r.session_id}`}
                  data-tone={KIND_TONE[r.kind] === 'major' ? 'major' : undefined}
                >
                  <Table.Td>
                    <span className="cell-title">#{r.session_id}</span>
                    {r.delivered_offline && (
                      <div className="muted small">Trụ gửi bù sau khi nối lại</div>
                    )}
                  </Table.Td>
                  <Table.Td>{formatGenerated(r.period_at)}</Table.Td>
                  <Table.Td>{r.operator_name}</Table.Td>
                  <Table.Td>
                    <span className="cell-title">{r.site_name}</span>
                    <div className="muted small">
                      {r.serial_number} · Súng {r.connector_no}
                    </div>
                  </Table.Td>
                  <Table.Td>{ORIGIN_LABEL[r.origin] ?? r.origin}</Table.Td>
                  <KindCell row={r} />
                  <Table.Td className="revenue-num">
                    {r.energy_wh === null ? (
                      <span className="muted">Thiếu số đo</span>
                    ) : (
                      formatKwh(r.energy_wh)
                    )}
                  </Table.Td>
                  <Table.Td className="revenue-num">
                    {r.amount_vnd === null ? '—' : formatVnd(r.amount_vnd)}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </DataTable>
        )
      ) : null}
    </section>
  );
}
