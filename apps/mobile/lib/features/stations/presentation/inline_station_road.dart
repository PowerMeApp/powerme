import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/l10n/app_copy.dart';
import '../../../core/widgets/flow_page.dart';
import '../application/station_discovery_controller.dart';
import '../domain/station.dart';
import '../domain/station_discovery.dart';
import 'api_discovery_components.dart';
import 'discovery_origin_panel.dart';
import 'road_format.dart';

String roadDisclosure(AppCopy copy) => copy.text(
  'PowerMe gửi điểm đi tới Vietmap để tính tuyến đường.',
  'PowerMe sends your starting point to Vietmap to calculate the route.',
);

class InlineStationRoad extends ConsumerStatefulWidget {
  const InlineStationRoad({
    super.key,
    required this.station,
    required this.copy,
    this.estimate,
  });

  final Station station;
  final AppCopy copy;
  final StationRoadEstimate? estimate;

  @override
  ConsumerState<InlineStationRoad> createState() => _InlineStationRoadState();
}

class _InlineStationRoadState extends ConsumerState<InlineStationRoad> {
  DiscoveryRoads? _controller;
  SelectedRoute? _requested;

  @override
  void dispose() {
    if (_requested != null) _controller?.stop(_requested);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final copy = widget.copy;
    final station = widget.station;
    final input = ref.watch(selectedRoadInputProvider(station.id));
    final roads = ref.watch(discoveryRoadsProvider);
    final route = cachedRoad(roads, input);
    final estimate = widget.estimate;
    final distance = route?.distanceM ?? estimate?.distanceM;
    final duration = route?.durationSeconds ?? estimate?.durationSeconds;
    if (input != null && distance != null && duration != null) {
      final km = roadDistance(distance, copy);
      final time = roadTravelTime(duration, copy);
      final congested = route == null
          ? estimate?.congestedDistanceM
          : route.congestedDistanceM;
      return Semantics(
        liveRegion: true,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              copy.text(
                '$km đường bộ · $time ước tính',
                '$km by road · $time estimated',
              ),
              style: Theme.of(context).textTheme.titleMedium,
            ),
            if (congested != null && congested > 0)
              Text(heavyTrafficDistance(congested, copy)),
          ],
        ),
      );
    }
    if (station.location == null) {
      return Text(
        copy.text(
          'Trạm chưa có tọa độ để tìm đường.',
          'This station has no coordinates for routing.',
        ),
        style: Theme.of(context).textTheme.bodySmall,
      );
    }
    if (input != null && roads.active == input) {
      return LinearProgressIndicator(
        semanticsLabel: copy.text('Đang tính tuyến đường', 'Calculating route'),
      );
    }
    final failed = input != null && roads.failed == input;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (failed) FailureNotice(roadError(roads.error, copy)),
        if (!failed || canRetryDiscovery(roads.error))
          TextButton.icon(
            key: ValueKey('station-road-${station.id}'),
            icon: const Icon(Icons.route_outlined),
            label: Text(
              input == null
                  ? copy.text(
                      'Chọn điểm đi để xem đường',
                      'Choose a starting point',
                    )
                  : copy.text(
                      'Xem quãng đường và thời gian',
                      'See road distance and time',
                    ),
            ),
            onPressed: roads.active != null
                ? null
                : () async {
                    if (input == null) {
                      showModalBottomSheet<void>(
                        context: context,
                        useSafeArea: true,
                        isScrollControlled: true,
                        builder: (context) => SingleChildScrollView(
                          padding: EdgeInsets.fromLTRB(
                            20,
                            20,
                            20,
                            20 + MediaQuery.viewInsetsOf(context).bottom,
                          ),
                          child: const DiscoveryOriginPanel(
                            closeAfterSelection: true,
                          ),
                        ),
                      );
                    } else {
                      final confirmed = await showDialog<bool>(
                        context: context,
                        builder: (dialogContext) => AlertDialog(
                          scrollable: true,
                          title: Text(
                            copy.text('Xem đường đến trạm', 'Route to station'),
                          ),
                          content: Text(roadDisclosure(copy)),
                          actions: [
                            TextButton(
                              onPressed: () => Navigator.pop(dialogContext),
                              child: Text(copy.text('Hủy', 'Cancel')),
                            ),
                            FilledButton(
                              key: const Key('confirm-inline-road'),
                              onPressed: () =>
                                  Navigator.pop(dialogContext, true),
                              child: Text(copy.text('Xem đường', 'View route')),
                            ),
                          ],
                        ),
                      );
                      if (!mounted ||
                          confirmed != true ||
                          input !=
                              ref.read(selectedRoadInputProvider(station.id))) {
                        return;
                      }
                      final controller = ref.read(
                        discoveryRoadsProvider.notifier,
                      );
                      _controller = controller;
                      _requested = input;
                      await controller.request(
                        input,
                        consentToVietmap: confirmed == true,
                      );
                      _requested = null;
                    }
                  },
          ),
      ],
    );
  }
}
