import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/formatters.dart';
import '../../../core/theme/app_theme.dart';
import '../../../ui/core/status_pill.dart';
import '../../charging/presentation/charging_controller.dart';
import '../data/fake_station_repository.dart';
import '../domain/station_models.dart';

class StationDetailScreen extends ConsumerWidget {
  const StationDetailScreen({required this.stationId, super.key});

  final String stationId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final station = ref.watch(stationByIdProvider(stationId));
    if (station == null) {
      return const Scaffold(body: Center(child: Text('Không tìm thấy trạm.')));
    }
    return Scaffold(
      appBar: AppBar(title: const Text('Chi tiết trạm')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 28),
          children: [
            Text(
              station.name,
              style: Theme.of(
                context,
              ).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 6),
            Text(
              station.address,
              style: const TextStyle(color: BrandColors.muted, height: 1.35),
            ),
            const SizedBox(height: 14),
            Row(
              children: [
                availabilityPill(
                  station.hasAvailableConnector ? 'Đang hoạt động' : 'Đang bận',
                  station.hasAvailableConnector,
                ),
                const SizedBox(width: 8),
                Text(
                  'Cập nhật ${AppFormatters.clock(station.updatedAt)}',
                  style: const TextStyle(
                    color: BrandColors.muted,
                    fontSize: 12,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 22),
            const Text(
              'Chọn đầu sạc',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 10),
            for (final connector in station.connectors) ...[
              _ConnectorCard(
                connector: connector,
                onStart: connector.isUsable
                    ? () => _start(context, ref, station, connector)
                    : null,
              ),
              const SizedBox(height: 10),
            ],
            const SizedBox(height: 12),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Thông tin giá',
                      style: TextStyle(fontWeight: FontWeight.w700),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      'Từ ${AppFormatters.money(station.connectors.first.pricePerKwh)} / kWh',
                      style: const TextStyle(
                        color: BrandColors.gold,
                        fontSize: 17,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 4),
                    const Text(
                      'Giá hiển thị là dữ liệu mô phỏng và cần xác nhận lại trước khi bắt đầu.',
                      style: TextStyle(color: BrandColors.muted, height: 1.35),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),
            OutlinedButton.icon(
              onPressed: () => context.push('/reservation/$stationId'),
              icon: const Icon(Icons.event_available_outlined),
              label: const Text('Xem đặt chỗ mô phỏng'),
            ),
          ],
        ),
      ),
    );
  }

  void _start(
    BuildContext context,
    WidgetRef ref,
    Station station,
    Connector connector,
  ) {
    ref
        .read(chargingControllerProvider.notifier)
        .startCommand(station, connector);
    context.go('/charging');
  }
}

class _ConnectorCard extends StatelessWidget {
  const _ConnectorCard({required this.connector, required this.onStart});

  final Connector connector;
  final VoidCallback? onStart;

  @override
  Widget build(BuildContext context) {
    final isAvailable = connector.isUsable;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: (isAvailable ? BrandColors.teal : BrandColors.muted)
                    .withValues(alpha: .12),
                borderRadius: BorderRadius.circular(13),
              ),
              child: Icon(
                Icons.power_outlined,
                color: isAvailable ? BrandColors.teal : BrandColors.muted,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    connector.type.label,
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    '${connector.powerKw} kW định mức · ${connector.id}',
                    style: const TextStyle(
                      color: BrandColors.muted,
                      fontSize: 12,
                    ),
                  ),
                ],
              ),
            ),
            FilledButton(
              onPressed: onStart,
              child: Text(isAvailable ? 'Chọn' : 'Bận'),
            ),
          ],
        ),
      ),
    );
  }
}
