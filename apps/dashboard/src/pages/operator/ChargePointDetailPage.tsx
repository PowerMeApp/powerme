/**
 * Screen 20 — Charge Point Detail (FE-05, UC-OPS-02 / UC-OPS-04), from GET
 * /api/operator/v1/charge-points/{id}: header with lifecycle and "last seen" (D22), capabilities,
 * one card per connector with its raw OCPP status (D21, Offline overriding it — D20), the charge
 * point's fault history (the screen 21 table, filtered; actions work in place) and its 20 latest
 * remote commands. Opened from screens 18 and 21 (D41). Uptime / utilisation and sending remote
 * commands come with Trí's `/metrics` and `/commands` routes; no placeholder until then (D36).
 */
import { Breadcrumbs } from '../../components/Breadcrumbs';
import { Link, useParams } from 'react-router';
import type { RemoteCommandRow } from '@powerme/shared';
import { errorMessage, useOperatorChargePointQuery, type ApiError } from '../../core/api/api';
import { FaultTable } from '../../features/alerts/FaultTable';
import {
  ago,
  connectorTone,
  LIFECYCLE,
  OFFLINE_CARD_RISK,
  statusLabel,
  useNow,
} from '../../features/chargePoints/format';

export const DETAIL_POLL_MS = 5000;

const COMMAND_STATUS: Record<RemoteCommandRow['status'], [string, string]> = {
  pending: ['Chờ gửi', 'muted'],
  sent: ['Đã gửi', ''],
  accepted: ['Trụ chấp nhận', ''],
  rejected: ['Trụ từ chối', 'major'],
  timeout: ['Hết thời gian chờ', 'major'],
  failed: ['Lỗi', 'critical'],
};

const time = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'medium' }) : '—';

export function ChargePointDetailPage() {
  const { id = '' } = useParams();
  const now = useNow();
  const { data, error, isLoading } = useOperatorChargePointQuery(id, {
    pollingInterval: DETAIL_POLL_MS,
    skipPollingIfUnfocused: true,
  });

  if (isLoading) return <p className="muted">Đang tải…</p>;
  if (!data) {
    const notFound = (error as ApiError | undefined)?.status === 404;
    return (
      <>
        <Breadcrumbs items={[{ label: 'Trụ sạc', to: '/operator/charge-points' }, { label: id }]} />
        <div className="card">
          <p role="alert">{notFound ? 'Không tìm thấy trụ sạc' : errorMessage(error)}</p>
          <Link to="/operator/charge-points">← Danh sách trụ sạc</Link>
        </div>
      </>
    );
  }

  const offline = !data.is_online || data.connectors.some((c) => c.status_quality === 'offline');
  const info: [string, string][] = [
    ['Số seri', data.serial_number],
    ['Dòng máy', data.model ?? '—'],
    ['Phần mềm', data.firmware_version ?? '—'],
    ['Công suất định mức', data.rated_power_kw ? `${data.rated_power_kw} kW` : '—'],
    ['Báo mức pin', data.reports_soc ? 'Có' : 'Không'],
    ['Hỗ trợ đặt chỗ', data.supports_reservation ? 'Có' : 'Không'],
  ];

  return (
    <>
      <Breadcrumbs
        items={[
          { label: 'Trụ sạc', to: '/operator/charge-points' },
          { label: data.site.site_name, to: `/operator/stations/${data.site.id}` },
          { label: data.display_code ?? data.serial_number },
        ]}
      />
      <div className="page-head">
        <h1>{data.display_code ?? data.serial_number}</h1>
        <p>
          <Link to={`/operator/stations/${data.site.id}`}>{data.site.site_name}</Link> ·{' '}
          {data.site.site_code}
        </p>
      </div>
      <div className="btn-row detail-status">
        <span className="pill">{LIFECYCLE[data.lifecycle]}</span>
        <span className={`pill ${offline ? 'muted' : ''}`}>
          {offline ? 'Mất kết nối' : 'Đang kết nối'}
        </span>
        <span className="muted small">Lần cuối nhận bản tin: {ago(data.last_message_at, now)}</span>
      </div>
      {data.offline_card_risk ? (
        <p className="detail-status" role="note" aria-label="Rủi ro thẻ khi mất kết nối">
          <span className="pill major">Rủi ro thẻ khi mất kết nối</span>{' '}
          <span className="small">
            {OFFLINE_CARD_RISK[data.offline_card_risk_reason ?? 'not_checked']}. Khi trụ mất mạng,
            thẻ lạ hoặc thẻ đã khoá có thể vẫn sạc được và chỉ bị phát hiện khi trụ nối lại
            (BR-P52).
            {data.offline_auth_check
              ? ` Lần kiểm cuối: ${time(data.offline_auth_check.checked_at)}.`
              : ''}
          </span>
        </p>
      ) : data.offline_auth_check ? (
        <p className="muted small detail-status">
          Đã tắt chấp nhận thẻ khi mất kết nối trên trụ · kiểm lúc{' '}
          {time(data.offline_auth_check.checked_at)}
        </p>
      ) : null}

      <div className="tiles">
        <section className="card tile" aria-label="Thông tin trụ sạc">
          <h2>Thông tin</h2>
          <dl className="info-list">
            {info.map(([k, v]) => (
              <div key={k}>
                <dt className="muted small">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>
        {data.connectors.map((c) => (
          <section key={c.connector_id} className="card tile" aria-label={`Súng ${c.connector_no}`}>
            <h2>Súng {c.connector_no}</h2>
            <p>
              <span className={`pill ${connectorTone(c)}`} title={c.status}>
                {c.status_quality === 'offline' ? 'Mất kết nối' : statusLabel(c.status)}
                {c.status === 'Faulted' && c.error_code ? ` · ${c.error_code}` : ''}
              </span>
              {c.status_quality === 'stale' && <span className="muted small"> · có thể đã cũ</span>}
            </p>
            <p className="muted small">
              {[c.connector_type?.toUpperCase(), c.max_power_kw ? `${c.max_power_kw} kW` : null]
                .filter(Boolean)
                .join(' · ') || '—'}
            </p>
            <p className="muted small">
              {c.active_session_id
                ? `Đang có phiên ${c.active_session_id}`
                : 'Không có phiên đang chạy'}
              {c.status_updated_at ? ` · trạng thái từ ${ago(c.status_updated_at, now)}` : ''}
            </p>
          </section>
        ))}
      </div>

      <h2 className="section-title">Sự cố của trụ sạc</h2>
      <FaultTable chargePointId={data.id} defaultStatus="all" />

      <h2 className="section-title">Lệnh gần đây</h2>
      {data.recent_commands.length === 0 ? (
        <div className="card">
          <p className="muted">Chưa có lệnh nào.</p>
        </div>
      ) : (
        <div className="card table-card">
          <div className="table-wrap">
            <table className="data-table" aria-label="Lệnh gần đây">
              <thead>
                <tr>
                  <th scope="col">Lệnh</th>
                  <th scope="col">Súng</th>
                  <th scope="col">Kết quả</th>
                  <th scope="col">Yêu cầu</th>
                  <th scope="col">Trụ trả lời</th>
                  <th scope="col">Lỗi</th>
                </tr>
              </thead>
              <tbody>
                {data.recent_commands.map((cmd) => {
                  const [label, tone] = COMMAND_STATUS[cmd.status];
                  return (
                    <tr key={cmd.id}>
                      <td className="cell-title">{cmd.action}</td>
                      <td>{cmd.connector_no ? `Súng ${cmd.connector_no}` : 'Cả trụ'}</td>
                      <td>
                        <span className={`pill ${tone}`}>{label}</span>
                      </td>
                      <td className="nowrap">{time(cmd.requested_at)}</td>
                      <td className="nowrap">{time(cmd.responded_at)}</td>
                      <td>{cmd.error ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
