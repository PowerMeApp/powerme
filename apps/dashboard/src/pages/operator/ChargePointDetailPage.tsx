import { RfidProtection } from '../../components/RfidProtection';
/**
 * Screen 20 — Charge Point Detail (FE-05, UC-OPS-02 / UC-OPS-04), from GET
 * /api/operator/v1/charge-points/{id}: header with lifecycle and "last seen" (D22), capabilities,
 * one card per connector with its raw OCPP status (D21, Offline overriding it — D20), the charge
 * point's fault history (the screen 21 table, filtered; actions work in place) and its 20 latest
 * remote commands. Opened from screens 18 and 21 (D41). Uptime / utilisation and sending remote
 * commands come with Trí's `/metrics` and `/commands` routes; no placeholder until then (D36).
 */
import { Anchor, Card, Group, Loader, SimpleGrid, Table, Text, Title } from '@mantine/core';
import { IconBolt, IconInfoCircle } from '@tabler/icons-react';
import { Link, useParams } from 'react-router';
import type { RemoteCommandRow } from '@powerme/shared';
import { Breadcrumbs } from '../../components/Breadcrumbs';
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
import { DataTable, EmptyState } from '../../ui/DataTable';
import { Notice } from '../../ui/Notice';
import { PageHeader, Section } from '../../ui/PageHeader';
import { StatusBadge } from '../../ui/StatusBadge';
import { onlineBadge } from '../../ui/tones';

export const DETAIL_POLL_MS = 5000;

/** Remote command names in Vietnamese; the OCPP action name stays in the tooltip. */
const COMMAND_ACTION: Record<string, string> = {
  RemoteStartTransaction: 'Bắt đầu sạc từ xa',
  RemoteStopTransaction: 'Dừng sạc từ xa',
  Reset: 'Khởi động lại',
  ChangeAvailability: 'Đổi trạng thái súng',
  ChangeConfiguration: 'Đổi cấu hình trụ',
  GetConfiguration: 'Đọc cấu hình trụ',
  TriggerMessage: 'Yêu cầu trụ gửi bản tin',
  SetChargingProfile: 'Đặt giới hạn công suất',
  ReserveNow: 'Giữ chỗ súng',
  CancelReservation: 'Huỷ giữ chỗ',
  UnlockConnector: 'Mở khoá súng',
};

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

  if (isLoading) return <Loader size="sm" aria-label="Đang tải…" />;
  if (!data) {
    const notFound = (error as ApiError | undefined)?.status === 404;
    return (
      <>
        <Breadcrumbs items={[{ label: 'Trụ sạc', to: '/operator/charge-points' }, { label: id }]} />
        <Notice tone="error">{notFound ? 'Không tìm thấy trụ sạc' : errorMessage(error)}</Notice>
        <Anchor component={Link} to="/operator/charge-points">
          ← Danh sách trụ sạc
        </Anchor>
      </>
    );
  }

  const offline = !data.is_online || data.connectors.some((c) => c.status_quality === 'offline');
  const [onlineLabel, onlineTone] = onlineBadge(offline);
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
      <PageHeader
        crumbs={[
          { label: 'Trụ sạc', to: '/operator/charge-points' },
          { label: data.site.site_name, to: `/operator/stations/${data.site.id}` },
          { label: data.display_code ?? data.serial_number },
        ]}
        title={data.display_code ?? data.serial_number}
        badges={
          <>
            <StatusBadge>{LIFECYCLE[data.lifecycle]}</StatusBadge>
            <StatusBadge tone={onlineTone}>{onlineLabel}</StatusBadge>
          </>
        }
        subtitle={
          <>
            <Link to={`/operator/stations/${data.site.id}`}>{data.site.site_name}</Link> ·{' '}
            {data.site.site_code} · Lần cuối nhận bản tin: {ago(data.last_message_at, now)}
          </>
        }
      />
      {data.offline_card_risk ? (
        <Notice
          tone="warn"
          role="note"
          label="Rủi ro thẻ khi mất kết nối"
          title="Rủi ro thẻ khi mất kết nối"
          className="note"
        >
          {OFFLINE_CARD_RISK[data.offline_card_risk_reason ?? 'not_checked']}. Khi trụ mất mạng, thẻ
          lạ hoặc thẻ đã khoá có thể vẫn sạc được và chỉ bị phát hiện khi trụ nối lại.
          {data.offline_auth_check
            ? ` Lần kiểm cuối: ${time(data.offline_auth_check.checked_at)}.`
            : ''}
        </Notice>
      ) : data.offline_auth_check ? (
        <p className="muted small">
          Đã tắt chấp nhận thẻ khi mất kết nối trên trụ · kiểm lúc{' '}
          {time(data.offline_auth_check.checked_at)}
        </p>
      ) : null}

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <Card component="section" aria-label="Thông tin trụ sạc" className="tile">
          <Group gap="xs" className="tile-head">
            <IconInfoCircle size={18} aria-hidden="true" />
            <Title order={2} className="tile-title">
              Thông tin
            </Title>
          </Group>
          <dl className="info-list">
            {info.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <SimpleGrid
          cols={{ base: 1, sm: Math.min(2, Math.max(1, data.connectors.length)) }}
          spacing="md"
        >
          {data.connectors.map((c) => {
            const tone = connectorTone(c);
            return (
              <Card
                key={c.connector_id}
                component="section"
                aria-label={`Súng ${c.connector_no}`}
                className="tile"
                data-tone={
                  tone === 'critical' ? 'critical' : tone === 'major' ? 'major' : undefined
                }
              >
                <Group gap="xs" className="tile-head">
                  <IconBolt size={18} aria-hidden="true" />
                  <Title order={2} className="tile-title">
                    Súng {c.connector_no}
                  </Title>
                </Group>
                <div>
                  <StatusBadge tone={tone} size="lg" title={c.status}>
                    {c.status_quality === 'offline' ? 'Mất kết nối' : statusLabel(c.status)}
                    {c.status === 'Faulted' && c.error_code ? ` · ${c.error_code}` : ''}
                  </StatusBadge>
                  {c.status_quality === 'stale' && (
                    <span className="muted small"> · có thể đã cũ</span>
                  )}
                </div>
                <Text size="sm" c="dimmed">
                  {[c.connector_type?.toUpperCase(), c.max_power_kw ? `${c.max_power_kw} kW` : null]
                    .filter(Boolean)
                    .join(' · ') || '—'}
                </Text>
                <Text size="sm" c="dimmed">
                  {c.active_session_id
                    ? `Đang có phiên ${c.active_session_id}`
                    : 'Không có phiên đang chạy'}
                  {c.status_updated_at ? ` · trạng thái từ ${ago(c.status_updated_at, now)}` : ''}
                </Text>
              </Card>
            );
          })}
        </SimpleGrid>
      </SimpleGrid>

      <Section label="Sự cố của trụ sạc">
        <FaultTable chargePointId={data.id} defaultStatus="all" />
      </Section>

      <RfidProtection data={data.rfid_credit_protection} />
      <Section label="Lệnh gần đây">
        {data.recent_commands.length === 0 ? (
          <EmptyState>Chưa có lệnh nào.</EmptyState>
        ) : (
          <DataTable label="Lệnh gần đây" minWidth={720}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th scope="col">Lệnh</Table.Th>
                <Table.Th scope="col">Súng</Table.Th>
                <Table.Th scope="col">Kết quả</Table.Th>
                <Table.Th scope="col">Yêu cầu</Table.Th>
                <Table.Th scope="col">Trụ trả lời</Table.Th>
                <Table.Th scope="col">Lỗi</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {data.recent_commands.map((cmd) => {
                const [label, tone] = COMMAND_STATUS[cmd.status];
                return (
                  <Table.Tr key={cmd.id} data-tone={tone || undefined}>
                    <Table.Td className="cell-title">
                      <span title={cmd.action}>{COMMAND_ACTION[cmd.action] ?? cmd.action}</span>
                    </Table.Td>
                    <Table.Td>{cmd.connector_no ? `Súng ${cmd.connector_no}` : 'Cả trụ'}</Table.Td>
                    <Table.Td>
                      <StatusBadge tone={tone}>{label}</StatusBadge>
                    </Table.Td>
                    <Table.Td className="nowrap">{time(cmd.requested_at)}</Table.Td>
                    <Table.Td className="nowrap">{time(cmd.responded_at)}</Table.Td>
                    <Table.Td>{cmd.error ?? '—'}</Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </DataTable>
        )}
      </Section>
    </>
  );
}
