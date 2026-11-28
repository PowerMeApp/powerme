/**
 * Station page (FE-07; detail page outside SRS Table 5, reached from screens 18, 20 and 25):
 * one Charging Station of the signed-in staff's Operator — its charge points with live status
 * (same data and rules as screen 18: GET /api/operator/v1/charge-points?site_id=, polled every
 * 5 s), each linking to its own page (screen 20), and the station's revenue (T108). A station of
 * another Operator, or one without charge points, comes back empty → "not found". The only
 * search is in the revenue filters below (Nghĩa 20/11); the charge point list always shows all.
 */
import { Anchor, Loader, Table } from '@mantine/core';
import { Link, useParams } from 'react-router';
import { Breadcrumbs } from '../../components/Breadcrumbs';
import { errorMessage, useOperatorChargePointsQuery } from '../../core/api/api';
import { ConnectorList, isOffline, OnlineCell } from '../../features/chargePoints/ConnectorList';
import { LIFECYCLE, useNow } from '../../features/chargePoints/format';
import { RevenueReportView } from '../../features/revenue/RevenueReportView';
import { DataTable } from '../../ui/DataTable';
import { Notice } from '../../ui/Notice';
import { PageHeader, Section } from '../../ui/PageHeader';
import { Pager, useClientPage } from '../../ui/Pager';
import { StatusBadge } from '../../ui/StatusBadge';
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
  const { pageRows, paged, pagerProps } = useClientPage(items);

  if (isLoading) return <Loader size="sm" aria-label="Đang tải…" />;
  if (error && !data) return <Notice tone="error">{errorMessage(error)}</Notice>;
  if (!site)
    return (
      <>
        <Breadcrumbs
          items={[{ label: 'Trụ sạc', to: '/operator/charge-points' }, { label: 'Trạm sạc' }]}
        />
        <Notice tone="warn" role="alert">
          Không tìm thấy trạm sạc này trong các trạm của đơn vị vận hành.
        </Notice>
        <Anchor component={Link} to="/operator/charge-points">
          ← Danh sách trụ sạc
        </Anchor>
      </>
    );

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Trụ sạc', to: '/operator/charge-points' }, { label: site.site_name }]}
        title={site.site_name}
        subtitle={`Trạm sạc ${site.site_code} · ${online}/${items.length} trụ sạc đang kết nối`}
      />
      <Section label="Trụ sạc của trạm">
        <DataTable
          minWidth={680}
          footer={paged ? <Pager label="Phân trang trụ sạc" {...pagerProps} /> : undefined}
        >
          <Table.Thead>
            <Table.Tr>
              <Table.Th scope="col">Trụ sạc</Table.Th>
              <Table.Th scope="col">Vòng đời</Table.Th>
              <Table.Th scope="col">Kết nối</Table.Th>
              <Table.Th scope="col">Súng</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {pageRows.map((cp) => (
              <Table.Tr
                key={cp.id}
                aria-label={`Trụ sạc ${cp.display_code ?? cp.serial_number}`}
                data-tone={isOffline(cp) ? 'muted' : undefined}
              >
                <Table.Td>
                  <Link className="cell-title" to={`/operator/charge-points/${cp.id}`}>
                    {cp.display_code ?? cp.serial_number}
                  </Link>
                  <div className="muted small">
                    {cp.serial_number}
                    {cp.model ? ` · ${cp.model}` : ''}
                  </div>
                </Table.Td>
                <Table.Td>
                  <StatusBadge>{LIFECYCLE[cp.lifecycle]}</StatusBadge>
                </Table.Td>
                <Table.Td className="nowrap">
                  <OnlineCell cp={cp} now={now} />
                </Table.Td>
                <Table.Td>
                  <ConnectorList cp={cp} />
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </DataTable>
      </Section>
      <Section label="Doanh thu của trạm" className="station-revenue">
        <RevenueReportView scope="operator" siteId={id} />
      </Section>
    </>
  );
}
