import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/flow_page.dart';
import '../../profile/application/profile_controller.dart';
import '../../profile/domain/driver_profile.dart';
import '../application/support_controller.dart';

class ReportScreen extends ConsumerStatefulWidget {
  const ReportScreen({super.key, required this.connector});
  final String connector;
  @override
  ConsumerState<ReportScreen> createState() => _ReportScreenState();
}

class _ReportScreenState extends ConsumerState<ReportScreen> {
  final note = TextEditingController();
  String category = 'Không khởi động';
  @override
  void initState() {
    super.initState();
    Future.microtask(() {
      if (mounted) ref.read(supportControllerProvider.notifier).clear();
    });
  }

  @override
  void dispose() {
    note.dispose();
    super.dispose();
  }

  AppCopy _safeCopy() {
    try {
      return AppCopy(ref.watch(profileControllerProvider).profile.language);
    } catch (_) {
      return const AppCopy(AppLanguage.vietnamese);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(supportControllerProvider);
    final copy = _safeCopy();
    final text = Theme.of(context).textTheme;
    return FlowPage(
      title: copy.text('Báo lỗi cổng sạc', 'Report connector issue'),
      backTooltip: copy.back,
      children: [
        Text(
          ref.watch(reportConnectorLabelProvider(widget.connector)),
          style: text.titleMedium,
        ),
        const SizedBox(height: 16),
        if (s.report != null)
          InfoCard(
            spacing: 12,
            children: [
              const Align(
                alignment: Alignment.centerLeft,
                child: Icon(
                  Icons.check_circle_outline,
                  size: 40,
                  color: PowerMeColors.teal,
                ),
              ),
              Text(
                copy.text('Đã nhận báo lỗi', 'Report received'),
                style: text.titleLarge,
              ),
              Text(
                copy.text(
                  'Thông tin đã được lưu để xử lý.',
                  'Your report has been saved for processing.',
                ),
              ),
              ValueLine(copy.text('Mã báo lỗi', 'Report ID'), s.report!.id),
              ValueLine(
                copy.text('Thời gian tiếp nhận', 'Received at'),
                ict(s.report!.savedAt),
                showDivider: false,
              ),
              FilledButton.icon(
                key: const Key('report-back'),
                onPressed: () =>
                    context.canPop() ? context.pop() : context.go('/'),
                icon: const Icon(Icons.arrow_back_rounded),
                label: Text(copy.back),
              ),
            ],
          )
        else
          InfoCard(
            spacing: 14,
            children: [
              DropdownButtonFormField<String>(
                initialValue: category,
                isExpanded: true,
                decoration: InputDecoration(
                  labelText: copy.text('Loại lỗi', 'Issue category'),
                  fillColor: PowerMeColors.black,
                  prefixIcon: const Icon(Icons.report_problem_outlined),
                ),
                items: [
                  DropdownMenuItem(
                    value: 'Không khởi động',
                    child: Text(copy.text('Không khởi động', 'Fails to start')),
                  ),
                  DropdownMenuItem(
                    value: 'Cáp / đầu nối',
                    child: Text(
                      copy.text('Cáp / đầu nối', 'Cable / connector'),
                    ),
                  ),
                  DropdownMenuItem(
                    value: 'Màn hình',
                    child: Text(copy.text('Màn hình', 'Display screen')),
                  ),
                  DropdownMenuItem(
                    value: 'Khác',
                    child: Text(copy.text('Khác', 'Other')),
                  ),
                ],
                onChanged: s.busy ? null : (v) => setState(() => category = v!),
              ),
              TextField(
                key: const Key('report-note'),
                controller: note,
                maxLines: 4,
                maxLength: 500,
                decoration: InputDecoration(
                  labelText: copy.text(
                    'Mô tả lỗi (5–500 ký tự)',
                    'Issue description (5–500 characters)',
                  ),
                  fillColor: PowerMeColors.black,
                ),
              ),
              FailureNotice(s.error),
              FilledButton(
                key: const Key('send-report'),
                onPressed: s.busy
                    ? null
                    : () => ref
                          .read(supportControllerProvider.notifier)
                          .submit(widget.connector, category, note.text),
                child: Text(
                  s.busy
                      ? copy.text('Đang gửi…', 'Submitting…')
                      : copy.text('Gửi báo lỗi', 'Submit report'),
                ),
              ),
            ],
          ),
      ],
    );
  }
}
