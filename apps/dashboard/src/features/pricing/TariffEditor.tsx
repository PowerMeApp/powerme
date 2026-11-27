/**
 * "Lập biểu giá mới" (screen 24, FE-06, UC-OPS-06, BR-P02): a new schedule from a date, pre-filled
 * from the current one. React Hook Form + Zod (D43): each problem shows in red under its own field;
 * a gap or overlap is shown on the row that causes it. A confirm step comes before the PUT, because
 * the new prices apply to every charging session from that date (settled sessions never change).
 */
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useId, useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import type { TariffBand, TariffSchedule } from '@powerme/shared';
import { Field, FieldError } from '../../components/Field';
import { usePutTariffsMutation, type ApiError } from '../../core/api/api';
import { BAND, pricingError } from './format';
import { BANDS, minutes, tariffSchema, type TariffForm, type TariffValues } from './schema';

const localDate = (offsetDays: number) => {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const dayLabel = (ymd: string) => ymd.split('-').reverse().join('/');

export function TariffEditor({
  current,
  onDone,
  onCancel,
}: {
  current: TariffSchedule | null;
  onDone: (text: string) => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const [put, { isLoading }] = usePutTariffsMutation();
  const [confirm, setConfirm] = useState<TariffValues | null>(null);
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<TariffForm, unknown, TariffValues>({
    resolver: zodResolver(tariffSchema),
    mode: 'onTouched',
    defaultValues: {
      effective_from: localDate(1),
      periods: (
        current?.periods ?? [
          { band: 'normal', time_start: '00:00', time_end: '24:00', price_per_kwh_vnd: 0 },
        ]
      ).map((p) => ({ ...p, price_per_kwh_vnd: String(p.price_per_kwh_vnd) })),
    },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'periods' });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !isLoading && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isLoading, onCancel]);

  async function apply(v: TariffValues) {
    const res = await put({
      effective_from: v.effective_from,
      periods: [...v.periods]
        .sort((a, b) => minutes(a.time_start) - minutes(b.time_start))
        .map((p) => ({ ...p, price_per_kwh_vnd: Number(p.price_per_kwh_vnd) })),
    });
    if ('error' in res) {
      setConfirm(null);
      const code = (res.error as ApiError).code;
      const onDate = code === 'effective_from_in_past' || code === 'schedule_in_use';
      return setError(onDate ? 'effective_from' : 'root.server', {
        type: 'server',
        message: pricingError(res.error),
      });
    }
    onDone(`Đã lập biểu giá mới, áp dụng từ ${dayLabel(v.effective_from)}`);
  }

  return (
    <div className="backdrop">
      <div
        className="card dialog pricing-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId}>Lập biểu giá mới</h2>
        {confirm ? (
          <>
            <p>
              Áp dụng biểu giá {confirm.periods.length} khung giờ từ ngày{' '}
              <b>{dayLabel(confirm.effective_from)}</b>? Biểu giá đang áp dụng kết thúc vào ngày
              trước đó. Phiên đã quyết toán không đổi.
            </p>
            <div className="btn-row">
              <button
                type="button"
                className="btn ghost"
                disabled={isLoading}
                onClick={() => setConfirm(null)}
              >
                Quay lại
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={isLoading}
                onClick={() => void apply(confirm)}
                autoFocus
              >
                {isLoading ? 'Đang gửi…' : 'Áp dụng'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted small">
              Các khung phải phủ kín 00:00–24:00, không chồng nhau. Một loại khung có thể lặp lại
              trong ngày (ví dụ hai khung cao điểm).
            </p>
            <Field label="Áp dụng từ ngày" error={errors.effective_from?.message}>
              {(a11y) => (
                <input
                  {...a11y}
                  {...register('effective_from')}
                  className="input"
                  type="date"
                  min={localDate(0)}
                />
              )}
            </Field>
            <fieldset className="tariff-rows">
              <legend>Khung giờ</legend>
              {fields.map((f, i) => {
                const e = errors.periods?.[i];
                return (
                  <div key={f.id} className="tariff-row">
                    <Field label={`Loại khung ${i + 1}`}>
                      {(a11y) => (
                        <select {...a11y} {...register(`periods.${i}.band`)} className="input">
                          {BANDS.map((b: TariffBand) => (
                            <option key={b} value={b}>
                              {BAND[b][0]}
                            </option>
                          ))}
                        </select>
                      )}
                    </Field>
                    <Field label={`Từ (khung ${i + 1})`} error={e?.time_start?.message}>
                      {(a11y) => (
                        <input
                          {...a11y}
                          {...register(`periods.${i}.time_start`)}
                          className="input"
                          placeholder="HH:MM"
                          maxLength={5}
                        />
                      )}
                    </Field>
                    <Field label={`Đến (khung ${i + 1})`} error={e?.time_end?.message}>
                      {(a11y) => (
                        <input
                          {...a11y}
                          {...register(`periods.${i}.time_end`)}
                          className="input"
                          placeholder="HH:MM"
                          maxLength={5}
                        />
                      )}
                    </Field>
                    <Field
                      label={`Giá khung ${i + 1} (₫/kWh)`}
                      error={e?.price_per_kwh_vnd?.message}
                    >
                      {(a11y) => (
                        <input
                          {...a11y}
                          {...register(`periods.${i}.price_per_kwh_vnd`)}
                          className="input"
                          inputMode="numeric"
                        />
                      )}
                    </Field>
                    <button
                      type="button"
                      className="btn small ghost"
                      aria-label={`Xoá khung ${i + 1}`}
                      disabled={fields.length === 1}
                      onClick={() => remove(i)}
                    >
                      Xoá
                    </button>
                  </div>
                );
              })}
              <button
                type="button"
                className="btn small ghost"
                disabled={fields.length >= 24}
                onClick={() =>
                  append({ band: 'normal', time_start: '', time_end: '', price_per_kwh_vnd: '' })
                }
              >
                Thêm khung
              </button>
              <FieldError message={errors.periods?.root?.message ?? errors.periods?.message} />
            </fieldset>
            <FieldError message={errors.root?.server?.message} />
            <div className="btn-row">
              <button type="button" className="btn ghost" onClick={onCancel}>
                Huỷ
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => void handleSubmit((v) => setConfirm(v))()}
              >
                Tiếp tục
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
