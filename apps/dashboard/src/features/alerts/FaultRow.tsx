/**
 * One FaultEvent (a table row) on screen 21 with its STM-6 actions (WF-04): Xác nhận (t2) → Reset (t4) → wait for
 * the connector to recover (t5) or the wait to expire (t6) → Đóng after a site visit (t7).
 * Buttons come from the server's `allowed_actions` (D38); the server still decides, and a refused
 * action shows its message on the alert. Reset: Soft by default, Hard selectable (D40); on 409
 * `sessions_active` a second confirmation lists the sessions and resends with `force`.
 * Ported from the FE-01 reference; the Charge Point Detail link arrives with FE-05 (D41).
 */
import { useEffect, useState } from 'react';
import type { FaultAction, OperatorFault, ResetType } from '@powerme/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import {
  errorMessage,
  useAcknowledgeFaultMutation,
  useCloseFaultMutation,
  useResetFaultMutation,
  type ApiError,
} from '../../core/api/api';

type Pending = FaultAction | 'force' | null;
type Note = { tone: 'ok' | 'warn' | 'error'; text: string } | null;

const STATUS = {
  raised: 'Mới',
  acknowledged: 'Đã xác nhận',
  resetting: 'Đang reset',
  resolved: 'Đã xử lý',
} as const;
const SEVERITY = { critical: 'Nghiêm trọng', major: 'Nặng', minor: 'Nhẹ', none: '—' } as const;
const BUTTON: Record<FaultAction, string> = {
  acknowledge: 'Xác nhận',
  reset: 'Reset',
  close: 'Đóng',
};

const where = (no: number | null) => (no ? `Connector ${no}` : 'toàn Charge Point');

/** D39 kind label: Faulted · code · Connector, Offline · whole charge point, Driver report · Connector. */
export function kindLabel(f: OperatorFault): string {
  if (f.kind === 'offline') return 'Offline · toàn Charge Point';
  if (f.kind === 'driver_report') return `Driver report · ${where(f.connector_no)}`;
  return `Faulted · ${f.error_code ?? '—'} · ${where(f.connector_no)}`;
}

const time = (iso: string) =>
  new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'medium' });

function Countdown({ deadline }: { deadline: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1000));
  return <span className="muted">Chờ connector hoạt động lại · còn {left} s</span>;
}

export function FaultRow({ fault }: { fault: OperatorFault }) {
  const [pending, setPending] = useState<Pending>(null);
  const [type, setType] = useState<ResetType>('Soft');
  const [sessions, setSessions] = useState<ApiError['sessions']>([]);
  const [note, setNote] = useState<Note>(null);
  const [ack, ackState] = useAcknowledgeFaultMutation();
  const [reset, resetState] = useResetFaultMutation();
  const [close, closeState] = useCloseFaultMutation();
  const busy = ackState.isLoading || resetState.isLoading || closeState.isLoading;
  const no = `#${fault.event_no}`;

  const run = async () => {
    if (pending === 'acknowledge' || pending === 'close') {
      const r = await (pending === 'acknowledge' ? ack(fault.id) : close(fault.id));
      setNote(
        r.error
          ? { tone: 'error', text: errorMessage(r.error) }
          : { tone: 'ok', text: `${pending === 'close' ? 'Đã đóng' : 'Đã xác nhận'} sự cố ${no}` },
      );
    } else if (pending === 'reset' || pending === 'force') {
      const r = await reset({
        id: fault.id,
        type,
        ...(pending === 'force' ? { force: true } : {}),
      });
      const err = r.error as ApiError | undefined;
      if (err?.code === 'sessions_active' && pending === 'reset') {
        setSessions(err.sessions ?? []);
        setPending('force');
        return;
      }
      if (err) setNote({ tone: 'error', text: errorMessage(err) });
      else if (r.data?.reset_status === 'Rejected')
        setNote({
          tone: 'warn',
          text: `Charge Point từ chối Reset — sự cố ${no} về "Đã xác nhận"`,
        });
      else
        setNote({
          tone: 'ok',
          text: `Charge Point nhận lệnh Reset ${type}${r.data?.forced ? ' (đã cắt phiên đang sạc)' : ''}`,
        });
    }
    setPending(null);
  };

  return (
    <tr
      aria-label={`Sự cố ${no}`}
      className={`sev-${fault.status === 'resolved' ? 'none' : fault.severity}`}
    >
      <td className="num">{no}</td>
      <td>
        <div className="cell-title">{kindLabel(fault)}</div>
        <div className="muted small">{fault.hint}</div>
        {fault.report_count > 0 && (
          <span className="pill major">{fault.report_count} tài xế báo lỗi</span>
        )}
      </td>
      <td>
        <div className="nowrap">{fault.charge_point_serial}</div>
        {fault.station_name && <div className="muted small">{fault.station_name}</div>}
        {!fault.charge_point_online && <span className="pill muted">Charge Point offline</span>}
      </td>
      <td>
        <span className={`pill ${fault.severity}`}>{SEVERITY[fault.severity]}</span>
      </td>
      <td>
        <span className="pill">{STATUS[fault.status]}</span>
        {fault.status === 'resetting' && fault.reset?.deadline && (
          <div className="small">
            <Countdown deadline={fault.reset.deadline} />
          </div>
        )}
        {fault.status === 'resolved' && fault.resolved_at && (
          <div className="muted small">Xử lý xong {time(fault.resolved_at)}</div>
        )}
      </td>
      <td className="nowrap">{time(fault.raised_at)}</td>
      <td>
        {fault.allowed_actions.length > 0 && (
          <div className="btn-row">
            {fault.allowed_actions.map((a) => (
              <button
                key={a}
                type="button"
                className={`btn small${a === 'acknowledge' ? ' primary' : ''}`}
                disabled={busy}
                onClick={() => {
                  setNote(null);
                  setType('Soft');
                  setPending(a);
                }}
              >
                {BUTTON[a]}
              </button>
            ))}
          </div>
        )}
        {note && (
          <p className={`note ${note.tone}`} role={note.tone === 'error' ? 'alert' : 'status'}>
            {note.text}
          </p>
        )}
        {pending && (
          <ConfirmDialog
            title={
              pending === 'acknowledge'
                ? `Xác nhận sự cố ${no}?`
                : pending === 'close'
                  ? `Đóng sự cố ${no}?`
                  : pending === 'reset'
                    ? `Gửi Reset tới ${fault.charge_point_serial}?`
                    : `${fault.charge_point_serial} đang có phiên sạc`
            }
            confirmLabel={
              pending === 'acknowledge'
                ? 'Xác nhận'
                : pending === 'close'
                  ? 'Đóng sự cố'
                  : pending === 'reset'
                    ? 'Gửi Reset'
                    : 'Vẫn Reset'
            }
            busy={busy}
            onCancel={() => setPending(null)}
            onConfirm={run}
          >
            {pending === 'acknowledge' && <p>Bạn đã thấy cảnh báo này và sẽ xử lý (UC-OPS-03).</p>}
            {pending === 'close' && (
              <p>Chỉ đóng sau khi kỹ thuật đã kiểm tra tại chỗ. Trạng thái connector do trụ báo.</p>
            )}
            {pending === 'reset' && (
              <>
                <fieldset className="field">
                  <legend>Kiểu Reset</legend>
                  {(['Soft', 'Hard'] as const).map((t) => (
                    <label key={t}>
                      <input
                        type="radio"
                        name={`reset-${fault.id}`}
                        checked={type === t}
                        onChange={() => setType(t)}
                      />{' '}
                      {t === 'Soft'
                        ? 'Soft — khởi động lại phần mềm'
                        : 'Hard — khởi động lại toàn trụ'}
                    </label>
                  ))}
                </fieldset>
                <p className="muted">
                  Reset khởi động lại cả Charge Point. Sự cố chuyển sang "Đang reset" cho tới khi
                  connector hoạt động lại hoặc hết hạn chờ.
                </p>
              </>
            )}
            {pending === 'force' && (
              <>
                <p>Reset sẽ dừng giữa chừng các phiên sạc này (BR-P07):</p>
                <ul>
                  {(sessions ?? []).map((s) => (
                    <li key={s.session_id}>
                      Connector {s.connector_no} — phiên {s.session_id}
                    </li>
                  ))}
                </ul>
                <p>Chỉ tiếp tục khi không thể chờ các phiên kết thúc.</p>
              </>
            )}
          </ConfirmDialog>
        )}
      </td>
    </tr>
  );
}
