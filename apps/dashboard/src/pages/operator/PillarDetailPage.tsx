/**
 * Screen 20 — Pillar Detail (UC-OPS-02/04): súng, lịch sử sự cố, lệnh từ xa (Reset Soft/Hard,
 * Unlock, Remote stop) với trạng thái `remote_commands` (pending → sent → accepted/rejected/timeout).
 * Từ đây mở phiếu bảo trì (Fig 10: "open tickets").
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Icon } from '../../components/Icon';
import { Card, ConfirmDialog, Empty, Loading, PageHeader, Pill } from '../../components/ui';
import { errorMessage, usePillarQuery, useSendCommandMutation } from '../../core/api/api';
import { LIVE_POLL_MS } from '../../core/realtime/polling';
import { FaultItem } from '../../features/alerts/FaultItem';
import { PillarCard } from '../../features/stations/PillarCard';
import { useToast } from '../../hooks/toast';
import type { CommandStatus } from '../../types/domain';
import { formatDateTime } from '../../utils/format';

const CMD_TONE: Record<CommandStatus, 'teal' | 'gold' | 'danger' | 'muted' | 'warning'> = {
  pending: 'muted',
  sent: 'gold',
  accepted: 'teal',
  rejected: 'danger',
  timeout: 'warning',
  failed: 'danger',
};

type PendingCmd = {
  action: 'Reset' | 'UnlockConnector' | 'RemoteStopTransaction';
  connectorNo?: number;
  type?: 'Soft' | 'Hard';
};

export function PillarDetailPage() {
  const id = Number(useParams()['id']);
  const toast = useToast();
  const { data, isLoading, isError } = usePillarQuery(id, { pollingInterval: LIVE_POLL_MS });
  const [send, { isLoading: sending }] = useSendCommandMutation();
  const [pending, setPending] = useState<PendingCmd | null>(null);

  if (isLoading) return <Loading />;
  if (isError || !data) return <Empty title="Không tìm thấy trụ" />;
  const { pillar, faults, commands, sessions } = data;

  const run = async () => {
    if (!pending) return;
    const r = await send({ pillarId: pillar.id, ...pending });
    if ('error' in r) toast.error(errorMessage(r.error));
    else toast.success(`Đã gửi ${pending.action} — chờ trụ trả lời`);
    setPending(null);
  };

  return (
    <>
      <PageHeader
        crumb={<Link to="/operator/pillars">← Trụ sạc</Link>}
        title={`Trụ ${pillar.displayCode}`}
        subtitle={`${pillar.serial} · ${pillar.model} · firmware ${pillar.firmware}`}
        actions={
          <Link to="/operator/tickets" className="btn">
            <Icon name="ticket" /> Phiếu bảo trì
          </Link>
        }
      />
      <div className="grid cols-2">
        <PillarCard pillar={pillar} />
        <Card title="Lệnh từ xa" extra={<small>UC-OPS-04</small>}>
          {!pillar.isOnline && (
            <div className="banner" style={{ marginBottom: 12 }}>
              Trụ đang offline — không gửi lệnh được.
            </div>
          )}
          <div className="btn-row">
            <button
              type="button"
              className="btn gold small"
              disabled={!pillar.isOnline}
              onClick={() => setPending({ action: 'Reset', type: 'Soft' })}
            >
              <Icon name="reset" /> Reset Soft
            </button>
            <button
              type="button"
              className="btn small"
              disabled={!pillar.isOnline}
              onClick={() => setPending({ action: 'Reset', type: 'Hard' })}
            >
              Reset Hard
            </button>
            {pillar.connectors.map((c) => (
              <span key={c.connectorNo} className="btn-row">
                <button
                  type="button"
                  className="btn small"
                  disabled={!pillar.isOnline}
                  onClick={() =>
                    setPending({ action: 'UnlockConnector', connectorNo: c.connectorNo })
                  }
                >
                  Mở khoá súng {c.connectorNo === 1 ? 'A' : 'B'}
                </button>
                <button
                  type="button"
                  className="btn small danger"
                  disabled={!pillar.isOnline || !c.activeSession}
                  onClick={() =>
                    setPending({ action: 'RemoteStopTransaction', connectorNo: c.connectorNo })
                  }
                >
                  Dừng phiên {c.connectorNo === 1 ? 'A' : 'B'}
                </button>
              </span>
            ))}
          </div>
          <div className="table-wrap" style={{ marginTop: 14 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Lệnh</th>
                  <th>Gửi lúc</th>
                  <th>Kết quả</th>
                </tr>
              </thead>
              <tbody>
                {commands.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">
                      Chưa có lệnh nào.
                    </td>
                  </tr>
                )}
                {commands.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.id}</td>
                    <td>
                      {c.action}
                      {c.connectorNo ? ` · súng ${c.connectorNo}` : ''}
                      {typeof c.payload['type'] === 'string' ? ` · ${c.payload['type']}` : ''}
                    </td>
                    <td>{formatDateTime(c.requestedAt)}</td>
                    <td>
                      <Pill tone={CMD_TONE[c.status]}>{c.status}</Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Card title="Lịch sử sự cố" extra={<small>{faults.length} sự cố</small>}>
        <div className="grid">
          {faults.length === 0 && <div className="muted">Trụ chưa có sự cố.</div>}
          {faults.map((f) => (
            <FaultItem key={f.id} fault={f} showPillarLink={false} />
          ))}
        </div>
      </Card>

      {sessions.length > 0 && (
        <Card title="Phiên cần xử lý trên trụ này">
          {sessions.map((s) => (
            <div key={s.id} className="muted">
              #{s.transactionNo} · {s.reason} <Link to="/operator/sessions">Xử lý →</Link>
            </div>
          ))}
        </Card>
      )}

      {pending && (
        <ConfirmDialog
          title={`Gửi ${pending.action} tới ${pillar.serial}?`}
          confirmLabel="Gửi lệnh"
          tone={pending.action === 'RemoteStopTransaction' ? 'danger' : 'gold'}
          busy={sending}
          onCancel={() => setPending(null)}
          onConfirm={run}
        >
          <p>
            {pending.action === 'Reset'
              ? `Reset ${pending.type} sẽ khởi động lại trụ; các phiên đang sạc sẽ dừng.`
              : pending.action === 'UnlockConnector'
                ? 'Mở khoá cơ cấu giữ súng để tài xế rút súng.'
                : 'Dừng phiên đang sạc trên súng này (RemoteStopTransaction).'}
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
