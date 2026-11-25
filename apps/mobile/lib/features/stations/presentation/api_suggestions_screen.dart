import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/flow_page.dart';
import '../../profile/application/profile_controller.dart';
import '../application/station_discovery_controller.dart';
import '../domain/station_discovery.dart';
import 'api_discovery_components.dart';
import 'discovery_origin_panel.dart';
import 'inline_station_road.dart';
import 'station_copy.dart';

class ApiSuggestionsScreen extends ConsumerWidget {
  const ApiSuggestionsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final vehicle = ref.watch(discoveryVehicleProvider);
    final copy = ref.watch(discoveryCopyProvider);
    if (vehicle.isNotEmpty) return _Suggestions(key: ValueKey(vehicle));
    return DiscoveryPage(
      title: copy.text('Gợi ý trạm', 'Station suggestions'),
      copy: copy,
      backLocation: null,
      children: const [DiscoveryVehicleRequired()],
    );
  }
}

class _Suggestions extends ConsumerStatefulWidget {
  const _Suggestions({super.key});

  @override
  ConsumerState<_Suggestions> createState() => _SuggestionsState();
}

class _SuggestionsState extends ConsumerState<_Suggestions> {
  final _soc = TextEditingController();
  final _editFocus = FocusNode();
  ({SmartSearchInput input, bool atEstimateTarget})? _submitted;
  DiscoveryOrigin? _consentedOrigin;
  bool _consentedVinFastFilter = false;
  bool _invalid = false;

  @override
  void dispose() {
    _soc.dispose();
    _editFocus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final copy = ref.watch(discoveryCopyProvider);
    final vehicle = ref
        .watch(profileControllerProvider)
        .profile
        .selectedVehicle;
    final discovery = ref.watch(discoveryContextProvider);
    ref.listen(discoveryContextProvider, (previous, next) {
      if (previous?.origin != next.origin ||
          previous?.includeVinFastOnly != next.includeVinFastOnly) {
        _consentedOrigin = null;
      }
    });
    final batteryLabel = copy.text(
      'Pin hiện tại (%) · Không bắt buộc',
      'Current battery (%) · Optional',
    );
    final rawSoc = _soc.text.trim().replaceAll(',', '.');
    final soc = double.tryParse(rawSoc);
    final valid =
        rawSoc.isEmpty ||
        (soc != null && soc.isFinite && soc >= 0 && soc <= 100);
    final atEstimateTarget =
        valid && soc != null && soc >= smartSearchTargetSoc;
    final SmartSearchInput draft = (
      soc: atEstimateTarget ? null : soc,
      target: smartSearchTargetSoc,
    );
    final canShareOrigin =
        valid && draft.soc != null && discovery.origin != null;
    final submitted = _submitted;
    final DiscoverySearch input = (
      session: ref.watch(discoverySessionProvider),
      query: (
        text: '',
        page: 1,
        availability: SearchAvailability.all,
        includeVinFastOnly: discovery.includeVinFastOnly,
      ),
      origin: discovery.origin,
      smart: submitted?.input,
      consentToRoute:
          submitted?.input.soc != null &&
          discovery.origin != null &&
          identical(_consentedOrigin, discovery.origin) &&
          _consentedVinFastFilter == discovery.includeVinFastOnly,
    );
    final results = submitted == null
        ? null
        : ref.watch(discoverySearchProvider(input));
    return DiscoveryPage(
      title: copy.text('Gợi ý trạm', 'Station suggestions'),
      copy: copy,
      backLocation: null,
      branded: true,
      children: [
        DiscoveryHeading(
          copy.text('Gợi ý trạm phù hợp', 'Compatible station suggestions'),
          Icons.auto_awesome_outlined,
        ),
        const SizedBox(height: 12),
        if (vehicle != null) ...[
          HeroCard(
            accent: PowerMeColors.gold,
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(
                      Icons.directions_car_filled_outlined,
                      color: PowerMeColors.gold,
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        vehicle.label,
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 12,
                  runSpacing: 6,
                  children: [
                    if (vehicle.batteryCapacityKwh case final capacity?)
                      Text(
                        copy.text(
                          'Pin ${capacity.toString()} kWh',
                          '${capacity.toString()} kWh battery',
                        ),
                      ),
                    if (vehicle.connectors.isNotEmpty)
                      Text(vehicle.connectors.join(' · ')),
                  ],
                ),
                TextButton(
                  onPressed: () => context.go('/profile'),
                  child: Text(copy.text('Quản lý xe', 'Manage vehicles')),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
        ],
        InfoCard(
          spacing: 8,
          children: [
            Text(batteryLabel, style: Theme.of(context).textTheme.labelLarge),
            Semantics(
              label: batteryLabel,
              child: TextField(
                key: const Key('suggestion-soc'),
                focusNode: _editFocus,
                controller: _soc,
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: true,
                ),
                onChanged: (_) => setState(() => _invalid = false),
              ),
            ),
            if (_invalid)
              FailureNotice(
                copy.text(
                  'Nhập mức pin từ 0% đến 100% hoặc để trống.',
                  'Enter a battery level from 0% to 100% or leave it blank.',
                ),
              ),
            if (canShareOrigin)
              Text(
                roadDisclosure(copy),
                style: Theme.of(context).textTheme.bodySmall,
              ),
            FilledButton.icon(
              key: const Key('submit-smart-search'),
              onPressed: () {
                FocusScope.of(context).unfocus();
                if (valid &&
                    input.smart == draft &&
                    input.consentToRoute == canShareOrigin) {
                  ref.invalidate(discoverySearchProvider(input));
                }
                setState(() {
                  _invalid = !valid;
                  _submitted = valid
                      ? (input: draft, atEstimateTarget: atEstimateTarget)
                      : null;
                  _consentedOrigin = canShareOrigin ? discovery.origin : null;
                  _consentedVinFastFilter = discovery.includeVinFastOnly;
                });
              },
              icon: const Icon(Icons.bolt_outlined),
              label: Text(copy.text('Xem gợi ý', 'See suggestions')),
            ),
          ],
        ),
        ExpansionTile(
          title: Text(copy.text('Điểm đi', 'Starting point')),
          subtitle: discovery.origin == null
              ? null
              : Text(
                  discovery.origin?.address ??
                      copy.text('Vị trí hiện tại', 'Current location'),
                ),
          maintainState: true,
          children: const [DiscoveryOriginPanel()],
        ),
        const SizedBox(height: 12),
        if (results != null)
          ...results.when(
            skipLoadingOnRefresh: false,
            skipLoadingOnReload: false,
            loading: () => const <Widget>[LinearProgressIndicator()],
            error: (error, _) => <Widget>[
              DiscoveryRetry(
                message: roadError(
                  error,
                  copy,
                  fallback: copy.text(
                    'Không tải được gợi ý.',
                    'Could not load suggestions.',
                  ),
                  invalid: copy.text(
                    'Hãy kiểm tra và sửa mức pin đã nhập.',
                    'Check and edit the battery level you entered.',
                  ),
                ),
                copy: copy,
                retry: canRetryDiscovery(error)
                    ? () => ref.invalidate(discoverySearchProvider(input))
                    : null,
                edit: invalidDiscoveryInput(error)
                    ? _editFocus.requestFocus
                    : null,
                editLabel: copy.text('Sửa mức pin', 'Edit battery level'),
              ),
            ],
            data: (page) => [
              DiscoveryHeading(
                page.rangeKm == null
                    ? copy.text('Trạm phù hợp', 'Matching stations')
                    : copy.text('Kết quả gợi ý', 'Suggested stations'),
                Icons.ev_station_outlined,
              ),
              const SizedBox(height: 8),
              if (page.rangeKm case final range?)
                Text(
                  copy.text(
                    'Tầm pin ước tính: ${range.toStringAsFixed(1)} km',
                    'Estimated battery range: ${range.toStringAsFixed(1)} km',
                  ),
                ),
              if (page.rangeKm == null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Text(
                    _fallback(
                      page.smartUnavailable,
                      copy,
                      atEstimateTarget: submitted?.atEstimateTarget ?? false,
                    ),
                  ),
                ),
              if (page.items.isEmpty)
                Text(
                  copy.text(
                    'Không tìm thấy trạm tương thích.',
                    'No compatible stations found.',
                  ),
                ),
              for (final (index, hit) in page.items.indexed)
                _SuggestionResult(
                  key: ValueKey(hit.station.id),
                  hit: hit,
                  copy: copy,
                  rank: page.rangeKm == null ? null : index + 1,
                  showRoadEstimate:
                      input.consentToRoute &&
                      page.rankingSource == StationRankingSource.vietmapRoute,
                  onTap: () => openStation(context, ref, hit.station),
                ),
            ],
          ),
      ],
    );
  }
}

class _SuggestionResult extends StatelessWidget {
  const _SuggestionResult({
    super.key,
    required this.hit,
    required this.copy,
    required this.rank,
    required this.onTap,
    required this.showRoadEstimate,
  });

  final StationSearchHit hit;
  final AppCopy copy;
  final int? rank;
  final VoidCallback onTap;
  final bool showRoadEstimate;

  @override
  Widget build(BuildContext context) {
    final station = hit.station;
    final connector = hit.bestConnector;
    final top = rank == 1;
    final actionKey = ValueKey('suggestion-result-${station.id}');
    final actionLabel = Text(copy.text('Xem trạm', 'View station'));
    final metrics = [
      MetricItem(
        copy.text('Chờ ước tính', 'Estimated wait'),
        estimatedMinutes(hit.waitMinutes, copy),
        Icons.schedule,
      ),
      MetricItem(
        copy.text('Sạc ước tính', 'Estimated charging'),
        estimatedMinutes(hit.chargeMinutes, copy),
        Icons.bolt_outlined,
      ),
      MetricItem(
        copy.text('Chi phí tối đa ước tính', 'Estimated upper cost'),
        hit.maxCostVnd == null
            ? _unknown(copy)
            : vnd(hit.maxCostVnd, copy: copy),
        Icons.payments_outlined,
      ),
    ];
    final children = <Widget>[
      if (top)
        StatusBadge(
          copy.text('Gợi ý hàng đầu', 'Top suggestion'),
          color: PowerMeColors.gold,
        ),
      DiscoveryStationTitle(
        station: station,
        copy: copy,
        title: rank == null || top ? null : '$rank. ${station.name}',
      ),
      Align(
        alignment: Alignment.centerLeft,
        child: AvailablePortsBadge(station, copy),
      ),
      InlineStationRoad(
        station: station,
        copy: copy,
        estimate: showRoadEstimate ? hit.roadEstimate : null,
      ),
      if (rank != null) ...[
        if (connector != null) ...[
          Text(
            '${connectorLabel(connector, copy)} · ${connectorStatus(connector, copy)}',
          ),
          if (availabilityUnconfirmed(connector))
            Text(unconfirmedAvailabilityLabel(connector.availableNow, copy)),
        ] else
          Text(
            copy.text(
              'Chưa xác định được cổng phù hợp để ước tính.',
              'No connector could be selected for the estimate.',
            ),
          ),
        if (top)
          MetricGrid(items: metrics)
        else
          ExpansionTile(
            tilePadding: EdgeInsets.zero,
            title: Text(copy.text('Các ước tính', 'Estimates')),
            children: [MetricGrid(items: metrics)],
          ),
      ],
      if (top)
        FilledButton(key: actionKey, onPressed: onTap, child: actionLabel)
      else
        OutlinedButton(key: actionKey, onPressed: onTap, child: actionLabel),
    ];
    if (!top) return InfoCard(children: children);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: HeroCard(
        key: const Key('top-station-suggestion'),
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final child in children)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 5),
                child: child,
              ),
          ],
        ),
      ),
    );
  }
}

String _unknown(AppCopy copy) => copy.text('Chưa xác định', 'Unknown');

String _fallback(
  SmartUnavailable? reason,
  AppCopy copy, {
  required bool atEstimateTarget,
}) {
  if (atEstimateTarget) {
    final target = smartSearchTargetSoc.toStringAsFixed(0);
    return copy.text(
      'Pin đã đạt $target% trở lên. Không có ước tính sạc.',
      'Battery is already at $target% or higher. Charging estimates are unavailable.',
    );
  }
  return switch (reason) {
    SmartUnavailable.noSoc => copy.text(
      'Chưa nhập mức pin.',
      'Current battery is missing.',
    ),
    SmartUnavailable.noLocation => copy.text(
      'Chưa chọn điểm đi.',
      'No starting point selected.',
    ),
    SmartUnavailable.missingVehicleSpecs => copy.text(
      'Thiếu thông số pin hoặc tầm hoạt động của xe.',
      'Vehicle battery or range specifications are missing.',
    ),
    null => copy.text(
      'Chưa có ước tính thông minh.',
      'Smart estimates are unavailable.',
    ),
  };
}
