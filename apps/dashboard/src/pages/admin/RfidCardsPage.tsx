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
import { useState } from 'react';
import type { UserAccount, RfidCard, RfidCardKind, RfidCardStatus } from '@powerme/shared';
import { Breadcrumbs } from '../../components/Breadcrumbs';
import { ConfirmDialog } from '../../components/ConfirmDialog';
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

type Dialog = { kind: 'register' } | { kind: CardAction; card: RfidCard };
type Note = { tone: 'ok' | 'error'; text: string } | null;

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
      <label className="field">
        Mã thẻ
        <input
          className="input"
          value={cardId}
          maxLength={MAX_CARD_ID + 10}
          placeholder="Mã in trên thẻ (idTag)"
          onChange={(e) => setCardId(e.target.value)}
        />
      </label>
      <label className="field">
        Loại
        <select
          className="input"
          value={kind}
          onChange={(e) => setKind(e.target.value as RfidCardKind)}
        >
          {(Object.keys(KIND) as RfidCardKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND[k]}
            </option>
          ))}
        </select>
      </label>
      {kind === 'online' ? (
        <DriverPicker value={driver} onChange={setDriver} label="Tài xế (tuỳ chọn)" />
      ) : (
        <p className="muted small">Thẻ free vend không gắn tài xế và dùng được ngay.</p>
      )}
      {error && <p role="alert">{error}</p>}
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
      {error && <p role="alert">{error}</p>}
    </ConfirmDialog>
  );
}

function CardRow({ card, onAction }: { card: RfidCard; onAction: (a: CardAction) => void }) {
  const [label, tone] = STATUS[card.status];
  return (
    <tr aria-label={`Thẻ ${card.card_identifier}`}>
      <td className="cell-title">{card.card_identifier}</td>
      <td>{KIND[card.card_kind]}</td>
      <td>
        <span className={`pill ${tone}`}>{label}</span>
      </td>
      <td>
        {card.driver ? (
          <>
            {card.driver.full_name}
            <div className="muted small">{card.driver.email}</div>
          </>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td className="nowrap">{day(card.issued_at)}</td>
      <td>
        <div className="btn-row">
          {cardActions(card).map((a) => (
            <button
              key={a}
              type="button"
              className={`btn small ${a === 'block' || a === 'unlink' ? 'ghost' : ''}`}
              onClick={() => onAction(a)}
            >
              {ACTION_LABEL[a]}
            </button>
          ))}
        </div>
      </td>
    </tr>
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
  const pages = Math.max(1, Math.ceil(total / RFID_PAGE_SIZE));
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

  return (
    <>
      <Breadcrumbs items={[{ label: 'Thẻ RFID' }]} />
      <div className="page-head">
        <h1>Thẻ RFID</h1>
        <p>Đăng ký, gắn tài xế, khoá và mở khoá thẻ dùng để bắt đầu sạc tại trụ</p>
        <button
          type="button"
          className="btn primary page-action"
          onClick={() => {
            setNote(null);
            setDialog({ kind: 'register' });
          }}
        >
          Đăng ký thẻ
        </button>
      </div>
      <div className="filters">
        <label className="field search-field">
          Tìm thẻ
          <input
            className="input"
            type="search"
            value={search}
            maxLength={MAX_CARD_ID}
            placeholder="Mã thẻ (phần đầu, phân biệt hoa thường)"
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <label className="field">
          Trạng thái
          <select
            className="input"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as RfidCardStatus | '');
              setPage(1);
            }}
          >
            <option value="">Tất cả</option>
            {(Object.keys(STATUS) as RfidCardStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS[s][0]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Loại
          <select
            className="input"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as RfidCardKind | '');
              setPage(1);
            }}
          >
            <option value="">Tất cả</option>
            {(Object.keys(KIND) as RfidCardKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND[k]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {note && (
        <p className={`queue-note ${note.tone}`} role={note.tone === 'ok' ? 'status' : 'alert'}>
          {note.text}
        </p>
      )}
      {isLoading ? (
        <p className="muted">Đang tải…</p>
      ) : error && !data ? (
        <p role="alert">{rfidError(error)}</p>
      ) : !data || data.items.length === 0 ? (
        <div className="card">
          <p className="muted">
            {filtered ? 'Không có thẻ nào khớp bộ lọc.' : 'Chưa có thẻ RFID nào được đăng ký.'}
          </p>
        </div>
      ) : (
        <div className="card table-card">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Mã thẻ</th>
                  <th scope="col">Loại</th>
                  <th scope="col">Trạng thái</th>
                  <th scope="col">Tài xế</th>
                  <th scope="col">Ngày đăng ký</th>
                  <th scope="col">Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((card) => (
                  <CardRow key={card.id} card={card} onAction={(a) => void act(card, a)} />
                ))}
              </tbody>
            </table>
          </div>
          <nav className="pager" aria-label="Phân trang">
            <span className="muted">
              {total} thẻ · Trang {page} / {pages}
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
