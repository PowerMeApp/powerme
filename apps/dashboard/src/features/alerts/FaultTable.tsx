/**
 * The fault table of screen 21, also the fault history of screen 20 (FE-05, filtered by charge
 * point). One table in the server's order (open → severity → newest, D39), filtered by status and
 * paged on the server (FAULT_PAGE_SIZE rows). Polling (D5): 3 s, 1 s while a fault on the page is
 * resetting so t5 / t6 show quickly. Realtime push is a known gap (W2).
 */
import { useState } from 'react';
import type { FaultListStatus } from '@powerme/shared';
import { errorMessage, FAULT_PAGE_SIZE, useOperatorFaultsQuery } from '../../core/api/api';
import { FaultRow } from './FaultRow';

export const POLL_MS = 3000;
export const FAST_POLL_MS = 1000;

const FILTERS: [FaultListStatus, string][] = [
  ['open', 'Đang mở'],
  ['raised', 'Mới'],
  ['acknowledged', 'Đã xác nhận'],
  ['resetting', 'Đang reset'],
  ['resolved', 'Đã xử lý'],
  ['all', 'Tất cả'],
];

export function FaultTable({
  chargePointId,
  defaultStatus = 'open',
}: {
  /** Screen 20: only this charge point's faults (its fault history). */
  chargePointId?: string;
  defaultStatus?: FaultListStatus;
}) {
  const [status, setStatus] = useState<FaultListStatus>(defaultStatus);
  const [page, setPage] = useState(1);
  const [fast, setFast] = useState(false);
  const { data, error, isLoading } = useOperatorFaultsQuery(
    { status, page, ...(chargePointId ? { chargePointId } : {}) },
    { pollingInterval: fast ? FAST_POLL_MS : POLL_MS, skipPollingIfUnfocused: true },
  );
  const faults = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / FAULT_PAGE_SIZE));
  const resetting = faults.some((f) => f.status === 'resetting');
  if (resetting !== fast) setFast(resetting);
  // Rows can leave the filter while polling; never stay on a page past the end.
  if (data && page > pages) setPage(pages);

  // Range from the response, not `page`: the old rows stay on screen while the next page loads.
  const first = ((data?.page ?? 1) - 1) * (data?.page_size ?? FAULT_PAGE_SIZE) + 1;
  const last = first + faults.length - 1;

  return (
    <>
      <div className="filters">
        <label className="field">
          Trạng thái
          <select
            className="input"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as FaultListStatus);
              setPage(1);
            }}
          >
            {FILTERS.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {isLoading ? (
        <p className="muted">Đang tải…</p>
      ) : error && !data ? (
        <p role="alert">{errorMessage(error)}</p>
      ) : faults.length === 0 ? (
        <div className="card">
          <p className="muted">
            {status === 'open'
              ? chargePointId
                ? 'Trụ sạc này không có sự cố đang mở.'
                : 'Không có cảnh báo. Mọi connector đang hoạt động bình thường.'
              : 'Không có sự cố ở trạng thái này.'}
          </p>
        </div>
      ) : (
        <div className="card table-card">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Sự cố</th>
                  <th scope="col">Trụ sạc</th>
                  <th scope="col">Mức độ</th>
                  <th scope="col">Trạng thái</th>
                  <th scope="col">Phát sinh</th>
                  <th scope="col">Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {faults.map((f) => (
                  <FaultRow key={f.id} fault={f} />
                ))}
              </tbody>
            </table>
          </div>
          <nav className="pager" aria-label="Phân trang">
            <span className="muted">
              Hiển thị {first}–{last} / {total}
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
              <span className="pager-page">
                Trang {page} / {pages}
              </span>
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
    </>
  );
}
