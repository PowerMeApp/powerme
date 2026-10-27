/**
 * Screen 21 — Fault Alerts (UC-OPS-03, WF-04). Sự cố mở trước, nặng trước; chọn một sự cố → Pillar
 * Detail (Fig 10: "select alert"). Khi có sự cố đang reset, nhịp làm mới dày hơn để thấy t5/t6.
 */
import { useEffect, useState } from 'react';
import { Empty, Loading, PageHeader, Tabs } from '../../components/ui';
import { useFaultsQuery } from '../../core/api/api';
import { FAST_POLL_MS, LIVE_POLL_MS } from '../../core/realtime/polling';
import { FaultItem } from '../../features/alerts/FaultItem';

export function FaultAlertsPage() {
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [fast, setFast] = useState(false);
  const { data, isLoading } = useFaultsQuery(filter, {
    pollingInterval: fast ? FAST_POLL_MS : LIVE_POLL_MS,
  });
  const resetting = (data ?? []).some((f) => f.status === 'resetting');
  useEffect(() => setFast(resetting), [resetting]);
  const open = (data ?? []).filter((f) => f.status !== 'resolved').length;

  return (
    <>
      <PageHeader
        title="Cảnh báo sự cố"
        subtitle="Faulted từ trụ, trụ offline và tài xế báo lỗi · STM-6: Mới → Đã xác nhận → Đang reset → Đã xử lý"
      />
      <Tabs
        tabs={[
          { id: 'open', label: 'Đang mở', badge: filter === 'open' ? open : undefined },
          { id: 'all', label: 'Tất cả' },
        ]}
        value={filter}
        onChange={setFilter}
      />
      {isLoading ? (
        <Loading />
      ) : !data || data.length === 0 ? (
        <Empty title="Không có cảnh báo">Mọi súng đang hoạt động bình thường.</Empty>
      ) : (
        <div className="grid">
          {data.map((f) => (
            <FaultItem key={f.id} fault={f} />
          ))}
        </div>
      )}
    </>
  );
}
