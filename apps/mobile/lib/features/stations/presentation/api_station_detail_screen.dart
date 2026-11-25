import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/app_copy.dart';
import '../../../core/api/driver_api_values.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/flow_page.dart';
import '../../support/application/connector_fault_report_controller.dart';
import '../application/station_discovery_controller.dart';
import '../domain/map_location.dart';
import '../domain/station_discovery.dart';
import '../domain/station.dart';
import 'api_discovery_components.dart';
import 'discovery_origin_panel.dart';
import 'inline_station_road.dart';
import 'road_format.dart';
import 'station_copy.dart';

class ApiStationDetailScreen extends ConsumerWidget {
  const ApiStationDetailScreen({super.key, required this.id});

  final String id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final vehicle = ref.watch(discoveryVehicleProvider);
    final copy = ref.watch(discoveryCopyProvider);
    final station = ref.watch(selectedDiscoveryStationProvider);
    final selected = station?.id == id ? station : null;
    final destination = selected?.location;
    final session = ref.watch(discoverySessionProvider);
    final reported = ref.watch(reportedSelectedConnectorsProvider);
    return DiscoveryPage(
      title: copy.text('Chi tiết trạm', 'Station details'),
      copy: copy,
      backLocation: '/discover',
      children: [
        if (vehicle.isEmpty)
          const DiscoveryVehicleRequired()
        else if (selected == null)
          InfoCard(
            children: [
              Text(
                copy.text(
                  'Hãy chọn trạm từ kết quả tìm kiếm hoặc gợi ý.',
                  'Select a station from search or suggestions.',
                ),
              ),
              FilledButton(
                onPressed: () => context.go('/discover'),
                child: Text(copy.text('Tìm trạm', 'Find stations')),
              ),
            ],
          )
        else ...[
          HeroCard(
            accent: PowerMeColors.gold,
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                DiscoveryStationTitle(station: selected, copy: copy),
                const SizedBox(height: 12),
                Wrap(
                  spacing: 10,
                  runSpacing: 8,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    AvailablePortsBadge(selected, copy),
                    Text(selected.operatorName),
                  ],
                ),
                if (selected.vinfastOnly) ...[
                  const SizedBox(height: 8),
                  Text(
                    copy.text(
                      'Trạm chỉ dành cho VinFast',
                      'VinFast-only station',
                    ),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: 16),
          FilledButton.icon(
            key: const Key('station-scan-qr'),
            onPressed: () => context.go('/scan'),
            icon: const Icon(Icons.qr_code_scanner_rounded),
            label: Text(
              copy.text('Quét QR tại trạm', 'Scan QR at the station'),
              textAlign: TextAlign.center,
            ),
          ),
          const SizedBox(height: 12),
          if (destination != null &&
              destination.valid &&
              !kIsWeb &&
              (defaultTargetPlatform == TargetPlatform.android ||
                  defaultTargetPlatform == TargetPlatform.iOS)) ...[
            _StationMapsButton(
              key: ValueKey((vehicle, id, destination)),
              destination: destination,
              copy: copy,
            ),
            const SizedBox(height: 12),
          ],
          _StationRoutePanel(key: ValueKey((vehicle, id)), station: selected),
          const SizedBox(height: 8),
          DiscoveryHeading(
            copy.text('Cổng tương thích', 'Compatible connectors'),
            Icons.ev_station_outlined,
          ),
          const SizedBox(height: 12),
          for (final connector in selected.connectors)
            InfoCard(
              key: ValueKey(connector.id),
              children: [
                Text(
                  connectorLabel(connector, copy),
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w700,
                  ),
                ),
                Wrap(
                  spacing: 10,
                  runSpacing: 8,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    StatusBadge(
                      statusLabel(connector.status, copy),
                      color: discoveryStatusColor(connector),
                    ),
                    Text(
                      '${connector.type} · ${connectorPower(connector, copy)}',
                    ),
                  ],
                ),
                if (availabilityUnconfirmed(connector))
                  Text(
                    unconfirmedAvailabilityLabel(connector.availableNow, copy),
                  ),
                if (connector.quality != DataQuality.observed)
                  Text(
                    connector.quality == DataQuality.stale
                        ? copy.text('Dữ liệu có thể đã cũ', 'Data may be stale')
                        : copy.text('Chưa rõ độ mới', 'Freshness unknown'),
                  ),
                Text(
                  updatedLabel(connector.updatedAt, copy),
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                if (reported.contains(connector.id))
                  Text(copy.text('Cổng đã được báo lỗi', 'Reported issue')),
                if (isDriverApiId(connector.id))
                  OutlinedButton(
                    key: ValueKey(('report-connector', connector.id)),
                    onPressed: () => context.push(
                      '/connector-report',
                      extra: FaultReportTarget(
                        session: session,
                        connectorId: connector.id!,
                        label: [
                          selected.name,
                          connectorLabel(connector, copy),
                        ].join(' · '),
                        stationId: selected.id,
                      ),
                    ),
                    child: Text(
                      copy.text('Báo lỗi cổng sạc', 'Report connector issue'),
                      textAlign: TextAlign.center,
                    ),
                  ),
              ],
            ),
        ],
      ],
    );
  }
}

class _StationMapsButton extends StatefulWidget {
  const _StationMapsButton({
    super.key,
    required this.destination,
    required this.copy,
  });

  final MapLocation destination;
  final AppCopy copy;

  @override
  State<_StationMapsButton> createState() => _StationMapsButtonState();
}

class _StationMapsButtonState extends State<_StationMapsButton> {
  static const _channel = MethodChannel('powerme/station_maps');
  bool _opening = false;
  bool _failed = false;

  Future<void> _open() async {
    if (_opening) return;
    setState(() {
      _opening = true;
      _failed = false;
    });
    bool opened;
    try {
      opened =
          await _channel.invokeMethod<bool>('openDestination', {
            'latitude': widget.destination.latitude,
            'longitude': widget.destination.longitude,
          }) ??
          false;
    } on PlatformException {
      opened = false;
    } on MissingPluginException {
      opened = false;
    }
    if (!mounted) return;
    setState(() {
      _opening = false;
      _failed = !opened;
    });
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      OutlinedButton.icon(
        key: const Key('open-station-maps'),
        onPressed: _opening ? null : _open,
        icon: const Icon(Icons.open_in_new),
        label: Text(widget.copy.text('Mở ứng dụng bản đồ', 'Open map app')),
      ),
      if (_failed)
        Semantics(
          liveRegion: true,
          child: Text(
            widget.copy.text(
              'Không mở được ứng dụng bản đồ.',
              'Could not open the map app.',
            ),
          ),
        ),
    ],
  );
}

class _StationRoutePanel extends ConsumerStatefulWidget {
  const _StationRoutePanel({super.key, required this.station});
  final Station station;

  @override
  ConsumerState<_StationRoutePanel> createState() => _StationRoutePanelState();
}

class _StationRoutePanelState extends ConsumerState<_StationRoutePanel> {
  DiscoveryRoads? _controller;
  SelectedRoute? _requested;

  @override
  void dispose() {
    if (_requested != null) _controller?.stop(_requested);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final copy = ref.watch(discoveryCopyProvider);
    final discovery = ref.watch(discoveryContextProvider);
    final origin = discovery.origin;
    final input = ref.watch(selectedRoadInputProvider(widget.station.id));
    final roads = ref.watch(discoveryRoadsProvider);
    final loading =
        input != null && roads.active == input && input == _requested;
    final failed =
        input != null && roads.failed == input && input == _requested;
    void request(SelectedRoute input) {
      _requested = input;
      final controller = ref.read(discoveryRoadsProvider.notifier);
      _controller = controller;
      controller.request(input, consentToVietmap: true);
    }

    final originPicker = ExpansionTile(
      title: Text(copy.text('Điểm đi', 'Starting point')),
      tilePadding: EdgeInsets.zero,
      maintainState: true,
      children: const [DiscoveryOriginPanel()],
    );
    final routeValue = cachedRoad(roads, input);
    if (routeValue != null) {
      return Padding(
        padding: const EdgeInsets.only(bottom: 16),
        child: Column(
          key: const Key('station-route-preview'),
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            RouteMapPreview(
              key: ValueKey(input),
              station: widget.station,
              origin: origin?.location,
              route: routeValue,
              copy: copy,
            ),
            const SizedBox(height: 12),
            HeroCard(
              padding: const EdgeInsets.all(14),
              child: _RouteSummary(routeValue, copy),
            ),
            originPicker,
          ],
        ),
      );
    }
    return InfoCard(
      children: [
        DiscoveryHeading(
          copy.text('Đường đến trạm', 'Route to station'),
          Icons.route_outlined,
        ),
        if (input == null)
          Text(
            copy.text(
              'Chọn điểm đi để xem đường đến trạm.',
              'Choose a starting point to see directions.',
            ),
          )
        else ...[
          Text(
            origin!.address ?? copy.text('Vị trí hiện tại', 'Current location'),
          ),
          Text(roadDisclosure(copy)),
          if (!loading && !failed)
            FilledButton.icon(
              key: const Key('request-station-route'),
              onPressed: roads.active == null ? () => request(input) : null,
              icon: const Icon(Icons.directions_outlined),
              label: Text(copy.text('Xem đường đi', 'Get directions')),
            ),
        ],
        originPicker,
        if (loading) const LinearProgressIndicator(),
        if (failed)
          DiscoveryRetry(
            message: roadError(roads.error, copy),
            copy: copy,
            retry: canRetryDiscovery(roads.error) ? () => request(input) : null,
          ),
      ],
    );
  }
}

class _RouteSummary extends StatelessWidget {
  const _RouteSummary(this.route, this.copy);
  final StationRoadRoute route;
  final AppCopy copy;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      MetricGrid(
        items: [
          MetricItem(
            copy.text('Quãng đường bộ', 'Road distance'),
            roadDistance(route.distanceM, copy),
            Icons.route_outlined,
          ),
          MetricItem(
            copy.text('Thời gian ước tính', 'Estimated travel time'),
            roadTravelTime(route.durationSeconds, copy),
            Icons.schedule,
          ),
        ],
      ),
      const SizedBox(height: 12),
      Text(updatedLabel(route.computedAt, copy)),
    ],
  );
}
