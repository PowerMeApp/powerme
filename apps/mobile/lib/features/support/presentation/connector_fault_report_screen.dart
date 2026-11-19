import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/brand_mark.dart';
import '../../../core/widgets/driver_task_page.dart';
import '../../../core/widgets/flow_page.dart';
import '../../profile/application/profile_controller.dart';
import '../application/connector_fault_report_controller.dart';
import '../domain/connector_fault_report.dart';

class ConnectorFaultReportScreen extends ConsumerStatefulWidget {
  const ConnectorFaultReportScreen({super.key, required this.target});

  final FaultReportTarget target;

  @override
  ConsumerState<ConnectorFaultReportScreen> createState() =>
      _ConnectorFaultReportScreenState();
}

class _ConnectorFaultReportScreenState
    extends ConsumerState<ConnectorFaultReportScreen> {
  final _description = TextEditingController();

  @override
  void dispose() {
    _description.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final copy = AppCopy(ref.watch(profileControllerProvider).profile.language);
    final valid = ref.watch(validFaultReportTargetProvider(widget.target));
    final provider = connectorFaultReportProvider(widget.target);
    final report = ref.watch(provider);
    final receipt = report.receipt;
    final route = ModalRoute.of(context);
    final unavailable = !valid || report.issue == FaultReportIssue.missing;
    final duplicate = report.issue == FaultReportIssue.duplicate;

    void back() => context.canPop() ? context.pop() : context.go('/discover');
    void submit() {
      FocusScope.of(context).unfocus();
      ref
          .read(provider.notifier)
          .submit(
            _description.text,
            () => mounted && (route?.isCurrent ?? false),
          );
    }

    final target = InfoCard(
      children: [
        Row(
          children: [
            const ChargingMark(
              size: 40,
              backgroundColor: PowerMeColors.graphite,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    copy.text('Cổng sạc', 'Connector'),
                    style: Theme.of(context).textTheme.labelMedium?.copyWith(
                      color: PowerMeColors.gold,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    widget.target.label,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ],
              ),
            ),
          ],
        ),
      ],
    );

    final close = FilledButton.icon(
      onPressed: back,
      icon: const Icon(Icons.arrow_back_rounded),
      label: Text(
        copy.text('Quay lại chọn cổng', 'Go back to connectors'),
        textAlign: TextAlign.center,
      ),
    );

    return DriverTaskPage(
      key: ValueKey((unavailable, receipt != null, duplicate)),
      backTooltip: copy.back,
      onBack: back,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (unavailable) ...[
            DriverTaskStatus(
              icon: Icons.power_off_outlined,
              color: Theme.of(context).colorScheme.error,
              title: copy.text(
                'Cổng sạc không khả dụng',
                'Connector unavailable',
              ),
              message: valid
                  ? copy.text(
                      'Cổng sạc này hiện không nhận báo lỗi.',
                      'This connector is unavailable for reporting.',
                    )
                  : copy.text(
                      'Cổng sạc đã thay đổi. Hãy quay lại và chọn cổng.',
                      'The connector has changed. Go back and choose a connector.',
                    ),
            ),
            target,
            if (context.canPop()) ...[close, const SizedBox(height: 8)],
            OutlinedButton.icon(
              onPressed: () => context.go('/discover'),
              icon: const Icon(Icons.explore_outlined),
              label: Text(
                copy.text('Khám phá trạm sạc', 'Explore charging stations'),
                textAlign: TextAlign.center,
              ),
            ),
          ] else if (receipt != null) ...[
            ..._receipt(receipt, copy),
            FilledButton(
              onPressed: back,
              child: Text(
                copy.text('Hoàn tất và quay lại', 'Done and go back'),
                textAlign: TextAlign.center,
              ),
            ),
          ] else if (duplicate) ...[
            DriverTaskStatus(
              icon: Icons.history_rounded,
              color: PowerMeColors.gold,
              title: copy.text(
                'Báo lỗi đã được gửi',
                'Report already submitted',
              ),
              message: copy.text(
                'Bạn vừa gửi báo lỗi cho cổng này. Hãy đợi ít nhất 60 giây giữa hai lần gửi.',
                'You recently reported this connector. Wait at least 60 seconds between reports.',
              ),
            ),
            target,
            close,
            const SizedBox(height: 8),
            OutlinedButton(
              key: const Key('send-connector-fault'),
              onPressed: submit,
              child: Text(
                copy.text('Thử gửi lại báo lỗi', 'Retry report'),
                textAlign: TextAlign.center,
              ),
            ),
          ] else ...[
            Semantics(
              header: true,
              child: Text(
                copy.text('Báo lỗi cổng sạc', 'Report a connector issue'),
                style: Theme.of(context).textTheme.headlineMedium,
              ),
            ),
            const SizedBox(height: 16),
            target,
            ..._form(report, copy, submit),
          ],
        ],
      ),
    );
  }

  List<Widget> _form(
    ConnectorFaultReportState report,
    AppCopy copy,
    VoidCallback submit,
  ) => [
    DriverTaskHeading(copy.text('Mô tả sự cố', 'Describe the issue')),
    const SizedBox(height: 8),
    TextField(
      key: const Key('connector-fault-description'),
      controller: _description,
      enabled: !report.busy,
      keyboardType: TextInputType.multiline,
      minLines: 4,
      maxLines: 8,
      decoration: InputDecoration(
        labelText: copy.text('Mô tả lỗi', 'Issue description'),
        alignLabelWithHint: true,
        hintText: copy.text(
          'Bạn gặp vấn đề gì khi dùng cổng sạc?',
          'What happened when you used the connector?',
        ),
      ),
    ),
    const SizedBox(height: 8),
    Text(
      copy.text(
        '5–500 ký tự sau khi bỏ khoảng trắng ở hai đầu.',
        '5–500 characters after trimming spaces at both ends.',
      ),
      style: Theme.of(context).textTheme.bodySmall,
    ),
    ListenableBuilder(
      listenable: _description,
      builder: (context, _) {
        final count = _description.text.runes.length;
        return Text(
          copy.text('Đã nhập $count ký tự', 'Characters entered: $count'),
          textAlign: TextAlign.end,
          style: Theme.of(context).textTheme.bodySmall,
        );
      },
    ),
    const SizedBox(height: 16),
    if (report.issue == FaultReportIssue.invalid)
      FailureNotice(
        copy.text(
          'Nhập mô tả từ 5 đến 500 ký tự và bỏ ký tự điều khiển.',
          'Enter 5 to 500 characters and remove any control characters.',
        ),
      ),
    if (report.issue == FaultReportIssue.unavailable)
      FailureNotice(
        copy.text(
          'Chưa xác nhận được báo lỗi. Hãy thử gửi lại.',
          'We could not confirm your report. Try submitting again.',
        ),
      ),
    FilledButton.icon(
      key: const Key('send-connector-fault'),
      onPressed: report.busy ? null : submit,
      icon: const Icon(Icons.send_outlined),
      label: Text(
        report.busy
            ? copy.text('Đang gửi…', 'Submitting…')
            : copy.text('Gửi báo lỗi', 'Submit report'),
        textAlign: TextAlign.center,
      ),
    ),
  ];

  List<Widget> _receipt(FaultReportReceipt receipt, AppCopy copy) => [
    DriverTaskStatus(
      icon: Icons.check_rounded,
      color: PowerMeColors.teal,
      title: copy.text('Đã nhận báo lỗi', 'Report received'),
      message: receipt.faultEventId == null
          ? copy.text(
              'Báo cáo đã được lưu để xử lý.',
              'Your report was saved for review.',
            )
          : copy.text(
              'Cảm ơn bạn. Đơn vị vận hành đã được thông báo.',
              'Thanks. The operator has been notified.',
            ),
    ),
    InfoCard(
      spacing: 8,
      children: [
        DriverTaskHeading(
          copy.text('Mã báo lỗi', 'Report number'),
          icon: Icons.receipt_long_outlined,
        ),
        Text(
          receipt.number,
          style: Theme.of(
            context,
          ).textTheme.headlineMedium?.copyWith(color: PowerMeColors.teal),
        ),
        const Divider(),
        ValueLine(copy.text('Cổng sạc', 'Connector'), widget.target.label),
        ValueLine(
          copy.text('Thời gian tiếp nhận', 'Received at'),
          '${ict(receipt.reportedAt)} ICT',
          showDivider: false,
        ),
        if (receipt.reportedIssue)
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: StatusBadge(
              copy.text(
                'Cổng đã được báo lỗi.',
                'The connector is marked as reported.',
              ),
            ),
          ),
      ],
    ),
  ];
}
