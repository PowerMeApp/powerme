/**
 * Một sự cố với các hành động STM-6 (WF-04 seq 1/2): Xác nhận (t2) → Reset (t4) → chờ súng
 * Available (t5) hoặc hết hạn (t6) → Đóng sau kiểm tra tại chỗ (t7). Nút chỉ bật khi chuyển hợp lệ
 * (canApplyFault) — server vẫn là bên quyết định, lỗi 409 hiện ở toast.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  errorMessage,
  useAcknowledgeFaultMutation,
  useCloseFaultMutation,
  useResetFaultMutation,
} from '../../core/api/api';
import { useToast } from '../../hooks/toast';
import type { FaultEvent } from '../../types/domain';
import { formatDateTime, secondsLeft, timeAgo } from '../../utils/format';
import { ConfirmDialog, FaultStatusPill, Pill, SeverityPill } from '../../components/ui';
import { canApplyFault } from './faultStateMachine';

type Pending = 'ack' | 'reset' | 'close' | null;

const STEPS: { status: FaultEvent['status']; label: string }[] = [
  { status: 'raised', label: 'Mới' },
  { status: 'acknowledged', label: 'Xác nhận' },
  { status: 'resetting', label: 'Reset' },
  { status: 'resolved', label: 'Xử lý xong' },
];

function Countdown({ deadline }: { deadline: string }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="countdown">Chờ súng Available · còn {secondsLeft(deadline)} s</span>;
}

export function FaultItem({
  fault,
  showPillarLink = true,
}: {
  fault: FaultEvent;
  showPillarLink?: boolean;
}) {
  const toast = useToast();
  const [pending, setPending] = useState<Pending>(null);
  const [resetType, setResetType] = useState<'Soft' | 'Hard'>('Soft');
  const [ack, ackState] = useAcknowledgeFaultMutation();
  const [reset, resetState] = useResetFaultMutation();
  const [close, closeState] = useCloseFaultMutation();
  const busy = ackState.isLoading || resetState.isLoading || closeState.isLoading;

  const where =
    fault.connectorNo === 0
      ? 'Cả trụ'
      : `Súng ${fault.connectorNo === 1 ? 'A' : 'B'} (${fault.connectorNo})`;
  const stepIndex = STEPS.findIndex((s) => s.status === fault.status);

  const run = async () => {
    if (pending === 'ack') {
      const r = await ack(fault.id);
      if ('error' in r) toast.error(errorMessage(r.error));
      else toast.success(`Đã xác nhận sự cố #${fault.eventNo}`);
    } else if (pending === 'reset') {
      const r = await reset({ id: fault.id, type: resetType });
      if ('error' in r) toast.error(errorMessage(r.error));
      else if (r.data.resetStatus === 'Rejected')
        toast.warning(`Trụ từ chối Reset — sự cố #${fault.eventNo} về "Đã xác nhận"`);
      else toast.success(`Trụ nhận lệnh Reset ${resetType} — đang chờ súng báo Available`);
    } else if (pending === 'close') {
      const r = await close(fault.id);
      if ('error' in r) toast.error(errorMessage(r.error));
      else toast.success(`Đã đóng sự cố #${fault.eventNo}`);
    }
    setPending(null);
  };

  return (
    <article className="card alert-row" aria-label={`Sự cố #${fault.eventNo}`}>
      <div className={`alert-bar ${fault.status === 'resolved' ? 'none' : fault.severity}`} />
      <div>
        <div className="alert-title">
          <b>#{fault.eventNo}</b>
          <span className="mono">{fault.errorCode ?? '—'}</span>
          <SeverityPill severity={fault.severity} />
          <FaultStatusPill status={fault.status} />
          {!fault.pillarOnline && <Pill tone="muted">Trụ offline</Pill>}
          {fault.driverReports > 0 && <Pill tone="gold">{fault.driverReports} tài xế báo lỗi</Pill>}
        </div>
        <div className="muted" style={{ marginTop: 4 }}>
          {showPillarLink ? (
            <Link to={`/operator/pillars/${fault.pillarId}`}>{fault.serial}</Link>
          ) : (
            fault.serial
          )}{' '}
          · {where} · {fault.siteName} · phát sinh {timeAgo(fault.raisedAt)} (
          {formatDateTime(fault.raisedAt)})
        </div>
        <div className="hint">{fault.hint}</div>
        <div className="timeline" aria-label="Tiến trình xử lý">
          {STEPS.map((s, i) => (
            <span
              key={s.status}
              className={`step ${i < stepIndex ? 'done' : ''} ${i === stepIndex ? 'now' : ''}`}
            >
              {s.label}
            </span>
          ))}
          {fault.resetCommandStatus && <span>· lệnh Reset: {fault.resetCommandStatus}</span>}
        </div>
      </div>
      <div className="alert-actions">
        {fault.status === 'resetting' && fault.resetDeadline && (
          <Countdown deadline={fault.resetDeadline} />
        )}
        {fault.status !== 'resolved' && (
          <div className="btn-row">
            <button
              type="button"
              className="btn small primary"
              disabled={busy || !canApplyFault(fault.status, 'ACKNOWLEDGE')}
              onClick={() => setPending('ack')}
            >
              Xác nhận
            </button>
            <button
              type="button"
              className="btn small gold"
              disabled={busy || !canApplyFault(fault.status, 'RESET_SENT') || !fault.pillarOnline}
              title={!fault.pillarOnline ? 'Trụ offline — không gửi lệnh được' : undefined}
              onClick={() => setPending('reset')}
            >
              Reset
            </button>
            <button
              type="button"
              className="btn small"
              disabled={busy || !canApplyFault(fault.status, 'OPERATOR_CLOSE')}
              onClick={() => setPending('close')}
            >
              Đóng
            </button>
          </div>
        )}
        {fault.status === 'resolved' && (
          <span className="muted">Xong {formatDateTime(fault.resolvedAt)}</span>
        )}
      </div>

      {pending && (
        <ConfirmDialog
          title={
            pending === 'ack'
              ? `Xác nhận sự cố #${fault.eventNo}?`
              : pending === 'reset'
                ? `Gửi Reset tới ${fault.serial}?`
                : `Đóng sự cố #${fault.eventNo}?`
          }
          confirmLabel={
            pending === 'ack' ? 'Xác nhận' : pending === 'reset' ? 'Gửi Reset' : 'Đóng sự cố'
          }
          tone={pending === 'reset' ? 'gold' : 'primary'}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={run}
          extra={
            pending === 'reset' ? (
              <label className="field">
                Kiểu Reset
                <select
                  className="input"
                  value={resetType}
                  onChange={(e) => setResetType(e.target.value as 'Soft' | 'Hard')}
                >
                  <option value="Soft">Soft — khởi động lại phần mềm</option>
                  <option value="Hard">Hard — khởi động lại toàn trụ</option>
                </select>
              </label>
            ) : undefined
          }
        >
          {pending === 'ack' && <p>Bạn đã thấy cảnh báo này và sẽ xử lý (UC-OPS-03).</p>}
          {pending === 'reset' && (
            <p>
              Trụ khởi động lại; phiên đang sạc trên trụ sẽ dừng. Sự cố chuyển sang "Đang reset" cho
              tới khi súng báo Available hoặc hết hạn chờ.
            </p>
          )}
          {pending === 'close' && (
            <p>
              Chỉ đóng sau khi kỹ thuật đã kiểm tra tại chỗ. Trạng thái súng do trụ báo, không đổi.
            </p>
          )}
        </ConfirmDialog>
      )}
    </article>
  );
}
