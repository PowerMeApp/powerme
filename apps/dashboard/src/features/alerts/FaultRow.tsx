/**
 * One FaultEvent (a table row) on screen 21 with its STM-6 actions (WF-04): Xác nhận (t2) → Reset (t4) → wait for
 * the connector to recover (t5) or the wait to expire (t6) → Đóng after a site visit (t7).
 * Buttons come from the server's `allowed_actions` (D38); the server still decides, and a refused
 * action shows its message on the alert. Reset: Soft by default, Hard selectable (D40); on 409
 * `sessions_active` a second confirmation lists the sessions and resends with `force`.
 * Ported from the FE-01 reference; the serial links to Charge Point Detail (FE-05, D41).
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
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
  resetting: 'Đang khởi động lại',
  resolved: 'Đã xử lý',
} as const;
const SEVERITY = { critical: 'Nghiêm trọng', major: 'Nặng', minor: 'Nhẹ', none: '—' } as const;
const BUTTON: Record<FaultAction, string> = {
  acknowledge: 'Xác nhận',
  reset: 'Khởi động lại',
  close: 'Đóng',
};

const where = (no: number | null) => (no ? `Súng ${no}` : 'toàn trụ sạc');

/**
 * D39 kind label: Faulted · code · Connector, Offline · whole charge point, Driver report · Connector.
 * A driver report that also got a hardware code (T131) shows it: Driver report · code · Connector.
 */
export function kindLabel(f: OperatorFault): string {
  if (f.kind === 'offline') return 'Mất kết nối · toàn trụ sạc';
  if (f.kind === 'driver_report')
    return `Tài xế báo lỗi · ${f.error_code ? `${f.error_code} · ` : ''}${where(f.connector_no)}`;
  return `Trụ báo lỗi · ${f.error_code ?? '—'} · ${where(f.connector_no)}`;
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
  return <span className="muted">Chờ súng hoạt động lại · còn {left} s</span>;
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
          text: `Trụ sạc từ chối khởi động lại — sự cố ${no} về "Đã xác nhận"`,
        });
      else
        setNote({
          tone: 'ok',
          text: `Trụ sạc nhận lệnh khởi động lại ${type === 'Soft' ? 'phần mềm' : 'toàn trụ'}${r.data?.forced ? ' (đã cắt phiên đang sạc)' : ''}`,
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
        <Link className="nowrap" to={`/operator/charge-points/${fault.charge_point_id}`}>
          {fault.charge_point_serial}
        </Link>
        {fault.station_name && <div className="muted small">{fault.station_name}</div>}
        {!fault.charge_point_online && <span className="pill muted">Trụ sạc mất kết nối</span>}
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
                    ? `Khởi động lại ${fault.charge_point_serial}?`
                    : `${fault.charge_point_serial} đang có phiên sạc`
            }
            confirmLabel={
              pending === 'acknowledge'
                ? 'Xác nhận'
                : pending === 'close'
                  ? 'Đóng sự cố'
                  : pending === 'reset'
                    ? 'Gửi lệnh'
                    : 'Vẫn gửi lệnh'
            }
            busy={busy}
            onCancel={() => setPending(null)}
            onConfirm={run}
          >
            {pending === 'acknowledge' && <p>Bạn đã thấy cảnh báo này và sẽ xử lý.</p>}
            {pending === 'close' && (
              <p>Chỉ đóng sau khi kỹ thuật đã kiểm tra tại chỗ. Trạng thái súng do trụ báo.</p>
            )}
            {pending === 'reset' && (
              <>
                <fieldset className="field">
                  <legend>Kiểu khởi động lại</legend>
                  {(['Soft', 'Hard'] as const).map((t) => (
                    <label key={t}>
                      <input
                        type="radio"
                        name={`reset-${fault.id}`}
                        checked={type === t}
                        onChange={() => setType(t)}
                      />{' '}
                      {t === 'Soft'
                        ? 'Khởi động lại phần mềm'
                        : 'Khởi động lại toàn trụ (tắt rồi bật)'}
                    </label>
                  ))}
                </fieldset>
                <p className="muted">
                  Lệnh này khởi động lại cả trụ sạc. Sự cố chuyển sang "Đang khởi động lại" cho tới
                  khi connector hoạt động lại hoặc hết hạn chờ.
                </p>
              </>
            )}
            {pending === 'force' && (
              <>
                <p>Khởi động lại sẽ dừng giữa chừng các phiên sạc này:</p>
                <ul>
                  {(sessions ?? []).map((s) => (
                    <li key={s.session_id}>
                      Súng {s.connector_no} — phiên {s.session_id}
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
