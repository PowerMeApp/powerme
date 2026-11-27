/**
 * Device registry (admin only): every registered charge point of the platform with its model,
 * firmware, rated power, warranty and lifecycle, filtered by lifecycle and paged. "Đăng ký trụ"
 * adds a serial, after which an operator can onboard it. Registered rows cannot be edited here.
 */
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { ChargePointLifecycle, RegistryChargePoint } from '@powerme/shared';
import { Breadcrumbs } from '../../components/Breadcrumbs';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Field, FieldError } from '../../components/Field';
import {
  REGISTRY_PAGE_SIZE,
  useAdminRegistryQuery,
  useRegisterDeviceMutation,
  type ApiError,
} from '../../core/api/api';
import { LIFECYCLE } from '../../features/chargePoints/format';
import { MAX_MODEL, registryError } from '../../features/registry/format';
import {
  registerSchema,
  type RegisterForm,
  type RegisterValues,
} from '../../features/registry/schema';

type Note = { tone: 'ok' | 'error'; text: string } | null;

const LIFECYCLE_TONE: Record<ChargePointLifecycle, string> = {
  registered: 'muted',
  awaiting_connection: 'major',
  in_service: '',
  disabled: 'major',
  decommissioned: 'muted',
};

const day = (iso: string) => new Date(iso).toLocaleDateString('vi-VN');
const dash = <span className="muted">—</span>;

/** "Đăng ký trụ" (react-hook-form + zod, D43): each invalid field shows its message beneath it. */
function RegisterDialog({
  onDone,
  onCancel,
}: {
  onDone: (t: string) => void;
  onCancel: () => void;
}) {
  const [registerDevice, { isLoading }] = useRegisterDeviceMutation();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterForm, unknown, RegisterValues>({
    resolver: zodResolver(registerSchema),
    mode: 'onTouched',
    defaultValues: { serial_number: '', model: '', rated_power_kw: '' },
  });

  async function onValid(v: RegisterValues) {
    const res = await registerDevice({
      serial_number: v.serial_number,
      ...(v.model ? { model: v.model } : {}),
      ...(v.rated_power_kw ? { rated_power_kw: Number(v.rated_power_kw) } : {}),
    });
    if ('error' in res) {
      const taken = (res.error as ApiError).code === 'serial_already_registered';
      return setError(taken ? 'serial_number' : 'root.server', {
        type: 'server',
        message: registryError(res.error),
      });
    }
    onDone(`Đã đăng ký trụ ${v.serial_number}, đơn vị vận hành có thể đưa trụ này vào vận hành`);
  }

  return (
    <ConfirmDialog
      title="Đăng ký trụ sạc"
      confirmLabel="Đăng ký"
      busy={isLoading || isSubmitting}
      onCancel={onCancel}
      onConfirm={() => void handleSubmit(onValid)()}
    >
      <Field label="Số seri" error={errors.serial_number?.message}>
        {(a11y) => (
          <input
            {...a11y}
            {...register('serial_number')}
            className="input"
            maxLength={40}
            placeholder="Số seri in trên trụ"
          />
        )}
      </Field>
      <Field label="Dòng máy (tuỳ chọn)" error={errors.model?.message}>
        {(a11y) => (
          <input {...a11y} {...register('model')} className="input" maxLength={MAX_MODEL + 10} />
        )}
      </Field>
      <Field label="Công suất định mức, kW (tuỳ chọn)" error={errors.rated_power_kw?.message}>
        {(a11y) => (
          <input {...a11y} {...register('rated_power_kw')} className="input" inputMode="decimal" />
        )}
      </Field>
      <FieldError message={errors.root?.server?.message} />
    </ConfirmDialog>
  );
}

function RegistryRow({ cp }: { cp: RegistryChargePoint }) {
  return (
    <tr aria-label={`Trụ ${cp.serial_number}`}>
      <td className="cell-title">{cp.serial_number}</td>
      <td>{cp.display_code ?? dash}</td>
      <td>
        {cp.model ?? dash}
        {cp.firmware_version && <div className="muted small">Phần mềm {cp.firmware_version}</div>}
      </td>
      <td>{cp.rated_power_kw ?? dash}</td>
      <td className="nowrap">
        {cp.warranty_until ? cp.warranty_until.split('-').reverse().join('/') : dash}
      </td>
      <td>
        <span className={`pill ${LIFECYCLE_TONE[cp.lifecycle]}`}>{LIFECYCLE[cp.lifecycle]}</span>
      </td>
      <td>
        {cp.operator ? (
          <>
            {cp.operator.legal_name}
            {cp.site && (
              <div className="muted small">
                {cp.site.site_code} · {cp.site.site_name}
              </div>
            )}
          </>
        ) : (
          dash
        )}
      </td>
      <td className="nowrap">{day(cp.created_at)}</td>
    </tr>
  );
}

export function DeviceRegistryPage() {
  const [lifecycle, setLifecycle] = useState<ChargePointLifecycle | ''>('');
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const { data, error, isLoading } = useAdminRegistryQuery({
    page,
    ...(lifecycle ? { lifecycle } : {}),
  });
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / REGISTRY_PAGE_SIZE));
  if (data && page > pages) setPage(pages);

  return (
    <>
      <Breadcrumbs items={[{ label: 'Sổ đăng ký trụ' }]} />
      <div className="page-head">
        <h1>Sổ đăng ký trụ</h1>
        <button
          type="button"
          className="btn primary page-action"
          onClick={() => {
            setNote(null);
            setDialog(true);
          }}
        >
          Đăng ký trụ
        </button>
      </div>
      <div className="filters">
        <label className="field">
          Vòng đời
          <select
            className="input"
            value={lifecycle}
            onChange={(e) => {
              setLifecycle(e.target.value as ChargePointLifecycle | '');
              setPage(1);
            }}
          >
            <option value="">Tất cả</option>
            {(Object.keys(LIFECYCLE) as ChargePointLifecycle[]).map((l) => (
              <option key={l} value={l}>
                {LIFECYCLE[l]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {note && (
        <p className={`queue-note ${note.tone}`} role={note.tone === 'ok' ? 'status' : 'alert'}>
          {note.text}
        </p>
      )}
      {isLoading ? (
        <p className="muted">Đang tải…</p>
      ) : error && !data ? (
        <p role="alert">{registryError(error)}</p>
      ) : !data || data.items.length === 0 ? (
        <div className="card">
          <p className="muted">
            {lifecycle ? 'Không có trụ nào khớp bộ lọc.' : 'Chưa có trụ nào được đăng ký.'}
          </p>
        </div>
      ) : (
        <div className="card table-card">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Số seri</th>
                  <th scope="col">Mã hiển thị</th>
                  <th scope="col">Dòng máy / phần mềm</th>
                  <th scope="col">Công suất (kW)</th>
                  <th scope="col">Bảo hành đến</th>
                  <th scope="col">Vòng đời</th>
                  <th scope="col">Đơn vị vận hành / trạm</th>
                  <th scope="col">Ngày đăng ký</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((cp) => (
                  <RegistryRow key={cp.id} cp={cp} />
                ))}
              </tbody>
            </table>
          </div>
          <nav className="pager" aria-label="Phân trang">
            <span className="muted">
              {total} trụ · Trang {page} / {pages}
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
      {dialog && (
        <RegisterDialog
          onDone={(text) => {
            setDialog(false);
            setNote({ tone: 'ok', text });
          }}
          onCancel={() => setDialog(false)}
        />
      )}
    </>
  );
}
