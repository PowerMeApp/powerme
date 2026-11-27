/**
 * Screen 19 — Charge Point Onboarding (sheet, FE-02, UC-OPS-01, AD-8, BR-P49). Opened from screen 18.
 *   1. Form: a serial the Admin registered, one of the Operator's own Charging Stations
 *      (GET /operator/v1/sites) and 1–2 connectors (BR-P10). The CSMS checks the site's Operator
 *      and the serial's state and refuses with a reason (409 / 403 / 404).
 *   2. Result: the charge point's credential, shown once (only its hash is stored). Escape and the
 *      backdrop do not close it; closing resets the mutation so the password leaves the store.
 * Manager and technician alike (D42).
 */
import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import type { ConnectorType, OnboardResult } from '@powerme/shared';
import {
  errorMessage,
  useOnboardChargePointMutation,
  useOperatorSitesQuery,
  type ApiError,
} from '../../core/api/api';
import { LIFECYCLE } from './format';

/** Same rule as the CSMS (`serialField`, OCPP identity = Basic-auth user name). */
export const SERIAL_RE = /^[A-Za-z0-9._-]{3,25}$/;
const MAX_KW = 99_999.99;

const CONNECTOR_TYPES: [ConnectorType, string][] = [
  ['ccs2', 'CCS2'],
  ['chademo', 'CHAdeMO'],
  ['gbt', 'GB/T'],
  ['type2', 'Type 2'],
];

interface ConnectorDraft {
  no: 1 | 2;
  type: ConnectorType;
  kw: string;
}

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

const kwOk = (kw: string) => {
  if (!kw.trim()) return true;
  const n = Number(kw);
  return Number.isFinite(n) && n > 0 && n <= MAX_KW;
};

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
  const [serial, setSerial] = useState('');
  const [siteId, setSiteId] = useState('');
  const [connectors, setConnectors] = useState<ConnectorDraft[]>([
    { no: 1, type: 'ccs2', kw: '' },
    { no: 2, type: 'ccs2', kw: '' },
  ]);
  const [error, setError] = useState<string | null>(null);
  const siteList = sites.data?.items ?? [];
  const chosenSite = siteId || siteList[0]?.id || '';
  const noSites = !!sites.data && siteList.length === 0;

  const close = () => {
    reset(); // the password must not stay in the store
    onClose();
  };
  // Escape cancels the form only; the credential needs an explicit "Đã lưu, đóng".
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !result && !isLoading && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [result, isLoading, onClose]);

  const setConnector = (no: 1 | 2, patch: Partial<ConnectorDraft>) =>
    setConnectors((list) => list.map((c) => (c.no === no ? { ...c, ...patch } : c)));

  async function submit() {
    const sn = serial.trim();
    if (!SERIAL_RE.test(sn)) return setError('Serial 3–25 ký tự: chữ, số, dấu . _ -');
    if (!chosenSite) return setError('Chọn một trạm sạc');
    if (!connectors.every((c) => kwOk(c.kw))) return setError('Công suất phải lớn hơn 0 kW');
    setError(null);
    const res = await onboard({
      serial_number: sn,
      site_id: Number(chosenSite),
      connectors: connectors.map((c) => ({
        connector_no: c.no,
        connector_type: c.type,
        ...(c.kw.trim() ? { max_power_kw: Number(c.kw) } : {}),
      })),
    });
    if ('error' in res) setError(onboardError(res.error));
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
            <label className="field">
              Serial
              <input
                className="input"
                value={serial}
                maxLength={40}
                placeholder="VD: SIM-0005"
                autoFocus
                onChange={(e) => setSerial(e.target.value)}
              />
            </label>
            <label className="field">
              Trạm sạc
              <select
                className="input"
                value={chosenSite}
                disabled={noSites}
                onChange={(e) => setSiteId(e.target.value)}
              >
                {siteList.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.site_code} · {s.site_name}
                  </option>
                ))}
              </select>
            </label>
            {sites.error && <p role="alert">{errorMessage(sites.error)}</p>}
            {noSites && <p className="muted small">Operator chưa có trạm sạc nào.</p>}
            <fieldset className="connectors">
              <legend>Súng</legend>
              {connectors.map((c) => (
                <div key={c.no} className="connector-row">
                  <span>Súng {c.no}</span>
                  <label className="field">
                    Loại súng {c.no}
                    <select
                      className="input"
                      value={c.type}
                      onChange={(e) =>
                        setConnector(c.no, { type: e.target.value as ConnectorType })
                      }
                    >
                      {CONNECTOR_TYPES.map(([id, label]) => (
                        <option key={id} value={id}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    Công suất súng {c.no} (kW, tuỳ chọn)
                    <input
                      className="input"
                      inputMode="decimal"
                      value={c.kw}
                      onChange={(e) => setConnector(c.no, { kw: e.target.value })}
                    />
                  </label>
                </div>
              ))}
              <button
                type="button"
                className="btn small ghost"
                onClick={() =>
                  setConnectors((list) =>
                    list.length === 2
                      ? list.slice(0, 1)
                      : [...list, { no: 2, type: 'ccs2', kw: '' }],
                  )
                }
              >
                {connectors.length === 2 ? 'Bỏ súng 2' : 'Thêm súng 2'}
              </button>
            </fieldset>
            {error && <p role="alert">{error}</p>}
            <div className="btn-row">
              <button type="button" className="btn ghost" disabled={isLoading} onClick={close}>
                Huỷ
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={isLoading || noSites}
                onClick={() => void submit()}
              >
                {isLoading ? 'Đang gửi…' : 'Onboard'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
