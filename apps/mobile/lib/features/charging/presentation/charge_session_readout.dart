import 'package:flutter/material.dart' hide ConnectionState;

import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/flow_page.dart';
import '../domain/charge_session.dart';
import '../domain/charging.dart';
import 'charge_energy_label.dart';
import 'charge_flow_visuals.dart';

class ChargeSessionReadout extends StatelessWidget {
  const ChargeSessionReadout({
    super.key,
    required this.copy,
    required this.progress,
    required this.waitingForStop,
    required this.hasStopRequest,
  });

  final AppCopy copy;
  final ChargeProgress progress;
  final bool waitingForStop;
  final bool hasStopRequest;

  @override
  Widget build(BuildContext context) {
    final energy = progress.measuredEnergyWh;
    final limit = progress.limitWh;
    final status = _status(copy, progress.status);
    return Column(
      children: [
        ChargeHeading(
          waitingForStop
              ? hasStopRequest
                    ? copy.text('Yêu cầu dừng sạc', 'Stop request')
                    : status
              : copy.text('Theo dõi phiên sạc', 'Charging progress'),
        ),
        const SizedBox(height: 8),
        Semantics(
          liveRegion: true,
          child: StatusBadge(
            status,
            color: progress.status == SessionState.active && !waitingForStop
                ? PowerMeColors.teal
                : PowerMeColors.gold,
          ),
        ),
        const SizedBox(height: 4),
        ChargeRing(
          icon: waitingForStop ? Icons.ev_station_outlined : Icons.bolt_rounded,
          phase: waitingForStop
              ? ChargeRingPhase.stopping
              : ChargeRingPhase.energy,
          label: waitingForStop
              ? copy.text('Chờ xác nhận dừng', 'Waiting for stop confirmation')
              : copy.text('Điện năng đã sạc', 'Energy delivered'),
          energy: waitingForStop ? null : _observedEnergy(progress, copy),
          fraction:
              !waitingForStop && energy != null && limit != null && limit > 0
              ? (energy / limit).clamp(0.0, 1.0)
              : null,
        ),
      ],
    );
  }
}

String _observedEnergy(ChargeProgress progress, AppCopy copy) =>
    progress.measuredEnergyWh == null
    ? copy.text('Chưa có số đo', 'No reading yet')
    : chargeEnergyLabel(progress.measuredEnergyWh!, copy);

class ChargeSessionMetrics extends StatelessWidget {
  const ChargeSessionMetrics({
    super.key,
    required this.copy,
    required this.progress,
    required this.includeEnergy,
    this.summary = false,
  });

  final AppCopy copy;
  final ChargeProgress progress;
  final bool includeEnergy;
  final bool summary;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      MetricGrid(
        items: [
          if (includeEnergy)
            MetricItem(
              copy.text('Điện năng đã sạc', 'Energy delivered'),
              _observedEnergy(progress, copy),
              Icons.bolt_outlined,
            ),
          if (!summary)
            MetricItem(
              copy.text('Hạn mức sạc', 'Energy limit'),
              progress.limitWh == null
                  ? copy.text('Chưa xác định', 'Unknown')
                  : chargeEnergyLabel(progress.limitWh!, copy),
              Icons.speed_outlined,
            ),
          if (progress.estimatedCostVnd != null)
            MetricItem(
              copy.text(
                'Chi phí (tạm tính, tối đa)',
                'Estimated cost (maximum)',
              ),
              vnd(progress.estimatedCostVnd),
              Icons.receipt_outlined,
            ),
        ],
      ),
      if (!summary) ...[
        const SizedBox(height: 12),
        Text(
          '${copy.text('Kết nối trụ', 'Charger connection')} · ${_connection(copy, progress.connection)}',
          style: Theme.of(context).textTheme.bodySmall,
        ),
        Text(
          '${copy.text('Cập nhật (ICT)', 'Updated (ICT)')} · ${ict(progress.updatedAt)}',
          style: Theme.of(context).textTheme.bodySmall,
        ),
        if (progress.connection == ConnectionState.offline)
          Text(
            copy.text(
              'Số liệu sạc có thể chưa được cập nhật.',
              'Charging readings may be out of date.',
            ),
          ),
      ],
    ],
  );
}

class ChargeProgressCard extends StatelessWidget {
  const ChargeProgressCard({
    super.key,
    required this.progress,
    required this.copy,
  });

  final ChargeProgress progress;
  final AppCopy copy;

  @override
  Widget build(BuildContext context) {
    final stopped = progress.meterStopWh != null;
    final energy = progress.measuredEnergyWh;
    return InfoCard(
      children: [
        ValueLine(
          copy.text('Trạng thái phiên', 'Session status'),
          _status(copy, progress.status),
        ),
        ValueLine(
          copy.text('Kết nối trụ', 'Charger connection'),
          _connection(copy, progress.connection),
        ),
        if (!stopped && progress.connection == ConnectionState.offline)
          Text(
            copy.text(
              'Số liệu sạc có thể chưa được cập nhật.',
              'Charging readings may be out of date.',
            ),
          ),
        ValueLine(
          copy.text('Hạn mức sạc', 'Energy limit'),
          progress.limitWh == null
              ? copy.text('Chưa xác định', 'Unknown')
              : chargeEnergyLabel(progress.limitWh!, copy),
        ),
        ValueLine(
          stopped
              ? copy.text('Điện năng khi dừng', 'Energy at stop')
              : copy.text('Điện năng đã sạc', 'Energy delivered'),
          energy == null
              ? copy.text('Chưa có số đo', 'No reading yet')
              : chargeEnergyLabel(energy, copy),
        ),
        if (progress.estimatedCostVnd != null)
          ValueLine(
            copy.text('Chi phí (tạm tính, tối đa)', 'Estimated cost (maximum)'),
            vnd(progress.estimatedCostVnd),
          ),
        ValueLine(
          copy.text('Cập nhật (ICT)', 'Updated (ICT)'),
          ict(progress.updatedAt),
          showDivider: false,
        ),
        if (progress.inReview)
          Text(
            copy.text(
              'Phiên đang chờ kiểm tra để quyết toán.',
              'The session is awaiting billing review.',
            ),
          )
        else if (progress.closed &&
            progress.settlement == SettlementState.notApplicable)
          Text(
            copy.text(
              'Phiên này không có bảng kê quyết toán.',
              'No billing statement applies to this session.',
            ),
          )
        else if (progress.closed &&
            progress.settlement != SettlementState.posted)
          Text(copy.text('Đang chờ quyết toán.', 'Settlement is pending.')),
      ],
    );
  }
}

String _connection(AppCopy copy, ConnectionState connection) =>
    switch (connection) {
      ConnectionState.online => copy.text('Đang kết nối', 'Online'),
      ConnectionState.offline => copy.text('Mất kết nối', 'Offline'),
      ConnectionState.unknown => copy.text('Chưa xác định', 'Unknown'),
    };

String _status(AppCopy copy, SessionState status) => switch (status) {
  SessionState.pending => copy.text('Chờ bắt đầu', 'Waiting to start'),
  SessionState.active => copy.text('Đang sạc', 'Charging'),
  SessionState.paused => copy.text('Tạm dừng', 'Paused'),
  SessionState.stopping => copy.text('Đang dừng', 'Stopping'),
  SessionState.closed => copy.text('Đã dừng', 'Stopped'),
  SessionState.reconciled => copy.text('Đã đối soát', 'Reconciled'),
  SessionState.review => copy.text('Đang chờ kiểm tra', 'Under review'),
  SessionState.orphaned => copy.text(
    'Đang chờ trụ báo cáo',
    'Waiting for charger report',
  ),
  SessionState.failed => copy.text('Phiên không thành công', 'Session failed'),
  SessionState.unknown => copy.text('Chưa xác định', 'Unknown'),
};
