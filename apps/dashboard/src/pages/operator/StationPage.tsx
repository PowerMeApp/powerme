/**
 * Station page (FE-07; detail page outside SRS Table 5, reached from screens 18, 20 and 25):
 * one Charging Station of the signed-in staff's Operator — its charge points with live status
 * (same data and rules as screen 18: GET /api/operator/v1/charge-points?site_id=, polled every
 * 5 s), each linking to its own page (screen 20), and the station's revenue (T108). A station of
 * another Operator, or one without charge points, comes back empty → "not found". The only
 * search is in the revenue filters below (Nghĩa 20/11); the charge point list always shows all.
 */
import { Link, useParams } from 'react-router';
import { Breadcrumbs } from '../../components/Breadcrumbs';
import { errorMessage, useOperatorChargePointsQuery } from '../../core/api/api';
import { ConnectorList, isOffline } from '../../features/chargePoints/ConnectorList';
import { ago, LIFECYCLE, useNow } from '../../features/chargePoints/format';
import { RevenueReportView } from '../../features/revenue/RevenueReportView';
import { LIST_POLL_MS } from './ChargePointListPage';

/** Contract maximum page size: a station has far fewer charge points. */
const STATION_PAGE_SIZE = 100;

export function StationPage() {
  const { id = '' } = useParams();
  const now = useNow();
  const { data, error, isLoading } = useOperatorChargePointsQuery(
    { page: 1, siteId: id, pageSize: STATION_PAGE_SIZE },
    { pollingInterval: LIST_POLL_MS, skipPollingIfUnfocused: true },
  );
  const items = data?.items ?? [];
  const site = items[0]?.site;
  const online = items.filter((cp) => !isOffline(cp)).length;

  if (isLoading) return <p className="muted">Đang tải…</p>;
  if (error && !data) return <p role="alert">{errorMessage(error)}</p>;
  if (!site)
    return (
      <>
        <Breadcrumbs
          items={[{ label: 'Trụ sạc', to: '/operator/charge-points' }, { label: 'Trạm sạc' }]}
        />
        <div className="card">
          <p role="alert">Không tìm thấy trạm sạc này trong các trạm của đơn vị vận hành.</p>
          <Link to="/operator/charge-points">← Danh sách trụ sạc</Link>
        </div>
      </>
    );

  return (
    <>
      <Breadcrumbs
        items={[{ label: 'Trụ sạc', to: '/operator/charge-points' }, { label: site.site_name }]}
      />
      <div className="page-head">
        <h1>{site.site_name}</h1>
        <p>
          Trạm sạc {site.site_code} · {online}/{items.length} trụ sạc đang kết nối
        </p>
      </div>
      <section aria-label="Trụ sạc của trạm">
        <h2 className="section-title">Trụ sạc của trạm</h2>
        <div className="card table-card">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Trụ sạc</th>
                  <th scope="col">Vòng đời</th>
                  <th scope="col">Kết nối</th>
                  <th scope="col">Súng</th>
                </tr>
              </thead>
              <tbody>
                {items.map((cp) => {
                  const off = isOffline(cp);
                  return (
                    <tr key={cp.id} aria-label={`Trụ sạc ${cp.display_code ?? cp.serial_number}`}>
                      <td>
                        <Link className="cell-title" to={`/operator/charge-points/${cp.id}`}>
                          {cp.display_code ?? cp.serial_number}
                        </Link>
                        <div className="muted small">
                          {cp.serial_number}
                          {cp.model ? ` · ${cp.model}` : ''}
                        </div>
                      </td>
                      <td>
                        <span className="pill">{LIFECYCLE[cp.lifecycle]}</span>
                      </td>
                      <td className="nowrap">
                        <span className={`pill ${off ? 'muted' : ''}`}>
                          {off ? 'Mất kết nối' : 'Đang kết nối'}
                        </span>
                        <div className="muted small">{ago(cp.last_message_at, now)}</div>
                      </td>
                      <td>
                        <ConnectorList cp={cp} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>
      <section aria-label="Doanh thu của trạm" className="station-revenue">
        <h2 className="section-title">Doanh thu của trạm</h2>
        <RevenueReportView scope="operator" siteId={id} />
      </section>
    </>
  );
}
