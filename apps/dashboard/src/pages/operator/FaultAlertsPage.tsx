/**
 * Screen 21 — Fault Alerts (UC-OPS-03, WF-04 / AD-7). One list in the server's order (open →
 * severity → newest, D39), Open / All filter. Polling (D5): 3 s, 1 s while a fault is resetting so
 * t5 / t6 show quickly. Realtime push is a known gap (W2).
 */
import { useState } from 'react';
import { errorMessage, useOperatorFaultsQuery } from '../../core/api/api';
import { FaultItem } from '../../features/alerts/FaultItem';

export const POLL_MS = 3000;
export const FAST_POLL_MS = 1000;

export function FaultAlertsPage() {
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [fast, setFast] = useState(false);
  const { data, error, isLoading } = useOperatorFaultsQuery(filter, {
    pollingInterval: fast ? FAST_POLL_MS : POLL_MS,
    skipPollingIfUnfocused: true,
  });
  const faults = data?.faults ?? [];
  const resetting = faults.some((f) => f.status === 'resetting');
  if (resetting !== fast) setFast(resetting);

  return (
    <>
      <div className="page-head">
        <h1>Cảnh báo sự cố</h1>
        <p>
          Faulted, Charge Point offline và tài xế báo lỗi · Mới → Đã xác nhận → Đang reset → Đã xử
          lý
        </p>
      </div>
      <div className="tabs" role="group" aria-label="Lọc sự cố">
        {(
          [
            ['open', 'Đang mở'],
            ['all', 'Tất cả'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`btn small${filter === id ? ' primary' : ' ghost'}`}
            aria-pressed={filter === id}
            onClick={() => setFilter(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {isLoading ? (
        <p className="muted">Đang tải…</p>
      ) : error && !data ? (
        <p role="alert">{errorMessage(error)}</p>
      ) : faults.length === 0 ? (
        <div className="card">
          <p className="muted">Không có cảnh báo. Mọi connector đang hoạt động bình thường.</p>
        </div>
      ) : (
        <div className="alerts">
          {faults.map((f) => (
            <FaultItem key={f.id} fault={f} />
          ))}
        </div>
      )}
    </>
  );
}
