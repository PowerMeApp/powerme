import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/l10n/app_copy.dart';
import '../../../core/widgets/flow_page.dart';
import '../../auth/application/auth_controller.dart';
import '../../charging/application/charge_session_controller.dart';
import '../../charging/application/charge_start_controller.dart';
import '../../charging/application/owned_sessions_controller.dart';
import '../../charging/domain/charge_session.dart';
import '../../charging/presentation/owned_session_card.dart';
import '../../charging/presentation/charge_statement_card.dart';
import '../../profile/application/profile_controller.dart';

class OwnedSessionHistoryScreen extends ConsumerWidget {
  const OwnedSessionHistoryScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) =>
      _HistoryBody(key: ValueKey(ref.watch(authScopeProvider)));
}

class _HistoryBody extends ConsumerStatefulWidget {
  const _HistoryBody({super.key});
  @override
  ConsumerState<_HistoryBody> createState() => _HistoryBodyState();
}

class _HistoryBodyState extends ConsumerState<_HistoryBody> {
  int _page = 1;
  @override
  Widget build(BuildContext context) {
    final copy = AppCopy(ref.watch(profileControllerProvider).profile.language);
    final scope = ref.watch(authScopeProvider);
    ref.watch(chargeStopProvider);
    ref.watch(chargeStartProvider);
    final provider = ownedSessionPageProvider(_page);
    final sessions = ref.watch(provider);
    final page = sessions.asData?.value;
    return FlowPage(
      title: copy.text('Lịch sử sạc', 'Charging history'),
      showBack: context.canPop(),
      backLocation: '/profile',
      backTooltip: copy.back,
      children: [
        Text(
          copy.text('Các phiên sạc của bạn', 'Your charging sessions'),
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        const SizedBox(height: 16),
        ...sessions.when<List<Widget>>(
          skipLoadingOnRefresh: false,
          loading: () => [
            Text(
              copy.text('Đang tải phiên sạc…', 'Loading charging sessions…'),
            ),
          ],
          error: (_, _) => [
            FailureNotice(
              copy.text(
                'Chưa tải được lịch sử sạc.',
                'Charging history unavailable.',
              ),
            ),
            OutlinedButton(
              onPressed: () => ref.invalidate(provider),
              child: Text(copy.text('Thử lại', 'Retry')),
            ),
          ],
          data: (page) => [
            if (page.items.isEmpty)
              InfoCard(
                children: [
                  Text(
                    page.total == 0
                        ? copy.text(
                            'Chưa có phiên sạc.',
                            'No charging sessions yet.',
                          )
                        : copy.text(
                            'Trang này không có phiên sạc.',
                            'No charging sessions on this page.',
                          ),
                  ),
                ],
              ),
            for (final item in page.items)
              OwnedSessionCard(
                item: item,
                compact: true,
                copy: copy,
                onProgress:
                    !ref
                        .read(selectedChargeSessionProvider.notifier)
                        .canSelectAnotherSession((scope: scope, id: item.id))
                    ? null
                    : () {
                        if (ref
                            .read(selectedChargeSessionProvider.notifier)
                            .select(
                              item,
                              target: (scope: scope, id: item.id),
                            )) {
                          context.go('/charge-session');
                        } else {
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(
                              content: Text(
                                copy.text(
                                  'Hoàn tất yêu cầu sạc hiện tại trước khi đổi phiên.',
                                  'Resolve the current charging request before switching sessions.',
                                ),
                              ),
                            ),
                          );
                        }
                      },
                onStatement: () =>
                    _openStatement((scope: scope, id: item.id), copy),
              ),
          ],
        ),
        if (page != null)
          Text(
            '${copy.text('Trang', 'Page')} $_page · ${page.total} ${copy.text('phiên', 'sessions')}',
          ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 12,
          runSpacing: 8,
          children: [
            OutlinedButton(
              onPressed: !sessions.isLoading && _page > 1
                  ? () => setState(() => _page--)
                  : null,
              child: Text(copy.text('Trang trước', 'Previous page')),
            ),
            OutlinedButton(
              onPressed: !sessions.isLoading && page?.hasNext == true
                  ? () => setState(() => _page++)
                  : null,
              child: Text(copy.text('Trang sau', 'Next page')),
            ),
            OutlinedButton(
              onPressed: sessions.isLoading
                  ? null
                  : () => ref.invalidate(provider),
              child: Text(copy.text('Tải lại lịch sử', 'Refresh history')),
            ),
          ],
        ),
      ],
    );
  }

  void _openStatement(ChargeSessionTarget target, AppCopy copy) {
    if (ref.read(authScopeProvider) != target.scope) return;
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      builder: (context) => Consumer(
        builder: (context, ref, _) {
          if (ref.watch(authScopeProvider) != target.scope) {
            return const SizedBox.shrink();
          }
          final provider = postedChargeStatementProvider(target);
          final statement = ref.watch(provider);
          final error = statement.error;
          return SafeArea(
            top: false,
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
              child: ChargeStatementCard(
                copy: copy,
                sessionId: target.id,
                onClose: () => Navigator.of(context).pop(),
                statement: statement.isLoading ? null : statement.asData?.value,
                issue: statement.isLoading
                    ? null
                    : error is ChargeSessionException
                    ? error.issue
                    : statement.hasError
                    ? ChargeSessionIssue.retry
                    : null,
                retry: () => ref.invalidate(provider),
              ),
            ),
          );
        },
      ),
    );
  }
}
