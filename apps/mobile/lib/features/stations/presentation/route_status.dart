import 'package:flutter/material.dart';

import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../domain/map_location.dart';
import '../domain/station_discovery.dart';
import 'road_format.dart';

typedef RouteManeuver = ({MapLocation point, IconData icon});

Color roadTrafficColor(RouteTraffic level) => switch (level) {
  RouteTraffic.low => PowerMeColors.teal,
  RouteTraffic.moderate => const Color(0xFFFFD443),
  RouteTraffic.heavy => const Color(0xFFFF4A45),
  RouteTraffic.severe => const Color(0xFFD92E40),
  RouteTraffic.unknown => const Color(0xFFA7B0BC),
};

String roadTrafficLabel(RouteTraffic level, AppCopy copy) => switch (level) {
  RouteTraffic.low => copy.text('Ít ùn tắc', 'Low congestion'),
  RouteTraffic.moderate => copy.text('Đi chậm', 'Moderate congestion'),
  RouteTraffic.heavy => copy.text('Ùn tắc nặng', 'Heavy congestion'),
  RouteTraffic.severe => copy.text('Ùn tắc nghiêm trọng', 'Severe congestion'),
  RouteTraffic.unknown => copy.text('Chưa có dữ liệu', 'Unknown traffic'),
};

class RouteTrafficLegend extends StatelessWidget {
  const RouteTrafficLegend({
    super.key,
    required this.route,
    required this.copy,
  });

  final StationRoadRoute route;
  final AppCopy copy;

  @override
  Widget build(BuildContext context) {
    final levels = roadTrafficSections(
      route.points.length,
      route.trafficSegments,
    ).map((section) => section.level).toSet();
    return Semantics(
      container: true,
      label: copy.text('Màu giao thông', 'Traffic colors'),
      child: Wrap(
        spacing: 12,
        runSpacing: 6,
        children: [
          for (final level in RouteTraffic.values.where(levels.contains))
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  width: 14,
                  height: 5,
                  decoration: BoxDecoration(
                    color: roadTrafficColor(level),
                    borderRadius: BorderRadius.circular(3),
                  ),
                ),
                const SizedBox(width: 6),
                Flexible(
                  child: Text(
                    roadTrafficLabel(level, copy),
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
              ],
            ),
        ],
      ),
    );
  }
}

(IconData, String) routeTurn(int sign, AppCopy copy) => switch (sign) {
  -3 => (Icons.turn_sharp_left, copy.text('Rẽ gấp trái', 'Turn sharply left')),
  -2 => (Icons.turn_left, copy.text('Rẽ trái', 'Turn left')),
  -1 => (Icons.turn_slight_left, copy.text('Chếch trái', 'Bear left')),
  0 => (Icons.straight, copy.text('Đi thẳng', 'Continue straight')),
  1 => (Icons.turn_slight_right, copy.text('Chếch phải', 'Bear right')),
  2 => (Icons.turn_right, copy.text('Rẽ phải', 'Turn right')),
  3 => (Icons.turn_sharp_right, copy.text('Rẽ gấp phải', 'Turn sharply right')),
  4 => (
    Icons.flag_outlined,
    copy.text('Đến điểm sạc', 'Arrive at the station'),
  ),
  5 => (
    Icons.place_outlined,
    copy.text('Đến điểm trung gian', 'Arrive at the waypoint'),
  ),
  6 => (
    Icons.roundabout_right,
    copy.text('Qua vòng xuyến', 'At the roundabout'),
  ),
  _ => (Icons.route_outlined, copy.text('Chặng đường', 'Route step')),
};

class RouteTurnBanner extends StatelessWidget {
  const RouteTurnBanner({
    super.key,
    required this.step,
    required this.index,
    required this.count,
    required this.copy,
  });

  final RouteInstruction step;
  final int index;
  final int count;
  final AppCopy copy;

  @override
  Widget build(BuildContext context) {
    final (icon, direction) = routeTurn(step.sign, copy);
    final detail = step.text;
    final street = step.streetName;
    final distance = step.distanceM;
    final styles = Theme.of(context).textTheme;
    return Semantics(
      liveRegion: true,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 32, color: PowerMeColors.teal),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  copy.text(
                    'Xem trước · Chặng ${index + 1}/$count',
                    'Preview · Step ${index + 1}/$count',
                  ),
                  style: styles.bodySmall,
                ),
                Text(direction, style: styles.titleMedium),
                if (street != null) Text(street, style: styles.bodyMedium),
                if (detail != null &&
                    detail.toLowerCase() != street?.toLowerCase() &&
                    detail.toLowerCase() != direction.toLowerCase())
                  Text(detail, style: styles.bodyMedium),
                if (index + 1 < count && distance != null && distance > 0)
                  Text(
                    copy.text(
                      '${roadDistance(distance, copy)} đến chỉ dẫn tiếp theo',
                      '${roadDistance(distance, copy)} to the next instruction',
                    ),
                    style: styles.bodySmall,
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
