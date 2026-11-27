/**
 * Device registry (admin only): every registered charge point of the platform with its model,
 * firmware, rated power, warranty and lifecycle, filtered by lifecycle and paged. "Đăng ký trụ"
 * adds a serial, after which an operator can onboard it. Registered rows cannot be edited here.
 */
import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Loader, Table } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { ChargePointLifecycle, RegistryChargePoint } from '@powerme/shared';
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
import { DataTable, EmptyState } from '../../ui/DataTable';
import { FilterBar, SelectFilter } from '../../ui/FilterBar';
import { Notice, type Note } from '../../ui/Notice';
import { PageHeader } from '../../ui/PageHeader';
import { Pager, pageCount } from '../../ui/Pager';
import { StatusBadge } from '../../ui/StatusBadge';

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
    <Table.Tr aria-label={`Trụ ${cp.serial_number}`}>
      <Table.Td className="cell-title">{cp.serial_number}</Table.Td>
      <Table.Td>{cp.display_code ?? dash}</Table.Td>
      <Table.Td>
        {cp.model ?? dash}
        {cp.firmware_version && <div className="muted small">Phần mềm {cp.firmware_version}</div>}
      </Table.Td>
      <Table.Td>{cp.rated_power_kw ?? dash}</Table.Td>
      <Table.Td className="nowrap">
        {cp.warranty_until ? cp.warranty_until.split('-').reverse().join('/') : dash}
      </Table.Td>
      <Table.Td>
        <StatusBadge tone={LIFECYCLE_TONE[cp.lifecycle]}>{LIFECYCLE[cp.lifecycle]}</StatusBadge>
      </Table.Td>
      <Table.Td>
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
      </Table.Td>
      <Table.Td className="nowrap">{day(cp.created_at)}</Table.Td>
    </Table.Tr>
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
  const pages = pageCount(total, REGISTRY_PAGE_SIZE);
  if (data && page > pages) setPage(pages);

  const first = ((data?.page ?? 1) - 1) * (data?.page_size ?? REGISTRY_PAGE_SIZE) + 1;

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Sổ đăng ký trụ' }]}
        title="Sổ đăng ký trụ"
        actions={
          <Button
            leftSection={<IconPlus size={16} aria-hidden="true" />}
            onClick={() => {
              setNote(null);
              setDialog(true);
            }}
          >
            Đăng ký trụ
          </Button>
        }
      />
      <FilterBar>
        <SelectFilter
          label="Vòng đời"
          value={lifecycle}
          options={[
            ['', 'Tất cả'],
            ...(Object.keys(LIFECYCLE) as ChargePointLifecycle[]).map(
              (l) => [l, LIFECYCLE[l]] as const,
            ),
          ]}
          onChange={(v) => {
            setLifecycle(v);
            setPage(1);
          }}
        />
      </FilterBar>
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      {isLoading ? (
        <Loader size="sm" aria-label="Đang tải…" />
      ) : error && !data ? (
        <Notice tone="error">{registryError(error)}</Notice>
      ) : !data || data.items.length === 0 ? (
        <EmptyState>
          {lifecycle ? 'Không có trụ nào khớp bộ lọc.' : 'Chưa có trụ nào được đăng ký.'}
        </EmptyState>
      ) : (
        <DataTable
          minWidth={1040}
          footer={
            <Pager
              first={first}
              last={first + data.items.length - 1}
              total={total}
              page={page}
              pages={pages}
              onPage={setPage}
            />
          }
        >
          <Table.Thead>
            <Table.Tr>
              <Table.Th scope="col">Số seri</Table.Th>
              <Table.Th scope="col">Mã hiển thị</Table.Th>
              <Table.Th scope="col">Dòng máy / phần mềm</Table.Th>
              <Table.Th scope="col">Công suất (kW)</Table.Th>
              <Table.Th scope="col">Bảo hành đến</Table.Th>
              <Table.Th scope="col">Vòng đời</Table.Th>
              <Table.Th scope="col">Đơn vị vận hành / trạm</Table.Th>
              <Table.Th scope="col">Ngày đăng ký</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.items.map((cp) => (
              <RegistryRow key={cp.id} cp={cp} />
            ))}
          </Table.Tbody>
        </DataTable>
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
