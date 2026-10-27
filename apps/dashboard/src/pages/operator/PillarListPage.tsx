/**
 * Screen 18 — Pillar List (UC-OPS-02) + screen 19 Pillar Onboarding (sheet, WF-05 / SD-5a):
 * serial do Admin đăng ký trước, chọn model và site của operator, nhận credential MỘT LẦN.
 */
import { FormEvent, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Empty, Loading, PageHeader, Sheet, Tabs } from '../../components/ui';
import {
  errorMessage,
  useOnboardPillarMutation,
  usePillarsQuery,
  useSitesQuery,
} from '../../core/api/api';
import { LIVE_POLL_MS } from '../../core/realtime/polling';
import { PillarCard } from '../../features/stations/PillarCard';
import { useToast } from '../../hooks/toast';

type Filter = 'all' | 'online' | 'offline' | 'faulted';

function OnboardingSheet({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const { data: sites } = useSitesQuery();
  const [onboard, { isLoading }] = useOnboardPillarMutation();
  const [serial, setSerial] = useState('');
  const [model, setModel] = useState('D1-120');
  const [siteId, setSiteId] = useState<number | ''>('');
  const [connectorCount, setConnectorCount] = useState(2);
  const [error, setError] = useState<string | null>(null);
  const [credential, setCredential] = useState<{ username: string; password: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const r = await onboard({ serial, model, siteId: Number(siteId), connectorCount });
    if ('error' in r) {
      setError(errorMessage(r.error));
      return;
    }
    setCredential(r.data.credential);
    toast.success(`Đã onboard ${r.data.pillar.serial} — trụ ở trạng thái "Chờ kết nối"`);
  };

  return (
    <Sheet title="Onboard trụ mới" onClose={onClose}>
      {credential ? (
        <>
          <div className="banner">
            Mật khẩu kết nối chỉ hiển thị <b>một lần</b>. Nhập vào trụ (OCPP Basic Auth) trước khi
            đóng cửa sổ này.
          </div>
          <div className="credential">
            <div className="field">
              Tên đăng nhập (serial)
              <span className="mono" style={{ color: 'var(--text)' }}>
                {credential.username}
              </span>
            </div>
            <div className="field" style={{ marginTop: 10 }}>
              Mật khẩu
              <span
                className="mono"
                style={{ color: 'var(--gold)' }}
                data-testid="credential-password"
              >
                {credential.password}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="btn"
            onClick={() => {
              void navigator.clipboard?.writeText(credential.password).catch(() => undefined);
              toast.success('Đã chép mật khẩu');
            }}
          >
            <Icon name="copy" /> Chép mật khẩu
          </button>
          <button type="button" className="btn primary" onClick={onClose}>
            Tôi đã lưu — đóng
          </button>
        </>
      ) : (
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p className="muted" style={{ margin: 0 }}>
            Serial phải đã có trong sổ thiết bị do Admin đăng ký (UC-ADM-03). Thử{' '}
            <span className="mono">RH24D1-00005</span>.
          </p>
          <label className="field">
            Serial
            <input
              className="input mono"
              value={serial}
              onChange={(e) => setSerial(e.target.value.toUpperCase())}
              placeholder="RH24D1-00005"
              required
            />
          </label>
          <label className="field">
            Model
            <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="D1-120">D1 · 120 kW · 2 súng</option>
              <option value="YJ-EU-60">YJ-EU · 60 kW</option>
            </select>
          </label>
          <label className="field">
            Site
            <select
              className="input"
              value={siteId}
              onChange={(e) => setSiteId(e.target.value ? Number(e.target.value) : '')}
              required
            >
              <option value="">— Chọn site —</option>
              {(sites ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} · {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Số súng
            <select
              className="input"
              value={connectorCount}
              onChange={(e) => setConnectorCount(Number(e.target.value))}
            >
              <option value={2}>2 súng</option>
              <option value={1}>1 súng</option>
            </select>
          </label>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <button className="btn primary" type="submit" disabled={isLoading}>
            {isLoading ? 'Đang onboard…' : 'Onboard và tạo mật khẩu'}
          </button>
        </form>
      )}
    </Sheet>
  );
}

export function PillarListPage() {
  const { data, isLoading } = usePillarsQuery(undefined, { pollingInterval: LIVE_POLL_MS });
  const [filter, setFilter] = useState<Filter>('all');
  const [onboarding, setOnboarding] = useState(false);

  const list = useMemo(() => {
    const all = data ?? [];
    switch (filter) {
      case 'online':
        return all.filter((p) => p.isOnline);
      case 'offline':
        return all.filter((p) => !p.isOnline);
      case 'faulted':
        return all.filter((p) => p.connectors.some((c) => c.status === 'Faulted'));
      default:
        return all;
    }
  }, [data, filter]);

  return (
    <>
      <PageHeader
        title="Trụ sạc"
        subtitle="Trạng thái hai súng của từng trụ, cập nhật mỗi 3 giây"
        actions={
          <button type="button" className="btn primary" onClick={() => setOnboarding(true)}>
            <Icon name="plus" /> Onboard trụ
          </button>
        }
      />
      <Tabs
        tabs={[
          { id: 'all', label: `Tất cả (${data?.length ?? 0})` },
          { id: 'online', label: 'Online' },
          { id: 'offline', label: 'Offline' },
          { id: 'faulted', label: 'Có súng lỗi' },
        ]}
        value={filter}
        onChange={setFilter}
      />
      {isLoading ? (
        <Loading />
      ) : list.length === 0 ? (
        <Empty title="Không có trụ nào khớp bộ lọc" />
      ) : (
        <div className="grid cols-2">
          {list.map((p) => (
            <PillarCard key={p.id} pillar={p} />
          ))}
        </div>
      )}
      {onboarding && <OnboardingSheet onClose={() => setOnboarding(false)} />}
    </>
  );
}
