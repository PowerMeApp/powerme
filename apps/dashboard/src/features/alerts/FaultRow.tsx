/**
 * One FaultEvent (a table row) on screen 21 with its STM-6 actions (WF-04): Xác nhận (t2) → Reset (t4) → wait for
 * the connector to recover (t5) or the wait to expire (t6) → Đóng after a site visit (t7).
 * Buttons come from the server's `allowed_actions` (D38); the server still decides, and a refused
 * action shows its message on the alert. Reset: Soft by default, Hard selectable (D40); on 409
 * `sessions_active` a second confirmation lists the sessions and resends with `force`.
 * Ported from the FE-01 reference; the serial links to Charge Point Detail (FE-05, D41).
 */
import { Badge, Button, Group, Table } from '@mantine/core';
import { IconClockHour4 } from '@tabler/icons-react';
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
import { Notice, type Note } from '../../ui/Notice';
import { StatusBadge } from '../../ui/StatusBadge';
import { SEVERITY_TONE } from '../../ui/tones';

type Pending = FaultAction | 'force' | null;

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
  return (
    <Badge
      color="warning"
      variant="outline"
      size="md"
      className="status-badge"
      leftSection={<IconClockHour4 size={14} aria-hidden="true" />}
    >
      Chờ súng hoạt động lại · còn {left} s
    </Badge>
  );
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

  const open = fault.status !== 'resolved';
  return (
    <Table.Tr
      aria-label={`Sự cố ${no}`}
      className={`sev-${open ? fault.severity : 'none'}`}
      data-tone={open ? SEVERITY_TONE[fault.severity] : 'none'}
      data-dim={!open}
    >
      <Table.Td className="num cell-title">{no}</Table.Td>
      <Table.Td miw={240}>
        <div className="cell-title">{kindLabel(fault)}</div>
        <div className="muted small">{fault.hint}</div>
        {fault.report_count > 0 && (
          <div>
            <StatusBadge tone="major">{fault.report_count} tài xế báo lỗi</StatusBadge>
          </div>
        )}
      </Table.Td>
      <Table.Td>
        <Link className="nowrap" to={`/operator/charge-points/${fault.charge_point_id}`}>
          {fault.charge_point_serial}
        </Link>
        {fault.station_name && <div className="muted small">{fault.station_name}</div>}
        {!fault.charge_point_online && (
          <div>
            <StatusBadge tone="muted">Trụ sạc mất kết nối</StatusBadge>
          </div>
        )}
      </Table.Td>
      <Table.Td>
        <StatusBadge
          tone={fault.severity}
          variant={fault.severity === 'critical' ? 'filled' : 'light'}
        >
          {SEVERITY[fault.severity]}
        </StatusBadge>
      </Table.Td>
      <Table.Td>
        <StatusBadge tone={open ? '' : 'muted'}>{STATUS[fault.status]}</StatusBadge>
        {fault.status === 'resetting' && fault.reset?.deadline && (
          <div className="small">
            <Countdown deadline={fault.reset.deadline} />
          </div>
        )}
        {fault.status === 'resolved' && fault.resolved_at && (
          <div className="muted small">Xử lý xong {time(fault.resolved_at)}</div>
        )}
      </Table.Td>
      <Table.Td className="nowrap">{time(fault.raised_at)}</Table.Td>
      <Table.Td>
        {fault.allowed_actions.length > 0 && (
          <Group gap={6} wrap="wrap">
            {fault.allowed_actions.map((a) => (
              <Button
                key={a}
                type="button"
                size="compact-sm"
                variant={a === 'acknowledge' ? 'filled' : 'default'}
                disabled={busy}
                onClick={() => {
                  setNote(null);
                  setType('Soft');
                  setPending(a);
                }}
              >
                {BUTTON[a]}
              </Button>
            ))}
          </Group>
        )}
        {note && (
          <Notice tone={note.tone} className="note">
            {note.text}
          </Notice>
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
            danger={pending === 'force'}
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
                    <label key={t} className="radio-row">
                      <input
                        type="radio"
                        name={`reset-${fault.id}`}
                        checked={type === t}
                        onChange={() => setType(t)}
                      />
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
              <Notice tone="warn" role="note" className="note">
                <p>Khởi động lại sẽ dừng giữa chừng các phiên sạc này:</p>
                <ul>
                  {(sessions ?? []).map((s) => (
                    <li key={s.session_id}>
                      Súng {s.connector_no} — phiên {s.session_id}
                    </li>
                  ))}
                </ul>
                <p>Chỉ tiếp tục khi không thể chờ các phiên kết thúc.</p>
              </Notice>
            )}
          </ConfirmDialog>
        )}
      </Table.Td>
    </Table.Tr>
  );
}
