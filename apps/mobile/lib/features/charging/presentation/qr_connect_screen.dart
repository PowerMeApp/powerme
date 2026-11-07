import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/flow_page.dart';
import '../../profile/application/profile_controller.dart';
import '../application/charging_controller.dart';
import '../application/qr_connection_controller.dart';
import 'charging_screens.dart';

class QrConnectScreen extends ConsumerStatefulWidget {
  const QrConnectScreen({super.key});
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

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _foreground =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
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
    if (mounted) setState(() {});
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    setState(() => _foreground = state == AppLifecycleState.resumed);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _router?.routerDelegate.removeListener(_routeChanged);
    _reference.dispose();
    super.dispose();
  }

  Future<void> _connect(String reference, {bool camera = false}) async {
    if (_opening || reference.trim().isEmpty) return;
    if (camera && _lastScan == reference) return;
    if (camera) _lastScan = reference;
    setState(() => _opening = true);
    final connector = await ref
        .read(qrConnectionProvider.notifier)
        .resolve(reference);
    if (!mounted) return;
    if (connector != null &&
        _router?.routerDelegate.currentConfiguration.last.matchedLocation ==
            '/scan' &&
        _foreground) {
      await context.push(
        Uri(
          path: '/start',
          queryParameters: {'connector': connector},
        ).toString(),
      );
    }
    if (mounted) setState(() => _opening = false);
  }

  @override
  Widget build(BuildContext context) {
    final view = ref.watch(chargingControllerProvider);
    final qr = ref.watch(qrConnectionProvider);
    final copy = AppCopy(ref.watch(profileControllerProvider).profile.language);
    final blocked = blocksQrConnection(view);
    final visible =
        _router?.routerDelegate.currentConfiguration.last.matchedLocation ==
        '/scan';
    return FlowPage(
      title: copy.scanQr,
      showBack: false,
      backTooltip: copy.back,
      children: [
        if (view.session != null || view.command != null) ...[
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
        Text(
          copy.text('Kết nối với cổng sạc', 'Connect to a charger'),
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        const SizedBox(height: 8),
        Text(
          copy.text(
            'Đưa mã QR trên cổng sạc vào khung. Bạn sẽ kiểm tra thông tin trước khi bắt đầu.',
            'Place the charger QR code inside the frame. Review the details before starting.',
          ),
          style: Theme.of(
            context,
          ).textTheme.bodyMedium?.copyWith(color: PowerMeColors.muted),
        ),
        const SizedBox(height: 20),
        ClipRRect(
          borderRadius: BorderRadius.circular(20),
          child: SizedBox(
            height: 280,
            child: blocked
                ? Center(
                    child: Text(
                      copy.text(
                        'Mở phiên hiện tại để tiếp tục.',
                        'Open your current session to continue.',
                      ),
                    ),
                  )
                : _foreground && visible && !_opening
                ? _QrCamera(
                    key: ValueKey(_retry),
                    copy: copy,
                    onCode: (code) => _connect(code, camera: true),
                    onRetry: () => setState(() {
                      _retry++;
                      _lastScan = null;
                    }),
                  )
                : Center(
                    child: _opening
                        ? const CircularProgressIndicator()
                        : const Icon(Icons.qr_code_scanner, size: 64),
                  ),
          ),
        ),
        const SizedBox(height: 20),
        FailureNotice(qr.error),
        if (qr.error != null) ...[
          TextButton(
            onPressed: () => setState(() {
              _lastScan = null;
              _retry++;
            }),
            child: Text(copy.text('Quét lại', 'Scan again')),
          ),
          const SizedBox(height: 8),
        ],
        InfoCard(
          spacing: 14,
          children: [
            Text(
              copy.text('Nhập mã cổng', 'Enter charger code'),
              style: Theme.of(context).textTheme.titleMedium,
            ),
            TextField(
              key: const Key('qr-manual-reference'),
              controller: _reference,
              enabled: !blocked && !_opening,
              decoration: InputDecoration(
                labelText: copy.text(
                  'Mã cổng hoặc nội dung QR',
                  'Charger code or QR content',
                ),
                fillColor: PowerMeColors.black,
                prefixIcon: const Icon(Icons.ev_station_outlined),
              ),
              onSubmitted: blocked || _opening ? null : _connect,
            ),
            FilledButton(
              key: const Key('qr-connect'),
              onPressed: blocked || _opening
                  ? null
                  : () => _connect(_reference.text),
              child: Text(copy.text('Kiểm tra cổng sạc', 'Check charger')),
            ),
          ],
        ),
        TextButton(
          onPressed: () => context.go('/'),
          child: Text(
            copy.text('Chọn trạm trên bản đồ', 'Choose a station on the map'),
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
        builder: (context, state, child) =>
            state.error == null ? child! : const SizedBox.shrink(),
        child: const IgnorePointer(
          child: Center(
            child: SizedBox(
              width: 210,
              height: 210,
              child: DecoratedBox(
                decoration: BoxDecoration(
                  border: Border.fromBorderSide(
                    BorderSide(color: PowerMeColors.teal, width: 2),
                  ),
                  borderRadius: BorderRadius.all(Radius.circular(20)),
                ),
              ),
            ),
          ),
        ),
      ),
    ],
  );
}
