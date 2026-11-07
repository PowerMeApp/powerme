import 'package:flutter/material.dart';
import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/brand_mark.dart';
import '../../../core/widgets/flow_page.dart';
import '../../profile/domain/driver_profile.dart';
import '../application/stations_controller.dart';
import '../domain/station_route.dart';

class RoadMapCanvas extends StatelessWidget {
  const RoadMapCanvas({
    super.key,
    required this.scene,
    required this.listings,
    required this.transformation,
    required this.onSelect,
    this.selectedId,
    this.route,
    this.padding = EdgeInsets.zero,
    this.copy = const AppCopy(AppLanguage.vietnamese),
  });
  final RoadMapScene scene;
  final List<StationListing> listings;
  final TransformationController transformation;
  final ValueChanged<String> onSelect;
  final String? selectedId;
  final RoadRoute? route;
  final EdgeInsets padding;
  final AppCopy copy;

  @override
  Widget build(BuildContext context) => ClipRect(
    child: InteractiveViewer(
      key: const Key('discover-map'),
      transformationController: transformation,
      minScale: 1,
      maxScale: 2.5,
      child: LayoutBuilder(
        builder: (context, box) {
          final area = Rect.fromLTWH(
            32,
            padding.top + 12,
            (box.maxWidth - 64).clamp(1, double.infinity),
            (box.maxHeight - padding.top - padding.bottom - 32).clamp(
              1,
              double.infinity,
            ),
          );
          Offset position(MapPoint point) => Offset(
            area.left + point.x * area.width,
            area.top + point.y * area.height,
          );
          return Stack(
            children: [
              Positioned.fill(
                child: CustomPaint(
                  painter: _CityRoadPainter(
                    scene,
                    route,
                    area,
                    Theme.of(context).textTheme.bodySmall!,
                  ),
                ),
              ),
              if (scene.origin case final origin?)
                Positioned(
                  left: position(origin).dx - 24,
                  top: position(origin).dy - 24,
                  child: Semantics(
                    label: copy.text('Điểm xuất phát', 'Starting point'),
                    child: Container(
                      width: 48,
                      height: 48,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: PowerMeColors.teal.withValues(alpha: .14),
                        border: Border.all(
                          color: PowerMeColors.teal.withValues(alpha: .25),
                        ),
                      ),
                      child: const Icon(
                        Icons.navigation_rounded,
                        color: PowerMeColors.teal,
                        size: 24,
                      ),
                    ),
                  ),
                ),
              for (final listing in listings)
                Positioned(
                  left:
                      position(
                        MapPoint(listing.station.mapX, listing.station.mapY),
                      ).dx -
                      44,
                  top:
                      position(
                        MapPoint(listing.station.mapX, listing.station.mapY),
                      ).dy -
                      36,
                  width: 88,
                  child: Semantics(
                    label: copy.text(
                      '${listing.station.name}, ${listing.maxPowerW ~/ 1000} kW, ${listing.available} cổng trống${listing.stale ? ', cần cập nhật' : ''}',
                      '${listing.station.name}, ${listing.maxPowerW ~/ 1000} kW, ${listing.available} available${listing.stale ? ', needs updating' : ''}',
                    ),
                    button: true,
                    selected: selectedId == listing.station.id,
                    child: ExcludeSemantics(
                      child: Material(
                        color: Colors.transparent,
                        child: InkWell(
                          key: Key('pin-${listing.station.id}'),
                          borderRadius: BorderRadius.circular(16),
                          onTap: () => onSelect(listing.station.id),
                          child: Container(
                            constraints: const BoxConstraints(minHeight: 64),
                            child: Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Container(
                                  padding: const EdgeInsets.all(6),
                                  decoration: BoxDecoration(
                                    shape: BoxShape.circle,
                                    color: PowerMeColors.graphite,
                                    border: Border.all(
                                      color: selectedId == listing.station.id
                                          ? PowerMeColors.teal
                                          : PowerMeColors.gold,
                                      width: selectedId == listing.station.id
                                          ? 2
                                          : 1,
                                    ),
                                    boxShadow: [
                                      BoxShadow(
                                        color: PowerMeColors.gold.withValues(
                                          alpha: .12,
                                        ),
                                        blurRadius: 14,
                                      ),
                                    ],
                                  ),
                                  child: const ChargingMark(
                                    size: 28,
                                    backgroundColor: PowerMeColors.graphite,
                                  ),
                                ),
                                const SizedBox(height: 4),
                                Container(
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 7,
                                    vertical: 4,
                                  ),
                                  decoration: BoxDecoration(
                                    color: PowerMeColors.graphite,
                                    borderRadius: BorderRadius.circular(12),
                                  ),
                                  child: Text(
                                    listing.station.tariffVndPerKwh == null
                                        ? copy.text('Chưa có giá', 'No price')
                                        : '${vnd(listing.station.tariffVndPerKwh)}/kWh',
                                    textAlign: TextAlign.center,
                                    style: const TextStyle(
                                      fontSize: 10,
                                      fontWeight: FontWeight.w700,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          );
        },
      ),
    ),
  );
}

class _CityRoadPainter extends CustomPainter {
  _CityRoadPainter(this.scene, this.route, this.area, this.labelStyle);
  final TextStyle labelStyle;
  final RoadMapScene scene;
  final RoadRoute? route;
  final Rect area;
  Offset point(MapPoint p) =>
      Offset(area.left + p.x * area.width, area.top + p.y * area.height);
  Path line(List<MapPoint> points) {
    final path = Path();
    if (points.isNotEmpty) {
      path.moveTo(point(points.first).dx, point(points.first).dy);
      for (final p in points.skip(1)) {
        path.lineTo(point(p).dx, point(p).dy);
      }
    }
    return path;
  }

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = PowerMeColors.black);
    final block = Paint()..color = PowerMeColors.graphite;
    for (var row = 0; row < 8; row++) {
      for (var col = 0; col < 6; col++) {
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            Rect.fromLTWH(
              col * size.width / 6 + 5,
              row * size.height / 8 + 5,
              size.width / 6 - 11,
              size.height / 8 - 11,
            ),
            const Radius.circular(7),
          ),
          block,
        );
      }
    }
    final river = Path()
      ..moveTo(size.width * .76, 0)
      ..cubicTo(
        size.width * .58,
        size.height * .3,
        size.width,
        size.height * .5,
        size.width * .73,
        size.height,
      )
      ..lineTo(size.width * .82, size.height)
      ..cubicTo(
        size.width * 1.08,
        size.height * .5,
        size.width * .68,
        size.height * .3,
        size.width * .85,
        0,
      )
      ..close();
    canvas.drawPath(
      river,
      Paint()..color = PowerMeColors.teal.withValues(alpha: .075),
    );
    for (final road in scene.roads) {
      canvas.drawPath(
        line(road.points),
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeJoin = StrokeJoin.round
          ..strokeCap = StrokeCap.round
          ..strokeWidth = road.major ? 16 : 9
          ..color = PowerMeColors.outline.withValues(
            alpha: road.major ? .45 : .24,
          ),
      );
      canvas.drawPath(
        line(road.points),
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeJoin = StrokeJoin.round
          ..strokeWidth = road.major ? 12 : 6
          ..color = PowerMeColors.graphite,
      );
    }
    _label(canvas, 'BÌNH THẠNH', const MapPoint(.36, .1), 11);
    _label(canvas, 'QUẬN 1', const MapPoint(.12, .52), 12);
    _label(canvas, 'THẢO ĐIỀN', const MapPoint(.75, .27), 10);
    _label(canvas, 'Nguyễn Huệ', const MapPoint(.3, .82), 10);
    _label(canvas, 'Điện Biên Phủ', const MapPoint(.42, .39), 10);
    if (route case final road?) {
      canvas.drawPath(
        line(road.points),
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeJoin = StrokeJoin.round
          ..strokeCap = StrokeCap.round
          ..strokeWidth = 11
          ..color = PowerMeColors.black,
      );
      canvas.drawPath(
        line(road.points),
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeJoin = StrokeJoin.round
          ..strokeCap = StrokeCap.round
          ..strokeWidth = 6
          ..color = PowerMeColors.teal,
      );
      for (final segment in road.slowSegments) {
        canvas.drawPath(
          line(segment),
          Paint()
            ..style = PaintingStyle.stroke
            ..strokeJoin = StrokeJoin.round
            ..strokeCap = StrokeCap.round
            ..strokeWidth = 6
            ..color = PowerMeColors.gold,
        );
      }
    }
  }

  void _label(Canvas canvas, String text, MapPoint at, double fontSize) {
    final painter = TextPainter(
      text: TextSpan(
        text: text,
        style: labelStyle.copyWith(
          fontSize: fontSize,
          color: PowerMeColors.muted.withValues(alpha: .6),
          letterSpacing: .5,
        ),
      ),
      textDirection: TextDirection.ltr,
    )..layout();
    painter.paint(canvas, point(at) - Offset(painter.width / 2, 0));
  }

  @override
  bool shouldRepaint(_CityRoadPainter oldDelegate) =>
      oldDelegate.scene != scene ||
      oldDelegate.route != route ||
      oldDelegate.area != area ||
      oldDelegate.labelStyle != labelStyle;
}
