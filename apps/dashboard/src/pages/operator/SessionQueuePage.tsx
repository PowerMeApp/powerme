/**
 * Screen 23 — Unattributed Sessions (UC-OPS-05, F-12, WF-03; FE-12). Two queues of the signed-in
 * staff's Operator, from GET /api/operator/v1/sessions:
 *   - "Chưa gắn tài xế": stopped `unattributed` sessions (unknown card, free vend…). Assign to a
 *     driver (then billed, BR-P06) or close without billing. Free vend / wallet-card sessions can
 *     only be closed (BR-P08).
 *   - "Cần xem lại": sessions in `review` (reconciliation conflict). Resolve → `reconciled`
 *     (STM-1 #17), which also settles the bill.
 * Every decision needs a note and is logged with the staff user as actor (CSMS side). The rules
 * live in Trí's services (BE-18, BE-24); this page only collects the decision. Queue kept in
 * `?queue=review`; polled every 10 s.
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { ReviewSession, SessionQueue, UnattributedSession } from '@powerme/shared';
import { Breadcrumbs } from '../../components/Breadcrumbs';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { CountBadge } from '../../components/CountBadge';
import {
  errorMessage,
  SESSION_PAGE_SIZE,
  useAssignSessionMutation,
  useCloseSessionMutation,
  useOperatorSessionsQuery,
  useOperatorSummaryQuery,
  useResolveSessionMutation,
  type ApiError,
} from '../../core/api/api';
import { ago, useNow } from '../../features/chargePoints/format';

export const SESSION_POLL_MS = 10_000;

const QUEUES: readonly [SessionQueue, string][] = [
  ['unattributed', 'Chưa gắn tài xế'],
  ['review', 'Cần xem lại'],
];

const ORIGIN: Record<string, string> = {
  rfid: 'Thẻ RFID',
  free_vend: 'Free vend',
  app: 'App',
  remote: 'Lệnh từ xa',
};

/** Close reasons (service: a-z, 0-9, _). */
const CLOSE_REASONS: readonly [string, string][] = [
  ['owner_unknown', 'Không xác định được chủ thẻ'],
  ['free_vend_ok', 'Free vend hợp lệ, không tính tiền'],
  ['test_session', 'Phiên thử nghiệm / bảo trì'],
  ['other', 'Lý do khác (ghi trong ghi chú)'],
];
/** Review verdicts (service: a-z, 0-9, _). */
const RESOLUTIONS: readonly [string, string][] = [
  ['meter_confirmed', 'Đã đối chiếu công tơ, số đo đúng'],
  ['station_data_accepted', 'Chấp nhận số liệu trụ gửi'],
  ['other', 'Kết luận khác (ghi trong ghi chú)'],
];

const NOT_ASSIGNABLE: Record<string, string> = {
  free_vend_not_billable: 'Free vend — không bao giờ tính tiền, chỉ đóng được',
  wallet_card_not_billable: 'Thẻ ví đã trả tại trụ — chỉ đóng được',
};

/** How the session is paid, in plain words (raw `payment_mode` never shown). */
const PAYMENT: Record<string, string> = {
  csms_billed: 'Tính tiền',
  unattributed: 'Không định danh',
  station_wallet: 'Thẻ ví tại trụ',
};

/** Reconciliation record kinds, in plain words; the raw detail stays in the tooltip. */
const RECORD: Record<string, string> = {
  conflict: 'Số đo cuối không khớp chuỗi đo',
  late_sample: 'Mẫu đo đến muộn',
  meter_gap: 'Thiếu mẫu đo',
  unknown_id_tag: 'Thẻ không xác định',
  replay: 'Bản tin gửi lại',
  duplicate: 'Bản tin trùng',
};

/**
 * One open reconciliation record as a readable label: `conflict: meter_stop…` → "Số đo cuối không
 * khớp chuỗi đo". Unattributed records carry only details (`card_status=…`): `fallback` names them.
 */
function RecordList({ records, fallback }: { records: string[]; fallback: string }) {
  if (records.length === 0) return <>{fallback}</>;
  return (
    <ul className="record-list">
      {records.map((text, i) => {
        const kind = /^([a-z_]+):/.exec(text)?.[1];
        const label = kind ? (RECORD[kind] ?? kind) : fallback;
        return (
          <li key={i} title={text}>
            {label}
          </li>
        );
      })}
    </ul>
  );
}

/** Session-specific error text; anything else falls back to the shared messages. */
export function sessionError(err: unknown): string {
  switch ((err as Partial<ApiError> | undefined)?.code) {
    case 'not_found':
      return 'Không tìm thấy phiên này trong các trụ sạc của Operator';
    case 'driver_not_eligible':
      return 'Tài xế không hoạt động hoặc không có Charging Credit đang mở';
    case 'free_vend_not_billable':
    case 'wallet_card_not_billable':
      return 'Phiên này không tính tiền được — chỉ đóng được';
    case 'already_resolved':
      return 'Phiên đã có quyết định khác, danh sách đã được làm mới';
    case 'not_in_review':
      return 'Phiên không còn chờ xem lại, danh sách đã được làm mới';
    case 'not_unattributed':
      return 'Phiên không còn là phiên chưa gắn tài xế';
    case 'session_not_stopped':
      return 'Phiên chưa kết thúc trên trụ — chưa quyết định được';
    case 'invalid_input':
      return 'Dữ liệu không hợp lệ (ghi chú 1–500 ký tự)';
    case 'sessions_unavailable':
      return 'Máy chủ chưa bật xử lý phiên';
  }
  return errorMessage(err);
}

const kwh = (wh: number | null) =>
  wh === null ? '—' : `${(wh / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} kWh`;

type Decision =
  | { kind: 'assign'; s: UnattributedSession }
  | { kind: 'close'; s: UnattributedSession }
  | { kind: 'resolve'; s: ReviewSession };
type Note = { tone: 'ok' | 'error'; text: string } | null;

function DecisionDialog({
  decision,
  onDone,
  onCancel,
}: {
  decision: Decision;
  onDone: (text: string) => void;
  onCancel: () => void;
}) {
  const [assign, a] = useAssignSessionMutation();
  const [close, c] = useCloseSessionMutation();
  const [resolve, r] = useResolveSessionMutation();
  const busy = a.isLoading || c.isLoading || r.isLoading;
  const [driverId, setDriverId] = useState('');
  const [code, setCode] = useState(
    decision.kind === 'close' ? CLOSE_REASONS[0]![0] : RESOLUTIONS[0]![0],
  );
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { s } = decision;
  const no = `#${s.transaction_no}`;

  async function submit() {
    const text = note.trim();
    if (decision.kind === 'assign' && !/^[1-9][0-9]{0,14}$/.test(driverId.trim()))
      return setError('Nhập ID tài xế (số)');
    if (!text || text.length > 500) return setError('Ghi chú bắt buộc, tối đa 500 ký tự');
    setError(null);
    const id = s.session_id;
    const res =
      decision.kind === 'assign'
        ? await assign({ id, driver_id: driverId.trim(), note: text })
        : decision.kind === 'close'
          ? await close({ id, reason: code, note: text })
          : await resolve({ id, resolution: code, note: text });
    if ('error' in res) return setError(sessionError(res.error));
    const settled = res.data.settlement ? ` · quyết toán: ${res.data.settlement}` : '';
    onDone(
      decision.kind === 'assign'
        ? `Đã gán phiên ${no} cho tài xế ${driverId.trim()}${settled}`
        : decision.kind === 'close'
          ? `Đã đóng phiên ${no}, không tính tiền`
          : `Phiên ${no} đã chốt đối soát (reconciled)${settled}`,
    );
  }

  const title =
    decision.kind === 'assign'
      ? `Gán phiên ${no} cho tài xế`
      : decision.kind === 'close'
        ? `Đóng phiên ${no} không tính tiền`
        : `Chốt đối soát phiên ${no}`;
  return (
    <ConfirmDialog
      title={title}
      confirmLabel={
        decision.kind === 'assign'
          ? 'Gán và tính tiền'
          : decision.kind === 'close'
            ? 'Đóng phiên'
            : 'Chốt đối soát'
      }
      busy={busy}
      onCancel={onCancel}
      onConfirm={() => void submit()}
    >
      <p className="muted small">
        {s.site_name} · {s.charge_point_serial} · Súng {s.connector_no} · {s.id_tag} ·{' '}
        {kwh(s.energy_wh)}
      </p>
      <p>
        {decision.kind === 'assign'
          ? 'Phiên chuyển sang tính tiền, trừ vào Charging Credit của tài xế. Không hoàn tác được.'
          : decision.kind === 'close'
            ? 'Phiên giữ không tính tiền và rời hàng đợi; quyết định được ghi lại.'
            : 'Chốt số đo dùng để tính tiền. Phiên đã kết thúc sẽ được trừ tiền vào tài khoản tài xế.'}
      </p>
      {decision.kind === 'assign' ? (
        <label className="field">
          ID tài xế
          <input
            className="input"
            inputMode="numeric"
            value={driverId}
            onChange={(e) => setDriverId(e.target.value)}
          />
        </label>
      ) : (
        <label className="field">
          {decision.kind === 'close' ? 'Lý do' : 'Kết luận'}
          <select className="input" value={code} onChange={(e) => setCode(e.target.value)}>
            {(decision.kind === 'close' ? CLOSE_REASONS : RESOLUTIONS).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        Ghi chú (bắt buộc)
        <textarea
          className="input"
          rows={3}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      {error && <p role="alert">{error}</p>}
    </ConfirmDialog>
  );
}

function UnattributedRow({
  s,
  now,
  onDecide,
}: {
  s: UnattributedSession;
  now: number;
  onDecide: (d: Decision) => void;
}) {
  const blocked = s.not_assignable_reason ? NOT_ASSIGNABLE[s.not_assignable_reason] : null;
  return (
    <tr aria-label={`Phiên #${s.transaction_no}`}>
      <td>
        <span className="cell-title">#{s.transaction_no}</span>
        <div className="muted small">dừng {ago(s.stopped_at, now)}</div>
      </td>
      <td>
        <Link className="cell-title" to={`/operator/charge-points/${s.charge_point_id}`}>
          {s.charge_point_serial}
        </Link>
        <div className="muted small">
          Súng {s.connector_no} · <Link to={`/operator/stations/${s.site_id}`}>{s.site_name}</Link>
        </div>
        {s.delivered_offline && <span className="pill major">gửi bù sau khi nối lại</span>}
      </td>
      <td>
        {s.id_tag}
        <div className="muted small">{ORIGIN[s.origin] ?? s.origin}</div>
      </td>
      <td className="nowrap">{kwh(s.energy_wh)}</td>
      <td className="small">
        {blocked ?? <RecordList records={s.open_records} fallback="Thẻ không xác định" />}
      </td>
      <td>
        <div className="btn-row">
          <button
            type="button"
            className="btn small"
            disabled={!!blocked}
            title={blocked ?? undefined}
            onClick={() => onDecide({ kind: 'assign', s })}
          >
            Gán tài xế
          </button>
          <button
            type="button"
            className="btn small ghost"
            onClick={() => onDecide({ kind: 'close', s })}
          >
            Đóng
          </button>
        </div>
      </td>
    </tr>
  );
}

function ReviewRow({ s, onDecide }: { s: ReviewSession; onDecide: (d: Decision) => void }) {
  return (
    <tr aria-label={`Phiên #${s.transaction_no}`}>
      <td>
        <span className="cell-title">#{s.transaction_no}</span>
        <div className="muted small">{s.stopped ? 'đã dừng' : 'chưa có StopTransaction'}</div>
      </td>
      <td>
        <Link className="cell-title" to={`/operator/charge-points/${s.charge_point_id}`}>
          {s.charge_point_serial}
        </Link>
        <div className="muted small">
          Súng {s.connector_no} · <Link to={`/operator/stations/${s.site_id}`}>{s.site_name}</Link>
        </div>
      </td>
      <td>
        {s.id_tag}
        <div className="muted small">
          {ORIGIN[s.origin] ?? s.origin} · {PAYMENT[s.payment_mode] ?? s.payment_mode}
        </div>
      </td>
      <td className="nowrap">{kwh(s.energy_wh)}</td>
      <td className="small">
        <RecordList records={s.open_records} fallback="—" />
      </td>
      <td>
        <button
          type="button"
          className="btn small"
          onClick={() => onDecide({ kind: 'resolve', s })}
        >
          Chốt đối soát
        </button>
      </td>
    </tr>
  );
}

export function SessionQueuePage() {
  const [params, setParams] = useSearchParams();
  const queue: SessionQueue = params.get('queue') === 'review' ? 'review' : 'unattributed';
  const [page, setPage] = useState(1);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [note, setNote] = useState<Note>(null);
  const now = useNow();
  const { data, error, isLoading } = useOperatorSessionsQuery(
    { queue, page },
    { pollingInterval: SESSION_POLL_MS, skipPollingIfUnfocused: true },
  );
  const current = data?.queue === queue ? data : undefined;
  const total = current?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / SESSION_PAGE_SIZE));
  if (current && page > pages) setPage(pages);

  // Count of each queue on its tab (same summary as the menu badge).
  const { data: summary } = useOperatorSummaryQuery(undefined, {
    pollingInterval: SESSION_POLL_MS,
    skipPollingIfUnfocused: true,
  });
  const counts: Record<SessionQueue, number | undefined> = {
    unattributed: summary?.unattributed_sessions,
    review: summary?.sessions_to_review,
  };

  const switchQueue = (next: SessionQueue) => {
    setPage(1);
    setNote(null);
    setParams(
      (p) => {
        if (next === 'review') p.set('queue', 'review');
        else p.delete('queue');
        return p;
      },
      { replace: true },
    );
  };

  return (
    <>
      <Breadcrumbs items={[{ label: 'Phiên cần xử lý' }]} />
      <div className="page-head">
        <h1>Phiên cần xử lý</h1>
        <p>Phiên chưa gắn tài xế và phiên cần xem lại của Operator · cập nhật mỗi 10 giây</p>
      </div>
      <div className="filters">
        <div className="queue-switch" role="group" aria-label="Hàng đợi">
          {QUEUES.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`btn small ${queue === id ? '' : 'ghost'}`}
              aria-pressed={queue === id}
              onClick={() => switchQueue(id)}
            >
              {label}
              <CountBadge count={counts[id]} label="phiên" />
            </button>
          ))}
        </div>
      </div>
      {note && (
        <p className={`queue-note ${note.tone}`} role={note.tone === 'ok' ? 'status' : 'alert'}>
          {note.text}
        </p>
      )}
      {isLoading || (!current && !error) ? (
        <p className="muted">Đang tải…</p>
      ) : error && !current ? (
        <p role="alert">{sessionError(error)}</p>
      ) : !current || current.items.length === 0 ? (
        <div className="card">
          <p className="muted">
            {queue === 'review'
              ? 'Không có phiên nào cần xem lại.'
              : 'Không có phiên nào chưa gắn tài xế.'}
          </p>
        </div>
      ) : (
        <div className="card table-card">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Phiên</th>
                  <th scope="col">Trụ sạc · trạm sạc</th>
                  <th scope="col">Thẻ / nguồn</th>
                  <th scope="col">Năng lượng</th>
                  <th scope="col">{queue === 'review' ? 'Bản ghi đối soát' : 'Lý do'}</th>
                  <th scope="col">Xử lý</th>
                </tr>
              </thead>
              <tbody>
                {current.queue === 'unattributed'
                  ? current.items.map((s) => (
                      <UnattributedRow key={s.session_id} s={s} now={now} onDecide={setDecision} />
                    ))
                  : current.items.map((s) => (
                      <ReviewRow key={s.session_id} s={s} onDecide={setDecision} />
                    ))}
              </tbody>
            </table>
          </div>
          <nav className="pager" aria-label="Phân trang">
            <span className="muted">
              {total} phiên · Trang {page} / {pages}
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
      {decision && (
        <DecisionDialog
          key={decision.s.session_id + decision.kind}
          decision={decision}
          onCancel={() => setDecision(null)}
          onDone={(text) => {
            setDecision(null);
            setNote({ tone: 'ok', text });
          }}
        />
      )}
    </>
  );
}
