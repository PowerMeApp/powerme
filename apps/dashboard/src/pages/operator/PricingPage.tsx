/**
 * Screen 23 — Pricing & Promotions (UC-OPS-06/07, M4: biểu giá bốn khung giờ cấu hình được từ
 * dashboard). Kiểm tra phía UI (validateBands) trước khi gửi; server kiểm lại và trả 422.
 */
import { useEffect, useState } from 'react';
import { Card, Loading, PageHeader, Pill } from '../../components/ui';
import {
  errorMessage,
  usePromotionsQuery,
  useSaveTariffMutation,
  useTariffQuery,
} from '../../core/api/api';
import { BAND_NAMES, validateBands } from '../../features/tariffs/validateBands';
import { useToast } from '../../hooks/toast';
import type { TariffBandName, TariffPeriod } from '../../types/domain';
import { formatDateTime, formatVnd } from '../../utils/format';

const BAND_TONE: Record<TariffBandName, 'danger' | 'gold' | 'teal' | 'muted'> = {
  Sharp: 'danger',
  Peak: 'gold',
  Shoulder: 'teal',
  'Off-peak': 'muted',
};

export function PricingPage() {
  const toast = useToast();
  const { data, isLoading } = useTariffQuery();
  const { data: promotions } = usePromotionsQuery();
  const [save, { isLoading: saving }] = useSaveTariffMutation();
  const [rows, setRows] = useState<TariffPeriod[]>([]);

  useEffect(() => {
    if (data) setRows(data.map((r) => ({ ...r })));
  }, [data]);

  if (isLoading) return <Loading />;
  const errors = validateBands(rows);
  const dirty = JSON.stringify(rows) !== JSON.stringify(data);

  const update = (i: number, patch: Partial<TariffPeriod>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <>
      <PageHeader
        title="Biểu giá & khuyến mãi"
        subtitle="Bốn khung giờ Sharp / Peak / Shoulder / Off-peak phủ đủ 24 giờ, giá theo kWh"
      />
      <Card
        title="Khung giờ"
        extra={
          <div className="btn-row" style={{ marginLeft: 'auto' }}>
            <button
              type="button"
              className="btn small"
              onClick={() =>
                setRows((rs) => [
                  ...rs,
                  { band: 'Shoulder', start: '00:00', end: '00:00', pricePerKwhVnd: 3000 },
                ])
              }
            >
              Thêm dòng
            </button>
            <button
              type="button"
              className="btn small primary"
              disabled={!dirty || errors.length > 0 || saving}
              onClick={async () => {
                const r = await save(rows);
                if ('error' in r) toast.error(errorMessage(r.error));
                else toast.success('Đã lưu biểu giá — áp dụng cho phiên bắt đầu sau thời điểm này');
              }}
            >
              {saving ? 'Đang lưu…' : 'Lưu biểu giá'}
            </button>
          </div>
        }
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Khung</th>
                <th>Từ</th>
                <th>Đến</th>
                <th className="num">Giá / kWh</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>
                    <select
                      className="input"
                      aria-label={`Khung dòng ${i + 1}`}
                      value={r.band}
                      onChange={(e) => update(i, { band: e.target.value as TariffBandName })}
                    >
                      {BAND_NAMES.map((b) => (
                        <option key={b}>{b}</option>
                      ))}
                    </select>{' '}
                    <Pill tone={BAND_TONE[r.band]}>{r.band}</Pill>
                  </td>
                  <td>
                    <input
                      className="input mono"
                      aria-label={`Bắt đầu dòng ${i + 1}`}
                      value={r.start}
                      onChange={(e) => update(i, { start: e.target.value })}
                      size={6}
                    />
                  </td>
                  <td>
                    <input
                      className="input mono"
                      aria-label={`Kết thúc dòng ${i + 1}`}
                      value={r.end}
                      onChange={(e) => update(i, { end: e.target.value })}
                      size={6}
                    />
                  </td>
                  <td className="num">
                    <input
                      className="input"
                      type="number"
                      min={1}
                      aria-label={`Giá dòng ${i + 1}`}
                      value={r.pricePerKwhVnd}
                      onChange={(e) => update(i, { pricePerKwhVnd: Number(e.target.value) })}
                      style={{ width: 120, textAlign: 'right' }}
                    />
                    <div className="hint">{formatVnd(r.pricePerKwhVnd)}</div>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn small ghost"
                      onClick={() => setRows((rs) => rs.filter((_x, j) => j !== i))}
                    >
                      Xoá
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {errors.length > 0 && (
          <ul className="form-error" role="alert">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Khuyến mãi">
        <table className="table">
          <thead>
            <tr>
              <th>Tên</th>
              <th className="num">Giảm</th>
              <th>Hiệu lực</th>
              <th>Trạng thái</th>
            </tr>
          </thead>
          <tbody>
            {(promotions ?? []).map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="num">{p.discountPercent}%</td>
                <td>
                  {formatDateTime(p.validFrom)} → {formatDateTime(p.validTo)}
                </td>
                <td>
                  {p.active ? (
                    <Pill tone="teal">Đang chạy</Pill>
                  ) : (
                    <Pill tone="muted">Hết hạn</Pill>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
