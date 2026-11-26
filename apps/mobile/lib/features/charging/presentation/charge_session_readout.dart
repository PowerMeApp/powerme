import 'package:flutter/material.dart' hide ConnectionState;

import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/flow_page.dart';
import '../domain/charge_session.dart';
import '../domain/charging.dart';
import 'charge_energy_label.dart';
import 'charge_flow_visuals.dart';
import 'charge_mode_widgets.dart';

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
    final mode = progress.billingMode;
    final limit = progress.limitValue;
    final value = switch (mode) {
      ChargingMode.timed => progress.elapsedSeconds,
      ChargingMode.cost => progress.costEstimateVnd,
      ChargingMode.energy => progress.measuredEnergyWh,
      _ => null,
    };
    final fraction = value == null || limit == null || limit <= 0
        ? null
        : (mode == ChargingMode.timed ? value / 60 / limit : value / limit)
              .clamp(0.0, 1.0);
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
        if (!waitingForStop) ChargeModeChoices(copy: copy, selected: mode),
        ChargeRing(
          icon: waitingForStop
              ? Icons.ev_station_outlined
              : mode == null
              ? Icons.help_outline
              : chargeModeIcon(mode),
          phase: waitingForStop
              ? ChargeRingPhase.stopping
              : ChargeRingPhase.energy,
          label: waitingForStop
              ? copy.text('Chờ xác nhận dừng', 'Waiting for stop confirmation')
              : switch (mode) {
                  ChargingMode.timed => copy.text(
                    'Thời gian đã sạc',
                    'Elapsed time',
                  ),
                  ChargingMode.cost => copy.text(
                    'Chi phí tạm tính',
                    'Estimated cost',
                  ),
                  _ => copy.text('Điện năng đã sạc', 'Energy delivered'),
                },
          energy: waitingForStop
              ? null
              : switch (mode) {
                  ChargingMode.timed => chargeElapsedLabel(
                    progress.elapsedSeconds,
                  ),
                  ChargingMode.cost =>
                    progress.costEstimateVnd == null
                        ? copy.text('Chưa xác định', 'Unknown')
                        : vnd(progress.costEstimateVnd, copy: copy),
                  _ => _observedEnergy(progress, copy),
                },
          fraction: waitingForStop ? null : fraction,
        ),
        if (!waitingForStop) ...[
          Text(
            chargeTargetLabel(mode, limit, copy),
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 16),
        ],
      ],
    );
  }
}

/// Ẩn tạm tính chưa được hỗ trợ; không suy ra nghĩa vụ thanh toán từ origin.
String _estimateLabel(ChargeProgress progress, AppCopy copy) =>
    !progress.supportsCostEstimate
    ? copy.text('Chưa có tạm tính', 'Estimate unavailable')
    : progress.costEstimateVnd == null
    ? copy.text('Chưa xác định', 'Unknown')
    : vnd(progress.costEstimateVnd, copy: copy);

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
      _ChargeMetricRow(
        items: [
          MetricItem(
            copy.text('Đã nạp', 'Delivered'),
            _observedEnergy(progress, copy),
            Icons.bolt_outlined,
          ),
          MetricItem(
            copy.text('Thời gian', 'Elapsed'),
            chargeElapsedLabel(progress.elapsedSeconds),
            Icons.schedule_outlined,
          ),
          MetricItem(
            copy.text('Tạm tính', 'Estimate'),
            _estimateLabel(progress, copy),
            Icons.payments_outlined,
          ),
        ],
      ),
      if (progress.supportsCostEstimate &&
          progress.estimatedCostVnd != null) ...[
        const SizedBox(height: 12),
        ValueLine(
          copy.text('Chi phí (tạm tính, tối đa)', 'Estimated cost (maximum)'),
          vnd(progress.estimatedCostVnd, copy: copy),
          showDivider: false,
        ),
      ],
      if (!summary) ...[
        const SizedBox(height: 12),
        if (progress.supportsCostEstimate && progress.costEstimateVnd != null)
          Text(switch (progress.costQuality) {
            ChargeCostQuality.interpolated => copy.text(
              'Tạm tính có nội suy giữa các mốc biểu giá.',
              'Estimate interpolated across tariff boundaries.',
            ),
            ChargeCostQuality.exact => copy.text(
              'Tạm tính theo số đo và biểu giá áp dụng.',
              'Estimate based on readings and applicable tariffs.',
            ),
            ChargeCostQuality.unknown => copy.text(
              'Chi phí tạm tính chưa xác định.',
              'Cost estimate unknown.',
            ),
          }, style: Theme.of(context).textTheme.bodySmall),
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

class _ChargeMetricRow extends StatelessWidget {
  const _ChargeMetricRow({required this.items});
  final List<MetricItem> items;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, box) {
      if (box.maxWidth < 340 ||
          MediaQuery.textScalerOf(context).scale(14) > 18 ||
          items.any((item) => item.value.length > 13)) {
        return MetricGrid(items: items);
      }
      return EqualHeightRows(
        columns: 3,
        spacing: 8,
        children: [
          for (final item in items)
            SizedBox(
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 16,
                ),
                decoration: BoxDecoration(
                  color: PowerMeColors.graphite,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Icon(item.icon, size: 18, color: PowerMeColors.gold),
                    const SizedBox(height: 8),
                    Text(
                      item.label,
                      style: Theme.of(context).textTheme.labelMedium,
                    ),
                    const SizedBox(height: 8),
                    Text(
                      item.value,
                      style: Theme.of(context).textTheme.titleMedium?.copyWith(
                        fontFeatures: const [FontFeature.tabularFigures()],
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ],
                ),
              ),
            ),
        ],
      );
    },
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
          copy.text('Chế độ sạc', 'Charging mode'),
          chargeModeLabel(progress.billingMode, copy),
        ),
        ValueLine(
          copy.text('Mục tiêu', 'Target'),
          chargeTargetLabel(progress.billingMode, progress.limitValue, copy),
        ),
        ValueLine(
          copy.text('Thời gian đã sạc', 'Elapsed time'),
          chargeElapsedLabel(progress.elapsedSeconds),
        ),
        ValueLine(
          copy.text('Chi phí tạm tính', 'Estimated cost'),
          _estimateLabel(progress, copy),
        ),
        ValueLine(
          stopped
              ? copy.text('Điện năng khi dừng', 'Energy at stop')
              : copy.text('Điện năng đã sạc', 'Energy delivered'),
          energy == null
              ? copy.text('Chưa có số đo', 'No reading yet')
              : chargeEnergyLabel(energy, copy),
        ),
        if (progress.supportsCostEstimate && progress.estimatedCostVnd != null)
          ValueLine(
            copy.text('Chi phí (tạm tính, tối đa)', 'Estimated cost (maximum)'),
            vnd(progress.estimatedCostVnd, copy: copy),
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
