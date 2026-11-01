import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/flow_page.dart';
import '../../profile/application/profile_controller.dart';
import '../../profile/domain/driver_profile.dart';
import '../application/station_actions_controller.dart';
import '../application/station_route_controller.dart';
import '../domain/station.dart';
import '../domain/station_actions.dart';
import 'discovery_screen.dart';

String connectorRoute(String path, String connector) =>
    Uri(path: path, queryParameters: {'connector': connector}).toString();

AppCopy _safeAppCopy(WidgetRef ref) {
  try {
    return AppCopy(ref.watch(profileControllerProvider).profile.language);
  } catch (_) {
    return const AppCopy(AppLanguage.vietnamese);
  }
}

class SuggestionsScreen extends ConsumerStatefulWidget {
  const SuggestionsScreen({
    super.key,
    this.initialMode = SuggestionMode.fastest,
  });
  final SuggestionMode initialMode;
  @override
  ConsumerState<SuggestionsScreen> createState() => _SuggestionsScreenState();
}

class _SuggestionsScreenState extends ConsumerState<SuggestionsScreen> {
  final battery = TextEditingController(text: '30');
  final target = TextEditingController(text: '80');
  late SuggestionMode mode;
  @override
  void initState() {
    super.initState();
    mode = widget.initialMode;
  }

  @override
  void dispose() {
    battery.dispose();
    target.dispose();
    super.dispose();
  }

  void search() => ref
      .read(suggestionControllerProvider.notifier)
      .search(
        mode,
        battery.text.isEmpty ? null : int.tryParse(battery.text) ?? -1,
        target.text.isEmpty ? null : int.tryParse(target.text) ?? -1,
      );
  @override
  Widget build(BuildContext context) {
    final state = ref.watch(suggestionControllerProvider);
    final copy = _safeAppCopy(ref);
    final text = Theme.of(context).textTheme;
    return FlowPage(
      title: copy.text('Gợi ý cho bạn', 'Suggestions for you'),
      backTooltip: copy.back,
      children: [
        HeroCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(
                Icons.alt_route_rounded,
                color: PowerMeColors.teal,
                size: 32,
              ),
              const SizedBox(height: 12),
              Text(
                copy.text(
                  'Trạm phù hợp trên đường đi',
                  'Best stations along your route',
                ),
                style: text.headlineSmall,
              ),
              const SizedBox(height: 8),
              Text(
                copy.text(
                  'Nhập pin để xem các trạm có thể đến. Khoảng cách theo đường bộ, thời gian di chuyển đã tính cả đoạn đi chậm.',
                  'Enter battery to see reachable stations. Road distance and travel time include slow segments.',
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 20),
        InfoCard(
          spacing: 14,
          children: [
            Text(
              copy.text('Bạn muốn sạc đến đâu?', 'Charging goal'),
              style: text.titleLarge,
            ),
            TextField(
              key: const Key('suggestion-battery'),
              controller: battery,
              keyboardType: TextInputType.number,
              decoration: InputDecoration(
                labelText: copy.text(
                  'Pin hiện tại (%) · có thể bỏ trống',
                  'Current battery (%) · optional',
                ),
                fillColor: PowerMeColors.black,
                prefixIcon: const Icon(Icons.battery_3_bar_rounded),
              ),
            ),
            TextField(
              key: const Key('suggestion-target'),
              controller: target,
              keyboardType: TextInputType.number,
              decoration: InputDecoration(
                labelText: copy.text(
                  'Mục tiêu (%) · mặc định 80',
                  'Target (%) · default 80',
                ),
                fillColor: PowerMeColors.black,
                prefixIcon: const Icon(Icons.battery_charging_full_rounded),
              ),
            ),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final m in SuggestionMode.values)
                  ChoiceChip(
                    backgroundColor: PowerMeColors.black,
                    selectedColor: PowerMeColors.teal,
                    checkmarkColor: PowerMeColors.black,
                    labelStyle: TextStyle(
                      color: mode == m
                          ? PowerMeColors.black
                          : PowerMeColors.text,
                    ),
                    label: Text(switch (m) {
                      SuggestionMode.fastest => copy.text(
                        'Nhanh nhất',
                        'Fastest',
                      ),
                      SuggestionMode.cheapest => copy.text(
                        'Tiết kiệm nhất',
                        'Lowest cost',
                      ),
                      SuggestionMode.nearest => copy.text(
                        'Gần nhất đường bộ',
                        'Nearest by road',
                      ),
                    }),
                    selected: mode == m,
                    onSelected: state.busy
                        ? null
                        : (_) {
                            setState(() => mode = m);
                            search();
                          },
                  ),
              ],
            ),
            Text(switch (mode) {
              SuggestionMode.nearest => copy.text(
                'Ưu tiên quãng đường bộ ngắn, trong tầm pin.',
                'Prioritizes short road distance within battery range.',
              ),
              SuggestionMode.fastest => copy.text(
                'Xét tổng thời gian di chuyển + chờ + sạc đến mục tiêu.',
                'Considers total drive + wait + charge time to target.',
              ),
              SuggestionMode.cheapest => copy.text(
                'Ưu tiên chi phí sạc đến mục tiêu, sau đó là thời gian.',
                'Prioritizes charging cost to target, then total time.',
              ),
            }, style: text.bodyMedium?.copyWith(color: PowerMeColors.muted)),
            Text(
              copy.text(
                'Thời gian và chi phí là khoảng ước tính.',
                'Times and costs are estimates.',
              ),
              style: text.bodySmall?.copyWith(color: PowerMeColors.muted),
            ),
            FilledButton(
              key: const Key('find-suggestions'),
              onPressed: state.busy ? null : search,
              child: Text(
                state.busy
                    ? copy.text('Đang tìm…', 'Searching…')
                    : copy.text('Tìm gợi ý', 'Find suggestions'),
              ),
            ),
          ],
        ),
        FailureNotice(state.error),
        if (state.loaded && state.options.isEmpty)
          InfoCard(
            children: [
              Text(
                copy.text(
                  'Không có trạm phù hợp trong tầm pin dự kiến. Hãy kiểm tra mức pin hoặc chọn trạm gần hơn.',
                  'No matching station within estimated battery range. Check your battery level or choose a closer station.',
                ),
              ),
            ],
          ),
        for (final o in state.options)
          InfoCard(
            spacing: 12,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (o.rank != null) ...[
                    StatusBadge('#${o.rank}', color: PowerMeColors.gold),
                    const SizedBox(width: 12),
                  ],
                  Expanded(child: Text(o.station.name, style: text.titleLarge)),
                ],
              ),
              Text(
                o.station.operatorName,
                style: text.bodyMedium?.copyWith(color: PowerMeColors.muted),
              ),
              if (o.roadRoute case final route?) ...[
                RouteSummary(route: route, compact: true, copy: copy),
                ValueLine(
                  copy.text(
                    'Chờ · Sạc đến mục tiêu',
                    'Wait · Charge to target',
                  ),
                  '${minutes(o.waitingSeconds)} · ${minutes(o.chargingSeconds)}',
                ),
                ValueLine(
                  copy.text('Chi phí sạc ước tính', 'Estimated charging cost'),
                  vnd(o.estimatedCostVnd),
                  showDivider: false,
                ),
              ] else ...[
                ValueLine(
                  copy.text(
                    'Di chuyển ước tính · chờ',
                    'Estimated drive · wait',
                  ),
                  '${minutes(o.etaSeconds)} · ${minutes(o.waitingSeconds)}',
                ),
                ValueLine(
                  copy.text('Thời gian sạc · chi phí', 'Charge time · cost'),
                  '${minutes(o.chargingSeconds)} · ${vnd(o.estimatedCostVnd)}',
                  showDivider: false,
                ),
              ],
              if (o.suggestionReason?.trim().isNotEmpty == true)
                Text(o.suggestionReason!),
              if (o.estimateSource?.trim().isNotEmpty == true)
                Text(
                  o.estimateSource!,
                  style: text.bodyMedium?.copyWith(color: PowerMeColors.muted),
                ),
              if (o.rangeLabel?.trim().isNotEmpty == true)
                Text(
                  o.rangeLabel!,
                  style: text.bodyMedium?.copyWith(color: PowerMeColors.muted),
                ),
              Text(
                '${copy.text('Độ mới', 'Freshness')}: ${switch (o.connector.quality) {
                  DataQuality.observed => copy.text('đã ghi nhận', 'observed'),
                  DataQuality.stale => copy.text('cần cập nhật', 'needs refresh'),
                  DataQuality.unknown => copy.text('chưa xác định', 'unverified'),
                }} · ${ict(o.updatedAt)}',
                style: text.bodyMedium?.copyWith(color: PowerMeColors.muted),
              ),
              OutlinedButton(
                onPressed: () => context.push('/station/${o.station.id}'),
                child: Text(copy.text('Xem trạm', 'View station')),
              ),
              FilledButton.icon(
                key: Key('suggestion-route-${o.connectorId}'),
                onPressed: () async {
                  await ref
                      .read(stationRouteControllerProvider.notifier)
                      .preview(o.station.id, battery: state.batteryPercent);
                  if (context.mounted) context.go('/');
                },
                icon: const Icon(Icons.alt_route_rounded),
                label: Text(copy.text('Xem đường đi', 'View route')),
              ),
            ],
          ),
      ],
    );
  }
}

/*
class ReservationScreen extends ConsumerStatefulWidget {
  const ReservationScreen({super.key, required this.connector});
  final String connector;
  @override
  ConsumerState<ReservationScreen> createState() => _ReservationScreenState();
}

class _ReservationScreenState extends ConsumerState<ReservationScreen> {
  @override
  void initState() {
    super.initState();
    Future.microtask(() {
      if (mounted) {
        ref.read(reservationControllerProvider.notifier).load(widget.connector);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(reservationControllerProvider);
    final c = ref.read(reservationControllerProvider.notifier);
    final copy = _safeAppCopy(ref);
    final q = s.quote;
    final h = s.hold;
    return FlowPage(
      title: copy.text('Giữ cổng sạc', 'Reserve connector'),
      backTooltip: copy.back,
      children: [
        if (q != null || h != null) ...[
          Text(
            q?.connectorLabel ??
                h?.quote.connectorLabel ??
                copy.text('Cổng sạc đã chọn', 'Selected connector'),
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 12),
        ],
        FailureNotice(s.error),
        if (s.busy) ...[
          const LinearProgressIndicator(),
          const SizedBox(height: 16),
        ],
        if (!s.busy && s.error == null && q == null && h == null)
          InfoCard(
            spacing: 12,
            children: [
              Text(
                copy.text(
                  'Bạn chưa giữ cổng nào',
                  'No active connector reservation',
                ),
                style: Theme.of(context).textTheme.titleLarge,
              ),
              Text(
                copy.text(
                  'Chọn một cổng phù hợp tại trạm để xem thời gian giữ chỗ, phí và hạn hủy miễn phí trước khi xác nhận.',
                  'Select a compatible connector at a station to view hold duration, fees, and free cancellation window before confirming.',
                ),
              ),
              FilledButton.icon(
                key: const Key('reserve-find-station'),
                onPressed: () => context.go('/'),
                icon: const Icon(Icons.explore_outlined),
                label: Text(
                  copy.text(
                    'Tìm trạm để giữ chỗ',
                    'Find a station to reserve',
                  ),
                ),
              ),
            ],
          ),
        if (q != null && h?.state != HoldState.active)
          InfoCard(
            spacing: 12,
            children: [
              Text(
                copy.text(
                  'Giữ chỗ trong 15 phút từ khi xác nhận.',
                  'Held for 15 minutes from confirmation.',
                ),
              ),
              ValueLine(copy.text('Phí không đến', 'No-show fee'), vnd(q.feeVnd)),
              ValueLine(
                copy.text('Hủy muộn', 'Late cancellation'),
                vnd(q.lateCancelFeeVnd),
                showDivider: false,
              ),
              Text(
                copy.text(
                  'Hủy miễn phí đến 5 phút trước khi hết giữ chỗ. Trạm lỗi, mất kết nối hoặc bị chiếm: hủy không phí.',
                  'Free cancellation up to 5 minutes before expiry. Station fault, offline, or occupied: cancelled with no fee.',
                ),
                style: const TextStyle(color: PowerMeColors.muted),
              ),
              FilledButton(
                key: const Key('confirm-reservation'),
                onPressed: s.busy ? null : c.confirm,
                child: Text(
                  copy.text('Xác nhận giữ chỗ', 'Confirm reservation'),
                ),
              ),
            ],
          ),
        if (h != null)
          InfoCard(
            spacing: 12,
            children: [
              Text(switch (h.state) {
                HoldState.active => copy.text(
                  'Đang giữ cổng',
                  'Holding connector',
                ),
                HoldState.fulfilled => copy.text(
                  'Đã bắt đầu sạc',
                  'Charging started',
                ),
                HoldState.cancelledFree => copy.text(
                  'Đã hủy miễn phí',
                  'Cancelled for free',
                ),
                HoldState.cancelledLate => copy.text(
                  'Đã hủy muộn',
                  'Late cancellation',
                ),
                HoldState.expired => copy.text(
                  'Đã hết thời gian giữ chỗ',
                  'Reservation expired',
                ),
                HoldState.voided => copy.text(
                  'Trạm không sử dụng được · đã hủy không phí',
                  'Station unavailable · cancelled with no fee',
                ),
              }, style: Theme.of(context).textTheme.titleLarge),
              ValueLine(
                copy.text('Cổng', 'Connector'),
                h.quote.connectorLabel ??
                    copy.text('Cổng sạc đã chọn', 'Selected connector'),
              ),
              ValueLine(
                copy.text('Hết giữ chỗ', 'Hold expires at'),
                ict(h.quote.expiresAt),
              ),
              if (h.state == HoldState.active) ...[
                Text(
                  copy.text(
                    'Còn ${minutes(h.remainingSeconds)}',
                    '${minutes(h.remainingSeconds)} remaining',
                  ),
                  style: const TextStyle(color: PowerMeColors.teal),
                ),
                ValueLine(
                  copy.text('Hủy miễn phí đến', 'Free cancellation until'),
                  ict(h.quote.freeCancelUntil),
                ),
                FilledButton(
                  key: const Key('start-reservation'),
                  onPressed: s.busy
                      ? null
                      : () => context.push(
                          connectorRoute('/start', h.quote.connectorId),
                        ),
                  child: Text(
                    copy.text(
                      'Bắt đầu sạc tại cổng',
                      'Start charging at connector',
                    ),
                  ),
                ),
                OutlinedButton(
                  key: const Key('cancel-reservation'),
                  onPressed: s.busy ? null : c.cancel,
                  child: Text(copy.text('Hủy giữ chỗ', 'Cancel reservation')),
                ),
              ],
              ValueLine(
                copy.text('Phí đã ghi nhận', 'Recorded fee'),
                vnd(h.chargedFeeVnd),
                showDivider: false,
              ),
              if (h.state == HoldState.voided || h.state == HoldState.expired)
                TextButton(
                  onPressed: () => context.push('/suggestions'),
                  child: Text(
                    copy.text('Tìm trạm khác', 'Find another station'),
                  ),
                ),
            ],
          ),
        OutlinedButton(
          onPressed: s.busy ? null : () => c.load(widget.connector),
          child: Text(copy.text('Kiểm tra lại', 'Check again')),
        ),
      ],
    );
  }
}
*/
