import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/app_page.dart';
import '../../../core/widgets/brand_mark.dart';
import '../../profile/application/profile_controller.dart';
import '../application/stations_controller.dart';
import '../domain/station.dart';
import 'station_copy.dart';
import 'station_actions_screens.dart';
import '../../../core/widgets/flow_page.dart';

class StationDetailScreen extends ConsumerWidget {
  const StationDetailScreen({super.key, required this.id});
  final String id;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final profile = ref.watch(profileControllerProvider).profile;
    final copy = AppCopy(profile.language);
    final station = ref.watch(stationDetailProvider(id));
    final text = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          tooltip: copy.back,
          onPressed: () => context.canPop() ? context.pop() : context.go('/'),
          icon: const Icon(Icons.arrow_back_rounded),
        ),
        title: Text(copy.text('Chi tiết trạm', 'Station details')),
      ),
      body: AppPage(
        children: [
          if (station == null) ...[
            Text(copy.missing, style: text.headlineSmall),
            const SizedBox(height: 12),
            TextButton(
              onPressed: () => context.go('/'),
              child: Text(copy.home),
            ),
          ] else ...[
            InfoCard(
              key: const Key('station-information'),
              spacing: 12,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const ChargingMark(
                      size: 42,
                      backgroundColor: PowerMeColors.graphite,
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(station.name, style: text.headlineSmall),
                    ),
                  ],
                ),
                Text(
                  station.address,
                  style: text.bodyLarge?.copyWith(color: PowerMeColors.muted),
                ),
                ValueLine(
                  copy.text('Đơn vị vận hành', 'Operator'),
                  station.operatorName,
                ),
                ValueLine(
                  copy.text('Giá hiện tại / kWh', 'Current price / kWh'),
                  vnd(station.tariffVndPerKwh),
                  showDivider: false,
                ),
                Text(
                  copy.text(
                    'Giá có thể thay đổi theo khung giờ; tổng tiền được xác nhận trong bảng kê.',
                    'Prices may vary by time of day; the statement confirms the final amount.',
                  ),
                  style: text.bodyMedium?.copyWith(color: PowerMeColors.muted),
                ),
                if (station.reportedIssue)
                  FailureNotice(
                    copy.text(
                      'Đã có phản ánh sự cố tại trạm',
                      'An issue has been reported at this station',
                    ),
                  ),
                if (station.vinfastOnly && !profile.isVinFast)
                  FailureNotice(
                    copy.text(
                      'Trạm chỉ dành cho VinFast. Xe đang chọn không được phép bắt đầu sạc tại đây.',
                      'VinFast-only station. The selected vehicle cannot start charging here.',
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 12),
            Text(copy.text('Cổng sạc', 'Connectors'), style: text.titleLarge),
            const SizedBox(height: 6),
            Text(
              '${copy.vehicle}: ${profile.vehicle}',
              style: text.bodyMedium?.copyWith(color: PowerMeColors.muted),
            ),
            const SizedBox(height: 16),
            for (final connector in station.connectors) ...[
              Card(
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(14),
                  side: BorderSide(
                    color:
                        connector.status == StationStatus.available &&
                            connector.quality == DataQuality.observed &&
                            profile.compatibleConnectors.contains(
                              connector.type,
                            )
                        ? PowerMeColors.teal.withValues(alpha: .42)
                        : PowerMeColors.outline.withValues(alpha: .5),
                  ),
                ),
                child: Padding(
                  padding: const EdgeInsets.all(18),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      LayoutBuilder(
                        builder: (context, box) {
                          final title = Text(
                            '${copy.text('Cổng', 'Connector')} ${connector.number.toString().padLeft(2, '0')} · ${connector.type}',
                            style: text.titleMedium,
                          );
                          final badge = StatusBadge(
                            statusLabel(connector.status, copy),
                            color:
                                connector.status == StationStatus.available &&
                                    connector.quality == DataQuality.observed
                                ? PowerMeColors.teal
                                : PowerMeColors.gold,
                          );
                          return MediaQuery.textScalerOf(context).scale(14) /
                                          14 >
                                      1.3 ||
                                  box.maxWidth < 300
                              ? Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    title,
                                    const SizedBox(height: 10),
                                    badge,
                                  ],
                                )
                              : Row(
                                  children: [
                                    Expanded(child: title),
                                    const SizedBox(width: 8),
                                    Flexible(child: badge),
                                  ],
                                );
                        },
                      ),
                      const SizedBox(height: 12),
                      Wrap(
                        spacing: 10,
                        runSpacing: 8,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          Text(
                            '${connector.powerW ~/ 1000} kW',
                            style: text.titleLarge?.copyWith(
                              color: PowerMeColors.gold,
                              fontWeight: FontWeight.w800,
                              fontFeatures: const [
                                FontFeature.tabularFigures(),
                              ],
                            ),
                          ),
                          StatusBadge(
                            profile.compatibleConnectors.contains(
                                  connector.type,
                                )
                                ? copy.text(
                                    'Phù hợp với xe của bạn',
                                    'Compatible with your vehicle',
                                  )
                                : copy.text(
                                    'Không phù hợp với xe của bạn',
                                    'Not compatible with your vehicle',
                                  ),
                            color:
                                profile.compatibleConnectors.contains(
                                  connector.type,
                                )
                                ? PowerMeColors.teal
                                : PowerMeColors.gold,
                          ),
                        ],
                      ),
                      if (connector.quality != DataQuality.observed) ...[
                        const SizedBox(height: 8),
                        Text(
                          connector.quality == DataQuality.stale
                              ? copy.text(
                                  'Trạng thái cần cập nhật',
                                  'Status needs updating',
                                )
                              : copy.text(
                                  'Chưa rõ độ mới của trạng thái',
                                  'Status freshness unknown',
                                ),
                          style: text.bodyMedium?.copyWith(
                            color: PowerMeColors.gold,
                          ),
                        ),
                      ],
                      const SizedBox(height: 10),
                      Text(
                        updatedLabel(connector.updatedAt, copy),
                        style: text.bodyMedium?.copyWith(
                          color: PowerMeColors.muted,
                        ),
                      ),
                      const SizedBox(height: 14),
                      Wrap(
                        spacing: 10,
                        runSpacing: 10,
                        children: [
                          if ((!station.vinfastOnly || profile.isVinFast) &&
                              profile.compatibleConnectors.contains(
                                connector.type,
                              ) &&
                              connector.status == StationStatus.available &&
                              connector.quality == DataQuality.observed) ...[
                            FilledButton(
                              onPressed: () => context.push(
                                connectorRoute(
                                  '/start',
                                  '$id/${connector.number}',
                                ),
                              ),
                              child: Text(
                                copy.text('Bắt đầu sạc', 'Start charging'),
                              ),
                            ),
                            // TextButton(
                            //   onPressed: () => context.push(
                            //     connectorRoute(
                            //       '/reserve',
                            //       '$id/${connector.number}',
                            //     ),
                            //   ),
                            //   child: Text(copy.text('Giữ cổng', 'Reserve')),
                            // ),
                          ],
                          TextButton(
                            onPressed: () => context.push(
                              connectorRoute(
                                '/report',
                                '$id/${connector.number}',
                              ),
                            ),
                            child: Text(copy.text('Báo lỗi', 'Report issue')),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 14),
            ],
          ],
        ],
      ),
    );
  }
}
