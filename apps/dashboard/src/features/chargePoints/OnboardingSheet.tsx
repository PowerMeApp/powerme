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
import { Button, Group } from '@mantine/core';
import { IconCopy } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
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
import { Notice } from '../../ui/Notice';
import { Sheet } from '../../ui/Sheet';
import { StatusBadge } from '../../ui/StatusBadge';
import { LIFECYCLE } from './format';
import { onboardSchema, type OnboardForm, type OnboardValues } from './onboardSchema';

export { SERIAL_RE } from './onboardSchema';

const CONNECTOR_LABEL: Record<ConnectorType, string> = {
  ccs2: 'CCS2',
  chademo: 'CHAdeMO',
  gbt: 'GB/T',
  type2: 'Loại 2 (châu Âu)',
};

/** Vietnamese text for each onboarding error (AD-8 "refuse with reason"); never the raw error. */
export function onboardError(err: unknown): string {
  switch ((err as Partial<ApiError> | undefined)?.code) {
    case 'serial_not_registered':
      return 'Số seri chưa được quản trị viên đăng ký';
    case 'already_onboarded':
      return 'Trụ này đã được đưa vào vận hành';
    case 'site_of_other_operator':
      return 'Trạm sạc này thuộc đơn vị vận hành khác';
    case 'site_not_found':
      return 'Không tìm thấy trạm sạc này';
    case 'invalid_input':
      return 'Dữ liệu không hợp lệ: số seri 3–25 ký tự (chữ, số, . _ -), 1–2 súng';
    case 'onboarding_unavailable':
      return 'Máy chủ chưa bật chức năng đưa trụ vào vận hành';
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
    ['Địa chỉ kết nối', result.ocpp_url],
    ['Tên đăng nhập của trụ', result.identity],
    ['Mật khẩu', result.password],
  ];
  return (
    <>
      <p>
        Trụ <b>{result.display_code}</b> đã được gắn vào trạm ·{' '}
        <StatusBadge tone="muted">{LIFECYCLE[result.lifecycle]}</StatusBadge>
      </p>
      <Notice tone="error">Mật khẩu chỉ hiện một lần — nhập vào trụ trước khi đóng.</Notice>
      <dl className="credential">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <code>{value}</code>
              <Button
                type="button"
                size="compact-sm"
                variant="subtle"
                color="slate"
                leftSection={<IconCopy size={14} aria-hidden="true" />}
                aria-label={`Sao chép ${label}`}
                onClick={() => copy(label, value)}
              >
                {copied === label ? 'Đã chép' : 'Sao chép'}
              </Button>
            </dd>
          </div>
        ))}
      </dl>
      <Group justify="flex-end" gap="sm">
        <Button
          component={Link}
          variant="default"
          to={`/operator/charge-points/${result.charge_point_id}`}
        >
          Xem trụ sạc
        </Button>
        <Button type="button" onClick={onClose}>
          Đã lưu, đóng
        </Button>
      </Group>
    </>
  );
}

export function OnboardingSheet({ onClose }: { onClose: () => void }) {
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
    // Escape cancels the form only; the credential needs an explicit "Đã lưu, đóng".
    <Sheet
      title={result ? 'Thông tin đăng nhập của trụ sạc' : 'Đưa trụ vào vận hành'}
      onClose={onClose}
      closeOnEscape={!result && !busy}
    >
      {result ? (
        <Credential result={result} onClose={close} />
      ) : (
        <>
          <p className="muted small">
            Gắn một số seri đã được quản trị viên đăng ký vào trạm sạc của đơn vị vận hành. Trụ
            chuyển sang "Chờ kết nối" cho tới khi kết nối bằng thông tin đăng nhập.
          </p>
          <Field label="Số seri" error={errors.serial_number?.message}>
            {(a11y) => (
              <input
                {...a11y}
                {...register('serial_number')}
                className="input"
                maxLength={40}
                placeholder="VD: SIM-0005"
                data-autofocus
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
          {noSites && <p className="muted small">Đơn vị vận hành chưa có trạm sạc nào.</p>}
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
            <Button
              type="button"
              size="compact-sm"
              variant="subtle"
              onClick={() =>
                fields.length === 2
                  ? remove(1)
                  : append({ connector_no: 2, connector_type: 'ccs2', max_power_kw: '' })
              }
            >
              {fields.length === 2 ? 'Bỏ súng 2' : 'Thêm súng 2'}
            </Button>
            <FieldError message={errors.connectors?.root?.message ?? errors.connectors?.message} />
          </fieldset>
          <FieldError message={errors.root?.server?.message} />
          <Group justify="flex-end" gap="sm">
            <Button variant="subtle" color="slate" disabled={busy} onClick={close}>
              Huỷ
            </Button>
            <Button disabled={busy || noSites} onClick={() => void handleSubmit(onValid)()}>
              {busy ? 'Đang gửi…' : 'Đưa vào vận hành'}
            </Button>
          </Group>
        </>
      )}
    </Sheet>
  );
}
