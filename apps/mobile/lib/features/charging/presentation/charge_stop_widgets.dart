import 'package:flutter/material.dart';

import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/flow_page.dart';
import '../application/charge_session_controller.dart';
import '../application/charge_start_controller.dart';
import '../domain/charge_session.dart';
import '../domain/charging.dart';
import 'charge_flow_visuals.dart';
import 'charge_session_readout.dart';

ButtonStyle chargeStopButtonStyle(BuildContext context) {
  final colors = Theme.of(context).colorScheme;
  return FilledButton.styleFrom(
    backgroundColor: Color.alphaBlend(
      colors.error.withValues(alpha: .17),
      colors.surface,
    ),
    foregroundColor: colors.error,
  );
}

bool isChargeStopUnconfirmed(ChargeStopOutcome? outcome) => switch (outcome) {
  null ||
  ChargeStopOutcome.pending ||
  ChargeStopOutcome.sent ||
  ChargeStopOutcome.accepted ||
  ChargeStopOutcome.effectReported ||
  ChargeStopOutcome.timeout ||
  ChargeStopOutcome.failed ||
  ChargeStopOutcome.pendingOrUnknown ||
  ChargeStopOutcome.responseUnknown ||
  ChargeStopOutcome.notStoppable => true,
  _ => false,
};

Widget chargeStopMilestones(
  ChargeStopAttempt attempt,
  ChargeProgress progress,
  AppCopy copy,
) {
  final outcome = attempt.outcome;
  final recorded = switch (outcome) {
    ChargeStopOutcome.pending ||
    ChargeStopOutcome.sent ||
    ChargeStopOutcome.accepted ||
    ChargeStopOutcome.effectReported ||
    ChargeStopOutcome.timeout ||
    ChargeStopOutcome.failed => true,
    _ => false,
  };
  final accepted = outcome == ChargeStopOutcome.accepted;
  final unconfirmed = copy.text('Chưa xác nhận', 'Unconfirmed');
  return ChargeMilestones(
    title: copy.text('Tiến trình dừng', 'Stop request progress'),
    steps: [
      (
        label: copy.text('Gửi yêu cầu dừng', 'Send stop request'),
        state: recorded
            ? copy.text('Đã ghi nhận', 'Recorded')
            : outcome == null
            ? copy.text('Đang gửi', 'Sending')
            : unconfirmed,
        icon: recorded ? Icons.check_rounded : Icons.send_outlined,
        color: recorded ? PowerMeColors.teal : PowerMeColors.gold,
      ),
      (
        label: copy.text('Trụ phản hồi', 'Charger acknowledges'),
        state: accepted
            ? copy.text('Đã chấp nhận', 'Accepted')
            : outcome == ChargeStopOutcome.effectReported
            ? copy.text('Đã báo dừng', 'Stop reported')
            : unconfirmed,
        icon: accepted ? Icons.check_rounded : Icons.sync_rounded,
        color: accepted ? PowerMeColors.teal : PowerMeColors.muted,
      ),
      (
        label: copy.text('Chốt điện năng', 'Record final energy'),
        state: progress.status == SessionState.stopping
            ? copy.text('Phiên đang dừng', 'Session is stopping')
            : unconfirmed,
        icon: Icons.bolt_outlined,
        color: PowerMeColors.muted,
      ),
    ],
  );
}

class ChargeStopSheet extends StatelessWidget {
  const ChargeStopSheet({
    super.key,
    required this.copy,
    required this.progress,
    required this.canConfirm,
    required this.attempt,
  });

  final AppCopy copy;
  final ChargeProgress? progress;
  final bool canConfirm;
  final ChargeStartAttempt? attempt;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final current = progress;
    return SafeArea(
      top: false,
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ExcludeSemantics(
              child: CircleAvatar(
                radius: 26,
                backgroundColor: colors.errorContainer,
                foregroundColor: colors.onErrorContainer,
                child: const Icon(Icons.power_settings_new_rounded, size: 28),
              ),
            ),
            const SizedBox(height: 12),
            ChargeHeading(copy.text('Bạn muốn dừng sạc?', 'Stop charging?')),
            const SizedBox(height: 8),
            Text(
              copy.text(
                'Xác nhận để gửi yêu cầu dừng đến trụ sạc.',
                'Confirm to send a stop request to the charge point.',
              ),
              textAlign: TextAlign.center,
            ),
            if (current != null && attempt != null) ...[
              const SizedBox(height: 16),
              ChargeDetail(
                icon: Icons.ev_station_outlined,
                title: attempt!.connector.stationName,
                detail: chargeConnectorLabel(attempt!.connector, copy),
              ),
            ],
            if (current != null) ...[
              const SizedBox(height: 12),
              ChargeSessionMetrics(
                copy: copy,
                progress: current,
                includeEnergy: true,
                summary: true,
              ),
            ],
            if (!canConfirm)
              FailureNotice(
                copy.text(
                  'Hiện chưa thể yêu cầu dừng phiên.',
                  'A stop request is currently unavailable.',
                ),
              ),
            const SizedBox(height: 20),
            FilledButton.icon(
              key: const Key('confirm-stop-charging'),
              style: FilledButton.styleFrom(
                backgroundColor: colors.error,
                foregroundColor: colors.onError,
              ),
              icon: const Icon(Icons.stop_circle_outlined),
              onPressed: canConfirm
                  ? () => Navigator.of(context).pop(true)
                  : null,
              label: Text(copy.text('Xác nhận dừng sạc', 'Confirm stop')),
            ),
            const SizedBox(height: 8),
            OutlinedButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: Text(copy.text('Hủy', 'Cancel')),
            ),
          ],
        ),
      ),
    );
  }
}

String chargeStopMessage(ChargeStopOutcome? outcome, AppCopy copy) =>
    switch (outcome) {
      null => copy.text('Đang gửi yêu cầu dừng…', 'Sending stop request…'),
      ChargeStopOutcome.pending ||
      ChargeStopOutcome.sent ||
      ChargeStopOutcome.accepted ||
      ChargeStopOutcome.effectReported => copy.text(
        'Đã ghi nhận yêu cầu dừng. Đang cập nhật tiến độ phiên.',
        'Stop request recorded. Checking charging progress.',
      ),
      ChargeStopOutcome.rejected => copy.text(
        'Trụ sạc đã từ chối yêu cầu dừng.',
        'The charge point rejected the stop request.',
      ),
      ChargeStopOutcome.timeout ||
      ChargeStopOutcome.failed ||
      ChargeStopOutcome.pendingOrUnknown => copy.text(
        'Chưa xác nhận được kết quả dừng. Đang theo dõi phiên.',
        'The stop outcome is unconfirmed. Monitoring the session.',
      ),
      ChargeStopOutcome.responseUnknown => copy.text(
        'Chưa nhận được phản hồi. Bạn có thể gửi lại cùng yêu cầu.',
        'No response received. You can retry the same request.',
      ),
      ChargeStopOutcome.notStoppable => copy.text(
        'Hiện chưa thể yêu cầu dừng phiên. Đang cập nhật tiến độ.',
        'A stop request is currently unavailable. Checking progress.',
      ),
      ChargeStopOutcome.unavailable => copy.text(
        'Không tìm thấy phiên có thể dừng từ ứng dụng.',
        'No session available to stop from the app.',
      ),
      ChargeStopOutcome.keyConflict ||
      ChargeStopOutcome.invalidRequest => copy.text(
        'Máy chủ không chấp nhận yêu cầu dừng.',
        'The server declined the stop request.',
      ),
    };
