import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/composition/vietmap_config.dart';
import '../../../core/api/driver_api_exception.dart';
import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/app_page.dart';
import '../../../core/widgets/brand_mark.dart';
import '../../../core/widgets/flow_page.dart';
import '../../profile/application/profile_controller.dart';
import '../application/station_discovery_controller.dart';
import '../domain/map_location.dart';
import '../domain/station.dart';
import '../domain/station_discovery.dart';
import 'route_status.dart';
import 'station_copy.dart';
import 'vietmap_surface.dart';

final discoveryCopyProvider = Provider<AppCopy>(
  (ref) => AppCopy(
    ref.watch(profileControllerProvider.select((p) => p.profile.language)),
  ),
);

class DiscoveryPage extends StatelessWidget {
  const DiscoveryPage({
    super.key,
    required this.title,
    required this.copy,
    required this.backLocation,
    required this.children,
    this.branded = false,
  });

  final String title;
  final String? backLocation;
  final AppCopy copy;
  final List<Widget> children;
  final bool branded;

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      toolbarHeight: 64,
      automaticallyImplyLeading: backLocation != null,
      leading: backLocation == null && !context.canPop()
          ? null
          : IconButton(
              tooltip: copy.text('Quay lại', 'Back'),
              onPressed: () =>
                  context.canPop() ? context.pop() : context.go(backLocation!),
              icon: const Icon(Icons.arrow_back_rounded),
            ),
      title: branded
          ? Semantics(label: title, child: const BrandMark())
          : Text(title, style: Theme.of(context).textTheme.titleLarge),
    ),
    body: AppPage(children: children),
  );
}

class DiscoveryHeading extends StatelessWidget {
  const DiscoveryHeading(this.label, this.icon, {super.key});

  final String label;
  final IconData icon;

  @override
  Widget build(BuildContext context) => Semantics(
    header: true,
    child: Row(
      children: [
        Icon(icon, color: PowerMeColors.teal, size: 21),
        const SizedBox(width: 10),
        Expanded(
          child: Text(label, style: Theme.of(context).textTheme.titleLarge),
        ),
      ],
    ),
  );
}

class DiscoveryStationTitle extends StatelessWidget {
  const DiscoveryStationTitle({
    super.key,
    required this.station,
    required this.copy,
    this.title,
    this.trailing,
    this.metadata,
  });

  final Station station;
  final AppCopy copy;
  final String? title;
  final Widget? trailing;
  final Widget? metadata;

  @override
  Widget build(BuildContext context) => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const ClipOval(
        child: ChargingMark(size: 38, backgroundColor: PowerMeColors.graphite),
      ),
      const SizedBox(width: 12),
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              title ?? station.name,
              style: Theme.of(
                context,
              ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 4),
            Text(
              stationAddress(station, copy),
              style: Theme.of(
                context,
              ).textTheme.bodyMedium?.copyWith(color: PowerMeColors.muted),
            ),
            if (metadata != null) ...[const SizedBox(height: 8), metadata!],
          ],
        ),
      ),
      if (trailing != null) ...[const SizedBox(width: 8), trailing!],
    ],
  );
}

class AvailablePortsBadge extends StatelessWidget {
  const AvailablePortsBadge(this.station, this.copy, {super.key});

  final Station station;
  final AppCopy copy;

  @override
  Widget build(BuildContext context) {
    final count = station.availableCount;
    return StatusBadge(
      copy.text('$count cổng khả dụng', '$count available connectors'),
      color: count > 0 ? PowerMeColors.teal : PowerMeColors.muted,
    );
  }
}

bool availabilityUnconfirmed(StationConnector connector) =>
    connector.status == StationStatus.available &&
    connector.availableNow != true;

String unconfirmedAvailabilityLabel(bool? availableNow, AppCopy copy) =>
    availableNow == false
    ? copy.text('Hiện chưa khả dụng', 'Not currently available')
    : copy.text('Chưa xác nhận khả dụng', 'Availability unconfirmed');

Color discoveryStatusColor(StationConnector connector) =>
    switch (connector.status) {
      StationStatus.available when connector.availableNow == true =>
        PowerMeColors.teal,
      StationStatus.inUse || StationStatus.freeingSoon => PowerMeColors.gold,
      _ => PowerMeColors.muted,
    };

class DiscoveryVehicleRequired extends ConsumerWidget {
  const DiscoveryVehicleRequired({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final profile = ref.watch(profileControllerProvider).profile;
    final copy = ref.watch(discoveryCopyProvider);
    final noVehicles = profile.vehicles.isEmpty;
    return InfoCard(
      children: [
        Text(
          noVehicles
              ? copy.text(
                  'Thêm xe để tìm trạm tương thích.',
                  'Add a vehicle to find compatible stations.',
                )
              : copy.text(
                  'Chọn xe mặc định để tìm trạm tương thích.',
                  'Select a default vehicle to find compatible stations.',
                ),
        ),
        FilledButton(
          key: const Key('discovery-vehicle-required'),
          onPressed: () {
            if (noVehicles) {
              context.push('/vehicles/new');
            } else {
              context.go('/profile');
            }
          },
          child: Text(
            noVehicles ? copy.text('Thêm xe', 'Add vehicle') : copy.profile,
          ),
        ),
      ],
    );
  }
}

class DiscoveryRetry extends StatelessWidget {
  const DiscoveryRetry({
    super.key,
    required this.message,
    required this.copy,
    required this.retry,
  });

  final String message;
  final AppCopy copy;
  final VoidCallback retry;

  @override
  Widget build(BuildContext context) => InfoCard(
    children: [
      FailureNotice(message),
      OutlinedButton(
        onPressed: retry,
        child: Text(copy.text('Thử lại', 'Retry')),
      ),
    ],
  );
}

class DiscoveryMap extends ConsumerWidget {
  const DiscoveryMap({
    super.key,
    required this.stations,
    this.origin,
    this.route = const [],
    this.trafficSegments = const [],
    this.maneuver,
    this.onSelect,
    this.height = 320,
  });

  final List<Station> stations;
  final MapLocation? origin;
  final List<MapLocation> route;
  final List<RouteTrafficSegment> trafficSegments;
  final RouteManeuver? maneuver;
  final ValueChanged<String>? onSelect;
  final double height;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final config = ref.watch(vietmapConfigProvider);
    final copy = ref.watch(discoveryCopyProvider);
    if (config == null || !config.configured) {
      return Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: [
              const Icon(Icons.map_outlined, color: PowerMeColors.muted),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  copy.text(
                    'Bản đồ hiện không khả dụng.',
                    'Map currently unavailable.',
                  ),
                ),
              ),
            ],
          ),
        ),
      );
    }
    return SizedBox(
      height: VietmapSurface.isSupported ? height : null,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(12),
        child: VietmapSurface(
          config: config,
          padding: EdgeInsets.zero,
          fitResults: true,
          stations: stations,
          origin: origin,
          routePoints: route,
          trafficSegments: trafficSegments,
          maneuver: maneuver,
          onSelect: onSelect,
          copy: copy,
        ),
      ),
    );
  }
}

class RouteMapPreview extends StatefulWidget {
  const RouteMapPreview({
    super.key,
    required this.route,
    required this.station,
    required this.origin,
    required this.copy,
  });

  final StationRoadRoute route;
  final Station station;
  final MapLocation? origin;
  final AppCopy copy;

  @override
  State<RouteMapPreview> createState() => _RouteMapPreviewState();
}

class _RouteMapPreviewState extends State<RouteMapPreview> {
  int? _stepIndex;

  @override
  void didUpdateWidget(covariant RouteMapPreview oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.route != widget.route || oldWidget.origin != widget.origin) {
      _stepIndex = null;
    }
  }

  @override
  Widget build(BuildContext context) {
    final route = widget.route;
    final copy = widget.copy;
    final steps = route.instructions;
    final index = _stepIndex;
    final step = index == null ? null : steps[index];
    final start = step?.startIndex;
    final maneuver =
        step != null &&
            start != null &&
            start >= 0 &&
            start < route.points.length &&
            route.points[start].valid
        ? (point: route.points[start], icon: routeTurn(step.sign, copy).$1)
        : null;
    return Material(
      key: const Key('route-map-frame'),
      color: PowerMeColors.graphite,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: const BorderSide(color: PowerMeColors.outline),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 8),
            child: step == null
                ? Text(
                    copy.text('Xem trước tuyến đường', 'Route preview'),
                    style: Theme.of(context).textTheme.titleMedium,
                  )
                : RouteTurnBanner(
                    step: step,
                    index: index!,
                    count: steps.length,
                    copy: copy,
                  ),
          ),
          DiscoveryMap(
            stations: [widget.station],
            origin: widget.origin,
            route: route.points,
            trafficSegments: route.trafficSegments,
            maneuver: maneuver,
            height: 300,
          ),
          Padding(
            padding: const EdgeInsets.all(12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                RouteTrafficLegend(route: route, copy: copy),
                const SizedBox(height: 8),
                if (index != null)
                  Wrap(
                    alignment: WrapAlignment.spaceBetween,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      OutlinedButton(
                        key: const Key('route-preview-previous'),
                        onPressed: index > 0
                            ? () => setState(() => _stepIndex = index - 1)
                            : null,
                        child: Text(copy.text('Chặng trước', 'Previous step')),
                      ),
                      OutlinedButton(
                        key: const Key('route-preview-next'),
                        onPressed: index + 1 < steps.length
                            ? () => setState(() => _stepIndex = index + 1)
                            : null,
                        child: Text(copy.text('Chặng tiếp', 'Next step')),
                      ),
                      TextButton(
                        key: const Key('route-preview-end'),
                        onPressed: () => setState(() => _stepIndex = null),
                        child: Text(copy.text('Kết thúc', 'End preview')),
                      ),
                    ],
                  )
                else if (steps.isNotEmpty)
                  FilledButton(
                    key: const Key('route-preview-start'),
                    onPressed: () => setState(() => _stepIndex = 0),
                    child: Text(
                      copy.text('Bắt đầu xem trước', 'Start route preview'),
                      textAlign: TextAlign.center,
                    ),
                  )
                else
                  Text(
                    copy.text(
                      'Chưa có chỉ dẫn từng chặng cho tuyến này.',
                      'Step-by-step directions are unavailable for this route.',
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

String roadError(Object? error, AppCopy copy) => switch (error) {
  DriverApiException(status: 429) => copy.text(
    'Dịch vụ bản đồ đang bận. Vui lòng thử lại sau.',
    'The map service is busy. Please try again later.',
  ),
  DriverApiException(code: 'station_location_unavailable') => copy.text(
    'Trạm chưa có tọa độ để tìm đường.',
    'This station has no coordinates for routing.',
  ),
  DriverApiException(status: 404) => copy.text(
    'Xe hoặc trạm không còn khả dụng.',
    'The vehicle or station is no longer available.',
  ),
  _ => copy.text(
    'Chưa lấy được dữ liệu bản đồ. Vui lòng thử lại.',
    'Map data could not be loaded. Please try again.',
  ),
};

String locationError(Object error, AppCopy copy) => switch (error) {
  LocationFailure(issue: LocationIssue.denied) => copy.text(
    'Bạn chưa cấp quyền vị trí. Bạn vẫn có thể tìm theo tên hoặc chọn địa chỉ.',
    'Location permission was denied. You can still search by name or select an address.',
  ),
  LocationFailure(issue: LocationIssue.deniedForever) => copy.text(
    'Quyền vị trí đã tắt. Hãy bật lại trong cài đặt hoặc chọn địa chỉ.',
    'Location permission is disabled. Enable it in Settings or select an address.',
  ),
  LocationFailure(issue: LocationIssue.serviceOff) => copy.text(
    'Hãy bật dịch vụ vị trí hoặc chọn địa chỉ.',
    'Enable location services or select an address.',
  ),
  _ => copy.text(
    'Chưa lấy được vị trí. Hãy thử lại hoặc chọn địa chỉ.',
    'Could not get your location. Try again or select an address.',
  ),
};

void openStation(BuildContext context, WidgetRef ref, Station station) {
  ref.read(selectedDiscoveryStationProvider.notifier).select(station);
  context.push('/station/${Uri.encodeComponent(station.id)}');
}
