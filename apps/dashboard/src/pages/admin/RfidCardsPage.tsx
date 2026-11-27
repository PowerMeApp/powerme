/**
 * Screen 30 — RFID Cards (T161, UC-ADM-04, BR-P15; Platform Administration, admin only). On the
 * card registry of T146 (contract §3.8a):
 *   - list with status / type filters, a card-identifier search (the API's `q` is a prefix of the
 *     card identifier) and paging;
 *   - "Đăng ký thẻ": card identifier (1–20 characters), type, optional driver for Online cards;
 *   - per row only the valid actions (format.ts `cardActions`); Khoá and Bỏ gắn ask first; no
 *     delete and no type change. Unblocking an Online card that has no driver asks for one
 *     (sent together, as the API requires).
 * Each change refreshes the list and the card counts of screen 27 (tags RfidCard, AdminSummary).
 */
import { Button, Group, Loader, NativeSelect, Table, TextInput } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { useState } from 'react';
import type { UserAccount, RfidCard, RfidCardKind, RfidCardStatus } from '@powerme/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { FieldError } from '../../components/Field';
import {
  RFID_PAGE_SIZE,
  useAdminRfidCardsQuery,
  useCreateRfidCardMutation,
  useUpdateRfidCardMutation,
  type ApiError,
} from '../../core/api/api';
import { DriverPicker } from '../../features/rfidCards/DriverPicker';
import {
  cardActions,
  KIND,
  MAX_CARD_ID,
  rfidError,
  STATUS,
  unblockNeedsDriver,
  validCardId,
  type CardAction,
} from '../../features/rfidCards/format';
import { DataTable, EmptyState } from '../../ui/DataTable';
import { FilterBar, SearchInput, SelectFilter } from '../../ui/FilterBar';
import { Notice, type Note } from '../../ui/Notice';
import { PageHeader } from '../../ui/PageHeader';
import { Pager, pageCount } from '../../ui/Pager';
import { StatusBadge } from '../../ui/StatusBadge';

type Dialog = { kind: 'register' } | { kind: CardAction; card: RfidCard };

const ACTION_LABEL: Record<CardAction, string> = {
  link: 'Gắn tài xế',
  unlink: 'Bỏ gắn',
  block: 'Khoá',
  unblock: 'Mở khoá',
};

const day = (iso: string) => new Date(iso).toLocaleDateString('vi-VN');

/** Register form (T161 point 2). */
function RegisterDialog({
  onDone,
  onCancel,
}: {
  onDone: (t: string) => void;
  onCancel: () => void;
}) {
  const [create, { isLoading }] = useCreateRfidCardMutation();
  const [cardId, setCardId] = useState('');
  const [kind, setKind] = useState<RfidCardKind>('online');
  const [driver, setDriver] = useState<UserAccount | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!validCardId(cardId)) return setError(`Nhập mã thẻ, tối đa ${MAX_CARD_ID} ký tự`);
    setError(null);
    const identifier = cardId.trim();
    const res = await create({
      card_identifier: identifier,
      card_kind: kind,
      ...(kind === 'online' && driver ? { driver_id: driver.id } : {}),
    });
    if ('error' in res) return setError(rfidError(res.error));
    onDone(
      `Đã đăng ký thẻ ${identifier}` +
        (kind === 'online' && driver ? ` và gắn cho ${driver.full_name}` : ''),
    );
  }

  return (
    <ConfirmDialog
      title="Đăng ký thẻ RFID"
      confirmLabel="Đăng ký"
      busy={isLoading}
      onCancel={onCancel}
      onConfirm={() => void submit()}
    >
      <TextInput
        label="Mã thẻ"
        value={cardId}
        maxLength={MAX_CARD_ID + 10}
        placeholder="Mã in trên thẻ"
        onChange={(e) => setCardId(e.currentTarget.value)}
      />
      <NativeSelect
        label="Loại"
        value={kind}
        onChange={(e) => setKind(e.currentTarget.value as RfidCardKind)}
        data={(Object.keys(KIND) as RfidCardKind[]).map((k) => ({ value: k, label: KIND[k] }))}
      />
      {kind === 'online' ? (
        <DriverPicker value={driver} onChange={setDriver} label="Tài xế (tuỳ chọn)" />
      ) : (
        <p className="muted small">Thẻ sạc miễn phí không gắn tài xế và dùng được ngay.</p>
      )}
      <FieldError message={error ?? undefined} />
    </ConfirmDialog>
  );
}

/** Link, unlink, block or unblock one card (T161 point 3). */
function ActionDialog({
  action,
  card,
  onDone,
  onCancel,
  onStale,
}: {
  action: CardAction;
  card: RfidCard;
  onDone: (t: string) => void;
  onCancel: () => void;
  onStale: () => void;
}) {
  const [update, { isLoading }] = useUpdateRfidCardMutation();
  const [driver, setDriver] = useState<UserAccount | null>(null);
  const [error, setError] = useState<string | null>(null);
  const needsDriver = action === 'link' || (action === 'unblock' && unblockNeedsDriver(card));
  const id = card.card_identifier;

  async function submit() {
    if (needsDriver && !driver) return setError('Chọn một tài xế');
    setError(null);
    const body =
      action === 'link'
        ? { driver_id: driver!.id }
        : action === 'unlink'
          ? { driver_id: null }
          : action === 'block'
            ? { status: 'blocked' as const }
            : { status: 'active' as const, ...(driver ? { driver_id: driver.id } : {}) };
    const res = await update({ id: card.id, ...body });
    if ('error' in res) {
      const status = (res.error as ApiError).status;
      if (status === 404 || status === 409) onStale();
      return setError(rfidError(res.error));
    }
    onDone(
      action === 'link'
        ? `Đã gắn thẻ ${id} cho ${driver!.full_name}`
        : action === 'unlink'
          ? `Đã bỏ gắn thẻ ${id}`
          : action === 'block'
            ? `Đã khoá thẻ ${id}`
            : `Đã mở khoá thẻ ${id}` + (driver ? ` và gắn cho ${driver.full_name}` : ''),
    );
  }

  return (
    <ConfirmDialog
      title={`${ACTION_LABEL[action]} thẻ ${id}`}
      confirmLabel={ACTION_LABEL[action]}
      danger={action === 'block'}
      busy={isLoading}
      onCancel={onCancel}
      onConfirm={() => void submit()}
    >
      {action === 'unlink' && (
        <p>
          Thẻ không còn gắn với {card.driver?.full_name ?? 'tài xế'} và chuyển về "Chưa gắn tài xế".
          Lần quẹt sau tại trụ sẽ không được chấp nhận.
        </p>
      )}
      {action === 'block' && (
        <p>Thẻ bị chặn: lần quẹt sau tại trụ sẽ bị từ chối. Phiên đang chạy không bị dừng.</p>
      )}
      {action === 'unblock' && needsDriver && (
        <p>Thẻ chưa gắn tài xế: chọn tài xế để mở khoá thẻ.</p>
      )}
      {needsDriver && <DriverPicker value={driver} onChange={setDriver} />}
      <FieldError message={error ?? undefined} />
    </ConfirmDialog>
  );
}

function CardRow({ card, onAction }: { card: RfidCard; onAction: (a: CardAction) => void }) {
  const [label, tone] = STATUS[card.status];
  return (
    <Table.Tr
      aria-label={`Thẻ ${card.card_identifier}`}
      data-tone={card.status === 'blocked' ? 'major' : undefined}
    >
      <Table.Td className="cell-title">{card.card_identifier}</Table.Td>
      <Table.Td>{KIND[card.card_kind]}</Table.Td>
      <Table.Td>
        <StatusBadge tone={tone}>{label}</StatusBadge>
      </Table.Td>
      <Table.Td>
        {card.driver ? (
          <>
            {card.driver.full_name}
            <div className="muted small">{card.driver.email}</div>
          </>
        ) : (
          <span className="muted">—</span>
        )}
      </Table.Td>
      <Table.Td className="nowrap">{day(card.issued_at)}</Table.Td>
      <Table.Td>
        <Group gap={6} wrap="nowrap">
          {cardActions(card).map((a) => (
            <Button
              key={a}
              type="button"
              size="compact-sm"
              variant={a === 'block' || a === 'unlink' ? 'default' : 'light'}
              onClick={() => onAction(a)}
            >
              {ACTION_LABEL[a]}
            </Button>
          ))}
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

export function RfidCardsPage() {
  const [status, setStatus] = useState<RfidCardStatus | ''>('');
  const [kind, setKind] = useState<RfidCardKind | ''>('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [update] = useUpdateRfidCardMutation();
  const { data, error, isLoading, refetch } = useAdminRfidCardsQuery({
    page,
    ...(status ? { status } : {}),
    ...(kind ? { card_kind: kind } : {}),
    ...(search.trim() ? { q: search } : {}),
  });
  const total = data?.total ?? 0;
  const pages = pageCount(total, RFID_PAGE_SIZE);
  if (data && page > pages) setPage(pages);
  const filtered = !!(status || kind || search.trim());
  const done = (text: string) => {
    setDialog(null);
    setNote({ tone: 'ok', text });
  };
  /** Only Khoá and Bỏ gắn ask first (T161 point 3); a plain unblock is sent at once. */
  async function act(card: RfidCard, a: CardAction) {
    setNote(null);
    if (a !== 'unblock' || unblockNeedsDriver(card)) return setDialog({ kind: a, card });
    const res = await update({ id: card.id, status: 'active' });
    if (!('error' in res))
      return setNote({ tone: 'ok', text: `Đã mở khoá thẻ ${card.card_identifier}` });
    const st = (res.error as ApiError).status;
    if (st === 404 || st === 409) void refetch();
    setNote({ tone: 'error', text: rfidError(res.error) });
  }

  const first = ((data?.page ?? 1) - 1) * (data?.page_size ?? RFID_PAGE_SIZE) + 1;

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Thẻ RFID' }]}
        title="Thẻ RFID"
        actions={
          <Button
            leftSection={<IconPlus size={16} aria-hidden="true" />}
            onClick={() => {
              setNote(null);
              setDialog({ kind: 'register' });
            }}
          >
            Đăng ký thẻ
          </Button>
        }
      />
      <FilterBar>
        <SearchInput
          label="Tìm thẻ"
          value={search}
          maxLength={MAX_CARD_ID}
          placeholder="Mã thẻ (phần đầu, phân biệt hoa thường)"
          onChange={(v) => {
            setSearch(v);
            setPage(1);
          }}
        />
        <SelectFilter
          label="Trạng thái"
          value={status}
          options={[
            ['', 'Tất cả'],
            ...(Object.keys(STATUS) as RfidCardStatus[]).map((k) => [k, STATUS[k][0]] as const),
          ]}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
        />
        <SelectFilter
          label="Loại"
          value={kind}
          options={[
            ['', 'Tất cả'],
            ...(Object.keys(KIND) as RfidCardKind[]).map((k) => [k, KIND[k]] as const),
          ]}
          onChange={(v) => {
            setKind(v);
            setPage(1);
          }}
        />
      </FilterBar>
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      {isLoading ? (
        <Loader size="sm" aria-label="Đang tải…" />
      ) : error && !data ? (
        <Notice tone="error">{rfidError(error)}</Notice>
      ) : !data || data.items.length === 0 ? (
        <EmptyState>
          {filtered ? 'Không có thẻ nào khớp bộ lọc.' : 'Chưa có thẻ RFID nào được đăng ký.'}
        </EmptyState>
      ) : (
        <DataTable
          minWidth={860}
          footer={
            <Pager
              first={first}
              last={first + data.items.length - 1}
              total={total}
              page={page}
              pages={pages}
              onPage={setPage}
            />
          }
        >
          <Table.Thead>
            <Table.Tr>
              <Table.Th scope="col">Mã thẻ</Table.Th>
              <Table.Th scope="col">Loại</Table.Th>
              <Table.Th scope="col">Trạng thái</Table.Th>
              <Table.Th scope="col">Tài xế</Table.Th>
              <Table.Th scope="col">Ngày đăng ký</Table.Th>
              <Table.Th scope="col">Thao tác</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.items.map((card) => (
              <CardRow key={card.id} card={card} onAction={(a) => void act(card, a)} />
            ))}
          </Table.Tbody>
        </DataTable>
      )}
      {dialog?.kind === 'register' && (
        <RegisterDialog onDone={done} onCancel={() => setDialog(null)} />
      )}
      {dialog && dialog.kind !== 'register' && (
        <ActionDialog
          key={dialog.card.id + dialog.kind}
          action={dialog.kind}
          card={dialog.card}
          onDone={done}
          onCancel={() => setDialog(null)}
          onStale={() => void refetch()}
        />
      )}
    </>
  );
}
