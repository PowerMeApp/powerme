import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/app_copy.dart';
import '../../../core/widgets/flow_page.dart';
import '../../profile/application/profile_controller.dart';
import '../application/charge_session_controller.dart';
import '../application/charge_start_controller.dart';
import '../domain/charge_session.dart';
import '../domain/charging.dart';
import 'charge_flow_visuals.dart';
import 'charge_session_readout.dart';
import 'charge_statement_card.dart';
import 'charge_stop_widgets.dart';

class ChargeSessionScreen extends ConsumerWidget {
  const ChargeSessionScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final target = ref.watch(confirmedChargeSessionProvider);
    final copy = AppCopy(ref.watch(profileControllerProvider).profile.language);
    if (target == null) {
      return ChargeFlowPage(
        title: copy.charging,
        backLocation: '/scan',
        backTooltip: copy.back,
        children: [Text(_unavailable(copy))],
      );
    }
    final canPop = context.canPop();
    return PopScope(
      canPop: canPop,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop || !canPop) {
          ref.read(chargeStartProvider.notifier).releaseFinishedSession();
          if (!didPop) context.go('/scan');
        }
      },
      child: _ChargeSessionView(
        key: ValueKey(target),
        target: target,
        copy: copy,
      ),
    );
  }
}

class _ChargeSessionView extends ConsumerStatefulWidget {
  const _ChargeSessionView({
    super.key,
    required this.target,
    required this.copy,
  });

  final ChargeSessionTarget target;
  final AppCopy copy;

  @override
  ConsumerState<_ChargeSessionView> createState() => _ChargeSessionViewState();
}

class _ChargeSessionViewState extends ConsumerState<_ChargeSessionView>
    with WidgetsBindingObserver {
  late final ChargeSessionController _controller;
  late bool _foreground;
  ModalRoute<dynamic>? _route;
  GoRouter? _router;
  bool _scheduled = false;
  bool _confirmingStop = false;

  @override
  void initState() {
    super.initState();
    final binding = WidgetsBinding.instance;
    binding.addObserver(this);
    _foreground =
        binding.lifecycleState == null ||
        binding.lifecycleState == AppLifecycleState.resumed;
    _controller = ChargeSessionController(
      ref.read(chargeSessionRepositoryProvider),
      widget.target,
      recordProgress: (target, progress) =>
          _visible &&
          ref
              .read(chargeStartProvider.notifier)
              .recordProgress(target, progress),
    );
    ref.listenManual(confirmedChargeSessionProvider, (_, target) {
      if (target != widget.target) _controller.setVisible(false);
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _route = ModalRoute.of(context);
    final router = GoRouter.of(context);
    if (_router != router) {
      _router?.routerDelegate.removeListener(_syncVisibility);
      _router = router;
      router.routerDelegate.addListener(_syncVisibility);
    }
    _syncVisibility();
  }

  bool get _visible {
    final routes = _router?.routerDelegate.currentConfiguration;
    return _foreground &&
        (_route?.isCurrent == true || _confirmingStop) &&
        routes != null &&
        routes.isNotEmpty &&
        routes.last.matchedLocation == '/charge-session' &&
        ref.read(confirmedChargeSessionProvider) == widget.target;
  }

  void _syncVisibility() {
    if (!_visible) {
      _controller.setVisible(false);
    } else if (!_scheduled) {
      _scheduled = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _scheduled = false;
        if (mounted && _visible) _controller.setVisible(true);
      });
      WidgetsBinding.instance.ensureVisualUpdate();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _syncVisibility();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _router?.routerDelegate.removeListener(_syncVisibility);
    _controller.dispose();
    super.dispose();
  }

  void _returnToScan() {
    ref.read(chargeStartProvider.notifier).releaseFinishedSession();
    context.go('/scan');
  }

  Future<void> _requestStop({required bool retry}) async {
    if (_confirmingStop ||
        !_visible ||
        !_controller.canRequestStop(retry: retry)) {
      return;
    }
    if (!retry) {
      final copy = widget.copy;
      _confirmingStop = true;
      bool? confirmed;
      try {
        confirmed = await showModalBottomSheet<bool>(
          context: context,
          isScrollControlled: true,
          useSafeArea: true,
          showDragHandle: true,
          builder: (context) => Consumer(
            builder: (context, ref, _) {
              final sameSession =
                  ref.watch(confirmedChargeSessionProvider) == widget.target;
              return ListenableBuilder(
                listenable: _controller,
                builder: (context, _) => ChargeStopSheet(
                  copy: copy,
                  progress: sameSession ? _controller.progress : null,
                  canConfirm:
                      sameSession && _controller.canRequestStop(retry: false),
                  attempt: sameSession
                      ? ref.read(chargeStartProvider)?.attempt
                      : null,
                ),
              );
            },
          ),
        );
      } finally {
        _confirmingStop = false;
        if (mounted) _syncVisibility();
      }
      if (confirmed != true || !mounted) return;
    }
    if (!_visible || !_controller.canRequestStop(retry: retry)) return;
    await ref
        .read(chargeStopProvider.notifier)
        .send(widget.target, retry: retry);
  }

  @override
  Widget build(BuildContext context) {
    final stop = ref.watch(chargeStopProvider);
    final attempt = ref.watch(chargeStartProvider)?.attempt;
    return ListenableBuilder(
      listenable: _controller,
      builder: (context, _) {
        final copy = widget.copy;
        final progress = _controller.progress;
        final canRetry =
            stop?.outcome == ChargeStopOutcome.responseUnknown &&
            _controller.canRequestStop(retry: true);
        final canStop =
            (stop == null || stop.outcome == ChargeStopOutcome.rejected) &&
            _controller.canRequestStop(retry: false);
        final issue = _controller.progressIssue;
        final awaitingStopMeter =
            progress?.closed == true &&
            progress?.settlement == SettlementState.posted &&
            progress?.meterStopWh == null;
        final showStopStatus =
            stop != null &&
            progress != null &&
            !progress.closed &&
            progress.meterStopWh == null &&
            progress.keepPolling;
        final waitingForStop =
            progress != null &&
            !progress.closed &&
            !progress.inReview &&
            progress.meterStopWh == null &&
            (progress.status == SessionState.stopping ||
                (showStopStatus && isChargeStopUnconfirmed(stop.outcome)));
        final showRing =
            progress != null &&
            !progress.inReview &&
            progress.meterStopWh == null &&
            (waitingForStop ||
                progress.status == SessionState.active ||
                progress.status == SessionState.paused);
        return ChargeFlowPage(
          key: ValueKey(waitingForStop),
          title: copy.charging,
          backLocation: '/scan',
          backTooltip: copy.back,
          onBack: () {
            if (context.canPop()) {
              context.pop();
            } else {
              _returnToScan();
            }
          },
          children: [
            if (showRing)
              ChargeSessionReadout(
                copy: copy,
                progress: progress,
                waitingForStop: waitingForStop,
                hasStopRequest: stop != null,
              )
            else if (progress != null)
              ChargeProgressCard(progress: progress, copy: copy),
            if (issue != null)
              FailureNotice(switch (issue) {
                ChargeSessionIssue.unavailable => _unavailable(copy),
                ChargeSessionIssue.retry when progress != null => copy.text(
                  'Chưa cập nhật được. Đang hiển thị số liệu gần nhất.',
                  'Update unavailable. Showing the last reading.',
                ),
                ChargeSessionIssue.retry => copy.text(
                  'Chưa tải được tiến độ phiên sạc.',
                  'Charging progress is unavailable.',
                ),
              }),
            if (progress == null && issue == null)
              Text(
                copy.text('Đang tải tiến độ…', 'Loading charging progress…'),
              ),
            if (awaitingStopMeter && progress?.inReview != true)
              Text(
                copy.text(
                  'Chưa có chỉ số chốt để xác nhận bảng kê.',
                  'The final meter reading is unavailable.',
                ),
              ),
            if (showStopStatus && !waitingForStop)
              FailureNotice(chargeStopMessage(stop.outcome, copy)),
            if (waitingForStop) ...[
              if (showStopStatus)
                Semantics(
                  liveRegion: true,
                  child: Padding(
                    padding: const EdgeInsets.only(bottom: 16),
                    child: Text(
                      chargeStopMessage(stop.outcome, copy),
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                  ),
                ),
              if (stop != null) chargeStopMilestones(stop, progress, copy),
            ],
            if (showRing && !waitingForStop) ...[
              ChargeSessionMetrics(
                copy: copy,
                progress: progress,
                includeEnergy: false,
              ),
              const SizedBox(height: 16),
              if (attempt != null)
                ChargeContextCard(
                  copy: copy,
                  connector: attempt.connector,
                  vehicle: attempt.vehicleLabel,
                ),
            ],
            if (canStop || canRetry)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: FilledButton.tonalIcon(
                  key: Key(
                    canRetry ? 'retry-stop-charging' : 'request-stop-charging',
                  ),
                  style: canRetry ? null : chargeStopButtonStyle(context),
                  icon: Icon(
                    canRetry
                        ? Icons.refresh_rounded
                        : Icons.stop_circle_outlined,
                  ),
                  onPressed: () => _requestStop(retry: canRetry),
                  label: Text(
                    canRetry
                        ? copy.text(
                            'Gửi lại yêu cầu dừng',
                            'Retry stop request',
                          )
                        : copy.text('Dừng sạc', 'Stop charging'),
                  ),
                ),
              ),
            if (issue != null ||
                progress?.inReview == true ||
                awaitingStopMeter ||
                waitingForStop)
              OutlinedButton(
                onPressed: _controller.reading
                    ? null
                    : _controller.refreshProgress,
                child: Text(copy.text('Thử cập nhật', 'Refresh progress')),
              ),
            if (waitingForStop) ...[
              const SizedBox(height: 16),
              if (attempt != null)
                ChargeContextCard(
                  copy: copy,
                  connector: attempt.connector,
                  vehicle: attempt.vehicleLabel,
                ),
              ChargeSessionMetrics(
                copy: copy,
                progress: progress,
                includeEnergy: true,
              ),
            ],
            if (progress?.statementEligible == true)
              ChargeStatementCard(
                copy: copy,
                statement: _controller.statement,
                issue: _controller.statementIssue,
                retry: _controller.reading ? null : _controller.retryStatement,
              ),
            if (progress?.confirmsEnd == true)
              FilledButton(
                key: const Key('charge-session-return-to-scan'),
                onPressed: _returnToScan,
                child: Text(copy.text('Về Quét QR', 'Back to QR scan')),
              ),
          ],
        );
      },
    );
  }
}

String _unavailable(AppCopy copy) =>
    copy.text('Không tìm thấy phiên sạc.', 'Charging session unavailable.');
