/**
 * Screen 22 — Unattributed Sessions (UC-OPS-05) mở rộng thành "Phiên cần xử lý":
 *   - Đối soát conflict: phiên `review` (WF-03) → operator giải quyết → `reconciled` (STM-1 #17);
 *   - Không định danh: thẻ lạ / free vend (ADR-0012) → ghi chú xử lý;
 *   - Lệnh start bị kẹt (WP3 T72): bắt đầu khôi phục (có ghi chú) → duyệt start muộn (chỉ khi trụ
 *     đã gửi StartTransaction muộn) hoặc trả súng về sẵn sàng.
 */
import { useState } from 'react';
import { ConfirmDialog, Empty, Loading, PageHeader, Pill, Tabs } from '../../components/ui';
import {
  errorMessage,
  useIntentActionMutation,
  useOperatorSummaryQuery,
  useResolveSessionMutation,
  useSessionsQuery,
  useStartIntentsQuery,
} from '../../core/api/api';
import { useToast } from '../../hooks/toast';
import type { ReviewSession, StartIntent } from '../../types/domain';
import { formatDateTime, formatKwh, timeAgo } from '../../utils/format';

type Tab = 'review' | 'unattributed' | 'starts';

function SessionsTable({ queue }: { queue: 'review' | 'unattributed' }) {
  const toast = useToast();
  const { data, isLoading } = useSessionsQuery(queue);
  const [resolve, { isLoading: busy }] = useResolveSessionMutation();
  const [target, setTarget] = useState<ReviewSession | null>(null);
  const [note, setNote] = useState('');

  if (isLoading) return <Loading />;
  if (!data?.length) return <Empty title="Không còn phiên nào cần xử lý" />;

  return (
    <div className="card table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Phiên</th>
            <th>Trụ / súng</th>
            <th>Thẻ / nguồn</th>
            <th>Lý do</th>
            <th className="num">meterStop</th>
            <th className="num">Chuỗi đo</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.map((s) => (
            <tr key={s.id}>
              <td>
                <b>#{s.transactionNo}</b>
                <div className="hint">{formatDateTime(s.startedAt)}</div>
              </td>
              <td>
                <span className="mono">{s.serial}</span> / {s.connectorNo}
                {s.deliveredOffline && (
                  <div>
                    <Pill tone="gold">gửi bù sau khi nối lại</Pill>
                  </div>
                )}
              </td>
              <td>
                <span className="mono">{s.idTag}</span>
                <div className="hint">
                  {s.origin} · {s.paymentMode}
                </div>
              </td>
              <td style={{ maxWidth: 320 }}>{s.reason}</td>
              <td className="num">{formatKwh(s.meterStopWh)}</td>
              <td className="num">{formatKwh(s.seriesLastWh)}</td>
              <td>
                <button
                  type="button"
                  className="btn small primary"
                  onClick={() => {
                    setTarget(s);
                    setNote('');
                  }}
                >
                  Xử lý
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {target && (
        <ConfirmDialog
          title={`Xử lý phiên #${target.transactionNo}`}
          confirmLabel={target.queue === 'review' ? 'Chốt đối soát' : 'Lưu xử lý'}
          busy={busy}
          onCancel={() => setTarget(null)}
          onConfirm={async () => {
            const r = await resolve({ id: target.id, note });
            if ('error' in r) toast.error(errorMessage(r.error));
            else {
              toast.success(
                target.queue === 'review'
                  ? `Phiên #${target.transactionNo} → reconciled`
                  : `Đã ghi xử lý phiên #${target.transactionNo}`,
              );
              setTarget(null);
            }
          }}
          extra={
            <label className="field">
              Ghi chú (bắt buộc, ≥ 5 ký tự)
              <textarea
                className="input"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                aria-label="Ghi chú xử lý"
              />
            </label>
          }
        >
          <p>
            {target.queue === 'review'
              ? 'Chốt số đo dùng để tính tiền sau khi đã đối chiếu chuỗi MeterValues (STM-1 #17 review → reconciled).'
              : 'Ghi lại cách xử lý phiên không có người trả tiền; phiên vẫn nằm ở dòng doanh thu "unattributed".'}
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function StartIntents() {
  const toast = useToast();
  const { data, isLoading } = useStartIntentsQuery();
  const [act, { isLoading: busy }] = useIntentActionMutation();
  const [target, setTarget] = useState<StartIntent | null>(null);
  const [note, setNote] = useState('');

  if (isLoading) return <Loading />;
  if (!data?.length) return <Empty title="Không có lệnh start nào bị kẹt" />;

  const doAction = async (
    it: StartIntent,
    action: 'begin-recovery' | 'approve-late-start' | 'restore-connector',
    n?: string,
  ) => {
    const r = await act({ id: it.id, action, note: n });
    if ('error' in r) toast.error(errorMessage(r.error));
    else toast.success(`Yêu cầu #${it.id}: ${r.data.state}`);
  };

  return (
    <div className="card table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>#</th>
            <th>Tài xế</th>
            <th>Trụ / súng</th>
            <th>Yêu cầu lúc</th>
            <th>Trạng thái</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.map((it) => (
            <tr key={it.id}>
              <td className="mono">{it.id}</td>
              <td>{it.driverEmail}</td>
              <td>
                <span className="mono">{it.serial}</span> / {it.connectorNo}
              </td>
              <td>{timeAgo(it.requestedAt)}</td>
              <td>
                {it.state === 'stuck' ? (
                  <Pill tone="danger">Kẹt</Pill>
                ) : (
                  <Pill tone="gold">Đang khôi phục</Pill>
                )}
                {it.lateStartSeen && <div className="hint">Trụ đã gửi StartTransaction muộn</div>}
                {it.note && <div className="hint">“{it.note}”</div>}
              </td>
              <td>
                {it.state === 'stuck' ? (
                  <button
                    type="button"
                    className="btn small primary"
                    onClick={() => {
                      setTarget(it);
                      setNote('');
                    }}
                  >
                    Bắt đầu khôi phục
                  </button>
                ) : (
                  <div className="btn-row">
                    <button
                      type="button"
                      className="btn small gold"
                      disabled={busy || !it.lateStartSeen}
                      title={it.lateStartSeen ? undefined : 'Trụ chưa gửi StartTransaction muộn'}
                      onClick={() => doAction(it, 'approve-late-start')}
                    >
                      Duyệt start muộn
                    </button>
                    <button
                      type="button"
                      className="btn small"
                      disabled={busy}
                      onClick={() => doAction(it, 'restore-connector')}
                    >
                      Trả súng về sẵn sàng
                    </button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {target && (
        <ConfirmDialog
          title={`Khôi phục yêu cầu sạc #${target.id}`}
          confirmLabel="Bắt đầu khôi phục"
          busy={busy}
          onCancel={() => setTarget(null)}
          onConfirm={async () => {
            await doAction(target, 'begin-recovery', note);
            setTarget(null);
          }}
          extra={
            <label className="field">
              Ghi chú (bắt buộc)
              <textarea
                className="input"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                aria-label="Ghi chú khôi phục"
              />
            </label>
          }
        >
          <p>
            Lệnh RemoteStart đã gửi nhưng chưa thấy kết quả. Ghi lại bạn đã kiểm tra gì trước khi
            quyết định (WP3 T72).
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

export function SessionsReviewPage() {
  const [tab, setTab] = useState<Tab>('review');
  const { data: summary } = useOperatorSummaryQuery();
  return (
    <>
      <PageHeader
        title="Phiên cần xử lý"
        subtitle="Đối soát conflict (WF-03), phiên không định danh (UC-OPS-05), lệnh start bị kẹt (WF-01)"
      />
      <Tabs
        tabs={[
          { id: 'review', label: 'Đối soát conflict' },
          { id: 'unattributed', label: 'Không định danh' },
          { id: 'starts', label: 'Lệnh start bị kẹt', badge: summary?.stuckStarts },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'starts' ? <StartIntents /> : <SessionsTable key={tab} queue={tab} />}
    </>
  );
}
