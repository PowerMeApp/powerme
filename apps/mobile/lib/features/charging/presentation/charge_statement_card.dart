import 'package:flutter/material.dart';

import '../../../core/l10n/app_copy.dart';
import '../../../core/widgets/flow_page.dart';
import '../domain/charge_session.dart';
import 'charge_energy_label.dart';

class ChargeStatementCard extends StatelessWidget {
  const ChargeStatementCard({
    super.key,
    required this.copy,
    required this.statement,
    required this.issue,
    required this.retry,
  });

  final AppCopy copy;
  final PostedChargeStatement? statement;
  final ChargeSessionIssue? issue;
  final VoidCallback? retry;

  @override
  Widget build(BuildContext context) {
    final posted = statement;
    return InfoCard(
      children: [
        Text(
          copy.text('Bảng kê phiên sạc', 'Charging statement'),
          style: Theme.of(context).textTheme.titleLarge,
        ),
        if (posted != null) ...[
          ValueLine(
            copy.text('Điện năng quyết toán', 'Settled energy'),
            chargeEnergyLabel(posted.energyWh, copy),
          ),
          ValueLine(
            copy.text('Tín dụng đã trừ', 'Credit debited'),
            vnd(posted.amountVnd),
          ),
          ValueLine(
            copy.text('Điểm nhận được', 'Points earned'),
            '${posted.earnedPoints}',
          ),
          ValueLine(
            copy.text('Ngày lập (ICT)', 'Posted (ICT)'),
            ict(posted.createdAt),
            showDivider: false,
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
        ] else
          Text(copy.text('Đang tải bảng kê…', 'Loading statement…')),
      ],
    );
  }
}
