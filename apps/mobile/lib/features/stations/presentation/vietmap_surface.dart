import 'dart:async';
import 'dart:math' show Point;
import 'package:flutter/services.dart';
import '../domain/station.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:vietmap_flutter_gl/vietmap_flutter_gl.dart';
import '../../../app/composition/vietmap_config.dart';
import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../profile/domain/driver_profile.dart';
import '../application/map_location_controller.dart';
import '../domain/map_location.dart';

class VietmapSurface extends ConsumerStatefulWidget {
  const VietmapSurface({
    super.key,
    required this.config,
    required this.padding,
    this.stations = const [],
    this.selectedId,
    this.onSelect,
    this.copy = const AppCopy(AppLanguage.vietnamese),
  });
  final VietmapConfig config;
  final EdgeInsets padding;
  final List<Station> stations;
  final String? selectedId;
  final ValueChanged<String>? onSelect;
  final AppCopy copy;
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

  @override
  void didUpdateWidget(covariant VietmapSurface oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.selectedId != widget.selectedId ||
        !listEquals(oldWidget.stations, widget.stations)) {
      _syncPins();
    }
  }

  void _onPinTapped(Symbol symbol) {
    final id = symbol.data?['stationId'];
    if (id is String && widget.stations.any((s) => s.id == id)) {
      widget.onSelect?.call(id);
    }
  }

  void _syncPins({bool loadImage = false}) {
    final controller = _controller;
    final epoch = _styleEpoch;
    if (!_ready || controller == null) return;
    bool current() =>
        mounted && controller == _controller && epoch == _styleEpoch;
    // Serialize native writes; stale style/filter work cannot restore old pins.
    _pinQueue = _pinQueue
        .then((_) async {
          if (!current()) return;
          if (loadImage) {
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
          await controller.clearSymbols();
          for (final station in widget.stations) {
            if (!current()) return;
            final point = station.location;
            if (point == null) continue;
            await controller.addSymbol(
              SymbolOptions(
                geometry: LatLng(point.latitude, point.longitude),
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
              ),
              {'stationId': station.id},
            );
          }
        })
        .catchError((Object _) {
          if (current()) setState(() => _failed = true);
        });
  }

  @override
  void initState() {
    super.initState();
    _armTimeout();
  }

  void _armTimeout() {
    _timeout?.cancel();
    if (!widget.config.configured) return;
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
    final location = ref.watch(mapLocationControllerProvider);
    ref.listen(mapLocationControllerProvider, (previous, next) {
      if (next.position != null && next.position != previous?.position) {
        _showLocation(next.position!);
      }
    });
    final supported =
        kIsWeb ||
        defaultTargetPlatform == TargetPlatform.android ||
        defaultTargetPlatform == TargetPlatform.iOS;
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
    return Stack(
      children: [
        if (!missing && supported)
          VietmapGL(
            key: ValueKey(_attempt),
            styleString: widget.config.styleUrl,
            initialCameraPosition: CameraPosition(
              target: LatLng(
                vietmapInitialCenter.latitude,
                vietmapInitialCenter.longitude,
              ),
              zoom: 16,
            ),
            compassEnabled: false,
            logoViewMargins: Point(12, widget.padding.bottom),
            attributionButtonMargins: Point(12, widget.padding.bottom),
            onMapCreated: (controller) {
              _controller?.onSymbolTapped.remove(_onPinTapped);
              _controller = controller;
              controller.onSymbolTapped.add(_onPinTapped);
            },
            onStyleLoadedCallback: () {
              _timeout?.cancel();
              if (!mounted) return;
              setState(() {
                _ready = true;
                _failed = false;
              });
              ++_styleEpoch;
              _syncPins(loadImage: true);
              final point = ref.read(mapLocationControllerProvider).position;
              if (point != null) _showLocation(point);
            },
          )
        else
          const ColoredBox(
            color: PowerMeColors.black,
            child: SizedBox.expand(),
          ),
        if (missing ||
            !supported ||
            _failed ||
            !_ready ||
            issue != null ||
            location.busy)
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
                      if (!missing && supported && !_ready && !_failed)
                        const LinearProgressIndicator(),
                      Text(
                        missing
                            ? copy.text(
                                'Chưa thể mở bản đồ.',
                                'Map could not be opened.',
                              )
                            : !supported
                            ? copy.text(
                                'Hãy mở bản đồ trên Android hoặc iOS.',
                                'Open the map on Android or iOS.',
                              )
                            : _failed
                            ? copy.text(
                                'Không tải được bản đồ. Kiểm tra kết nối hoặc quyền truy cập bản đồ.',
                                'Could not load the map. Check your connection or map access.',
                              )
                            : location.busy
                            ? copy.text(
                                'Đang lấy vị trí…',
                                'Locating…',
                              )
                            : issue ??
                                  copy.text(
                                    'Đang tải bản đồ…',
                                    'Loading map…',
                                  ),
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
