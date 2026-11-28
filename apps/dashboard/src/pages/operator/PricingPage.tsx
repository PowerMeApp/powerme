/**
 * Screen 24 — Pricing & Promotions (FE-06, UC-OPS-06/07, BR-P02), Operator staff (manager and
 * technician, contract N5). Two tabs, kept in the URL (`?tab=promotions`):
 *   - Biểu giá: the Operator's time-of-day tariff in force and the upcoming ones (3 bands, per
 *     Operator, contract §6 #3); "Lập biểu giá mới" sets a new schedule from a date (TariffEditor).
 *   - Khuyến mãi: the Operator's promotions; create, edit, end. They are stored only: settlement does
 *     not apply them yet (decision K6), which the screen says.
 * The reservation hold window / no-show fee of Table 5 #24 wait for reservation (Should).
 */
import { Button, Card, Group, Loader, SimpleGrid, Table, Text, Title } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import type { Promotion, TariffSchedule } from '@powerme/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import {
  useDeactivatePromotionMutation,
  useOperatorPromotionsQuery,
  useOperatorTariffsQuery,
} from '../../core/api/api';
import {
  BAND,
  pricingError,
  promotionEnded,
  promotionStatus,
  vnd,
} from '../../features/pricing/format';
import { PromotionDialog } from '../../features/pricing/PromotionDialog';
import { TariffEditor } from '../../features/pricing/TariffEditor';
import { Notice, type Note } from '../../ui/Notice';
import { PageHeader } from '../../ui/PageHeader';
import { Pager, useClientPage } from '../../ui/Pager';
import { QueueSwitch } from '../../ui/QueueSwitch';
import { StatusBadge } from '../../ui/StatusBadge';
import { DataTable, EmptyState } from '../../ui/DataTable';
const day = (ymd: string) => ymd.split('-').reverse().join('/');
const when = (iso: string) =>
  new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });

function ScheduleTable({ schedule, label }: { schedule: TariffSchedule; label: string }) {
  return (
    <Card component="section" padding={0} className="table-card" aria-label={label}>
      <Title order={2} className="section-title table-toolbar">
        {label} · từ {day(schedule.effective_from)}
        {schedule.effective_to ? ` đến ${day(schedule.effective_to)}` : ''}
      </Title>
      <Table.ScrollContainer minWidth={420} type="native">
        <Table className="data-table">
          <Table.Thead>
            <Table.Tr>
              <Table.Th scope="col">Khung giờ</Table.Th>
              <Table.Th scope="col">Loại</Table.Th>
              <Table.Th scope="col">Giá</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {schedule.periods.map((p) => (
              <Table.Tr key={`${p.time_start}-${p.band}`} aria-label={`${label} ${p.time_start}`}>
                <Table.Td className="nowrap">
                  {p.time_start} – {p.time_end}
                </Table.Td>
                <Table.Td>
                  <StatusBadge tone={BAND[p.band][1]}>{BAND[p.band][0]}</StatusBadge>
                </Table.Td>
                <Table.Td className="nowrap">{vnd(p.price_per_kwh_vnd)}/kWh</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Card>
  );
}

function TariffTab({ onNote }: { onNote: (n: Note) => void }) {
  const { data, error, isLoading } = useOperatorTariffsQuery();
  const [editing, setEditing] = useState(false);
  return (
    <>
      <Group justify="flex-end">
        <Button
          type="button"
          leftSection={<IconPlus size={16} aria-hidden="true" />}
          disabled={!data}
          onClick={() => {
            onNote(null);
            setEditing(true);
          }}
        >
          Lập biểu giá mới
        </Button>
      </Group>
      {isLoading ? (
        <Loader size="sm" aria-label="Đang tải…" />
      ) : error && !data ? (
        <Notice tone="error">{pricingError(error)}</Notice>
      ) : !data?.current && !data?.upcoming.length ? (
        <Notice tone="warn" role="note">
          Operator chưa có biểu giá. Tài xế chưa bắt đầu sạc được cho tới khi có biểu giá.
        </Notice>
      ) : (
        <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
          {data.current && <ScheduleTable schedule={data.current} label="Đang áp dụng" />}
          {data.upcoming.map((s) => (
            <ScheduleTable key={s.effective_from} schedule={s} label="Sắp áp dụng" />
          ))}
        </SimpleGrid>
      )}
      {editing && data && (
        <TariffEditor
          current={data.upcoming.at(-1) ?? data.current}
          onCancel={() => setEditing(false)}
          onDone={(text) => {
            setEditing(false);
            onNote({ tone: 'ok', text });
          }}
        />
      )}
    </>
  );
}

function PromotionTab({ onNote }: { onNote: (n: Note) => void }) {
  const { data, error, isLoading, refetch } = useOperatorPromotionsQuery();
  const [deactivate, d] = useDeactivatePromotionMutation();
  const [dialog, setDialog] = useState<{ promotion?: Promotion } | null>(null);
  const [ending, setEnding] = useState<Promotion | null>(null);
  const [endError, setEndError] = useState<string | null>(null);
  const { pageRows, paged, pagerProps } = useClientPage(data?.items ?? []);

  async function end(p: Promotion) {
    const res = await deactivate(p.id);
    if ('error' in res) {
      void refetch();
      return setEndError(pricingError(res.error));
    }
    setEnding(null);
    onNote({ tone: 'ok', text: `Đã kết thúc khuyến mãi ${p.promotion_code}` });
  }

  return (
    <>
      <Group justify="space-between" wrap="wrap">
        <Text size="sm" c="dimmed">
          Mã khuyến mãi được lưu nhưng chưa được áp dụng khi tính tiền phiên sạc.
        </Text>
        <Button
          type="button"
          leftSection={<IconPlus size={16} aria-hidden="true" />}
          onClick={() => {
            onNote(null);
            setDialog({});
          }}
        >
          Tạo khuyến mãi
        </Button>
      </Group>
      {isLoading ? (
        <Loader size="sm" aria-label="Đang tải…" />
      ) : error && !data ? (
        <Notice tone="error">{pricingError(error)}</Notice>
      ) : !data || data.items.length === 0 ? (
        <EmptyState>Chưa có khuyến mãi nào.</EmptyState>
      ) : (
        <DataTable
          minWidth={720}
          footer={paged ? <Pager label="Phân trang khuyến mãi" {...pagerProps} /> : undefined}
        >
          <Table.Thead>
            <Table.Tr>
              <Table.Th scope="col">Mã</Table.Th>
              <Table.Th scope="col">Giảm</Table.Th>
              <Table.Th scope="col">Thời gian</Table.Th>
              <Table.Th scope="col">Trạng thái</Table.Th>
              <Table.Th scope="col">Thao tác</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {pageRows.map((p) => {
              const [label, tone] = promotionStatus(p);
              return (
                <Table.Tr key={p.id} aria-label={`Khuyến mãi ${p.promotion_code}`}>
                  <Table.Td className="cell-title">{p.promotion_code}</Table.Td>
                  <Table.Td className="nowrap">
                    {p.discount_type === 'percent' ? `${p.discount_value}%` : vnd(p.discount_value)}
                  </Table.Td>
                  <Table.Td className="small">
                    {when(p.valid_from)} – {when(p.valid_to)}
                  </Table.Td>
                  <Table.Td>
                    <StatusBadge tone={tone}>{label}</StatusBadge>
                  </Table.Td>
                  <Table.Td>
                    {!promotionEnded(p) && (
                      <Group gap={6} wrap="nowrap">
                        <Button
                          type="button"
                          size="compact-sm"
                          variant="light"
                          onClick={() => {
                            onNote(null);
                            setDialog({ promotion: p });
                          }}
                        >
                          Sửa
                        </Button>
                        <Button
                          type="button"
                          size="compact-sm"
                          variant="default"
                          onClick={() => {
                            setEndError(null);
                            setEnding(p);
                          }}
                        >
                          Kết thúc
                        </Button>
                      </Group>
                    )}
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </DataTable>
      )}
      {dialog && (
        <PromotionDialog
          {...(dialog.promotion ? { promotion: dialog.promotion } : {})}
          onCancel={() => setDialog(null)}
          onDone={(text) => {
            setDialog(null);
            onNote({ tone: 'ok', text });
          }}
        />
      )}
      {ending && (
        <ConfirmDialog
          title={`Kết thúc khuyến mãi ${ending.promotion_code}`}
          confirmLabel="Kết thúc"
          busy={d.isLoading}
          onCancel={() => setEnding(null)}
          onConfirm={() => void end(ending)}
        >
          <p>Khuyến mãi kết thúc ngay bây giờ và không sửa được nữa.</p>
          {endError && <p className="form-error">{endError}</p>}
        </ConfirmDialog>
      )}
    </>
  );
}

export function PricingPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'promotions' ? 'promotions' : 'tariffs';
  const [note, setNote] = useState<Note>(null);
  const switchTab = (next: 'tariffs' | 'promotions') => {
    setNote(null);
    setParams(
      (p) => {
        if (next === 'promotions') p.set('tab', 'promotions');
        else p.delete('tab');
        return p;
      },
      { replace: true },
    );
  };
  return (
    <>
      <PageHeader crumbs={[{ label: 'Giá & khuyến mãi' }]} title="Giá & khuyến mãi" />
      <QueueSwitch
        label="Mục"
        value={tab}
        onChange={switchTab}
        items={[
          { key: 'tariffs', label: 'Biểu giá' },
          { key: 'promotions', label: 'Khuyến mãi' },
        ]}
      />
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      {tab === 'tariffs' ? <TariffTab onNote={setNote} /> : <PromotionTab onNote={setNote} />}
    </>
  );
}
