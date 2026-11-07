import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/widgets/flow_page.dart';
import '../../../core/widgets/brand_mark.dart';
import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../profile/application/profile_controller.dart';
import '../../profile/domain/driver_profile.dart';
import '../application/charging_controller.dart';
import '../domain/charging.dart';

String modeLabel(
  ChargingMode m, [
  AppCopy copy = const AppCopy(AppLanguage.vietnamese),
]) => switch (m) {
  ChargingMode.autoFull => copy.text('Sạc đầy tự động', 'Auto full charge'),
  ChargingMode.timed => copy.text('Theo thời gian', 'By time'),
  ChargingMode.energy => copy.text('Theo năng lượng', 'By energy'),
  ChargingMode.cost => copy.text('Theo chi phí', 'By cost'),
};
String limitLabel(
  ChargingMode m,
  int? value, [
  AppCopy copy = const AppCopy(AppLanguage.vietnamese),
]) => value == null
    ? copy.text(
        'Tự động đến khi đầy hoặc ngưỡng tín dụng',
        'Automatic until full or credit threshold',
      )
    : switch (m) {
        ChargingMode.timed => minutes(value),
        ChargingMode.energy => '${value / 1000} kWh',
        ChargingMode.cost => vnd(value),
        ChargingMode.autoFull => copy.text('Tự động', 'Automatic'),
      };
String sessionLabel(
  SessionState state, [
  AppCopy copy = const AppCopy(AppLanguage.vietnamese),
]) => switch (state) {
  SessionState.pending => copy.text('Đang chờ bắt đầu', 'Waiting to start'),
  SessionState.active => copy.text('Đang sạc', 'Charging'),
  SessionState.paused => copy.text('Tạm dừng nhận điện', 'Charging paused'),
  SessionState.stopping => copy.text(
    'Đang chờ trạm dừng',
    'Waiting for station to stop',
  ),
  SessionState.closed => copy.text(
    'Đã kết thúc · đang đối soát',
    'Ended · reconciling',
  ),
  SessionState.reconciled => copy.text('Đã đối soát', 'Reconciled'),
  SessionState.orphaned => copy.text(
    'Mất kết nối với trụ, dữ liệu đang chờ',
    'Disconnected from charger, data pending',
  ),
  SessionState.review => copy.text(
    'Cần kiểm tra phiên',
    'Session under review',
  ),
  SessionState.failed => copy.text('Không thể bắt đầu', 'Could not start'),
  SessionState.unknown => copy.text('Chưa rõ trạng thái', 'Status unknown'),
};
String settlementLabel(
  SettlementState s, [
  AppCopy copy = const AppCopy(AppLanguage.vietnamese),
]) => switch (s) {
  SettlementState.pending => copy.text(
    'Đang chờ đối soát',
    'Awaiting reconciliation',
  ),
  SettlementState.posted => copy.text('Đã ghi sổ tín dụng', 'Credit posted'),
  SettlementState.review => copy.text('Cần kiểm tra', 'Under review'),
  SettlementState.notApplicable => copy.text(
    'Không trừ tín dụng PowerMe',
    'No PowerMe credit deducted',
  ),
  SettlementState.unknown => copy.text('Chưa xác định', 'Unknown'),
};

bool showSettlement(SessionSnapshot s) => switch (s.state) {
  SessionState.closed || SessionState.reconciled || SessionState.review => true,
  _ => false,
};

class StartScreen extends ConsumerStatefulWidget {
  const StartScreen({super.key, this.connector = ''});
  final String connector;
  @override
  ConsumerState<StartScreen> createState() => _StartScreenState();
}

class _StartScreenState extends ConsumerState<StartScreen> {
  late final TextEditingController reference;
  final limit = TextEditingController(text: '20');
  ChargingMode mode = ChargingMode.autoFull;
  String? connector;
  @override
  void initState() {
    super.initState();
    reference = TextEditingController(text: widget.connector);
  }

  @override
  void dispose() {
    reference.dispose();
    limit.dispose();
    super.dispose();
  }

  Future<void> prepare() async {
    await ref
        .read(chargingControllerProvider.notifier)
        .prepare(reference.text, mode, limit.text);
    if (mounted) setState(() => connector = reference.text);
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(chargingControllerProvider);
    final c = ref.read(chargingControllerProvider.notifier);
    final profile = ref.watch(profileControllerProvider).profile;
    final copy = AppCopy(profile.language);
    final text = Theme.of(context).textTheme;
    final waiting =
        s.command?.status == CommandState.unknown ||
        s.command?.status == CommandState.accepted && s.session == null ||
        s.session != null &&
            s.session!.state != SessionState.reconciled &&
            s.session!.state != SessionState.failed;
    return FlowPage(
      title: copy.text('Bắt đầu sạc', 'Start charging'),
      backTooltip: copy.back,
      children: [
        const Center(child: ChargingMark()),
        const SizedBox(height: 20),
        InfoCard(
          spacing: 14,
          children: [
            Row(
              children: [
                const Icon(
                  Icons.directions_car_outlined,
                  color: PowerMeColors.gold,
                ),
                const SizedBox(width: 10),
                Expanded(child: Text(profile.vehicle, style: text.titleLarge)),
              ],
            ),
            TextField(
              key: const Key('connector-reference'),
              controller: reference,
              onChanged: (_) => setState(() => connector = null),
              decoration: InputDecoration(
                labelText: copy.text(
                  'Mã trạm/cổng hoặc nội dung QR',
                  'Station/connector code or QR content',
                ),
                hintText: 'station-powerme-center/1',
                fillColor: PowerMeColors.black,
                prefixIcon: const Icon(Icons.ev_station_outlined),
              ),
            ),
            DropdownButtonFormField<ChargingMode>(
              key: const Key('charging-mode'),
              initialValue: mode,
              isExpanded: true,
              items: [
                for (final m in ChargingMode.values)
                  DropdownMenuItem(value: m, child: Text(modeLabel(m, copy))),
              ],
              onChanged: waiting
                  ? null
                  : (v) => setState(() {
                      mode = v!;
                      connector = null;
                    }),
              decoration: InputDecoration(
                labelText: copy.text('Chế độ sạc', 'Charging mode'),
                fillColor: PowerMeColors.black,
                prefixIcon: const Icon(Icons.tune_rounded),
              ),
            ),
            if (mode != ChargingMode.autoFull)
              TextField(
                key: const Key('charging-limit'),
                controller: limit,
                keyboardType: TextInputType.number,
                onChanged: (_) => setState(() => connector = null),
                decoration: InputDecoration(
                  labelText: switch (mode) {
                    ChargingMode.timed => copy.text(
                      'Thời lượng (phút)',
                      'Duration (minutes)',
                    ),
                    ChargingMode.energy => copy.text(
                      'Năng lượng (kWh)',
                      'Energy (kWh)',
                    ),
                    _ => copy.text('Giới hạn (đ)', 'Limit (VND)'),
                  },
                  fillColor: PowerMeColors.black,
                  prefixIcon: const Icon(Icons.bolt_rounded),
                ),
              ),
            OutlinedButton(
              key: const Key('check-start'),
              onPressed: s.busy || waiting ? null : prepare,
              child: Text(
                copy.text(
                  'Kiểm tra cổng và tín dụng',
                  'Check connector and credit',
                ),
              ),
            ),
          ],
        ),
        FailureNotice(s.error),
        if (s.preview != null && connector != null)
          InfoCard(
            spacing: 12,
            children: [
              Text(s.preview!.connectorLabel, style: text.titleLarge),
              ValueLine(
                copy.text('Giá hiện tại / kWh', 'Current price / kWh'),
                vnd(s.preview!.tariffVndPerKwh),
              ),
              ValueLine(
                copy.text('Tín dụng khả dụng', 'Available credit'),
                vnd(s.preview!.creditVnd),
              ),
              ValueLine(
                copy.text('Mức bắt đầu tối thiểu', 'Minimum to start'),
                vnd(s.preview!.minimumVnd),
              ),
              ValueLine(
                copy.text('Giới hạn được chấp nhận', 'Accepted limit'),
                limitLabel(mode, s.preview!.effectiveLimit, copy),
                showDivider: false,
              ),
              Text(
                copy.text(
                  'Yêu cầu dừng khi tín dụng còn ${vnd(s.preview!.cutoffVnd)}. Trạm mất kết nối có thể dừng trễ.',
                  'Stop requested when credit reaches ${vnd(s.preview!.cutoffVnd)}. Offline stations may stop late.',
                ),
                style: text.bodyMedium?.copyWith(color: PowerMeColors.muted),
              ),
              FailureNotice(s.preview!.reason),
              if (!s.preview!.canStart)
                TextButton(
                  onPressed: () => context.push('/credit'),
                  child: Text(copy.text('Nạp tín dụng', 'Top up credit')),
                ),
              FilledButton(
                key: const Key('confirm-start'),
                onPressed: !s.preview!.canStart || s.busy || waiting
                    ? null
                    : c.startPrepared,
                child: Text(copy.text('Xác nhận bắt đầu', 'Confirm start')),
              ),
            ],
          ),
        if (waiting || s.session != null && !s.session!.ended)
          InfoCard(
            spacing: 12,
            children: [
              Text(
                s.command?.status == CommandState.unknown
                    ? copy.text(
                        'Chưa rõ kết quả bắt đầu. Giữ nguyên yêu cầu để kiểm tra.',
                        'Start result unknown. Keep the current request to check.',
                      )
                    : copy.text(
                        'Đã nhận yêu cầu. Chờ trạm xác nhận phiên sạc.',
                        'Request received. Waiting for station confirmation.',
                      ),
              ),
              FilledButton(
                key: const Key('open-session'),
                onPressed: () => context.go('/charging'),
                child: Text(copy.text('Theo dõi phiên sạc', 'View session')),
              ),
            ],
          ),
        if (s.session != null && !s.session!.ended && !waiting)
          TextButton(
            onPressed: () => context.go('/charging'),
            child: Text(
              copy.text('Xem phiên hiện tại', 'View current session'),
            ),
          ),
      ],
    );
  }
}

class ActiveSessionScreen extends ConsumerWidget {
  const ActiveSessionScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final view = ref.watch(chargingControllerProvider);
    final c = ref.read(chargingControllerProvider.notifier);
    final copy = AppCopy(ref.watch(profileControllerProvider).profile.language);
    final s = view.session;
    final command = view.command;
    final id = command?.sessionId ?? s?.sessionId;
    return FlowPage(
      title: copy.charging,
      showBack: false,
      backTooltip: copy.back,
      children: [
        if (s == null && command != null ||
            s?.state == SessionState.pending) ...[
          const Center(child: ChargingMark()),
          const SizedBox(height: 24),
        ],
        if (s == null) ...[
          if (command == null)
            InfoCard(
              spacing: 20,
              children: [
                const Center(
                  child: ChargingMark(backgroundColor: PowerMeColors.graphite),
                ),
                Text(
                  copy.text(
                    'Bạn chưa có phiên sạc.',
                    'You have no active charging session.',
                  ),
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.headlineSmall,
                ),
                Text(
                  copy.text(
                    'Nhập mã cổng tại trạm hoặc chọn cổng sạc để bắt đầu phiên sạc mới.',
                    'Enter a charger code or select a connector to start a new charging session.',
                  ),
                  textAlign: TextAlign.center,
                ),
                FilledButton(
                  onPressed: () => context.push('/start'),
                  child: Text(copy.text('Chọn cổng sạc', 'Choose connector')),
                ),
              ],
            )
          else
            InfoCard(
              children: [
                Text(
                  command.status == CommandState.unknown
                      ? copy.text(
                          'Chưa rõ kết quả yêu cầu',
                          'Request outcome unknown',
                        )
                      : copy.text(
                          'Đã nhận yêu cầu · chờ xác nhận bắt đầu',
                          'Request received · waiting for start confirmation',
                        ),
                  style: Theme.of(context).textTheme.headlineSmall,
                ),
              ],
            ),
        ] else ...[
          Text(s.connectorLabel, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 12),
          Align(
            alignment: Alignment.centerLeft,
            child: StatusBadge(
              sessionLabel(s.state, copy),
              color: s.state == SessionState.active
                  ? PowerMeColors.teal
                  : PowerMeColors.gold,
            ),
          ),
          const SizedBox(height: 20),
          HeroCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            copy.text('Mức pin hiện tại', 'Current battery'),
                            style: const TextStyle(color: PowerMeColors.muted),
                          ),
                          const SizedBox(height: 6),
                          Text(
                            s.socPercent == null
                                ? copy.text('Chưa xác định', 'Unknown')
                                : '${s.socPercent}%',
                            style: Theme.of(context).textTheme.headlineLarge
                                ?.copyWith(
                                  color: PowerMeColors.teal,
                                  fontSize: 36,
                                  fontWeight: FontWeight.w800,
                                  letterSpacing: -.8,
                                  fontFeatures: const [
                                    FontFeature.tabularFigures(),
                                  ],
                                ),
                          ),
                        ],
                      ),
                    ),
                    Container(
                      width: 48,
                      height: 48,
                      decoration: BoxDecoration(
                        color: PowerMeColors.black.withValues(alpha: .65),
                        borderRadius: BorderRadius.circular(14),
                        border: Border.all(
                          color: PowerMeColors.teal.withValues(alpha: .36),
                        ),
                      ),
                      child: const Icon(
                        Icons.battery_charging_full_rounded,
                        size: 26,
                        color: PowerMeColors.teal,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                if (s.socPercent != null)
                  Semantics(
                    label: copy.text('Mức pin', 'Battery level'),
                    value: '${s.socPercent}%',
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(8),
                      child: LinearProgressIndicator(
                        value: s.socPercent!.clamp(0, 100) / 100,
                        minHeight: 10,
                        backgroundColor: PowerMeColors.teal.withValues(
                          alpha: .12,
                        ),
                        color: PowerMeColors.teal,
                      ),
                    ),
                  ),
                const SizedBox(height: 24),
                MetricGrid(
                  items: [
                    MetricItem(
                      copy.text('Năng lượng', 'Energy'),
                      s.energyWh == null
                          ? copy.text('Chưa xác định', 'Unknown')
                          : '${(s.energyWh! / 1000).toStringAsFixed(2)} kWh',
                      Icons.bolt_rounded,
                    ),
                    MetricItem(
                      copy.text('Thời gian sạc', 'Elapsed time'),
                      minutes(s.elapsedSeconds),
                      Icons.timer_outlined,
                    ),
                    MetricItem(
                      copy.text('Chi phí ước tính', 'Estimated cost'),
                      vnd(s.estimatedCostVnd),
                      Icons.payments_outlined,
                    ),
                    MetricItem(
                      copy.text('Tín dụng còn lại', 'Remaining credit'),
                      vnd(s.availableCreditVnd),
                      Icons.account_balance_wallet_outlined,
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          if (s.quality == DataQuality.stale)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Text(
                copy.text(
                  'Dữ liệu có thể chưa cập nhật',
                  'Data may be outdated',
                ),
                style: const TextStyle(color: PowerMeColors.gold),
              ),
            ),
          if (s.pauseCause != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Text(s.pauseCause!),
            ),
          if (s.stopReason != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Text(s.stopReason!),
            ),
          InfoCard(
            spacing: 10,
            children: [
              Row(
                children: [
                  Icon(
                    s.connectionState == ConnectionState.online
                        ? Icons.wifi_rounded
                        : Icons.wifi_off_rounded,
                    size: 18,
                    color: PowerMeColors.muted,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      '${copy.text('Kết nối', 'Connection')}: ${switch (s.connectionState) {
                        ConnectionState.online => copy.text('trực tuyến', 'online'),
                        ConnectionState.offline => copy.text('mất kết nối', 'offline'),
                        ConnectionState.unknown => copy.text('chưa rõ', 'unknown'),
                      }}',
                    ),
                  ),
                ],
              ),
              Text(
                '${copy.text('Số liệu', 'Telemetry')} ${s.staleAt(DateTime.now())
                    ? copy.text('cần cập nhật', 'needs updating')
                    : s.quality == DataQuality.unknown
                    ? copy.text('chưa rõ độ mới', 'freshness unknown')
                    : copy.text('đã ghi nhận', 'observed')} · ${ict(s.observedAt)}',
                style: Theme.of(
                  context,
                ).textTheme.bodyMedium?.copyWith(color: PowerMeColors.muted),
              ),
            ],
          ),
          if (showSettlement(s))
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Text(
                settlementLabel(s.settlement, copy),
                style: const TextStyle(color: PowerMeColors.muted),
              ),
            ),
          if (!s.ended)
            FilledButton.icon(
              key: const Key('stop-charging'),
              onPressed: view.busy || command?.status == CommandState.unknown
                  ? null
                  : c.stopCurrent,
              icon: const Icon(Icons.stop_rounded),
              label: Text(copy.text('Yêu cầu dừng sạc', 'Stop charging')),
            ),
          if (s.ended)
            FilledButton(
              key: const Key('open-statement'),
              onPressed: () => context.push('/statement/${s.sessionId}'),
              child: Text(copy.text('Xem bảng kê', 'View statement')),
            ),
        ],
        FailureNotice(view.error),
        if (command?.status == CommandState.unknown) ...[
          const SizedBox(height: 12),
          FilledButton(
            key: const Key('recover-command'),
            onPressed: view.busy ? null : () => c.recover(command!.requestKey),
            child: Text(
              copy.text('Kiểm tra yêu cầu hiện tại', 'Check current request'),
            ),
          ),
        ],
        const SizedBox(height: 12),
        if (id != null)
          TextButton.icon(
            key: const Key('refresh-session'),
            onPressed: view.busy ? null : () => c.resync(id),
            icon: const Icon(Icons.refresh_rounded),
            label: Text(
              view.busy
                  ? copy.text('Đang kiểm tra…', 'Checking…')
                  : copy.text('Cập nhật phiên sạc', 'Refresh session'),
            ),
          ),
      ],
    );
  }
}

class StatementScreen extends ConsumerWidget {
  const StatementScreen({super.key, required this.id});
  final String id;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final view = ref.watch(statementProvider(id));
    final copy = AppCopy(ref.watch(profileControllerProvider).profile.language);
    final s = view.asData?.value;
    final statement = s?.statement;
    return FlowPage(
      title: copy.text('Bảng kê phiên sạc', 'Session statement'),
      backTooltip: copy.back,
      children: [
        if (view.isLoading) ...[
          const LinearProgressIndicator(),
          const SizedBox(height: 16),
        ],
        if (s != null) ...[
          Text(s.connectorLabel, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              StatusBadge(sessionLabel(s.state, copy)),
              if (showSettlement(s))
                StatusBadge(
                  settlementLabel(s.settlement, copy),
                  color: PowerMeColors.gold,
                ),
            ],
          ),
          const SizedBox(height: 20),
          if (statement != null)
            InfoCard(
              children: [
                for (final segment in statement.segments)
                  ValueLine(
                    '${segment.label} · ${segment.energyWh / 1000} kWh · ${vnd(segment.tariffVndPerKwh)}/kWh',
                    vnd(segment.debitVnd),
                  ),
                ValueLine(
                  copy.text('Tín dụng đã trừ', 'Credit deducted'),
                  vnd(statement.debitVnd),
                ),
                ValueLine(
                  copy.text('Số dư sau ghi sổ', 'Balance after posting'),
                  vnd(statement.balanceVnd),
                ),
                ValueLine(
                  copy.text('Điểm tích lũy', 'Points earned'),
                  '${statement.earnedPoints}',
                ),
                ValueLine(
                  copy.text('Lý do kết thúc', 'Stop reason'),
                  statement.stopReason,
                  showDivider: false,
                ),
              ],
            )
          else
            InfoCard(
              children: [
                Text(
                  s.state == SessionState.failed
                      ? copy.text(
                          'Phiên không khởi động được, không trừ tín dụng.',
                          'Session did not start; no credit was deducted.',
                        )
                      : showSettlement(s)
                      ? copy.text(
                          'Bảng kê sẽ có khi kết quả đối soát được xác nhận. Phiên thanh toán tại trạm không tự trừ tín dụng hoặc cộng điểm PowerMe.',
                          'The statement will be available once reconciliation is confirmed. Station-paid sessions do not deduct credit or earn PowerMe points.',
                        )
                      : copy.text(
                          'Bảng kê được lập sau khi phiên sạc kết thúc.',
                          'The statement is generated after the charging session ends.',
                        ),
                ),
              ],
            ),
        ],
        if (view.hasError) FailureNotice(failureText(view.error!)),
        OutlinedButton(
          key: const Key('refresh-statement'),
          onPressed: view.isLoading
              ? null
              : () => ref.invalidate(statementProvider(id)),
          child: Text(copy.text('Kiểm tra bảng kê', 'Check statement')),
        ),
        const SizedBox(height: 8),
        TextButton(
          onPressed: () => context.go('/history'),
          child: Text(copy.text('Lịch sử và hóa đơn', 'History and invoices')),
        ),
      ],
    );
  }
}
