/**
 * Screen 19 — Charge Point Onboarding (sheet, FE-02, UC-OPS-01, AD-8, BR-P49). Opened from screen 18.
 *   1. Form (react-hook-form + zod, D43): a serial the Admin registered, one of the Operator's own
 *      Charging Stations (GET /operator/v1/sites) and 1–2 connectors (BR-P10). Each invalid field
 *      shows its message in red right beneath it; the CSMS refusals (409 / 403 / 404, AD-8) go under
 *      the field they are about.
 *   2. Result: the charge point's credential, shown once (only its hash is stored). Escape and the
 *      backdrop do not close it; closing resets the mutation so the password leaves the store.
 * Manager and technician alike (D42).
 */
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useId, useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { Link } from 'react-router';
import type { ConnectorType, OnboardResult } from '@powerme/shared';
import { Field, FieldError } from '../../components/Field';
import {
  errorMessage,
  useOnboardChargePointMutation,
  useOperatorSitesQuery,
  type ApiError,
} from '../../core/api/api';
import { LIFECYCLE } from './format';
import { onboardSchema, type OnboardForm, type OnboardValues } from './onboardSchema';

export { SERIAL_RE } from './onboardSchema';

const CONNECTOR_LABEL: Record<ConnectorType, string> = {
  ccs2: 'CCS2',
  chademo: 'CHAdeMO',
  gbt: 'GB/T',
  type2: 'Type 2',
};

/** Vietnamese text for each onboarding error (AD-8 "refuse with reason"); never the raw error. */
export function onboardError(err: unknown): string {
  switch ((err as Partial<ApiError> | undefined)?.code) {
    case 'serial_not_registered':
      return 'Serial chưa được Admin đăng ký';
    case 'already_onboarded':
      return 'Trụ này đã được onboard';
    case 'site_of_other_operator':
      return 'Trạm sạc này thuộc Operator khác';
    case 'site_not_found':
      return 'Không tìm thấy trạm sạc này';
    case 'invalid_input':
      return 'Dữ liệu không hợp lệ: serial 3–25 ký tự (chữ, số, . _ -), 1–2 súng';
    case 'onboarding_unavailable':
      return 'Máy chủ chưa bật onboarding';
  }
  return errorMessage(err);
}

/** The field a CSMS refusal is about (shown under it); null = a form-level message. */
function serverField(err: unknown): 'serial_number' | 'site_id' | null {
  switch ((err as Partial<ApiError> | undefined)?.code) {
    case 'serial_not_registered':
    case 'already_onboarded':
      return 'serial_number';
    case 'site_of_other_operator':
    case 'site_not_found':
      return 'site_id';
  }
  return null;
}

function Credential({ result, onClose }: { result: OnboardResult; onClose: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (label: string, value: string) =>
    void navigator.clipboard?.writeText(value).then(() => setCopied(label));
  const rows: [string, string][] = [
    ['OCPP URL', result.ocpp_url],
    ['Identity', result.identity],
    ['Mật khẩu', result.password],
  ];
  return (
    <>
      <p>
        Trụ <b>{result.display_code}</b> đã được gắn vào trạm ·{' '}
        <span className="pill muted">{LIFECYCLE[result.lifecycle]}</span>
      </p>
      <p className="queue-note error" role="alert">
        Mật khẩu chỉ hiện một lần — nhập vào trụ trước khi đóng.
      </p>
      <dl className="credential">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <code>{value}</code>
              <button
                type="button"
                className="btn small ghost"
                aria-label={`Sao chép ${label}`}
                onClick={() => copy(label, value)}
              >
                {copied === label ? 'Đã chép' : 'Sao chép'}
              </button>
            </dd>
          </div>
        ))}
      </dl>
      <div className="btn-row">
        <Link className="btn ghost" to={`/operator/charge-points/${result.charge_point_id}`}>
          Xem trụ sạc
        </Link>
        <button type="button" className="btn primary" onClick={onClose}>
          Đã lưu, đóng
        </button>
      </div>
    </>
  );
}

export function OnboardingSheet({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const sites = useOperatorSitesQuery();
  const [onboard, { data: result, isLoading, reset }] = useOnboardChargePointMutation();
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<OnboardForm, unknown, OnboardValues>({
    resolver: zodResolver(onboardSchema),
    mode: 'onTouched',
    defaultValues: {
      serial_number: '',
      site_id: '',
      connectors: [
        { connector_no: 1, connector_type: 'ccs2', max_power_kw: '' },
        { connector_no: 2, connector_type: 'ccs2', max_power_kw: '' },
      ],
    },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'connectors' });
  const siteList = sites.data?.items ?? [];
  const firstSite = siteList[0]?.id;
  const noSites = !!sites.data && siteList.length === 0;
  const busy = isLoading || isSubmitting;

  // The first station is chosen once the list arrives.
  useEffect(() => {
    if (firstSite && !getValues('site_id')) setValue('site_id', firstSite);
  }, [firstSite, getValues, setValue]);

  const close = () => {
    reset(); // the password must not stay in the store
    onClose();
  };
  // Escape cancels the form only; the credential needs an explicit "Đã lưu, đóng".
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !result && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [result, busy, onClose]);

  async function onValid(v: OnboardValues) {
    const res = await onboard({
      serial_number: v.serial_number,
      site_id: Number(v.site_id),
      connectors: v.connectors.map((c) => ({
        connector_no: c.connector_no,
        connector_type: c.connector_type,
        ...(c.max_power_kw ? { max_power_kw: Number(c.max_power_kw) } : {}),
      })),
    });
    if (!('error' in res)) return;
    const field = serverField(res.error);
    setError(field ?? 'root.server', { type: 'server', message: onboardError(res.error) });
  }

  return (
    <div className="backdrop">
      <div
        className="card dialog onboarding-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId}>{result ? 'Credential của trụ sạc' : 'Onboard trụ sạc'}</h2>
        {result ? (
          <Credential result={result} onClose={close} />
        ) : (
          <>
            <p className="muted small">
              Gắn một serial Admin đã đăng ký vào trạm sạc của Operator. Trụ chuyển sang "Chờ kết
              nối" cho tới khi kết nối bằng credential.
            </p>
            <Field label="Serial" error={errors.serial_number?.message}>
              {(a11y) => (
                <input
                  {...a11y}
                  {...register('serial_number')}
                  className="input"
                  maxLength={40}
                  placeholder="VD: SIM-0005"
                  autoFocus
                />
              )}
            </Field>
            <Field label="Trạm sạc" error={errors.site_id?.message}>
              {(a11y) => (
                <select {...a11y} {...register('site_id')} className="input" disabled={noSites}>
                  {siteList.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.site_code} · {s.site_name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {sites.error && <FieldError message={errorMessage(sites.error)} />}
            {noSites && <p className="muted small">Operator chưa có trạm sạc nào.</p>}
            <fieldset className="connectors">
              <legend>Súng</legend>
              {fields.map((f, i) => (
                <div key={f.id} className="connector-row">
                  <span>Súng {f.connector_no}</span>
                  <Field label={`Loại súng ${f.connector_no}`}>
                    {(a11y) => (
                      <select
                        {...a11y}
                        {...register(`connectors.${i}.connector_type`)}
                        className="input"
                      >
                        {(Object.keys(CONNECTOR_LABEL) as ConnectorType[]).map((t) => (
                          <option key={t} value={t}>
                            {CONNECTOR_LABEL[t]}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                  <Field
                    label={`Công suất súng ${f.connector_no} (kW, tuỳ chọn)`}
                    error={errors.connectors?.[i]?.max_power_kw?.message}
                  >
                    {(a11y) => (
                      <input
                        {...a11y}
                        {...register(`connectors.${i}.max_power_kw`)}
                        className="input"
                        inputMode="decimal"
                      />
                    )}
                  </Field>
                </div>
              ))}
              <button
                type="button"
                className="btn small ghost"
                onClick={() =>
                  fields.length === 2
                    ? remove(1)
                    : append({ connector_no: 2, connector_type: 'ccs2', max_power_kw: '' })
                }
              >
                {fields.length === 2 ? 'Bỏ súng 2' : 'Thêm súng 2'}
              </button>
              <FieldError
                message={errors.connectors?.root?.message ?? errors.connectors?.message}
              />
            </fieldset>
            <FieldError message={errors.root?.server?.message} />
            <div className="btn-row">
              <button type="button" className="btn ghost" disabled={busy} onClick={close}>
                Huỷ
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={busy || noSites}
                onClick={() => void handleSubmit(onValid)()}
              >
                {busy ? 'Đang gửi…' : 'Onboard'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
