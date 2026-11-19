import 'package:flutter/material.dart';

import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/flow_page.dart';
import '../domain/charge_session.dart';
import 'charge_energy_label.dart';
import 'charge_mode_widgets.dart';

class ChargeStatementCard extends StatelessWidget {
  const ChargeStatementCard({
    super.key,
    required this.copy,
    required this.statement,
    required this.issue,
    required this.retry,
    required this.sessionId,
    this.onClose,
    this.progress,
  });

  final AppCopy copy;
  final PostedChargeStatement? statement;
  final ChargeSessionIssue? issue;
  final VoidCallback? retry;
  final String sessionId;
  final VoidCallback? onClose;
  final ChargeProgress? progress;

  @override
  Widget build(BuildContext context) {
    final posted = statement;
    final type = Theme.of(context).textTheme;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Semantics(
                header: true,
                child: Text(
                  copy.text('Bảng kê phiên sạc', 'Charging statement'),
                  style: type.headlineSmall?.copyWith(
                    color: PowerMeColors.gold,
                  ),
                ),
              ),
            ),
            if (onClose != null)
              IconButton.filledTonal(
                tooltip: copy.text('Đóng bảng kê', 'Close statement'),
                onPressed: onClose,
                icon: const Icon(Icons.close),
              ),
          ],
        ),
        const SizedBox(height: 12),
        if (posted != null) ...[
          Align(
            alignment: Alignment.centerLeft,
            child: StatusBadge(copy.text('Đã quyết toán', 'Settled')),
          ),
          const SizedBox(height: 12),
          InfoCard(
            spacing: 0,
            children: [
              ValueLine(copy.text('Mã phiên sạc', 'Session ID'), sessionId),
              if (progress != null) ...[
                ValueLine(
                  copy.text('Chế độ sạc', 'Charging mode'),
                  chargeModeLabel(progress!.billingMode, copy),
                ),
                ValueLine(
                  copy.text('Mục tiêu', 'Target'),
                  chargeTargetLabel(
                    progress!.billingMode,
                    progress!.limitValue,
                    copy,
                  ),
                ),
              ],
              ValueLine(
                copy.text('Ngày lập', 'Posted'),
                ictDateTime(posted.createdAt),
                showDivider: false,
              ),
            ],
          ),
          HeroCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  copy.text('Điện năng quyết toán', 'Settled energy'),
                  style: type.labelLarge,
                ),
                const SizedBox(height: 6),
                Text(
                  chargeEnergyLabel(posted.energyWh, copy),
                  style: type.headlineLarge?.copyWith(
                    color: PowerMeColors.teal,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          InfoCard(
            spacing: 0,
            children: [
              Text(
                copy.text('Tín dụng đã trừ', 'Credit debited'),
                style: type.labelLarge,
              ),
              const SizedBox(height: 4),
              Text(
                vnd(posted.amountVnd),
                style: type.headlineSmall?.copyWith(color: PowerMeColors.gold),
              ),
              const Divider(height: 24),
              ValueLine(
                copy.text('Điểm nhận được', 'Points earned'),
                '${posted.earnedPoints}',
                showDivider: false,
              ),
            ],
          ),
        ] else if (issue != null) ...[
          FailureNotice(switch (issue!) {
            ChargeSessionIssue.unavailable => copy.text(
              'Bảng kê chưa có. Bạn có thể thử tải lại.',
              'The statement is not available yet. You can try again.',
            ),
            ChargeSessionIssue.retry => copy.text(
              'Chưa tải được bảng kê.',
              'The statement could not be loaded.',
            ),
          }),
          OutlinedButton(
            onPressed: retry,
            child: Text(copy.text('Tải lại bảng kê', 'Retry statement')),
          ),
        ] else ...[
          Semantics(
            liveRegion: true,
            child: Text(copy.text('Đang tải bảng kê…', 'Loading statement…')),
          ),
          const SizedBox(height: 16),
        ],
      ],
    );
  }
}
