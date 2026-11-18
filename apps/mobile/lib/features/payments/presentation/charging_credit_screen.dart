import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/app_copy.dart';
import '../../../core/widgets/flow_page.dart';
import '../../auth/application/auth_controller.dart';
import '../../charging/application/charge_session_controller.dart';
import '../../charging/domain/charge_session.dart';
import '../../charging/presentation/charge_statement_card.dart';
import '../../profile/application/profile_controller.dart';
import '../application/charging_credit_controller.dart';
import '../domain/charging_credit.dart';

class ChargingCreditScreen extends ConsumerStatefulWidget {
  const ChargingCreditScreen({super.key, this.historyOnly = false});

  final bool historyOnly;

  @override
  ConsumerState<ChargingCreditScreen> createState() =>
      _ChargingCreditScreenState();
}

class _ChargingCreditScreenState extends ConsumerState<ChargingCreditScreen> {
  int _page = 1;

  @override
  Widget build(BuildContext context) {
    final copy = AppCopy(ref.watch(profileControllerProvider).profile.language);
    final history = widget.historyOnly;
    final scope = ref.watch(authScopeProvider);
    final credit = history ? null : ref.watch(chargingCreditProvider);
    final ledgerProvider = creditLedgerProvider(_page);
    final ledger = ref.watch(ledgerProvider);
    final next = !ledger.isLoading && ledger.asData?.value.hasNext == true;
    return FlowPage(
      key: ValueKey(_page),
      title: history
          ? copy.text('Lịch sử', 'History')
          : copy.text('Tín dụng sạc', 'Charging credit'),
      showBack: context.canPop(),
      backLocation: '/profile',
      backTooltip: copy.back,
      children: [
        if (history) ...[
          Text(
            copy.text('Phiên đã quyết toán', 'Settled charging sessions'),
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 12),
        ],
        if (credit != null) ...[
          credit.when(
            skipLoadingOnRefresh: false,
            data: (summary) => _SummaryCard(summary: summary, copy: copy),
            loading: () => const LinearProgressIndicator(),
            error: (_, _) => FailureNotice(
              copy.text(
                'Chưa tải được số dư tín dụng.',
                'Credit balance is unavailable.',
              ),
            ),
          ),
          OutlinedButton(
            key: const Key('refresh-credit-balance'),
            onPressed: credit.isLoading
                ? null
                : () => ref.invalidate(chargingCreditProvider),
            child: Text(
              credit.hasError
                  ? copy.text('Thử tải lại số dư', 'Retry balance')
                  : copy.text('Cập nhật số dư', 'Refresh balance'),
            ),
          ),
          const SizedBox(height: 20),
          Text(
            copy.text('Giao dịch tín dụng', 'Credit transactions'),
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 12),
        ],
        ledger.when(
          skipLoadingOnRefresh: false,
          data: (page) {
            final items = history ? page.sessionDebits.toList() : page.items;
            return InfoCard(
              children: [
                if (items.isEmpty)
                  Text(
                    history
                        ? (page.total == 0
                              ? copy.text(
                                  'Chưa có phiên đã quyết toán.',
                                  'No settled charging sessions yet.',
                                )
                              : copy.text(
                                  'Trang này không có phiên đã quyết toán.',
                                  'This page has no settled charging sessions.',
                                ))
                        : _page == 1
                        ? copy.text(
                            'Chưa có giao dịch.',
                            'No transactions yet.',
                          )
                        : copy.text(
                            'Trang này không còn giao dịch.',
                            'This page has no transactions.',
                          ),
                  ),
                for (final (index, item) in items.indexed)
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      ValueLine(
                        _ledgerLabel(item.kind, copy),
                        _money(item.amountVnd, copy, signed: true),
                        showDivider: false,
                      ),
                      Text(
                        ict(item.createdAt),
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                      if (history && item.sessionId != null)
                        TextButton(
                          onPressed: () => _openStatement((
                            scope: scope,
                            id: item.sessionId!,
                          ), copy),
                          child: Text(
                            copy.text('Xem bảng kê', 'View statement'),
                          ),
                        ),
                      if (index < items.length - 1) const Divider(),
                    ],
                  ),
              ],
            );
          },
          loading: () => const LinearProgressIndicator(),
          error: (_, _) => FailureNotice(
            copy.text(
              history
                  ? 'Chưa tải được các phiên đã quyết toán.'
                  : 'Chưa tải được giao dịch tín dụng.',
              history
                  ? 'Settled charging sessions are unavailable.'
                  : 'Credit transactions are unavailable.',
            ),
          ),
        ),
        if (ledger.hasError && !ledger.isLoading)
          OutlinedButton(
            key: const Key('retry-credit-ledger'),
            onPressed: () => ref.invalidate(ledgerProvider),
            child: Text(
              copy.text('Thử tải lại giao dịch', 'Retry transactions'),
            ),
          ),
        if (_page > 1 || next)
          Wrap(
            alignment: WrapAlignment.spaceBetween,
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: 8,
            runSpacing: 8,
            children: [
              TextButton(
                onPressed: _page > 1 && !ledger.isLoading
                    ? () => setState(() => _page--)
                    : null,
                child: Text(copy.text('Trang trước', 'Previous page')),
              ),
              Text(copy.text('Trang $_page', 'Page $_page')),
              TextButton(
                onPressed: next ? () => setState(() => _page++) : null,
                child: Text(copy.text('Trang sau', 'Next page')),
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
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: statement.isLoading
                  ? const LinearProgressIndicator()
                  : ChargeStatementCard(
                      copy: copy,
                      statement: statement.asData?.value,
                      issue: error is ChargeSessionException
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

class _SummaryCard extends StatelessWidget {
  const _SummaryCard({required this.summary, required this.copy});

  final ChargingCredit summary;
  final AppCopy copy;

  @override
  Widget build(BuildContext context) => InfoCard(
    children: [
      ValueLine(
        copy.text('Khả dụng', 'Available'),
        _money(summary.availableVnd, copy),
      ),
      ValueLine(
        copy.text('Số dư', 'Balance'),
        _money(summary.balanceVnd, copy),
      ),
      ValueLine(
        copy.text('Đang giữ cho phiên', 'Held for charging'),
        _money(summary.heldVnd, copy),
      ),
      ValueLine(copy.text('Trạng thái', 'Status'), switch (summary.status) {
        CreditStatus.active => copy.text('Đang hoạt động', 'Active'),
        CreditStatus.inShortfall => copy.text(
          'Thiếu hụt tín dụng',
          'Credit shortfall',
        ),
        CreditStatus.closed => copy.text('Đã đóng', 'Closed'),
        CreditStatus.none => copy.text(
          'Chưa có tài khoản tín dụng',
          'No credit account yet',
        ),
      }, showDivider: false),
    ],
  );
}

String _money(int value, AppCopy copy, {bool signed = false}) {
  final absolute = vnd(value.abs());
  final amount = copy.text(
    absolute,
    absolute.replaceAll('.', ',').replaceFirst(' đ', ' VND'),
  );
  final sign = value < 0
      ? '−'
      : signed && value > 0
      ? '+'
      : '';
  return '$sign$amount';
}

String _ledgerLabel(LedgerKind kind, AppCopy copy) => switch (kind) {
  LedgerKind.topUp => copy.text('Nạp tín dụng', 'Top-up'),
  LedgerKind.sessionDebit => copy.text(
    'Thanh toán phiên sạc',
    'Charging debit',
  ),
  LedgerKind.refund => copy.text('Hoàn tiền', 'Refund'),
  LedgerKind.adjustment => copy.text('Điều chỉnh', 'Adjustment'),
  LedgerKind.reservationFee => copy.text('Phí giữ chỗ', 'Reservation fee'),
};
