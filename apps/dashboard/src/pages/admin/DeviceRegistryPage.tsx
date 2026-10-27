/**
 * Screen 29 — Device Registry (UC-ADM-03): model, firmware, bảo hành, vòng đời. Admin đăng ký serial
 * (`registered`) trước — operator mới onboard được (WF-05, AD-8).
 */
import { FormEvent, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Card, Loading, PageHeader, Pill } from '../../components/ui';
import { errorMessage, useDevicesQuery, useRegisterDeviceMutation } from '../../core/api/api';
import { useToast } from '../../hooks/toast';
import type { PillarLifecycle } from '../../types/domain';
import { formatDateTime } from '../../utils/format';

const LC: Record<PillarLifecycle, { label: string; tone: 'teal' | 'gold' | 'muted' | 'danger' }> = {
  registered: { label: 'Đã đăng ký', tone: 'muted' },
  awaiting_connection: { label: 'Chờ kết nối', tone: 'gold' },
  in_service: { label: 'Đang hoạt động', tone: 'teal' },
  disabled: { label: 'Tạm ngưng', tone: 'danger' },
  decommissioned: { label: 'Đã gỡ', tone: 'muted' },
};

export function DeviceRegistryPage() {
  const toast = useToast();
  const { data, isLoading } = useDevicesQuery();
  const [register, { isLoading: busy }] = useRegisterDeviceMutation();
  const [serial, setSerial] = useState('');
  const [model, setModel] = useState('D1-120');
  const [firmware, setFirmware] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const r = await register({ serial, model, firmware });
    if ('error' in r) {
      setError(errorMessage(r.error));
      return;
    }
    toast.success(`Đã đăng ký ${r.data.serial} — operator có thể onboard`);
    setSerial('');
    setFirmware('');
  };

  return (
    <>
      <PageHeader
        title="Sổ thiết bị"
        subtitle="Model, firmware, bảo hành và vòng đời của từng trụ"
      />
      <Card title="Đăng ký serial mới">
        <form onSubmit={submit} className="btn-row" style={{ alignItems: 'flex-end' }}>
          <label className="field">
            Serial
            <input
              className="input mono"
              value={serial}
              onChange={(e) => setSerial(e.target.value.toUpperCase())}
              placeholder="RH24D1-00007"
              required
            />
          </label>
          <label className="field">
            Model
            <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="D1-120">D1-120</option>
              <option value="YJ-EU-60">YJ-EU-60</option>
            </select>
          </label>
          <label className="field">
            Firmware
            <input
              className="input"
              value={firmware}
              onChange={(e) => setFirmware(e.target.value)}
              placeholder="3.2.7"
            />
          </label>
          <button className="btn primary" type="submit" disabled={busy}>
            <Icon name="plus" /> Đăng ký
          </button>
        </form>
        {error && (
          <div className="form-error" role="alert" style={{ marginTop: 10 }}>
            {error}
          </div>
        )}
      </Card>
      {isLoading ? (
        <Loading />
      ) : (
        <Card>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Serial</th>
                  <th>Model</th>
                  <th>Firmware</th>
                  <th>Operator</th>
                  <th>Đăng ký</th>
                  <th>Bảo hành đến</th>
                  <th>Vòng đời</th>
                </tr>
              </thead>
              <tbody>
                {(data ?? []).map((d) => (
                  <tr key={d.id}>
                    <td className="mono">{d.serial}</td>
                    <td>{d.model}</td>
                    <td>{d.firmware}</td>
                    <td>{d.operatorName ?? '—'}</td>
                    <td>{formatDateTime(d.registeredAt)}</td>
                    <td>{formatDateTime(d.warrantyUntil)}</td>
                    <td>
                      <Pill tone={LC[d.lifecycle].tone}>{LC[d.lifecycle].label}</Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
