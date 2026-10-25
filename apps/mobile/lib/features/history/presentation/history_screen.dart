import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/formatters.dart';
import '../../../core/theme/app_theme.dart';
import '../../../ui/core/app_scaffold.dart';
import '../../../ui/core/status_pill.dart';
import '../../charging/presentation/charging_controller.dart';
import '../data/fake_history_repository.dart';
import '../domain/history_models.dart';

class HistoryScreen extends ConsumerWidget {
  const HistoryScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final entries = ref.watch(historyEntriesProvider);
    final summary = ref.watch(chargingControllerProvider).summary;
    return AppScaffold(
      title: 'Lịch sử',
      actions: [
        IconButton(
          onPressed: () => _showFilter(context),
          icon: const Icon(Icons.filter_list),
          tooltip: 'Bộ lọc',
        ),
      ],
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
        children: [
          Text(
            'Phiên sạc của bạn',
            style: Theme.of(
              context,
            ).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 6),
          const Text(
            'Thanh toán, hóa đơn và trạng thái đối soát được hiển thị độc lập.',
            style: TextStyle(color: BrandColors.muted, height: 1.35),
          ),
          const SizedBox(height: 18),
          if (summary != null) ...[
            _CurrentEntry(
              summaryAmount: summary.amountVnd,
              energyWh: summary.energyWh,
            ),
            const SizedBox(height: 12),
          ],
          for (final entry in entries) ...[
            _HistoryCard(entry: entry),
            const SizedBox(height: 12),
          ],
          const SizedBox(height: 4),
          OutlinedButton.icon(
            onPressed: () =>
                _showSnack(context, 'Bộ lọc ngày sẽ gọi API phân trang ở WP2.'),
            icon: const Icon(Icons.calendar_month_outlined),
            label: const Text('Lọc theo thời gian'),
          ),
        ],
      ),
    );
  }

  void _showFilter(BuildContext context) => _showSnack(
    context,
    'Bản demo đang hiển thị fixture paid, pending và failed.',
  );

  void _showSnack(BuildContext context, String message) => ScaffoldMessenger.of(
    context,
  ).showSnackBar(SnackBar(content: Text(message)));
}

class _CurrentEntry extends StatelessWidget {
  const _CurrentEntry({required this.summaryAmount, required this.energyWh});

  final int summaryAmount;
  final int energyWh;

  @override
  Widget build(BuildContext context) {
    return Card(
      color: BrandColors.teal.withValues(alpha: .1),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            Container(
              width: 42,
              height: 42,
              decoration: BoxDecoration(
                color: BrandColors.teal.withValues(alpha: .15),
                borderRadius: BorderRadius.circular(12),
              ),
              child: const Icon(Icons.bolt, color: BrandColors.teal),
            ),
            const SizedBox(width: 12),
            const Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Phiên vừa kết thúc',
                    style: TextStyle(fontWeight: FontWeight.w700),
                  ),
                  SizedBox(height: 4),
                  Text(
                    'Đang chờ đối soát bill',
                    style: TextStyle(color: BrandColors.muted, fontSize: 12),
                  ),
                ],
              ),
            ),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(
                  AppFormatters.money(summaryAmount),
                  style: const TextStyle(
                    color: BrandColors.gold,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  AppFormatters.kwh(energyWh),
                  style: const TextStyle(
                    color: BrandColors.muted,
                    fontSize: 12,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _HistoryCard extends StatelessWidget {
  const _HistoryCard({required this.entry});

  final HistoryEntry entry;

  @override
  Widget build(BuildContext context) {
    final invoice = switch (entry.invoiceStatus) {
      InvoiceStatus.issued => const StatusPill(
        label: 'Hóa đơn đã phát hành',
        color: BrandColors.teal,
        icon: Icons.receipt_long_outlined,
      ),
      InvoiceStatus.pending => const StatusPill(
        label: 'Hóa đơn đang xử lý',
        color: BrandColors.warning,
        icon: Icons.hourglass_top,
      ),
      InvoiceStatus.failed => const StatusPill(
        label: 'Hóa đơn lỗi',
        color: BrandColors.danger,
        icon: Icons.error_outline,
      ),
    };
    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(20),
        onTap: () => showDialog<void>(
          context: context,
          builder: (_) => AlertDialog(
            title: Text(entry.stationName),
            content: Text(
              'Session: ${entry.id}\nNăng lượng: ${AppFormatters.kwh(entry.energyWh)}\nThanh toán: ${entry.paymentLabel}\nHóa đơn: ${entry.invoiceStatus.name}',
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context),
                child: const Text('Đóng'),
              ),
            ],
          ),
        ),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Icon(
                    Icons.ev_station_outlined,
                    color: BrandColors.teal,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      entry.stationName,
                      style: const TextStyle(fontWeight: FontWeight.w700),
                    ),
                  ),
                  Text(
                    AppFormatters.dateTime(entry.date),
                    style: const TextStyle(
                      color: BrandColors.muted,
                      fontSize: 11,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    AppFormatters.kwh(entry.energyWh),
                    style: const TextStyle(color: BrandColors.muted),
                  ),
                  Text(
                    AppFormatters.money(entry.amountVnd),
                    style: const TextStyle(
                      color: BrandColors.gold,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  invoice,
                  const Spacer(),
                  Text(
                    entry.paymentLabel,
                    style: const TextStyle(
                      color: BrandColors.muted,
                      fontSize: 12,
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
