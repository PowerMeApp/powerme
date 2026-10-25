import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/formatters.dart';
import '../../../core/theme/app_theme.dart';
import '../../../ui/core/status_pill.dart';
import '../../stations/domain/station_models.dart';
import '../domain/charging_models.dart';
import 'charging_controller.dart';

class ChargingScreen extends ConsumerWidget {
  const ChargingScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final flow = ref.watch(chargingControllerProvider);
    final controller = ref.read(chargingControllerProvider.notifier);
    if (flow.summary != null) {
      return _SummaryView(
        flow: flow,
        onPayment: () => context.push('/payment'),
      );
    }
    if (!flow.hasSelection) {
      return _NoSessionView(
        onExplore: () => context.go('/discover'),
        onScan: () => context.push('/scan'),
      );
    }
    if (flow.stopRequested) {
      return _StopPendingView(
        flow: flow,
        onEvidence: controller.simulateStopEvidence,
        onUnknown: controller.simulateStopUnknown,
        onQuery: controller.queryStopResult,
      );
    }
    if (flow.session == null) {
      return _StartPendingView(
        flow: flow,
        onStartEvidence: controller.simulateStartTransaction,
        onReject: controller.simulateRejected,
      );
    }
    return _ActiveSessionView(
      flow: flow,
      onStop: controller.requestStop,
      onStale: controller.simulateStale,
      onReconnect: controller.reconnect,
      onSuspend: controller.simulateSuspended,
    );
  }
}

class _NoSessionView extends StatelessWidget {
  const _NoSessionView({required this.onExplore, required this.onScan});

  final VoidCallback onExplore;
  final VoidCallback onScan;

  @override
  Widget build(BuildContext context) {
    return _ChargingScaffold(
      title: 'Phiên sạc',
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Container(
                width: 76,
                height: 76,
                decoration: BoxDecoration(
                  color: BrandColors.teal.withValues(alpha: .12),
                  shape: BoxShape.circle,
                ),
                child: const Icon(
                  Icons.bolt_outlined,
                  color: BrandColors.teal,
                  size: 38,
                ),
              ),
              const SizedBox(height: 18),
              Text(
                'Chưa có phiên đang hoạt động',
                style: Theme.of(
                  context,
                ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 8),
              const Text(
                'Chọn một trạm hoặc quét mã trên trụ để bắt đầu luồng mô phỏng.',
                textAlign: TextAlign.center,
                style: TextStyle(color: BrandColors.muted, height: 1.4),
              ),
              const SizedBox(height: 22),
              FilledButton.icon(
                onPressed: onExplore,
                icon: const Icon(Icons.explore_outlined),
                label: const Text('Tìm trạm'),
              ),
              const SizedBox(height: 10),
              OutlinedButton.icon(
                onPressed: onScan,
                icon: const Icon(Icons.qr_code_scanner),
                label: const Text('Quét mã trụ'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _StartPendingView extends StatelessWidget {
  const _StartPendingView({
    required this.flow,
    required this.onStartEvidence,
    required this.onReject,
  });

  final ChargingFlowState flow;
  final VoidCallback onStartEvidence;
  final VoidCallback onReject;

  @override
  Widget build(BuildContext context) {
    final isSending = flow.commandStatus == CommandStatus.sending;
    final isRejected = flow.commandStatus == CommandStatus.rejected;
    return _ChargingScaffold(
      title: 'Đang khởi động',
      child: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          _StationHeader(flow: flow),
          const SizedBox(height: 18),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                children: [
                  Icon(
                    isSending
                        ? Icons.sync
                        : isRejected
                        ? Icons.block
                        : Icons.hourglass_top,
                    color: isRejected ? BrandColors.danger : BrandColors.gold,
                    size: 42,
                  ),
                  const SizedBox(height: 12),
                  Text(
                    isSending
                        ? 'Đang gửi yêu cầu'
                        : isRejected
                        ? 'Yêu cầu bị từ chối'
                        : 'Trụ đã nhận yêu cầu',
                    style: const TextStyle(
                      fontSize: 19,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    flow.message ?? 'Đang chờ StartTransaction từ simulator.',
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      color: BrandColors.muted,
                      height: 1.4,
                    ),
                  ),
                  const SizedBox(height: 18),
                  StatusPill(
                    label: isSending
                        ? 'Sending'
                        : isRejected
                        ? 'Rejected'
                        : 'Accepted · chưa có phiên',
                    color: isSending
                        ? BrandColors.warning
                        : isRejected
                        ? BrandColors.danger
                        : BrandColors.gold,
                    icon: Icons.info_outline,
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          if (!isSending && !isRejected)
            FilledButton.icon(
              onPressed: onStartEvidence,
              icon: const Icon(Icons.play_arrow),
              label: const Text('Mô phỏng StartTransaction'),
            ),
          if (!isSending && !isRejected)
            TextButton.icon(
              onPressed: onReject,
              icon: const Icon(Icons.block),
              label: const Text('Mô phỏng lệnh bị từ chối'),
            ),
          const SizedBox(height: 12),
          const Text(
            'Accepted chỉ xác nhận simulator nhận lệnh; chưa chứng minh xe đang truyền điện.',
            textAlign: TextAlign.center,
            style: TextStyle(
              color: BrandColors.muted,
              fontSize: 12,
              height: 1.4,
            ),
          ),
        ],
      ),
    );
  }
}

class _ActiveSessionView extends StatelessWidget {
  const _ActiveSessionView({
    required this.flow,
    required this.onStop,
    required this.onStale,
    required this.onReconnect,
    required this.onSuspend,
  });

  final ChargingFlowState flow;
  final VoidCallback onStop;
  final VoidCallback onStale;
  final VoidCallback onReconnect;
  final VoidCallback onSuspend;

  @override
  Widget build(BuildContext context) {
    final session = flow.session!;
    final elapsed = DateTime.now()
        .toUtc()
        .difference(session.startedAt)
        .inMinutes;
    final qualityColor = flow.dataQuality == DataQuality.live
        ? BrandColors.teal
        : BrandColors.warning;
    return _ChargingScaffold(
      title: 'Phiên sạc',
      actions: [
        IconButton(
          onPressed: () => _showDemoMenu(context),
          icon: const Icon(Icons.tune),
          tooltip: 'Tình huống mô phỏng',
        ),
      ],
      child: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
        children: [
          _StationHeader(flow: flow),
          const SizedBox(height: 14),
          Row(
            children: [
              StatusPill(
                label: flow.dataQuality == DataQuality.live
                    ? 'Dữ liệu trực tiếp'
                    : 'Last-known · ${flow.connectionStatus.name}',
                color: qualityColor,
                icon: flow.dataQuality == DataQuality.live
                    ? Icons.wifi
                    : Icons.sync_problem,
              ),
              const Spacer(),
              Text(
                'Cập nhật ${AppFormatters.clock(session.lastUpdated)}',
                style: const TextStyle(color: BrandColors.muted, fontSize: 12),
              ),
            ],
          ),
          if (flow.message != null) ...[
            const SizedBox(height: 12),
            _Notice(message: flow.message!, color: qualityColor),
          ],
          const SizedBox(height: 18),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(18),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Năng lượng đã nhận',
                    style: TextStyle(color: BrandColors.muted),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    AppFormatters.kwh(session.energyWh),
                    style: Theme.of(context).textTheme.displaySmall?.copyWith(
                      color: BrandColors.teal,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 18),
                  Row(
                    children: [
                      Expanded(
                        child: _Metric(
                          label: 'Chi phí ước tính',
                          value: AppFormatters.money(session.estimatedCostVnd),
                          icon: Icons.payments_outlined,
                        ),
                      ),
                      Expanded(
                        child: _Metric(
                          label: 'Thời gian phiên',
                          value: '$elapsed phút',
                          icon: Icons.timer_outlined,
                        ),
                      ),
                      Expanded(
                        child: _Metric(
                          label: 'SOC',
                          value: session.soc == null
                              ? 'Chưa có dữ liệu'
                              : '${session.soc}%',
                          icon: Icons.battery_charging_full,
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 14),
          FilledButton.icon(
            onPressed: onStop,
            style: FilledButton.styleFrom(
              backgroundColor: BrandColors.danger,
              foregroundColor: Colors.white,
            ),
            icon: const Icon(Icons.stop_circle_outlined),
            label: const Text('Dừng phiên sạc'),
          ),
          const SizedBox(height: 10),
          OutlinedButton.icon(
            onPressed: onStale,
            icon: const Icon(Icons.network_check),
            label: const Text('Mô phỏng dữ liệu cũ'),
          ),
          if (flow.dataQuality != DataQuality.live) ...[
            const SizedBox(height: 10),
            TextButton.icon(
              onPressed: onReconnect,
              icon: const Icon(Icons.refresh),
              label: const Text('Khôi phục và lấy snapshot'),
            ),
          ],
        ],
      ),
    );
  }

  void _showDemoMenu(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      builder: (_) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Wrap(
            children: [
              const ListTile(
                title: Text('Tình huống mô phỏng'),
                subtitle: Text(
                  'Các nút chỉ thay đổi fixture local, không tác động trụ thật.',
                ),
              ),
              ListTile(
                leading: const Icon(Icons.pause_circle_outline),
                title: const Text('Xe tạm dừng'),
                onTap: () {
                  Navigator.pop(context);
                  onSuspend();
                },
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _StopPendingView extends StatelessWidget {
  const _StopPendingView({
    required this.flow,
    required this.onEvidence,
    required this.onUnknown,
    required this.onQuery,
  });

  final ChargingFlowState flow;
  final VoidCallback onEvidence;
  final VoidCallback onUnknown;
  final VoidCallback onQuery;

  @override
  Widget build(BuildContext context) {
    final unknown = flow.commandStatus == CommandStatus.unknown;
    return _ChargingScaffold(
      title: unknown ? 'Chưa rõ kết quả dừng' : 'Đang dừng phiên',
      child: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          _StationHeader(flow: flow),
          const SizedBox(height: 18),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                children: [
                  Icon(
                    unknown ? Icons.help_outline : Icons.sync,
                    color: unknown ? BrandColors.warning : BrandColors.gold,
                    size: 44,
                  ),
                  const SizedBox(height: 12),
                  Text(
                    unknown
                        ? 'Không có xác nhận cuối cùng'
                        : 'Đang chờ StopTransaction',
                    style: const TextStyle(
                      fontSize: 19,
                      fontWeight: FontWeight.w700,
                    ),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    flow.message ?? '',
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      color: BrandColors.muted,
                      height: 1.4,
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          if (unknown) ...[
            OutlinedButton.icon(
              onPressed: onQuery,
              icon: const Icon(Icons.refresh),
              label: const Text('Tra cứu snapshot hiện có'),
            ),
            const SizedBox(height: 10),
          ],
          FilledButton.icon(
            onPressed: onEvidence,
            icon: const Icon(Icons.verified_outlined),
            label: const Text('Mô phỏng nhận StopTransaction'),
          ),
          const SizedBox(height: 10),
          TextButton(
            onPressed: onUnknown,
            child: const Text('Giữ trạng thái chưa rõ'),
          ),
          const SizedBox(height: 14),
          const Text(
            'Không hiển thị đã dừng cho đến khi có bằng chứng từ server.',
            textAlign: TextAlign.center,
            style: TextStyle(color: BrandColors.muted, fontSize: 12),
          ),
        ],
      ),
    );
  }
}

class _SummaryView extends StatelessWidget {
  const _SummaryView({required this.flow, required this.onPayment});

  final ChargingFlowState flow;
  final VoidCallback onPayment;

  @override
  Widget build(BuildContext context) {
    final summary = flow.summary!;
    return _ChargingScaffold(
      title: 'Tổng kết phiên',
      child: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
        children: [
          _StationHeader(flow: flow),
          const SizedBox(height: 18),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const StatusPill(
                    label: 'Đã nhận bằng chứng dừng',
                    color: BrandColors.teal,
                    icon: Icons.check_circle_outline,
                  ),
                  const SizedBox(height: 18),
                  const Text(
                    'Năng lượng',
                    style: TextStyle(color: BrandColors.muted),
                  ),
                  Text(
                    AppFormatters.kwh(summary.energyWh),
                    style: const TextStyle(
                      fontSize: 26,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 14),
                  const Text(
                    'Ước tính hiện tại',
                    style: TextStyle(color: BrandColors.muted),
                  ),
                  Text(
                    AppFormatters.money(summary.amountVnd),
                    style: const TextStyle(
                      fontSize: 26,
                      fontWeight: FontWeight.w700,
                      color: BrandColors.gold,
                    ),
                  ),
                  const SizedBox(height: 14),
                  Text(
                    'Lý do: ${summary.reason}',
                    style: const TextStyle(color: BrandColors.muted),
                  ),
                  Text(
                    'Kết thúc lúc ${AppFormatters.dateTime(summary.endedAt)}',
                    style: const TextStyle(color: BrandColors.muted),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 14),
          if (flow.message != null)
            _Notice(message: flow.message!, color: BrandColors.warning),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: onPayment,
            icon: const Icon(Icons.payments_outlined),
            label: const Text('Xem và thanh toán bill'),
          ),
          const SizedBox(height: 10),
          const Text(
            'Bill cuối cùng cần đối soát theo dữ liệu server; màn này không tự chốt tiền.',
            textAlign: TextAlign.center,
            style: TextStyle(
              color: BrandColors.muted,
              fontSize: 12,
              height: 1.4,
            ),
          ),
        ],
      ),
    );
  }
}

class _StationHeader extends StatelessWidget {
  const _StationHeader({required this.flow});

  final ChargingFlowState flow;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Container(
          width: 44,
          height: 44,
          decoration: BoxDecoration(
            color: BrandColors.teal.withValues(alpha: .12),
            borderRadius: BorderRadius.circular(13),
          ),
          child: const Icon(Icons.ev_station_outlined, color: BrandColors.teal),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                flow.station?.name ?? 'Trạm mô phỏng',
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 3),
              Text(
                '${flow.connector?.type.label ?? 'CCS2'} · ${flow.connector?.id ?? 'connector'}',
                style: const TextStyle(color: BrandColors.muted, fontSize: 12),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _Metric extends StatelessWidget {
  const _Metric({required this.label, required this.value, required this.icon});

  final String label;
  final String value;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, color: BrandColors.gold, size: 18),
        const SizedBox(height: 6),
        Text(
          value,
          style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13),
        ),
        const SizedBox(height: 3),
        Text(
          label,
          style: const TextStyle(color: BrandColors.muted, fontSize: 11),
        ),
      ],
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.message, required this.color});

  final String message;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(13),
      decoration: BoxDecoration(
        color: color.withValues(alpha: .12),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.info_outline, color: color, size: 19),
          const SizedBox(width: 8),
          Expanded(
            child: Text(message, style: TextStyle(color: color, height: 1.35)),
          ),
        ],
      ),
    );
  }
}

class _ChargingScaffold extends StatelessWidget {
  const _ChargingScaffold({
    required this.title,
    required this.child,
    this.actions = const [],
  });

  final String title;
  final Widget child;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text(title), actions: actions),
    body: SafeArea(child: child),
  );
}
