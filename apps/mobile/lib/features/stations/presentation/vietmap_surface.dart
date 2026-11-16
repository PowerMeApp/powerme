import 'dart:async';
import 'dart:math' show Point, min, max;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:vietmap_flutter_gl/vietmap_flutter_gl.dart';

import '../../../app/composition/vietmap_config.dart';
import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../profile/domain/driver_profile.dart';
import '../application/map_location_controller.dart';
import '../domain/map_location.dart';
import '../domain/station.dart';
import '../domain/station_discovery.dart';
import 'route_status.dart';

class VietmapSurface extends ConsumerStatefulWidget {
  const VietmapSurface({
    super.key,
    required this.config,
    required this.padding,
    this.stations = const [],
    this.selectedId,
    this.onSelect,
    this.fitResults = false,
    this.origin,
    this.routePoints = const [],
    this.trafficSegments = const [],
    this.maneuver,
    this.copy = const AppCopy(AppLanguage.vietnamese),
  });
  final VietmapConfig config;
  final EdgeInsets padding;
  final List<Station> stations;
  final String? selectedId;
  final ValueChanged<String>? onSelect;
  final bool fitResults;
  final MapLocation? origin;
  final List<MapLocation> routePoints;
  final List<RouteTrafficSegment> trafficSegments;
  final RouteManeuver? maneuver;
  final AppCopy copy;

  static bool get isSupported =>
      kIsWeb ||
      defaultTargetPlatform == TargetPlatform.android ||
      defaultTargetPlatform == TargetPlatform.iOS;

  @override
  ConsumerState<VietmapSurface> createState() => VietmapSurfaceState();
}

class VietmapSurfaceState extends ConsumerState<VietmapSurface> {
  VietmapController? _controller;
  Timer? _timeout;
  bool _ready = false;
  bool _failed = false;
  int _attempt = 0;
  int _styleEpoch = 0;
  Future<void> _pinQueue = Future.value();
  bool _contentDirty = false;
  final _maneuverImages = <IconData>{};
  RouteManeuver? _renderedManeuver;
  Symbol? _maneuverSymbol;

  @override
  void didUpdateWidget(covariant VietmapSurface oldWidget) {
    super.didUpdateWidget(oldWidget);
    final contentChanged =
        oldWidget.selectedId != widget.selectedId ||
        oldWidget.origin != widget.origin ||
        !listEquals(oldWidget.stations, widget.stations) ||
        !listEquals(oldWidget.routePoints, widget.routePoints) ||
        !listEquals(oldWidget.trafficSegments, widget.trafficSegments);
    if (contentChanged || oldWidget.maneuver != widget.maneuver) {
      _syncPins(contentChanged: contentChanged);
    }
  }

  void _onPinTapped(Symbol symbol) {
    final id = symbol.data?['stationId'];
    if (id is String && widget.stations.any((s) => s.id == id)) {
      widget.onSelect?.call(id);
    }
  }

  void _syncPins({bool loadImage = false, bool contentChanged = true}) {
    final controller = _controller;
    final epoch = _styleEpoch;
    if (!_ready || controller == null) return;
    _contentDirty |= contentChanged;
    bool current() =>
        mounted && controller == _controller && epoch == _styleEpoch;
    // Serialize native writes; stale style/filter work cannot restore old pins.
    _pinQueue = _pinQueue
        .then((_) async {
          if (!current()) return;
          if (loadImage) {
            _maneuverImages.clear();
            _renderedManeuver = null;
            _maneuverSymbol = null;
            final bytes = await rootBundle.load(
              'assets/brand/powerme-secondary-icon.png',
            );
            if (!current()) return;
            await controller.addImage(
              'powerme-charger',
              bytes.buffer.asUint8List(
                bytes.offsetInBytes,
                bytes.lengthInBytes,
              ),
            );
          }
          if (!current()) return;
          final redraw = _contentDirty;
          if (redraw) {
            _contentDirty = false;
            await _syncStations(controller, current);
            if (current() && widget.fitResults) {
              await _syncGeography(controller, current);
            }
          }
          if (current() && widget.fitResults) {
            await _syncManeuver(controller, current, redraw: redraw);
          }
        })
        .catchError((Object _) {
          if (current()) setState(() => _failed = true);
        });
  }

  LatLng _latLng(MapLocation point) => LatLng(point.latitude, point.longitude);

  Future<void> _syncStations(
    VietmapController controller,
    bool Function() current,
  ) async {
    final symbols = controller.symbols;
    if (symbols.isNotEmpty) await controller.removeSymbols(symbols);
    if (!current()) return;
    _maneuverSymbol = null;
    for (final station in widget.stations) {
      if (!current()) return;
      final point = station.location;
      if (point == null) continue;
      await controller.addSymbol(
        SymbolOptions(
          geometry: _latLng(point),
          iconImage: 'powerme-charger',
          iconSize: station.id == widget.selectedId ? .28 : .23,
          textField: station.name,
          textSize: 12,
          textOffset: const Offset(0, 2.5),
          textColor: station.id == widget.selectedId
              ? PowerMeColors.teal
              : PowerMeColors.gold,
          textHaloColor: PowerMeColors.black,
          textHaloWidth: 2,
          zIndex: 0,
        ),
        {'stationId': station.id},
      );
    }
  }

  Future<void> _syncGeography(
    VietmapController controller,
    bool Function() current,
  ) async {
    final origin = widget.origin;
    final route = widget.routePoints;
    final circles = controller.circles;
    if (circles.isNotEmpty) await controller.removeCircles(circles);
    if (!current()) return;
    if (origin != null) {
      await controller.addCircle(
        CircleOptions(
          geometry: _latLng(origin),
          circleRadius: 8,
          circleColor: PowerMeColors.teal,
          circleStrokeColor: PowerMeColors.graphite,
          circleStrokeWidth: 3,
        ),
      );
    }
    if (!current()) return;
    final lines = controller.lines;
    if (lines.isNotEmpty) await controller.removePolylines(lines);
    if (!current()) return;
    if (route.length >= 2) {
      final geometry = route.map(_latLng).toList(growable: false);
      await controller.addPolylines([
        PolylineOptions(
          geometry: geometry,
          polylineColor: PowerMeColors.black,
          polylineWidth: 11,
          polylineOpacity: 1,
          polylineJoin: 'round',
        ),
        for (final section in roadTrafficSections(
          route.length,
          widget.trafficSegments,
        ))
          PolylineOptions(
            geometry: geometry.sublist(section.start, section.end + 1),
            polylineColor: roadTrafficColor(section.level),
            polylineWidth: 7,
            polylineOpacity: 1,
            polylineJoin: 'round',
          ),
      ]);
    }
  }

  Future<void> _syncManeuver(
    VietmapController controller,
    bool Function() current, {
    required bool redraw,
  }) async {
    final maneuver = widget.maneuver;
    final previous = _renderedManeuver;
    if (!redraw && maneuver == previous) return;
    final symbol = _maneuverSymbol;
    if (symbol != null) await controller.removeSymbol(symbol);
    if (!current()) return;
    _maneuverSymbol = null;
    if (maneuver == null) {
      _renderedManeuver = null;
      await _fitResults(controller);
      return;
    }

    final icon = maneuver.icon;
    final imageName = 'powerme-maneuver-${icon.codePoint}';
    if (!_maneuverImages.contains(icon)) {
      final bytes = await _drawManeuverIcon(icon);
      if (!current()) return;
      if (_maneuverImages.isEmpty) {
        await controller.setSymbolIconAllowOverlap(true);
        if (!current()) return;
      }
      await controller.addImage(imageName, bytes);
      if (!current()) return;
      _maneuverImages.add(icon);
    }
    final next = await controller.addSymbol(
      SymbolOptions(
        geometry: _latLng(maneuver.point),
        iconImage: imageName,
        iconSize: 0.5,
        iconOpacity: 1,
        zIndex: 1,
      ),
    );
    if (!current()) return;
    _maneuverSymbol = next;
    _renderedManeuver = maneuver;
    if (widget.maneuver == maneuver &&
        (redraw || previous?.point != maneuver.point)) {
      await controller.animateCamera(
        CameraUpdate.newLatLngZoom(_latLng(maneuver.point), 16),
      );
    }
  }

  Future<void> _fitResults(VietmapController controller) async {
    final points = [
      ?widget.origin,
      for (final station in widget.stations) ?station.location,
      ...widget.routePoints,
    ];
    if (points.isEmpty) return;
    var south = points.first.latitude;
    var north = south;
    var west = points.first.longitude;
    var east = west;
    for (final point in points.skip(1)) {
      south = min(south, point.latitude);
      north = max(north, point.latitude);
      west = min(west, point.longitude);
      east = max(east, point.longitude);
    }
    await controller.animateCamera(
      south == north && west == east
          ? CameraUpdate.newLatLngZoom(_latLng(points.first), 15)
          : CameraUpdate.newLatLngBounds(
              LatLngBounds(
                southwest: LatLng(south, west),
                northeast: LatLng(north, east),
              ),
              left: 32,
              top: 32,
              right: 32,
              bottom: 32,
            ),
    );
  }

  @override
  void initState() {
    super.initState();
    _armTimeout();
  }

  void _armTimeout() {
    _timeout?.cancel();
    if (!widget.config.configured || !VietmapSurface.isSupported) return;
    _timeout = Timer(const Duration(seconds: 20), () {
      if (mounted && !_ready) setState(() => _failed = true);
    });
  }

  @override
  void dispose() {
    _timeout?.cancel();
    ++_styleEpoch;
    _controller?.onSymbolTapped.remove(_onPinTapped);
    // VietmapGL owns and disposes its native controller.
    super.dispose();
  }

  Future<void> zoomIn() async {
    if (!_ready) return;
    try {
      await _controller?.animateCamera(CameraUpdate.zoomIn());
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  void locate() => ref.read(mapLocationControllerProvider.notifier).locate();

  Future<void> _showLocation(MapLocation point) async {
    final controller = _controller;
    if (!_ready || controller == null) return;
    try {
      await controller.clearCircles();
      if (!mounted || controller != _controller) return;
      await controller.addCircle(
        CircleOptions(
          geometry: LatLng(point.latitude, point.longitude),
          circleRadius: 9,
          circleColor: PowerMeColors.teal,
          circleStrokeColor: PowerMeColors.graphite,
          circleStrokeWidth: 3,
        ),
      );
      if (!mounted || controller != _controller) return;
      await controller.animateCamera(
        CameraUpdate.newLatLngZoom(LatLng(point.latitude, point.longitude), 15),
      );
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final copy = widget.copy;
    if (!VietmapSurface.isSupported) {
      return Card(
        child: ListTile(
          leading: const Icon(Icons.map_outlined),
          title: Text(
            copy.text(
              'Bản đồ khả dụng trên Android và iOS.',
              'The map is available on Android and iOS.',
            ),
            style: Theme.of(context).textTheme.bodyMedium,
          ),
        ),
      );
    }
    final location = widget.fitResults
        ? const MapLocationState()
        : ref.watch(mapLocationControllerProvider);
    if (!widget.fitResults) {
      ref.listen(mapLocationControllerProvider, (previous, next) {
        if (next.position != null && next.position != previous?.position) {
          _showLocation(next.position!);
        }
      });
    }
    final center = widget.fitResults
        ? widget.routePoints.firstOrNull ??
              widget.origin ??
              widget.stations
                  .map((station) => station.location)
                  .nonNulls
                  .firstOrNull
        : vietmapInitialCenter;
    final missing = !widget.config.configured;
    final issue = switch (location.issue) {
      LocationIssue.serviceOff => copy.text(
        'Hãy bật dịch vụ vị trí. Bạn vẫn có thể di chuyển bản đồ.',
        'Please enable location services. You can still pan the map.',
      ),
      LocationIssue.denied => copy.text(
        'Chưa được cấp quyền vị trí. Bạn vẫn có thể tìm và chọn trạm.',
        'Location permission denied. You can still search and select stations.',
      ),
      LocationIssue.deniedForever => copy.text(
        'Quyền vị trí đang bị tắt. Bạn có thể bật lại trong Cài đặt ứng dụng.',
        'Location permission is disabled. You can re-enable it in App Settings.',
      ),
      LocationIssue.unavailable => copy.text(
        'Chưa lấy được vị trí. Hãy thử lại ở nơi có tín hiệu tốt hơn.',
        'Could not get your location. Please retry in an area with better signal.',
      ),
      null => null,
    };
    final attempt = _attempt;
    return Stack(
      children: [
        if (!missing)
          VietmapGL(
            key: ValueKey(_attempt),
            styleString: widget.config.styleUrl,
            initialCameraPosition: CameraPosition(
              target: _latLng(center ?? vietmapInitialCenter),
              zoom: center == null ? 13 : 16,
            ),
            compassEnabled: false,
            logoViewMargins: Point(12, widget.padding.bottom),
            attributionButtonMargins: Point(12, widget.padding.bottom),
            onMapCreated: (controller) {
              if (!mounted || attempt != _attempt) return;
              _controller?.onSymbolTapped.remove(_onPinTapped);
              _controller = controller;
              controller.onSymbolTapped.add(_onPinTapped);
            },
            onStyleLoadedCallback: () {
              if (!mounted || attempt != _attempt) return;
              _timeout?.cancel();
              setState(() {
                _ready = true;
                _failed = false;
              });
              ++_styleEpoch;
              _syncPins(loadImage: true);
              if (!widget.fitResults) {
                final point = ref.read(mapLocationControllerProvider).position;
                if (point != null) _showLocation(point);
              }
            },
          )
        else
          const ColoredBox(
            color: PowerMeColors.black,
            child: SizedBox.expand(),
          ),
        if (missing || _failed || !_ready || issue != null || location.busy)
          Positioned(
            top: widget.padding.top + 12,
            left: 20,
            right: 72,
            child: Semantics(
              liveRegion: true,
              child: Material(
                color: PowerMeColors.graphite,
                borderRadius: BorderRadius.circular(12),
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (!missing && !_ready && !_failed)
                        const LinearProgressIndicator(),
                      Text(
                        missing
                            ? copy.text(
                                'Chưa thể mở bản đồ.',
                                'Map could not be opened.',
                              )
                            : _failed
                            ? copy.text(
                                'Không tải được bản đồ. Kiểm tra kết nối hoặc quyền truy cập bản đồ.',
                                'Could not load the map. Check your connection or map access.',
                              )
                            : location.busy
                            ? copy.text('Đang lấy vị trí…', 'Locating…')
                            : issue ??
                                  copy.text('Đang tải bản đồ…', 'Loading map…'),
                      ),
                      if (_failed)
                        TextButton(
                          onPressed: () {
                            setState(() {
                              ++_attempt;
                              ++_styleEpoch;
                              _controller?.onSymbolTapped.remove(_onPinTapped);
                              _controller = null;
                              _ready = false;
                              _failed = false;
                            });
                            _armTimeout();
                          },
                          child: Text(copy.text('Thử lại', 'Retry')),
                        ),
                    ],
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

Future<Uint8List> _drawManeuverIcon(IconData icon) async {
  const size = 72;
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder);
  const center = Offset(size / 2, size / 2);
  canvas.drawRRect(
    RRect.fromRectAndRadius(
      Rect.fromCenter(center: center, width: 68, height: 68),
      const Radius.circular(18),
    ),
    Paint()..color = PowerMeColors.black,
  );
  canvas.drawRRect(
    RRect.fromRectAndRadius(
      Rect.fromCenter(center: center, width: 58, height: 58),
      const Radius.circular(13),
    ),
    Paint()..color = PowerMeColors.teal,
  );
  final glyph = TextPainter(
    text: TextSpan(
      text: String.fromCharCode(icon.codePoint),
      style: TextStyle(
        fontFamily: icon.fontFamily,
        package: icon.fontPackage,
        fontSize: 44,
        color: PowerMeColors.black,
      ),
    ),
    textDirection: TextDirection.ltr,
  )..layout();
  glyph.paint(canvas, center - Offset(glyph.width / 2, glyph.height / 2));
  glyph.dispose();
  final picture = recorder.endRecording();
  try {
    final image = await picture.toImage(size, size);
    try {
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      return bytes!.buffer.asUint8List(
        bytes.offsetInBytes,
        bytes.lengthInBytes,
      );
    } finally {
      image.dispose();
    }
  } finally {
    picture.dispose();
  }
}
