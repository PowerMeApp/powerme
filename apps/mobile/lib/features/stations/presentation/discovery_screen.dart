import '../../../app/composition/vietmap_config.dart';
import 'vietmap_surface.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/brand_mark.dart';
import '../../../core/widgets/flow_page.dart';
import '../../profile/application/profile_controller.dart';
import '../../profile/domain/driver_profile.dart';
import '../application/stations_controller.dart';
import '../application/station_actions_controller.dart';
import '../application/station_route_controller.dart';
import '../domain/station.dart';
import '../domain/station_route.dart';
import 'station_copy.dart';
import 'road_map_canvas.dart';
import 'station_actions_screens.dart' show connectorRoute;

class DiscoveryScreen extends ConsumerStatefulWidget {
  const DiscoveryScreen({super.key});
  @override
  ConsumerState<DiscoveryScreen> createState() => _DiscoveryScreenState();
}

class _DiscoveryScreenState extends ConsumerState<DiscoveryScreen> {
  late final TextEditingController search;
  final transformation = TransformationController();
  final sheet = DraggableScrollableController();
  final liveMap = GlobalKey<VietmapSurfaceState>();

  @override
  void initState() {
    super.initState();
    search = TextEditingController(
      text: ref.read(stationsControllerProvider).query,
    );
  }

  @override
  void dispose() {
    search.dispose();
    transformation.dispose();
    sheet.dispose();
    super.dispose();
  }

  void expandList() {
    if (sheet.isAttached) {
      sheet.animateTo(
        .84,
        duration: const Duration(milliseconds: 240),
        curve: Curves.easeOut,
      );
    }
  }

  void select(String id) {
    ref.read(stationRouteControllerProvider.notifier).select(id);
    transformation.value = Matrix4.identity();
    if (sheet.isAttached) {
      sheet.animateTo(
        .38,
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOut,
      );
    }
  }

  void showFilters() => showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (context) => SafeArea(
      child: SingleChildScrollView(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Consumer(
            builder: (context, sheetRef, _) {
              final state = sheetRef.watch(stationsControllerProvider);
              final copy = AppCopy(
                sheetRef.watch(profileControllerProvider).profile.language,
              );
              return Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    copy.text(
                      'Trạm phù hợp với bạn',
                      'Compatible stations for you',
                    ),
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  const SizedBox(height: 16),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      for (final f in StationFilter.values)
                        FilterChip(
                          key: Key('filter-${f.name}'),
                          label: Text(switch (f) {
                            StationFilter.all => copy.text('Tất cả', 'All'),
                            StationFilter.available => copy.text(
                              'Có chỗ trống',
                              'Available',
                            ),
                            StationFilter.highPower => copy.text(
                              'Từ 120 kW',
                              '120 kW+',
                            ),
                          }),
                          selected: f == state.filter,
                          onSelected: (_) => sheetRef
                              .read(stationsControllerProvider.notifier)
                              .selectFilter(f),
                        ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  CheckboxListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text(
                      copy.text(
                        'Hiện cả trạm chỉ dành cho VinFast',
                        'Include VinFast-only stations',
                      ),
                    ),
                    subtitle: Text(
                      copy.text(
                        'Các trạm này vẫn không hỗ trợ xe đang chọn.',
                        'These stations still do not support the selected vehicle.',
                      ),
                    ),
                    value: sheetRef.watch(showRestrictedProvider),
                    onChanged: (v) => sheetRef
                        .read(showRestrictedProvider.notifier)
                        .select(v!),
                  ),
                  const SizedBox(height: 12),
                  FilledButton(
                    onPressed: () => Navigator.pop(context),
                    child: Text(copy.text('Xong', 'Done')),
                  ),
                ],
              );
            },
          ),
        ),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final mapConfig = ref.watch(vietmapConfigProvider);
    final profile = ref.watch(profileControllerProvider).profile;
    final copy = AppCopy(profile.language);
    final state = ref.watch(stationsControllerProvider);
    final controller = ref.read(stationsControllerProvider.notifier);
    final routeState = ref.watch(stationRouteControllerProvider);
    final routeController = ref.read(stationRouteControllerProvider.notifier);
    final selected = state.listings
        .where((l) => l.station.id == routeState.stationId)
        .firstOrNull;
    final text = Theme.of(context).textTheme;
    return SafeArea(
      child: Column(
        children: [
          Expanded(
            child: LayoutBuilder(
              builder: (context, box) {
                final large =
                    MediaQuery.textScalerOf(context).scale(14) / 14 > 1.3;
                final collapsed = large ? .3 : .27;
                final mapPadding = EdgeInsets.fromLTRB(
                  20,
                  large ? 250 : 188,
                  20,
                  box.maxHeight *
                          (selected == null
                              ? collapsed
                              : routeState.requested
                              ? .44
                              : .38) +
                      16,
                );
                return Stack(
                  children: [
                    Positioned.fill(
                      child: mapConfig != null
                          ? VietmapSurface(
                              key: liveMap,
                              config: mapConfig,
                              stations: state.stations,
                              selectedId: selected?.station.id,
                              onSelect: select,
                              padding: mapPadding,
                              copy: copy,
                            )
                          : RoadMapCanvas(
                              scene: ref.watch(roadMapSceneProvider),
                              listings: state.listings,
                              selectedId: selected?.station.id,
                              route: selected == null ? null : routeState.route,
                              transformation: transformation,
                              onSelect: select,
                              padding: mapPadding,
                              copy: copy,
                            ),
                    ),
                    Positioned(
                      top: 12,
                      left: 16,
                      right: 16,
                      child: Column(
                        children: [
                          Row(
                            children: [
                              Material(
                                color: PowerMeColors.graphite,
                                elevation: 6,
                                borderRadius: BorderRadius.circular(18),
                                child: const BrandMark(
                                  backgroundColor: PowerMeColors.graphite,
                                ),
                              ),
                              const Spacer(),
                              _MapControl(
                                icon: Icons.account_balance_wallet_outlined,
                                label: copy.text(
                                  'Tín dụng sạc',
                                  'Charging credit',
                                ),
                                onTap: () => context.push('/credit'),
                              ),
                            ],
                          ),
                          const SizedBox(height: 12),
                          Material(
                            color: PowerMeColors.graphite,
                            elevation: 8,
                            borderRadius: BorderRadius.circular(16),
                            child: ValueListenableBuilder<TextEditingValue>(
                              valueListenable: search,
                              builder: (context, searchValue, _) => TextField(
                                key: const Key('station-search'),
                                controller: search,
                                onChanged: (query) {
                                  routeController.clear();
                                  controller.find(profile.vehicleId, query);
                                },
                                decoration: InputDecoration(
                                  hintText: copy.text(
                                    'Tìm trạm, địa chỉ…',
                                    'Station or address…',
                                  ),
                                  prefixIcon: const Icon(Icons.search_rounded),
                                  suffixIcon: searchValue.text.isNotEmpty
                                      ? IconButton(
                                          tooltip: copy.text(
                                            'Xóa tìm kiếm',
                                            'Clear search',
                                          ),
                                          onPressed: () {
                                            search.clear();
                                            controller.clear();
                                            routeController.clear();
                                          },
                                          icon: const Icon(Icons.close_rounded),
                                        )
                                      : IconButton(
                                          key: const Key(
                                            'compatibility-options',
                                          ),
                                          tooltip: copy.text(
                                            'Bộ lọc trạm',
                                            'Station filters',
                                          ),
                                          onPressed: showFilters,
                                          icon: const Icon(Icons.tune_rounded),
                                        ),
                                ),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                    Positioned(
                      top: large ? 190 : 146,
                      left: 16,
                      right: 16,
                      child: SizedBox(
                        height: large ? 66 : 48,
                        child: SingleChildScrollView(
                          scrollDirection: Axis.horizontal,
                          child: Row(
                            children: [
                              _MapChip(
                                icon: Icons.directions_car_outlined,
                                label: profile.selectedVehicle == null
                                    ? copy.text(
                                        'Thêm xe của bạn',
                                        'Add your vehicle',
                                      )
                                    : profile.vehicle,
                                onTap: () => context.go('/profile'),
                              ),
                              const SizedBox(width: 8),
                              _MapChip(
                                key: const Key('station-filters'),
                                icon: Icons.filter_list_rounded,
                                label: switch (state.filter) {
                                  StationFilter.all => copy.text(
                                    'Bộ lọc',
                                    'Filters',
                                  ),
                                  StationFilter.available => copy.text(
                                    'Có chỗ trống',
                                    'Available',
                                  ),
                                  StationFilter.highPower => copy.text(
                                    'Từ 120 kW',
                                    '120 kW+',
                                  ),
                                },
                                onTap: showFilters,
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                    Positioned(
                      right: 12,
                      bottom:
                          box.maxHeight *
                              (selected == null
                                  ? collapsed
                                  : routeState.requested
                                  ? .44
                                  : .38) +
                          12,
                      child: Column(
                        children: [
                          _MapControl(
                            icon: Icons.add_rounded,
                            label: copy.text('Phóng to bản đồ', 'Zoom in map'),
                            onTap: () {
                              if (mapConfig != null) {
                                liveMap.currentState?.zoomIn();
                                return;
                              }
                              final scale = transformation.value
                                  .getMaxScaleOnAxis();
                              if (scale < 2.5) {
                                transformation.value = Matrix4.diagonal3Values(
                                  (scale + .5).clamp(1, 2.5),
                                  (scale + .5).clamp(1, 2.5),
                                  1,
                                );
                              }
                            },
                          ),
                          const SizedBox(height: 8),
                          _MapControl(
                            icon: Icons.center_focus_strong_rounded,
                            label: mapConfig != null
                                ? copy.text('Vị trí của tôi', 'My location')
                                : copy.text(
                                    'Xem toàn bộ khu vực',
                                    'View entire area',
                                  ),
                            onTap: () {
                              if (mapConfig != null) {
                                liveMap.currentState?.locate();
                              } else {
                                transformation.value = Matrix4.identity();
                              }
                            },
                          ),
                        ],
                      ),
                    ),
                    DraggableScrollableSheet(
                      controller: sheet,
                      minChildSize: collapsed,
                      initialChildSize: selected == null
                          ? collapsed
                          : routeState.requested
                          ? .44
                          : .38,
                      maxChildSize: .88,
                      snap: true,
                      snapSizes: [collapsed, .55, .88],
                      shouldCloseOnMinExtent: false,
                      builder: (context, scroll) => Material(
                        color: PowerMeColors.graphite,
                        elevation: 12,
                        shape: RoundedRectangleBorder(
                          borderRadius: const BorderRadius.vertical(
                            top: Radius.circular(24),
                          ),
                          side: BorderSide(
                            color: PowerMeColors.outline.withValues(alpha: .35),
                          ),
                        ),
                        clipBehavior: Clip.antiAlias,
                        child: ListView(
                          key: ValueKey(
                            'map-sheet-${selected?.station.id ?? 'list'}',
                          ),
                          controller: scroll,
                          padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
                          children: [
                            Center(
                              child: IconButton(
                                key: const Key('expand-map-sheet'),
                                tooltip: copy.text(
                                  'Mở rộng thông tin trạm',
                                  'Expand station info',
                                ),
                                onPressed: () => sheet.animateTo(
                                  .88,
                                  duration: const Duration(milliseconds: 240),
                                  curve: Curves.easeOut,
                                ),
                                icon: Container(
                                  width: 34,
                                  height: 4,
                                  decoration: BoxDecoration(
                                    color: PowerMeColors.muted.withValues(
                                      alpha: .5,
                                    ),
                                    borderRadius: BorderRadius.circular(2),
                                  ),
                                ),
                              ),
                            ),
                            if (selected != null) ...[
                              Row(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  const Padding(
                                    padding: EdgeInsets.only(right: 12, top: 4),
                                    child: ChargingMark(
                                      size: 38,
                                      backgroundColor: PowerMeColors.graphite,
                                    ),
                                  ),
                                  Expanded(
                                    child: Text(
                                      selected.station.name,
                                      style: text.titleLarge,
                                    ),
                                  ),
                                  IconButton(
                                    tooltip: copy.text(
                                      'Bỏ chọn trạm',
                                      'Clear selection',
                                    ),
                                    onPressed: routeController.clear,
                                    icon: const Icon(Icons.close_rounded),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 6),
                              Text(
                                selected.station.address,
                                style: text.bodySmall?.copyWith(
                                  color: PowerMeColors.muted,
                                ),
                              ),
                              const SizedBox(height: 14),
                              Wrap(
                                spacing: 10,
                                runSpacing: 8,
                                crossAxisAlignment: WrapCrossAlignment.center,
                                children: [
                                  Text(
                                    '${vnd(selected.station.tariffVndPerKwh)}/kWh',
                                    style: text.titleMedium?.copyWith(
                                      color: PowerMeColors.gold,
                                    ),
                                  ),
                                  StatusBadge(
                                    selected.available > 0
                                        ? copy.text(
                                            '${selected.available} cổng trống',
                                            '${selected.available} available',
                                          )
                                        : copy.text(
                                            'Chưa có cổng trống',
                                            'No available connectors',
                                          ),
                                    color: selected.available > 0
                                        ? PowerMeColors.teal
                                        : PowerMeColors.gold,
                                  ),
                                  Text(
                                    '${selected.connectors} · ${selected.maxPowerW ~/ 1000} kW',
                                    style: text.bodyMedium,
                                  ),
                                ],
                              ),
                              const SizedBox(height: 16),
                              FilledButton.icon(
                                key: const Key('map-choose-connector'),
                                onPressed: () => sheet.animateTo(
                                  .88,
                                  duration: const Duration(milliseconds: 240),
                                  curve: Curves.easeOut,
                                ),
                                icon: const Icon(Icons.ev_station_outlined),
                                label: Text(
                                  copy.text(
                                    'Chọn cổng sạc',
                                    'Choose connector',
                                  ),
                                ),
                              ),
                              const SizedBox(height: 10),
                              if (mapConfig == null && !routeState.requested)
                                OutlinedButton.icon(
                                  key: const Key('preview-road-route'),
                                  onPressed: () {
                                    routeController.preview(
                                      selected.station.id,
                                    );
                                    if (sheet.isAttached) {
                                      sheet.animateTo(
                                        .44,
                                        duration: const Duration(
                                          milliseconds: 240,
                                        ),
                                        curve: Curves.easeOut,
                                      );
                                    }
                                  },
                                  icon: const Icon(Icons.alt_route_rounded),
                                  label: Text(
                                    copy.text('Xem đường đi', 'Preview route'),
                                  ),
                                ),
                              if (mapConfig != null) ...[
                                const SizedBox(height: 8),
                                Text(
                                  copy.text(
                                    'Chưa có tọa độ địa lý và lộ trình cho trạm này.',
                                    'Geographic coordinates and route are unavailable for this station.',
                                  ),
                                ),
                              ] else if (routeState.loading) ...[
                                const SizedBox(height: 8),
                                const LinearProgressIndicator(),
                              ] else if (routeState.route != null) ...[
                                const SizedBox(height: 12),
                                RouteSummary(
                                  route: routeState.route!,
                                  compact: true,
                                  copy: copy,
                                ),
                              ] else if (routeState.requested)
                                FailureNotice(
                                  copy.text(
                                    'Chưa có lộ trình đường bộ cho trạm này. Bạn có thể xem thông tin trạm hoặc chọn trạm khác.',
                                    'Road route is unavailable for this station. You can view station details or choose another station.',
                                  ),
                                ),
                              FailureNotice(routeState.error),
                              const SizedBox(height: 20),
                              Text(
                                copy.text(
                                  'Chọn cổng tại trạm',
                                  'Select connector at station',
                                ),
                                style: text.titleMedium,
                              ),
                              const SizedBox(height: 8),
                              for (final connector
                                  in selected.station.connectors)
                                _MapConnector(
                                  station: selected.station,
                                  connector: connector,
                                  copy: copy,
                                  eligible:
                                      (!selected.station.vinfastOnly ||
                                          profile.isVinFast) &&
                                      profile.compatibleConnectors.contains(
                                        connector.type,
                                      ) &&
                                      connector.status ==
                                          StationStatus.available &&
                                      connector.quality == DataQuality.observed,
                                ),
                              const SizedBox(height: 8),
                              Text(
                                updatedLabel(selected.updatedAt, copy),
                                style: text.bodySmall?.copyWith(
                                  color: PowerMeColors.muted,
                                ),
                              ),
                              if (selected.stale) ...[
                                const SizedBox(height: 6),
                                Text(
                                  copy.text(
                                    'Dữ liệu trạm cần cập nhật',
                                    'Station data needs updating',
                                  ),
                                  style: const TextStyle(
                                    color: PowerMeColors.gold,
                                  ),
                                ),
                              ],
                              const SizedBox(height: 14),
                              OutlinedButton(
                                key: const Key('map-station-detail'),
                                onPressed: () => context.push(
                                  '/station/${selected.station.id}',
                                ),
                                child: Text(
                                  copy.text(
                                    'Chi tiết trạm · chọn cổng',
                                    'Station details · connectors',
                                  ),
                                ),
                              ),
                              const SizedBox(height: 6),
                              TextButton(
                                onPressed: () =>
                                    context.push('/suggestions?mode=nearest'),
                                child: Text(
                                  copy.text(
                                    'Gợi ý trạm khác phù hợp pin',
                                    'Suggest other battery-compatible stations',
                                  ),
                                ),
                              ),
                            ] else ...[
                              Row(
                                children: [
                                  Expanded(
                                    child: Text(
                                      copy.text(
                                        'Trạm quanh bạn',
                                        'Stations around you',
                                      ),
                                      style: text.titleLarge,
                                    ),
                                  ),
                                  IconButton(
                                    key: const Key('jump-to-stations'),
                                    tooltip: copy.text(
                                      'Xem danh sách trạm',
                                      'View station list',
                                    ),
                                    onPressed: expandList,
                                    icon: const Icon(
                                      Icons.list_alt_rounded,
                                      color: PowerMeColors.gold,
                                    ),
                                  ),
                                ],
                              ),
                              if (profile.selectedVehicle == null) ...[
                                const SizedBox(height: 10),
                                FilledButton.icon(
                                  onPressed: () =>
                                      context.push('/vehicles/new'),
                                  icon: const Icon(Icons.add_rounded),
                                  label: Text(
                                    copy.text('Thêm xe', 'Add vehicle'),
                                  ),
                                ),
                                const SizedBox(height: 10),
                              ],
                              const SizedBox(height: 4),
                              Text(
                                copy.text(
                                  'Tìm nơi sạc tiếp theo',
                                  'Find your next charge',
                                ),
                                style: text.bodyMedium?.copyWith(
                                  color: PowerMeColors.muted,
                                ),
                              ),
                              const SizedBox(height: 14),
                              FilledButton.icon(
                                key: const Key('nearest-station-suggestions'),
                                onPressed: () =>
                                    context.push('/suggestions?mode=nearest'),
                                icon: const Icon(Icons.near_me_outlined),
                                label: Text(
                                  copy.text(
                                    'Gợi ý trạm gần phù hợp',
                                    'Suggest nearby stations',
                                  ),
                                ),
                              ),
                              const SizedBox(height: 10),
                              Text(
                                copy.text(
                                  'Xét đường bộ, giao thông và mức pin của xe.',
                                  'Considers road distance, traffic, and vehicle battery.',
                                ),
                                style: text.bodyMedium?.copyWith(
                                  color: PowerMeColors.muted,
                                ),
                              ),
                              const SizedBox(height: 16),
                              Wrap(
                                spacing: 10,
                                runSpacing: 10,
                                children: [
                                  OutlinedButton.icon(
                                    onPressed: () => context.go('/scan'),
                                    icon: const Icon(
                                      Icons.qr_code_scanner_rounded,
                                    ),
                                    label: Text(
                                      copy.text('Mã cổng', 'Charger code'),
                                    ),
                                  ),
                                  // OutlinedButton.icon(
                                  //   key: const Key('quick-reserve'),
                                  //   onPressed: () => context.push('/reserve'),
                                  //   icon: const Icon(
                                  //     Icons.bookmark_border_rounded,
                                  //   ),
                                  //   label: Text(
                                  //     copy.text('Giữ chỗ', 'Reserve'),
                                  //   ),
                                  // ),
                                  OutlinedButton.icon(
                                    onPressed: () => context.push('/credit'),
                                    icon: const Icon(
                                      Icons.account_balance_wallet_outlined,
                                    ),
                                    label: Text(
                                      copy.text(
                                        'Tín dụng sạc',
                                        'Charging credit',
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 24),
                              Text(
                                copy.text('Trạm sạc', 'Charging stations'),
                                style: text.titleLarge,
                              ),
                              const SizedBox(height: 14),
                              if (state.loading)
                                const LinearProgressIndicator()
                              else if (state.failed) ...[
                                FailureNotice(
                                  copy.text(
                                    'Chưa tải được trạm sạc',
                                    'Could not load stations',
                                  ),
                                ),
                                TextButton(
                                  onPressed: () => controller.find(
                                    profile.vehicleId,
                                    search.text,
                                  ),
                                  child: Text(copy.text('Thử lại', 'Retry')),
                                ),
                              ] else if (state.listings.isEmpty) ...[
                                Text(
                                  copy.text(
                                    'Không có trạm phù hợp',
                                    'No matching stations',
                                  ),
                                  style: text.titleMedium,
                                ),
                                const SizedBox(height: 8),
                                TextButton(
                                  onPressed: () {
                                    search.clear();
                                    controller.clear();
                                  },
                                  child: Text(
                                    copy.text('Xóa bộ lọc', 'Clear filters'),
                                  ),
                                ),
                              ] else
                                for (final listing in state.listings) ...[
                                  _StationCard(listing: listing, copy: copy),
                                  const SizedBox(height: 14),
                                ],
                            ],
                          ],
                        ),
                      ),
                    ),
                  ],
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _MapConnector extends StatelessWidget {
  const _MapConnector({
    required this.station,
    required this.connector,
    required this.copy,
    required this.eligible,
  });
  final Station station;
  final StationConnector connector;
  final AppCopy copy;
  final bool eligible;
  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.only(bottom: 12),
    padding: const EdgeInsets.all(16),
    decoration: BoxDecoration(
      color: PowerMeColors.black,
      borderRadius: BorderRadius.circular(14),
      border: Border.all(
        color: eligible
            ? PowerMeColors.teal.withValues(alpha: .42)
            : PowerMeColors.outline.withValues(alpha: .48),
      ),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Wrap(
          spacing: 12,
          runSpacing: 8,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text(
              '${copy.text('Cổng', 'Connector')} ${connector.number.toString().padLeft(2, '0')} · ${connector.type}',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            StatusBadge(
              statusLabel(connector.status, copy),
              color: eligible ? PowerMeColors.teal : PowerMeColors.gold,
            ),
          ],
        ),
        const SizedBox(height: 10),
        Text(
          '${connector.powerW ~/ 1000} kW · ${vnd(station.tariffVndPerKwh)}/kWh',
          style: const TextStyle(
            color: PowerMeColors.muted,
            fontFeatures: [FontFeature.tabularFigures()],
          ),
        ),
        if (connector.quality != DataQuality.observed) ...[
          const SizedBox(height: 8),
          Text(
            copy.text('Trạng thái cần cập nhật', 'Status needs updating'),
            style: const TextStyle(color: PowerMeColors.gold),
          ),
        ],
        const SizedBox(height: 14),
        FilledButton(
          key: Key('map-start-${station.id}/${connector.number}'),
          onPressed: eligible
              ? () => context.push(
                  connectorRoute('/start', '${station.id}/${connector.number}'),
                )
              : null,
          child: Text(
            eligible
                ? copy.text('Bắt đầu sạc', 'Start charging')
                : statusLabel(connector.status, copy),
          ),
        ),
      ],
    ),
  );
}

class _MapChip extends StatelessWidget {
  const _MapChip({
    super.key,
    required this.icon,
    required this.label,
    required this.onTap,
  });
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Material(
    color: PowerMeColors.graphite,
    elevation: 4,
    shape: StadiumBorder(
      side: BorderSide(color: PowerMeColors.outline.withValues(alpha: .55)),
    ),
    child: InkWell(
      customBorder: const StadiumBorder(),
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 18, color: PowerMeColors.gold),
            const SizedBox(width: 7),
            Flexible(
              child: Text(
                label,
                style: Theme.of(context).textTheme.labelMedium?.copyWith(
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

class _MapControl extends StatelessWidget {
  const _MapControl({
    required this.icon,
    required this.label,
    required this.onTap,
  });
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Material(
    color: PowerMeColors.graphite,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(14),
      side: BorderSide(color: PowerMeColors.outline.withValues(alpha: .4)),
    ),
    child: IconButton(
      tooltip: label,
      onPressed: onTap,
      icon: Icon(icon, color: PowerMeColors.text),
    ),
  );
}

class RouteSummary extends StatelessWidget {
  const RouteSummary({
    super.key,
    required this.route,
    this.compact = false,
    this.copy = const AppCopy(AppLanguage.vietnamese),
  });
  final bool compact;
  final RoadRoute route;
  final AppCopy copy;
  @override
  Widget build(BuildContext context) {
    final style = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Wrap(
          spacing: 12,
          runSpacing: 8,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text(
              minutes(route.travelSeconds),
              style: style.headlineMedium?.copyWith(
                color: PowerMeColors.teal,
                fontWeight: FontWeight.w800,
              ),
            ),
            Text(
              copy.text(
                '${(route.distanceM / 1000).toStringAsFixed(1)} km · đường bộ',
                '${(route.distanceM / 1000).toStringAsFixed(1)} km · road route',
              ),
              style: style.titleMedium,
            ),
          ],
        ),
        const SizedBox(height: 10),
        Wrap(
          spacing: 12,
          runSpacing: 8,
          children: [
            StatusBadge(
              switch (route.traffic) {
                TrafficLevel.clear => copy.text(
                  'Thông thoáng',
                  'Clear traffic',
                ),
                TrafficLevel.slow => copy.text(
                  'Có đoạn đi chậm',
                  'Slow traffic ahead',
                ),
                TrafficLevel.unknown => copy.text(
                  'Giao thông chưa rõ',
                  'Traffic unknown',
                ),
              },
              color: route.traffic == TrafficLevel.slow
                  ? PowerMeColors.gold
                  : PowerMeColors.teal,
            ),
            if (route.trafficDelaySeconds case final seconds?)
              Text(
                copy.text(
                  'Giao thông +${minutes(seconds)}',
                  'Traffic +${minutes(seconds)}',
                ),
                style: style.bodyMedium,
              ),
          ],
        ),
        const SizedBox(height: 10),
        Text(
          switch (route.reachability) {
            RouteReachability.insufficient => copy.text(
              'Pin có thể không đủ để đến trạm',
              'Battery may be insufficient to reach station',
            ),
            RouteReachability.unknown => copy.text(
              'Chưa xác định pin khi đến · nhập pin trong Gợi ý',
              'Arrival battery unknown · enter battery in Suggestions',
            ),
            RouteReachability.reachable => copy.text(
              'Pin dự kiến khi đến: ${route.batteryAtArrivalPercent}%',
              'Estimated arrival battery: ${route.batteryAtArrivalPercent}%',
            ),
          },
          style: TextStyle(
            color: route.reachability == RouteReachability.insufficient
                ? PowerMeColors.gold
                : PowerMeColors.text,
          ),
        ),
        if (!compact && route.via.isNotEmpty) ...[
          const SizedBox(height: 8),
          Text(
            copy.text('Qua ${route.via}', 'Via ${route.via}'),
            style: style.bodyMedium?.copyWith(color: PowerMeColors.muted),
          ),
        ],
        if (!compact) const SizedBox(height: 8),
        if (!compact)
          Text(
            copy.text(
              'Tuyến đường ước tính · ${ict(route.updatedAt)}',
              'Estimated route · ${ict(route.updatedAt)}',
            ),
            style: style.bodySmall?.copyWith(color: PowerMeColors.muted),
          ),
      ],
    );
  }
}

class _StationCard extends StatelessWidget {
  const _StationCard({required this.listing, required this.copy});
  final StationListing listing;
  final AppCopy copy;
  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final station = listing.station;
    return Card(
      child: InkWell(
        key: Key(station.id),
        borderRadius: BorderRadius.circular(14),
        onTap: () => context.push('/station/${station.id}'),
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(
                    width: 42,
                    height: 42,
                    alignment: Alignment.center,
                    child: const ChargingMark(
                      size: 38,
                      backgroundColor: PowerMeColors.graphite,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(station.name, style: text.titleMedium),
                        const SizedBox(height: 4),
                        Text(
                          station.address,
                          style: text.bodyMedium?.copyWith(
                            color: PowerMeColors.muted,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  const Icon(
                    Icons.chevron_right_rounded,
                    size: 22,
                    color: PowerMeColors.muted,
                  ),
                ],
              ),
              const SizedBox(height: 14),
              const Divider(height: 1),
              const SizedBox(height: 14),
              Wrap(
                spacing: 12,
                runSpacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  if (station.tariffVndPerKwh != null)
                    Text(
                      '${vnd(station.tariffVndPerKwh)}/kWh',
                      style: text.labelLarge?.copyWith(
                        color: PowerMeColors.gold,
                        fontWeight: FontWeight.w700,
                        fontFeatures: const [FontFeature.tabularFigures()],
                      ),
                    ),
                  Text(
                    '${listing.connectors} · ${listing.maxPowerW ~/ 1000} kW',
                    style: text.labelLarge?.copyWith(
                      fontFeatures: const [FontFeature.tabularFigures()],
                    ),
                  ),
                  StatusBadge(
                    listing.available > 0
                        ? copy.text(
                            '${listing.available} cổng trống',
                            '${listing.available} available',
                          )
                        : copy.text(
                            'Chưa có cổng trống',
                            'No available connectors',
                          ),
                    color: listing.available > 0
                        ? PowerMeColors.teal
                        : PowerMeColors.muted,
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Text(
                updatedLabel(listing.updatedAt, copy),
                style: text.bodySmall?.copyWith(color: PowerMeColors.muted),
              ),
              if (listing.stale) ...[
                const SizedBox(height: 8),
                Text(
                  copy.text('Trạng thái cần cập nhật', 'Status needs updating'),
                  style: text.bodyMedium?.copyWith(color: PowerMeColors.gold),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
