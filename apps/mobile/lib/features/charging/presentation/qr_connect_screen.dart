import 'dart:async';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/flow_page.dart';
import '../../profile/application/profile_controller.dart';
import '../../stations/application/connector_lookup_controller.dart';
import '../../support/application/connector_fault_report_controller.dart';
import '../../stations/application/station_discovery_controller.dart';
import '../application/charge_session_controller.dart';
import '../application/charge_start_controller.dart';
import '../application/charging_controller.dart';
import '../application/qr_connection_controller.dart';
import '../domain/charging.dart';
import 'charge_flow_visuals.dart';
import 'charge_start_attempt_panel.dart';
import 'charge_start_panel.dart';
import 'charging_screens.dart';

class QrConnectScreen extends ConsumerStatefulWidget {
  const QrConnectScreen({super.key, this.apiMode = false});

  final bool apiMode;

  @override
  ConsumerState<QrConnectScreen> createState() => _QrConnectScreenState();
}

class _QrConnectScreenState extends ConsumerState<QrConnectScreen>
    with WidgetsBindingObserver {
  final _reference = TextEditingController();
  GoRouter? _router;
  bool _foreground = true;
  bool _opening = false;
  int _retry = 0;
  String? _lastScan;
  int _navigationGeneration = 0;
  StartRequest? _pendingAutoNavigation;
  ChargeStartController? _startController;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _foreground =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
    if (widget.apiMode) {
      _startController = ref.read(chargeStartProvider.notifier);
      ref.listenManual(chargeStartProvider, (previous, next) {
        if (next == null) {
          _pendingAutoNavigation = null;
          if (previous != null) _reference.clear();
        }
        if (next?.snapshot?.started != true ||
            (previous?.attempt.request.key == next!.attempt.request.key &&
                previous?.snapshot?.started == true)) {
          return;
        }
        if (!_isScanCurrent) return;
        _pendingAutoNavigation = next.attempt.request;
        _scheduleAutoNavigation();
      });
    }
  }

  void _scheduleAutoNavigation() {
    final request = _pendingAutoNavigation;
    if (request == null || !_foreground || !_isScanCurrent) return;
    final generation = _navigationGeneration;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted ||
          generation != _navigationGeneration ||
          !_foreground ||
          !_isScanCurrent ||
          !identical(_pendingAutoNavigation, request)) {
        return;
      }
      final current = ref.read(chargeStartProvider);
      final selection = ref.read(discoverySessionProvider);
      if (!identical(current?.attempt.request, request) ||
          current?.sessionTarget == null ||
          selection.scope != request.scope ||
          selection.vehicleId != request.vehicleId) {
        return;
      }
      _pendingAutoNavigation = null;
      context.go('/charge-session');
    });
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final router = GoRouter.of(context);
    if (_router == router) return;
    _router?.routerDelegate.removeListener(_routeChanged);
    _router = router;
    router.routerDelegate.addListener(_routeChanged);
  }

  void _routeChanged() {
    if (!_isScanCurrent) {
      _startController?.pauseStatusReads();
      _navigationGeneration++;
      _pendingAutoNavigation = null;
    }
    if (mounted) setState(() {});
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) {
      _startController?.pauseStatusReads();
    }
    if (state != AppLifecycleState.resumed) _navigationGeneration++;
    setState(() => _foreground = state == AppLifecycleState.resumed);
    if (_foreground && widget.apiMode) _scheduleAutoNavigation();
  }

  @override
  void dispose() {
    _startController?.pauseStatusReads();
    WidgetsBinding.instance.removeObserver(this);
    _router?.routerDelegate.removeListener(_routeChanged);
    _reference.dispose();
    super.dispose();
  }

  bool get _isScanCurrent {
    final configuration = _router?.routerDelegate.currentConfiguration;
    return configuration != null &&
        configuration.isNotEmpty &&
        configuration.last.matchedLocation == '/scan' &&
        ModalRoute.isCurrentOf(context) == true;
  }

  Future<void> _connect(String reference, {bool camera = false}) async {
    if (camera && (!_foreground || !_isScanCurrent)) return;
    if (widget.apiMode) {
      if (ref.read(chargeStartProvider) != null) return;
      final lookup = ref.read(connectorLookupProvider);
      if (camera && (lookup.failure != null || lookup.connector != null)) {
        return;
      }
      if (!camera) FocusScope.of(context).unfocus();
      await ref.read(connectorLookupProvider.notifier).resolve(reference);
      return;
    }
    if (_opening || reference.trim().isEmpty) return;
    if (camera && _lastScan == reference) return;
    if (camera) _lastScan = reference;
    setState(() => _opening = true);
    final connector = await ref
        .read(qrConnectionProvider.notifier)
        .resolve(reference);
    if (!mounted) return;
    if (connector != null && _isScanCurrent && _foreground) {
      await context.push(
        Uri(
          path: '/start',
          queryParameters: {'connector': connector},
        ).toString(),
      );
    }
    if (mounted) setState(() => _opening = false);
  }

  void _retryCamera() {
    if (widget.apiMode) ref.read(connectorLookupProvider.notifier).clear();
    setState(() {
      _lastScan = null;
      _retry++;
    });
  }

  @override
  Widget build(BuildContext context) {
    final profile = ref.watch(profileControllerProvider).profile;
    final copy = AppCopy(profile.language);
    final selection = widget.apiMode
        ? ref.watch(discoverySessionProvider)
        : null;
    final attempt = widget.apiMode ? ref.watch(chargeStartProvider) : null;
    if (attempt != null) {
      return ChargeFlowPage(
        key: const Key('qr-start-attempt'),
        title: copy.scanQr,
        showBack: false,
        children: [
          ChargeStartAttemptPanel(
            key: ValueKey(attempt.attempt.request),
            copy: copy,
            view: attempt,
            visible: _foreground && _isScanCurrent,
            isCurrent: () => _foreground && _isScanCurrent,
            onFollow: ref.watch(confirmedChargeSessionProvider) == null
                ? null
                : () => context.push('/charge-session'),
            onReturnToScan: () {
              ref.read(chargeStartProvider.notifier).clear();
            },
          ),
        ],
      );
    }
    if (selection != null && selection.vehicleId.isEmpty) {
      final hasVehicles = profile.vehicles.isNotEmpty;
      return FlowPage(
        title: copy.scanQr,
        showBack: false,
        children: [
          InfoCard(
            spacing: 14,
            children: [
              Text(
                hasVehicles
                    ? copy.text(
                        'Chọn xe mặc định để kiểm tra cổng phù hợp.',
                        'Choose a default vehicle to check compatible chargers.',
                      )
                    : copy.text(
                        'Thêm xe để kiểm tra cổng sạc phù hợp.',
                        'Add a vehicle to check compatible chargers.',
                      ),
              ),
              FilledButton(
                onPressed: () => hasVehicles
                    ? context.go('/profile')
                    : context.push('/vehicles/new'),
                child: Text(
                  hasVehicles
                      ? copy.profile
                      : copy.text('Thêm xe', 'Add vehicle'),
                ),
              ),
            ],
          ),
        ],
      );
    }
    final view = widget.apiMode ? null : ref.watch(chargingControllerProvider);
    final qr = widget.apiMode ? null : ref.watch(qrConnectionProvider);
    final lookup = widget.apiMode ? ref.watch(connectorLookupProvider) : null;
    final connector = lookup?.connector;
    if (connector != null && selection != null) {
      return ChargeFlowPage(
        key: const Key('qr-selected-connector'),
        title: copy.scanQr,
        showBack: false,
        children: [
          ChargeConnectorPanel(
            copy: copy,
            selection: selection,
            connector: connector,
            vehicle: profile.selectedVehicle,
            onRecheck: () =>
                _connect('${connector.displayCode}/${connector.number}'),
            onRescan: _retryCamera,
          ),
          OutlinedButton(
            key: const Key('qr-report-connector'),
            onPressed: () => context.push(
              '/connector-report',
              extra: FaultReportTarget(
                session: selection,
                connectorId: connector.id,
                label: [
                  connector.stationName,
                  connector.displayCode,
                  '${copy.text('Cổng', 'Connector')} ${connector.number}',
                ].join(' · '),
              ),
            ),
            child: Text(
              copy.text('Báo lỗi cổng sạc', 'Report connector issue'),
              textAlign: TextAlign.center,
            ),
          ),
        ],
      );
    }
    final error = switch (lookup?.failure) {
      ConnectorLookupFailure.invalidCode => copy.text(
        'Mã cổng chưa đúng. Nhập mã trụ và số cổng, ví dụ PM-01/1.',
        'Enter the charger code and connector number, for example PM-01/1.',
      ),
      ConnectorLookupFailure.notFound => copy.text(
        'Không tìm thấy cổng phù hợp. Kiểm tra mã và xe đang chọn.',
        'No compatible connector found. Check the code and selected vehicle.',
      ),
      ConnectorLookupFailure.unavailable => copy.text(
        'Chưa kiểm tra được cổng sạc. Vui lòng thử lại.',
        'Could not check the connector. Please try again.',
      ),
      null => qr?.error,
    };
    final blocked = view != null && blocksQrConnection(view);
    final busy = lookup?.busy ?? _opening;
    final cameraReady =
        _foreground && _isScanCurrent && !busy && lookup?.failure == null;
    return ChargeFlowPage(
      title: copy.scanQr,
      showBack: false,
      backTooltip: copy.back,
      children: [
        if (view != null && (view.session != null || view.command != null)) ...[
          HeroCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  view.session == null
                      ? copy.text(
                          'Yêu cầu sạc đang chờ xác nhận',
                          'Charging request awaiting confirmation',
                        )
                      : sessionLabel(view.session!.state, copy),
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 12),
                FilledButton.icon(
                  key: const Key('qr-open-session'),
                  onPressed: () => context.push('/charging'),
                  icon: const Icon(Icons.bolt_rounded),
                  label: Text(copy.charging),
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),
        ],
        ChargeHeading(
          widget.apiMode
              ? copy.text('Tra cứu cổng sạc', 'Look up a connector')
              : copy.text('Kết nối với cổng sạc', 'Connect to a charger'),
          centered: false,
        ),
        const SizedBox(height: 8),
        Text(
          widget.apiMode
              ? copy.text(
                  'Quét mã trên trụ hoặc nhập mã cổng để xem trạng thái.',
                  'Scan the charger QR code or enter its code to check the status.',
                )
              : copy.text(
                  'Đưa mã QR trên cổng sạc vào khung. Bạn sẽ kiểm tra thông tin trước khi bắt đầu.',
                  'Place the charger QR code inside the frame. Review the details before starting.',
                ),
          style: Theme.of(
            context,
          ).textTheme.bodyMedium?.copyWith(color: PowerMeColors.muted),
        ),
        const SizedBox(height: 20),
        ClipRRect(
          borderRadius: BorderRadius.circular(14),
          child: Container(
            height: 264,
            color: PowerMeColors.graphite,
            child: blocked
                ? Center(
                    child: Text(
                      copy.text(
                        'Mở phiên hiện tại để tiếp tục.',
                        'Open your current session to continue.',
                      ),
                    ),
                  )
                : cameraReady
                ? _QrCamera(
                    key: ValueKey(_retry),
                    copy: copy,
                    onCode: (code) => _connect(code, camera: true),
                    onRetry: _retryCamera,
                  )
                : Center(
                    child: busy
                        ? CircularProgressIndicator(
                            semanticsLabel: copy.text(
                              'Đang kiểm tra cổng sạc',
                              'Checking charger',
                            ),
                          )
                        : const Icon(
                            Icons.qr_code_scanner,
                            size: 40,
                            color: PowerMeColors.muted,
                          ),
                  ),
          ),
        ),
        const SizedBox(height: 20),
        FailureNotice(error),
        if (error != null) ...[
          TextButton(
            onPressed: _retryCamera,
            child: Text(copy.text('Quét lại', 'Scan again')),
          ),
          const SizedBox(height: 8),
        ],
        InfoCard(
          spacing: 12,
          children: [
            Semantics(
              header: true,
              child: Text(
                copy.text('Nhập mã thủ công', 'Enter code manually'),
                style: Theme.of(
                  context,
                ).textTheme.titleMedium?.copyWith(color: PowerMeColors.gold),
              ),
            ),
            if (widget.apiMode)
              Text(
                copy.text(
                  'Dùng mã trụ và số cổng, ví dụ PM-01/1.',
                  'Use the charger code and connector number, e.g. PM-01/1.',
                ),
                style: Theme.of(context).textTheme.bodySmall,
              ),
            TextField(
              key: const Key('qr-manual-reference'),
              controller: _reference,
              enabled: !blocked && !busy,
              textInputAction: TextInputAction.go,
              decoration: InputDecoration(
                labelText: copy.text('Mã cổng', 'Connector code'),
                hintText: widget.apiMode ? 'PM-01/1' : null,
                fillColor: PowerMeColors.black,
                prefixIcon: const Icon(Icons.ev_station_outlined),
              ),
              onSubmitted: blocked || busy
                  ? null
                  : (value) {
                      if (value.trim().isNotEmpty) _connect(value);
                    },
            ),
            ValueListenableBuilder(
              valueListenable: _reference,
              builder: (context, value, _) => FilledButton(
                key: const Key('qr-connect'),
                onPressed: blocked || busy || value.text.trim().isEmpty
                    ? null
                    : () => _connect(value.text),
                child: Text(
                  copy.text('Kiểm tra cổng sạc', 'Check charger'),
                  textAlign: TextAlign.center,
                ),
              ),
            ),
          ],
        ),
        TextButton(
          onPressed: () => context.go(widget.apiMode ? '/discover' : '/'),
          child: Text(
            copy.text('Chọn trạm trên bản đồ', 'Choose a station on the map'),
            textAlign: TextAlign.center,
          ),
        ),
      ],
    );
  }
}

class _QrCamera extends StatefulWidget {
  const _QrCamera({
    super.key,
    required this.copy,
    required this.onCode,
    required this.onRetry,
  });
  final AppCopy copy;
  final ValueChanged<String> onCode;
  final VoidCallback onRetry;
  @override
  State<_QrCamera> createState() => _QrCameraState();
}

class _QrCameraState extends State<_QrCamera> {
  final _controller = MobileScannerController(
    autoStart: false,
    formats: [BarcodeFormat.qrCode],
  );
  Future<void> _work = Future.value();
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _work = _controller.start().catchError((Object _) {});
    });
  }

  @override
  void dispose() {
    // Finish pending permission/start before releasing the native camera.
    unawaited(
      _work
          .then((_) async {
            await _controller.stop();
            await _controller.dispose();
          })
          .catchError((Object _) {}),
    );
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Stack(
    fit: StackFit.expand,
    children: [
      MobileScanner(
        controller: _controller,
        onDetect: (capture) {
          for (final barcode in capture.barcodes) {
            final raw = barcode.rawValue;
            if (raw != null && raw.isNotEmpty) {
              widget.onCode(raw);
              break;
            }
          }
        },
        errorBuilder: (context, error) => ColoredBox(
          color: PowerMeColors.graphite,
          child: Center(
            child: SingleChildScrollView(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(
                      Icons.no_photography_outlined,
                      color: PowerMeColors.gold,
                      size: 40,
                    ),
                    const SizedBox(height: 12),
                    Text(
                      error.errorCode == MobileScannerErrorCode.permissionDenied
                          ? widget.copy.text(
                              'Cho phép Camera trong cài đặt ứng dụng để quét QR, hoặc nhập mã cổng bên dưới.',
                              'Allow Camera access in app settings to scan QR codes, or enter the charger code below.',
                            )
                          : widget.copy.text(
                              'Chưa mở được camera. Bạn có thể thử lại hoặc nhập mã cổng.',
                              'Could not open camera. You can retry or enter the charger code.',
                            ),
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 8),
                    TextButton(
                      onPressed: widget.onRetry,
                      child: Text(widget.copy.text('Thử lại', 'Retry')),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
      ValueListenableBuilder<MobileScannerState>(
        valueListenable: _controller,
        builder: (context, state, _) {
          if (state.error != null) return const SizedBox.shrink();
          return IgnorePointer(
            child: Stack(
              fit: StackFit.expand,
              children: [
                if (state.isRunning) const CustomPaint(painter: _QrFrame()),
                Positioned(
                  top: 12,
                  left: 12,
                  right: 12,
                  child: Align(
                    alignment: Alignment.topLeft,
                    child: StatusBadge(
                      state.isRunning
                          ? widget.copy.text(
                              'Camera đang hoạt động',
                              'Camera active',
                            )
                          : widget.copy.text(
                              'Đang mở camera',
                              'Opening camera',
                            ),
                      color: state.isRunning
                          ? PowerMeColors.teal
                          : PowerMeColors.muted,
                    ),
                  ),
                ),
              ],
            ),
          );
        },
      ),
    ],
  );
}

class _QrFrame extends CustomPainter {
  const _QrFrame();

  @override
  void paint(Canvas canvas, Size size) {
    final side = math.min(size.width - 56, size.height - 76);
    if (side <= 0) return;
    final frame = Rect.fromCenter(
      center: Offset(size.width / 2, size.height / 2 + 16),
      width: side,
      height: side,
    );
    final shade = Path()
      ..fillType = PathFillType.evenOdd
      ..addRect(Offset.zero & size)
      ..addRect(frame);
    canvas.drawPath(shade, Paint()..color = Colors.black54);

    final corner = Paint()
      ..color = PowerMeColors.teal
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    const arm = 22.0;
    for (final x in [frame.left, frame.right]) {
      for (final y in [frame.top, frame.bottom]) {
        final dx = x == frame.left ? arm : -arm;
        final dy = y == frame.top ? arm : -arm;
        canvas.drawPath(
          Path()
            ..moveTo(x + dx, y)
            ..lineTo(x, y)
            ..lineTo(x, y + dy),
          corner,
        );
      }
    }
  }

  @override
  bool shouldRepaint(covariant _QrFrame oldDelegate) => false;
}
