/**
 * Screen 24 — Pricing & Promotions (FE-06, UC-OPS-06/07, BR-P02), Operator staff (manager and
 * technician, contract N5). Two tabs, kept in the URL (`?tab=promotions`):
 *   - Biểu giá: the Operator's time-of-day tariff in force and the upcoming ones (3 bands, per
 *     Operator, contract §6 #3); "Lập biểu giá mới" sets a new schedule from a date (TariffEditor).
 *   - Khuyến mãi: the Operator's promotions; create, edit, end. They are stored only: settlement does
 *     not apply them yet (decision K6), which the screen says.
 * The reservation hold window / no-show fee of Table 5 #24 wait for reservation (Should).
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import type { Promotion, TariffSchedule } from '@powerme/shared';
import { Breadcrumbs } from '../../components/Breadcrumbs';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import {
  useDeactivatePromotionMutation,
  useOperatorPromotionsQuery,
  useOperatorTariffsQuery,
} from '../../core/api/api';
import {
  BAND,
  pricingError,
  promotionEnded,
  promotionStatus,
  vnd,
} from '../../features/pricing/format';
import { PromotionDialog } from '../../features/pricing/PromotionDialog';
import { TariffEditor } from '../../features/pricing/TariffEditor';

type Note = { tone: 'ok' | 'error'; text: string } | null;
const day = (ymd: string) => ymd.split('-').reverse().join('/');
const when = (iso: string) =>
  new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });

function ScheduleTable({ schedule, label }: { schedule: TariffSchedule; label: string }) {
  return (
    <section className="card table-card" aria-label={label}>
      <h2 className="section-title">
        {label} · từ {day(schedule.effective_from)}
        {schedule.effective_to ? ` đến ${day(schedule.effective_to)}` : ''}
      </h2>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Khung giờ</th>
              <th scope="col">Loại</th>
              <th scope="col">Giá</th>
            </tr>
          </thead>
          <tbody>
            {schedule.periods.map((p) => (
              <tr key={`${p.time_start}-${p.band}`} aria-label={`${label} ${p.time_start}`}>
                <td className="nowrap">
                  {p.time_start} – {p.time_end}
                </td>
                <td>
                  <span className={`pill ${BAND[p.band][1]}`}>{BAND[p.band][0]}</span>
                </td>
                <td className="nowrap">{vnd(p.price_per_kwh_vnd)}/kWh</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TariffTab({ onNote }: { onNote: (n: Note) => void }) {
  const { data, error, isLoading } = useOperatorTariffsQuery();
  const [editing, setEditing] = useState(false);
  return (
    <>
      <div className="btn-row">
        <button
          type="button"
          className="btn primary"
          disabled={!data}
          onClick={() => {
            onNote(null);
            setEditing(true);
          }}
        >
          Lập biểu giá mới
        </button>
      </div>
      {isLoading ? (
        <p className="muted">Đang tải…</p>
      ) : error && !data ? (
        <p role="alert">{pricingError(error)}</p>
      ) : !data?.current && !data?.upcoming.length ? (
        <div className="card">
          <p className="muted">
            Operator chưa có biểu giá. Tài xế chưa bắt đầu sạc được cho tới khi có biểu giá.
          </p>
        </div>
      ) : (
        <>
          {data.current && <ScheduleTable schedule={data.current} label="Đang áp dụng" />}
          {data.upcoming.map((s) => (
            <ScheduleTable key={s.effective_from} schedule={s} label="Sắp áp dụng" />
          ))}
        </>
      )}
      {editing && data && (
        <TariffEditor
          current={data.upcoming.at(-1) ?? data.current}
          onCancel={() => setEditing(false)}
          onDone={(text) => {
            setEditing(false);
            onNote({ tone: 'ok', text });
          }}
        />
      )}
    </>
  );
}

function PromotionTab({ onNote }: { onNote: (n: Note) => void }) {
  const { data, error, isLoading, refetch } = useOperatorPromotionsQuery();
  const [deactivate, d] = useDeactivatePromotionMutation();
  const [dialog, setDialog] = useState<{ promotion?: Promotion } | null>(null);
  const [ending, setEnding] = useState<Promotion | null>(null);
  const [endError, setEndError] = useState<string | null>(null);

  async function end(p: Promotion) {
    const res = await deactivate(p.id);
    if ('error' in res) {
      void refetch();
      return setEndError(pricingError(res.error));
    }
    setEnding(null);
    onNote({ tone: 'ok', text: `Đã kết thúc khuyến mãi ${p.promotion_code}` });
  }

  return (
    <>
      <p className="muted small">
        Mã khuyến mãi được lưu nhưng chưa được áp dụng khi tính tiền phiên sạc.
      </p>
      <div className="btn-row">
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            onNote(null);
            setDialog({});
          }}
        >
          Tạo khuyến mãi
        </button>
      </div>
      {isLoading ? (
        <p className="muted">Đang tải…</p>
      ) : error && !data ? (
        <p role="alert">{pricingError(error)}</p>
      ) : !data || data.items.length === 0 ? (
        <div className="card">
          <p className="muted">Chưa có khuyến mãi nào.</p>
        </div>
      ) : (
        <div className="card table-card">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Mã</th>
                  <th scope="col">Giảm</th>
                  <th scope="col">Thời gian</th>
                  <th scope="col">Trạng thái</th>
                  <th scope="col">Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((p) => {
                  const [label, tone] = promotionStatus(p);
                  return (
                    <tr key={p.id} aria-label={`Khuyến mãi ${p.promotion_code}`}>
                      <td className="cell-title">{p.promotion_code}</td>
                      <td className="nowrap">
                        {p.discount_type === 'percent'
                          ? `${p.discount_value}%`
                          : vnd(p.discount_value)}
                      </td>
                      <td className="small">
                        {when(p.valid_from)} – {when(p.valid_to)}
                      </td>
                      <td>
                        <span className={`pill ${tone}`}>{label}</span>
                      </td>
                      <td>
                        {!promotionEnded(p) && (
                          <div className="btn-row">
                            <button
                              type="button"
                              className="btn small"
                              onClick={() => {
                                onNote(null);
                                setDialog({ promotion: p });
                              }}
                            >
                              Sửa
                            </button>
                            <button
                              type="button"
                              className="btn small ghost"
                              onClick={() => {
                                setEndError(null);
                                setEnding(p);
                              }}
                            >
                              Kết thúc
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {dialog && (
        <PromotionDialog
          {...(dialog.promotion ? { promotion: dialog.promotion } : {})}
          onCancel={() => setDialog(null)}
          onDone={(text) => {
            setDialog(null);
            onNote({ tone: 'ok', text });
          }}
        />
      )}
      {ending && (
        <ConfirmDialog
          title={`Kết thúc khuyến mãi ${ending.promotion_code}`}
          confirmLabel="Kết thúc"
          busy={d.isLoading}
          onCancel={() => setEnding(null)}
          onConfirm={() => void end(ending)}
        >
          <p>Khuyến mãi kết thúc ngay bây giờ và không sửa được nữa.</p>
          {endError && <p className="form-error">{endError}</p>}
        </ConfirmDialog>
      )}
    </>
  );
}

export function PricingPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'promotions' ? 'promotions' : 'tariffs';
  const [note, setNote] = useState<Note>(null);
  const switchTab = (next: 'tariffs' | 'promotions') => {
    setNote(null);
    setParams(
      (p) => {
        if (next === 'promotions') p.set('tab', 'promotions');
        else p.delete('tab');
        return p;
      },
      { replace: true },
    );
  };
  return (
    <>
      <Breadcrumbs items={[{ label: 'Giá & khuyến mãi' }]} />
      <div className="page-head">
        <h1>Giá &amp; khuyến mãi</h1>
        <p>
          Biểu giá theo khung giờ (cao điểm, bình thường, thấp điểm) và mã khuyến mãi của Operator
        </p>
      </div>
      <div className="filters">
        <div className="queue-switch" role="group" aria-label="Mục">
          {(
            [
              ['tariffs', 'Biểu giá'],
              ['promotions', 'Khuyến mãi'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`btn small ${tab === id ? '' : 'ghost'}`}
              aria-pressed={tab === id}
              onClick={() => switchTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {note && (
        <p className={`queue-note ${note.tone}`} role={note.tone === 'ok' ? 'status' : 'alert'}>
          {note.text}
        </p>
      )}
      {tab === 'tariffs' ? <TariffTab onNote={setNote} /> : <PromotionTab onNote={setNote} />}
    </>
  );
}
