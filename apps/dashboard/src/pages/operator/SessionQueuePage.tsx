/**
 * Screen 23 — Unattributed Sessions (UC-OPS-05, F-12, WF-03; FE-12). Two queues of the signed-in
 * staff's Operator, from GET /api/operator/v1/sessions:
 *   - "Chưa gắn tài xế": stopped `unattributed` sessions (unknown card, free vend…). Assign to a
 *     driver (then billed, BR-P06) or close without billing. Sạc miễn phí / wallet-card sessions can
 *     only be closed (BR-P08).
 *   - "Cần xem lại": sessions in `review` (reconciliation conflict). Resolve → `reconciled`
 *     (STM-1 #17), which also settles the bill.
 * Every decision needs a note and is logged with the staff user as actor (CSMS side). The rules
 * live in Trí's services (BE-18, BE-24); this page only collects the decision. Queue kept in
 * `?queue=review`; polled every 10 s.
 */
import { Button, Group, Loader, NativeSelect, Table, Textarea, TextInput } from '@mantine/core';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { ReviewSession, SessionQueue, UnattributedSession } from '@powerme/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { FieldError } from '../../components/Field';
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
import { DataTable, EmptyState } from '../../ui/DataTable';
import { Notice, type Note } from '../../ui/Notice';
import { PageHeader } from '../../ui/PageHeader';
import { Pager, pageCount } from '../../ui/Pager';
import { QueueSwitch } from '../../ui/QueueSwitch';
import { StatusBadge } from '../../ui/StatusBadge';

export const SESSION_POLL_MS = 10_000;

const QUEUES: readonly [SessionQueue, string][] = [
  ['unattributed', 'Chưa gắn tài xế'],
  ['review', 'Cần xem lại'],
];

const ORIGIN: Record<string, string> = {
  rfid: 'Thẻ RFID',
  free_vend: 'Sạc miễn phí',
  app: 'App',
  remote: 'Lệnh từ xa',
};

/** Close reasons (service: a-z, 0-9, _). */
const CLOSE_REASONS: readonly [string, string][] = [
  ['owner_unknown', 'Không xác định được chủ thẻ'],
  ['free_vend_ok', 'Thẻ sạc miễn phí hợp lệ, không tính tiền'],
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
  free_vend_not_billable: 'Sạc miễn phí — không bao giờ tính tiền, chỉ đóng được',
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
      return 'Không tìm thấy phiên này trong các trụ sạc của đơn vị vận hành';
    case 'driver_not_eligible':
      return 'Tài xế không hoạt động hoặc không có tín dụng sạc đang mở';
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

/** Settlement result after a decision, in words (the raw value is the CSMS job state). */
const SETTLEMENT: Record<string, string> = {
  posted: 'đã trừ tiền',
  pending: 'đang chờ',
  ineligible: 'không đủ điều kiện trừ tiền',
};

type Decision =
  | { kind: 'assign'; s: UnattributedSession }
  | { kind: 'close'; s: UnattributedSession }
  | { kind: 'resolve'; s: ReviewSession };

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
    const settled = res.data.settlement
      ? ` · quyết toán: ${SETTLEMENT[res.data.settlement] ?? res.data.settlement}`
      : '';
    onDone(
      decision.kind === 'assign'
        ? `Đã gán phiên ${no} cho tài xế ${driverId.trim()}${settled}`
        : decision.kind === 'close'
          ? `Đã đóng phiên ${no}, không tính tiền`
          : `Phiên ${no} đã chốt đối soát${settled}`,
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
          ? 'Phiên chuyển sang tính tiền, trừ vào tín dụng sạc của tài xế. Không hoàn tác được.'
          : decision.kind === 'close'
            ? 'Phiên giữ không tính tiền và rời hàng đợi; quyết định được ghi lại.'
            : 'Chốt số đo dùng để tính tiền. Phiên đã kết thúc sẽ được trừ tiền vào tài khoản tài xế.'}
      </p>
      {decision.kind === 'assign' ? (
        <TextInput
          label="ID tài xế"
          inputMode="numeric"
          value={driverId}
          onChange={(e) => setDriverId(e.currentTarget.value)}
        />
      ) : (
        <NativeSelect
          label={decision.kind === 'close' ? 'Lý do' : 'Kết luận'}
          value={code}
          onChange={(e) => setCode(e.currentTarget.value)}
          data={(decision.kind === 'close' ? CLOSE_REASONS : RESOLUTIONS).map(([value, label]) => ({
            value,
            label,
          }))}
        />
      )}
      <Textarea
        label="Ghi chú (bắt buộc)"
        rows={3}
        autosize
        minRows={3}
        maxLength={500}
        value={note}
        onChange={(e) => setNote(e.currentTarget.value)}
      />
      <FieldError message={error ?? undefined} />
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
    <Table.Tr aria-label={`Phiên #${s.transaction_no}`} data-tone={blocked ? 'muted' : 'major'}>
      <Table.Td>
        <span className="cell-title">#{s.transaction_no}</span>
        <div className="muted small">dừng {ago(s.stopped_at, now)}</div>
      </Table.Td>
      <Table.Td>
        <Link className="cell-title" to={`/operator/charge-points/${s.charge_point_id}`}>
          {s.charge_point_serial}
        </Link>
        <div className="muted small">
          Súng {s.connector_no} · <Link to={`/operator/stations/${s.site_id}`}>{s.site_name}</Link>
        </div>
        {s.delivered_offline && (
          <div>
            <StatusBadge tone="major">gửi bù sau khi nối lại</StatusBadge>
          </div>
        )}
      </Table.Td>
      <Table.Td>
        {s.id_tag}
        <div className="muted small">{ORIGIN[s.origin] ?? s.origin}</div>
      </Table.Td>
      <Table.Td className="nowrap">{kwh(s.energy_wh)}</Table.Td>
      <Table.Td className="small">
        {blocked ?? <RecordList records={s.open_records} fallback="Thẻ không xác định" />}
      </Table.Td>
      <Table.Td>
        <Group gap={6} wrap="nowrap">
          <Button
            type="button"
            size="compact-sm"
            disabled={!!blocked}
            title={blocked ?? undefined}
            onClick={() => onDecide({ kind: 'assign', s })}
          >
            Gán tài xế
          </Button>
          <Button
            type="button"
            size="compact-sm"
            variant="default"
            onClick={() => onDecide({ kind: 'close', s })}
          >
            Đóng
          </Button>
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

function ReviewRow({ s, onDecide }: { s: ReviewSession; onDecide: (d: Decision) => void }) {
  return (
    <Table.Tr aria-label={`Phiên #${s.transaction_no}`} data-tone="major">
      <Table.Td>
        <span className="cell-title">#{s.transaction_no}</span>
        <div className="muted small">{s.stopped ? 'đã dừng' : 'trụ chưa báo kết thúc phiên'}</div>
      </Table.Td>
      <Table.Td>
        <Link className="cell-title" to={`/operator/charge-points/${s.charge_point_id}`}>
          {s.charge_point_serial}
        </Link>
        <div className="muted small">
          Súng {s.connector_no} · <Link to={`/operator/stations/${s.site_id}`}>{s.site_name}</Link>
        </div>
      </Table.Td>
      <Table.Td>
        {s.id_tag}
        <div className="muted small">
          {ORIGIN[s.origin] ?? s.origin} · {PAYMENT[s.payment_mode] ?? s.payment_mode}
        </div>
      </Table.Td>
      <Table.Td className="nowrap">{kwh(s.energy_wh)}</Table.Td>
      <Table.Td className="small">
        <RecordList records={s.open_records} fallback="—" />
      </Table.Td>
      <Table.Td>
        <Button type="button" size="compact-sm" onClick={() => onDecide({ kind: 'resolve', s })}>
          Chốt đối soát
        </Button>
      </Table.Td>
    </Table.Tr>
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
  const pages = pageCount(total, SESSION_PAGE_SIZE);
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

  const first = (page - 1) * SESSION_PAGE_SIZE + 1;

  return (
    <>
      <PageHeader crumbs={[{ label: 'Phiên cần xử lý' }]} title="Phiên cần xử lý" />
      <QueueSwitch
        label="Hàng đợi"
        value={queue}
        onChange={switchQueue}
        items={QUEUES.map(([key, label]) => ({
          key,
          label,
          count: counts[key],
          countLabel: 'phiên',
        }))}
      />
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      {isLoading || (!current && !error) ? (
        <Loader size="sm" aria-label="Đang tải…" />
      ) : error && !current ? (
        <Notice tone="error">{sessionError(error)}</Notice>
      ) : !current || current.items.length === 0 ? (
        <EmptyState>
          {queue === 'review'
            ? 'Không có phiên nào cần xem lại.'
            : 'Không có phiên nào chưa gắn tài xế.'}
        </EmptyState>
      ) : (
        <DataTable
          minWidth={960}
          footer={
            <Pager
              first={first}
              last={first + current.items.length - 1}
              total={total}
              page={page}
              pages={pages}
              onPage={setPage}
            />
          }
        >
          <Table.Thead>
            <Table.Tr>
              <Table.Th scope="col">Phiên</Table.Th>
              <Table.Th scope="col">Trụ sạc · trạm sạc</Table.Th>
              <Table.Th scope="col">Thẻ / nguồn</Table.Th>
              <Table.Th scope="col">Năng lượng</Table.Th>
              <Table.Th scope="col">{queue === 'review' ? 'Bản ghi đối soát' : 'Lý do'}</Table.Th>
              <Table.Th scope="col">Xử lý</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {current.queue === 'unattributed'
              ? current.items.map((s) => (
                  <UnattributedRow key={s.session_id} s={s} now={now} onDecide={setDecision} />
                ))
              : current.items.map((s) => (
                  <ReviewRow key={s.session_id} s={s} onDecide={setDecision} />
                ))}
          </Table.Tbody>
        </DataTable>
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
