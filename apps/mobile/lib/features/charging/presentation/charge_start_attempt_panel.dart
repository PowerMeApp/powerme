import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/flow_page.dart';
import '../../stations/application/station_discovery_controller.dart';
import '../application/charge_session_controller.dart';
import '../application/charge_start_controller.dart';
import '../domain/charge_start.dart';
import 'charge_energy_label.dart';
import 'charge_flow_visuals.dart';

class ChargeStartAttemptPanel extends ConsumerStatefulWidget {
  const ChargeStartAttemptPanel({
    super.key,
    required this.copy,
    required this.view,
    required this.visible,
    required this.isCurrent,
    required this.onReturnToScan,
    this.onFollow,
  });

  final AppCopy copy;
  final ChargeStartState view;
  final bool visible;
  final bool Function() isCurrent;
  final VoidCallback onReturnToScan;
  final VoidCallback? onFollow;

  @override
  ConsumerState<ChargeStartAttemptPanel> createState() =>
      _ChargeStartAttemptPanelState();
}

class _ChargeStartAttemptPanelState
    extends ConsumerState<ChargeStartAttemptPanel>
    with WidgetsBindingObserver {
  Timer? _poll;
  ChargeSessionController? _sessionMonitor;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _syncPolling();
  }

  @override
  void didUpdateWidget(covariant ChargeStartAttemptPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    _syncPolling();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) return;
    // Pause can suspend frames before the parent rebuilds.
    _stopStartPolling();
    _sessionMonitor?.setVisible(false);
  }

  void _syncPolling() {
    final view = widget.view;
    if (widget.visible && view.recoverable) {
      _poll ??= Timer.periodic(const Duration(milliseconds: 1500), (timer) {
        _readStart();
        if (timer.tick >= 90) {
          timer.cancel();
          _poll = Timer.periodic(
            const Duration(seconds: 5),
            (_) => _readStart(),
          );
        }
      });
    } else {
      _stopStartPolling();
    }

    final target = view.sessionTarget;
    if (target == null || view.sessionEnded) {
      _sessionMonitor?.dispose();
      _sessionMonitor = null;
      return;
    }
    _sessionMonitor ??= ChargeSessionController(
      ref.read(chargeSessionRepositoryProvider),
      target,
      completionOnly: true,
      recordProgress: (target, progress) =>
          widget.isCurrent() &&
          ref
              .read(chargeStartProvider.notifier)
              .recordProgress(target, progress),
    );
    _sessionMonitor!.setVisible(widget.visible);
  }

  void _readStart() {
    if (widget.isCurrent()) {
      unawaited(ref.read(chargeStartProvider.notifier).check());
    }
  }

  void _stopStartPolling() {
    _poll?.cancel();
    _poll = null;
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _stopStartPolling();
    _sessionMonitor?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final copy = widget.copy;
    final view = widget.view;
    final controller = ref.read(chargeStartProvider.notifier);
    final attempt = view.attempt;
    final snapshot = view.snapshot;
    final request = attempt.request;
    final cap = snapshot?.maxEnergyWh;
    final sameVehicle =
        ref.watch(discoveryVehicleProvider) == request.vehicleId;
    final showPending = view.recoverable;
    final message = _startMessage(view, copy);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ChargeHeading(
          showPending
              ? copy.text('Khởi động phiên sạc', 'Starting your charge')
              : copy.text('Yêu cầu bắt đầu sạc', 'Start request'),
        ),
        if (showPending) ...[
          const SizedBox(height: 8),
          const ChargeRing(
            icon: Icons.ev_station_outlined,
            phase: ChargeRingPhase.starting,
          ),
        ] else
          const SizedBox(height: 16),
        Padding(
          padding: const EdgeInsets.only(bottom: 16),
          child: Semantics(
            liveRegion: true,
            child: Text(
              message,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.titleMedium,
            ),
          ),
        ),
        if (showPending) _startMilestones(view, copy),
        if (snapshot?.outcome == ChargeStartOutcome.topUpRequired &&
            view.issue == null)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: FilledButton(
              key: const Key('charge-start-top-up'),
              onPressed: () => context.push('/credit/top-up'),
              child: Text(copy.text('Nạp tín dụng', 'Top up credit')),
            ),
          ),
        if (widget.onFollow != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: FilledButton(
              key: const Key('qr-follow-charge'),
              onPressed: widget.onFollow,
              child: Text(
                view.sessionEnded
                    ? copy.text(
                        'Xem phiên đã kết thúc',
                        'View completed session',
                      )
                    : copy.text('Theo dõi phiên', 'Track session'),
              ),
            ),
          ),
        if (view.canResend) ...[
          const SizedBox(height: 8),
          FilledButton(
            key: const Key('qr-resend-charge'),
            onPressed: controller.resend,
            child: Text(
              copy.text('Gửi lại yêu cầu này', 'Resend this request'),
            ),
          ),
        ],
        const SizedBox(height: 12),
        ChargeContextCard(
          copy: copy,
          connector: attempt.connector,
          vehicle: attempt.vehicleLabel,
        ),
        ValueLine(
          copy.text('Hạn mức đã chọn', 'Requested limit'),
          chargeEnergyLabel(request.limitValue!, copy),
        ),
        if (snapshot?.started == true)
          ValueLine(
            copy.text('Mã phiên', 'Session ID'),
            snapshot!.sessionId!,
            showDivider: false,
          ),
        if (cap != null && cap > 0) ...[
          ValueLine(
            copy.text('Hạn mức tối đa', 'Maximum limit'),
            chargeEnergyLabel(cap, copy),
            showDivider: false,
          ),
          if (sameVehicle)
            FilledButton(
              key: const Key('qr-accept-charge-limit'),
              onPressed: view.busy
                  ? null
                  : () => controller.acceptLimit(request),
              child: Text(
                copy.text('Đồng ý và bắt đầu sạc', 'Accept and start charging'),
              ),
            )
          else
            Text(
              copy.text(
                'Chọn lại xe ban đầu để chấp nhận hạn mức này.',
                'Select the original vehicle to accept this limit.',
              ),
            ),
        ],
        if (snapshot?.started == true) ...[
          const SizedBox(height: 12),
          _startMilestones(view, copy),
        ],
        if (view.canClear)
          TextButton(
            key: const Key('qr-clear-charge'),
            onPressed: widget.onReturnToScan,
            child: Text(
              view.sessionEnded
                  ? copy.text('Quét mã khác', 'Scan another code')
                  : copy.text('Quay lại quét QR', 'Back to QR scan'),
            ),
          ),
      ],
    );
  }
}

Widget _startMilestones(ChargeStartState view, AppCopy copy) {
  final outcome = view.snapshot?.outcome;
  final sent = view.snapshot != null;
  final started = view.snapshot?.started == true;
  final accepted = outcome == ChargeStartOutcome.accepted;
  final acknowledged = accepted || started;
  final unconfirmed = copy.text('Chưa xác nhận', 'Unconfirmed');
  return ChargeMilestones(
    title: copy.text('Tiến trình bắt đầu', 'Start request progress'),
    steps: [
      (
        label: copy.text('Gửi yêu cầu bắt đầu', 'Send start request'),
        state: sent
            ? copy.text('Đã gửi', 'Sent')
            : view.busy && view.issue == null
            ? copy.text('Đang gửi', 'Sending')
            : unconfirmed,
        icon: sent ? Icons.check_rounded : Icons.send_outlined,
        color: sent ? PowerMeColors.teal : PowerMeColors.gold,
      ),
      (
        label: copy.text('Trụ phản hồi', 'Charger acknowledges'),
        state: started
            ? copy.text('Đã xác nhận', 'Confirmed')
            : accepted
            ? copy.text('Đã chấp nhận', 'Accepted')
            : unconfirmed,
        icon: acknowledged ? Icons.check_rounded : Icons.sync_rounded,
        color: acknowledged ? PowerMeColors.teal : PowerMeColors.muted,
      ),
      (
        label: copy.text('Phiên bắt đầu', 'Charging starts'),
        state: started
            ? copy.text('Đã bắt đầu', 'Confirmed started')
            : unconfirmed,
        icon: started ? Icons.check_rounded : Icons.bolt_outlined,
        color: started ? PowerMeColors.teal : PowerMeColors.muted,
      ),
    ],
  );
}

String _startMessage(ChargeStartState view, AppCopy copy) {
  final snapshot = view.snapshot;
  if (view.sessionEnded) {
    return copy.text(
      'Phiên sạc đã kết thúc.',
      'The charging session has ended.',
    );
  }
  if (snapshot?.started == true) {
    return copy.text(
      'Trụ đã bắt đầu phiên sạc.',
      'The charger started the session.',
    );
  }
  final issue = view.issue;
  if (issue != null) {
    return switch (issue) {
      ChargeStartIssue.uncertain => copy.text(
        'Chưa xác nhận được kết quả. Bạn có thể gửi lại yêu cầu này.',
        'The result is unconfirmed. You can resend this request.',
      ),
      ChargeStartIssue.notFound => copy.text(
        'Chưa tìm thấy yêu cầu. Bạn có thể gửi lại yêu cầu này.',
        'The request has not been found. You can resend this request.',
      ),
      ChargeStartIssue.keyConflict => copy.text(
        'Mã yêu cầu trùng với một yêu cầu khác. Chưa xác nhận được kết quả sạc.',
        'This request ID conflicts with another request. The charging result is unconfirmed.',
      ),
      ChargeStartIssue.creditUnavailable => copy.text(
        'Tài khoản tín dụng sạc chưa hoạt động.',
        'Your charging credit account is unavailable.',
      ),
      ChargeStartIssue.connectorUnavailable => copy.text(
        'Cổng sạc không sẵn sàng. Hãy chọn cổng khác.',
        'The connector is unavailable. Choose another connector.',
      ),
      ChargeStartIssue.connectorBusy => copy.text(
        'Cổng đang bận hoặc có yêu cầu sạc chưa xác nhận.',
        'The connector is busy or has an unconfirmed charging request.',
      ),
      ChargeStartIssue.tariffUnavailable => copy.text(
        'Chưa có biểu giá cho cổng sạc này.',
        'Pricing is unavailable for this connector.',
      ),
      ChargeStartIssue.vehicleIncompatible => copy.text(
        'Không thể dùng xe đã chọn với cổng sạc này.',
        'The selected vehicle cannot use this connector.',
      ),
      ChargeStartIssue.invalidRequest => copy.text(
        'Yêu cầu sạc không hợp lệ. Hãy kiểm tra hạn mức và thử lại.',
        'The charging request was invalid. Check the limit and try again.',
      ),
    };
  }
  return switch (snapshot?.outcome) {
    ChargeStartOutcome.topUpRequired => copy.text(
      'Tín dụng sạc dưới mức tối thiểu. Hãy nạp thêm trước khi thử lại.',
      'Charging credit is below the minimum. Top up before trying again.',
    ),
    ChargeStartOutcome.requiresConfirmation when snapshot?.maxEnergyWh == 0 =>
      copy.text(
        'Tín dụng hiện tại không đủ cho hạn mức dương.',
        'Current credit cannot cover a positive energy limit.',
      ),
    ChargeStartOutcome.requiresConfirmation => copy.text(
      'Tín dụng sạc chỉ đủ cho hạn mức thấp hơn. Xác nhận để dùng hạn mức bên dưới.',
      'Charging credit covers a lower limit. Confirm to use the limit below.',
    ),
    ChargeStartOutcome.rejected => copy.text(
      'Trụ đã từ chối yêu cầu sạc.',
      'The charger rejected the request.',
    ),
    ChargeStartOutcome.released || ChargeStartOutcome.startTimeout => copy.text(
      'Trụ chưa bắt đầu phiên. Bạn có thể quay lại để thử yêu cầu mới.',
      'The charger did not start a session. You can go back to make a new request.',
    ),
    ChargeStartOutcome.sent || ChargeStartOutcome.accepted => copy.text(
      'Đang chờ trụ bắt đầu phiên. Hãy cắm súng sạc.',
      'Waiting for the charger to start. Plug in the connector.',
    ),
    ChargeStartOutcome.unknown => copy.text(
      'Chưa có xác nhận từ trụ sạc.',
      'The charger has not confirmed the result.',
    ),
    _ => copy.text('Đang gửi yêu cầu sạc…', 'Sending the charging request…'),
  };
}
