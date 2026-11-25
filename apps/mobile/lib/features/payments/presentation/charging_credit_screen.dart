import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
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
          ? copy.text('Lịch sử sạc', 'Charging history')
          : copy.text('Tín dụng sạc', 'Charging credit'),
      showBack: context.canPop(),
      backLocation: '/profile',
      backTooltip: copy.back,
      children: [
        if (history) ...[
          Semantics(
            header: true,
            child: Text(
              copy.text('Phiên đã quyết toán', 'Settled charging sessions'),
              style: Theme.of(context).textTheme.headlineSmall,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            copy.text(
              'Xem số tiền đã trừ và bảng kê từng phiên.',
              'See the amount debited and the statement for each session.',
            ),
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: 16),
        ],
        if (credit != null) ...[
          _BalanceCard(
            credit: credit,
            copy: copy,
            onRefresh: () => ref.invalidate(chargingCreditProvider),
          ),
          const SizedBox(height: 24),
          Semantics(
            header: true,
            child: Text(
              copy.text('Giao dịch tín dụng', 'Credit transactions'),
              style: Theme.of(context).textTheme.titleLarge,
            ),
          ),
          const SizedBox(height: 12),
        ],
        ...ledger.when<List<Widget>>(
          skipLoadingOnRefresh: false,
          data: (page) {
            final items = history ? page.sessionDebits.toList() : page.items;
            return [
              if (items.isEmpty)
                InfoCard(
                  children: [
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
                  ],
                ),
              for (final (index, item) in items.indexed)
                if (history)
                  _HistoryCard(
                    item: item,
                    copy: copy,
                    latest: _page == 1 && index == 0,
                    onStatement: switch (item.sessionId) {
                      final id? => () => _openStatement((
                        scope: scope,
                        id: id,
                      ), copy),
                      null => null,
                    },
                  )
                else
                  _TransactionCard(item: item, copy: copy),
            ];
          },
          loading: () => [
            LinearProgressIndicator(
              semanticsLabel: copy.text(
                'Đang tải giao dịch',
                'Loading transactions',
              ),
            ),
          ],
          error: (_, _) => [
            FailureNotice(
              copy.text(
                history
                    ? 'Chưa tải được các phiên đã quyết toán.'
                    : 'Chưa tải được giao dịch tín dụng.',
                history
                    ? 'Settled charging sessions are unavailable.'
                    : 'Credit transactions are unavailable.',
              ),
            ),
          ],
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

class _BalanceCard extends StatelessWidget {
  const _BalanceCard({
    required this.credit,
    required this.copy,
    required this.onRefresh,
  });

  final AsyncValue<ChargingCredit> credit;
  final AppCopy copy;
  final VoidCallback onRefresh;

  @override
  Widget build(BuildContext context) => HeroCard(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        credit.when(
          skipLoadingOnRefresh: false,
          data: (summary) => _BalanceReadout(summary: summary, copy: copy),
          loading: () => LinearProgressIndicator(
            semanticsLabel: copy.text('Đang tải số dư', 'Loading balance'),
          ),
          error: (_, _) => FailureNotice(
            copy.text(
              'Chưa tải được số dư tín dụng.',
              'Credit balance is unavailable.',
            ),
          ),
        ),
        const SizedBox(height: 16),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            FilledButton(
              key: const Key('open-credit-top-up'),
              onPressed: () => context.push('/credit/top-up'),
              child: Text(
                copy.text('Nạp tín dụng', 'Top up credit'),
                textAlign: TextAlign.center,
              ),
            ),
            OutlinedButton(
              key: const Key('refresh-credit-balance'),
              onPressed: credit.isLoading ? null : onRefresh,
              child: Text(
                credit.hasError
                    ? copy.text('Thử tải lại số dư', 'Retry balance')
                    : copy.text('Cập nhật số dư', 'Refresh balance'),
                textAlign: TextAlign.center,
              ),
            ),
          ],
        ),
      ],
    ),
  );
}

class _BalanceReadout extends StatelessWidget {
  const _BalanceReadout({required this.summary, required this.copy});

  final ChargingCredit summary;
  final AppCopy copy;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        copy.text('Số dư khả dụng', 'Available balance'),
        style: Theme.of(context).textTheme.labelLarge,
      ),
      const SizedBox(height: 6),
      Text(
        _money(summary.availableVnd, copy),
        style: Theme.of(context).textTheme.headlineLarge?.copyWith(
          color: PowerMeColors.teal,
          fontSize: 36,
          fontFeatures: const [FontFeature.tabularFigures()],
        ),
      ),
      const SizedBox(height: 10),
      ValueLine(
        copy.text('Số dư', 'Balance'),
        _money(summary.balanceVnd, copy),
      ),
      ValueLine(
        copy.text('Đang giữ cho phiên', 'Held for charging'),
        _money(summary.heldVnd, copy),
        showDivider: false,
      ),
      const SizedBox(height: 8),
      StatusBadge(
        switch (summary.status) {
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
        },
        color: summary.status == CreditStatus.active
            ? PowerMeColors.teal
            : PowerMeColors.gold,
      ),
    ],
  );
}

class _TransactionCard extends StatelessWidget {
  const _TransactionCard({required this.item, required this.copy});

  final LedgerEntry item;
  final AppCopy copy;

  @override
  Widget build(BuildContext context) {
    final type = Theme.of(context).textTheme;
    final received = item.amountVnd > 0;
    return InfoCard(
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _LedgerIcon(
              icon: switch (item.kind) {
                LedgerKind.topUp => Icons.account_balance_wallet_outlined,
                LedgerKind.sessionDebit => Icons.ev_station_outlined,
                LedgerKind.refund => Icons.replay,
                LedgerKind.adjustment => Icons.tune,
                LedgerKind.reservationFee => Icons.event_outlined,
              },
              color: received ? PowerMeColors.teal : PowerMeColors.gold,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(_ledgerLabel(item.kind, copy), style: type.titleMedium),
                  Text(ictDateTime(item.createdAt), style: type.bodySmall),
                  if (item.sessionId case final id?)
                    Text(_sessionLabel(id, copy), style: type.bodySmall),
                  const SizedBox(height: 6),
                  Text(
                    _money(item.amountVnd, copy, signed: true),
                    style: type.titleMedium?.copyWith(
                      color: received ? PowerMeColors.teal : PowerMeColors.text,
                      fontFeatures: const [FontFeature.tabularFigures()],
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ],
    );
  }
}

class _HistoryCard extends StatelessWidget {
  const _HistoryCard({
    required this.item,
    required this.copy,
    required this.latest,
    required this.onStatement,
  });

  final LedgerEntry item;
  final AppCopy copy;
  final bool latest;
  final VoidCallback? onStatement;

  @override
  Widget build(BuildContext context) {
    final type = Theme.of(context).textTheme;
    return InfoCard(
      spacing: 8,
      children: [
        Row(
          children: [
            const _LedgerIcon(
              icon: Icons.bolt_rounded,
              color: PowerMeColors.teal,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                _ledgerLabel(item.kind, copy),
                style: type.titleMedium,
              ),
            ),
          ],
        ),
        Wrap(
          spacing: 8,
          runSpacing: 6,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            StatusBadge(copy.text('Đã quyết toán', 'Settled')),
            if (latest)
              Text(copy.text('Gần nhất', 'Latest'), style: type.bodySmall),
          ],
        ),
        if (item.sessionId case final id?)
          Text(_sessionLabel(id, copy), style: type.bodyMedium),
        Text(ictDateTime(item.createdAt), style: type.bodySmall),
        const Divider(height: 1),
        ValueLine(
          copy.text('Tín dụng đã trừ', 'Credit debited'),
          _money(item.amountVnd, copy, signed: true),
          showDivider: false,
        ),
        if (onStatement != null)
          OutlinedButton(
            onPressed: onStatement,
            child: Text(
              copy.text('Xem bảng kê', 'View statement'),
              textAlign: TextAlign.center,
            ),
          ),
      ],
    );
  }
}

class _LedgerIcon extends StatelessWidget {
  const _LedgerIcon({required this.icon, required this.color});

  final IconData icon;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    width: 36,
    height: 36,
    decoration: BoxDecoration(
      color: color.withValues(alpha: .12),
      borderRadius: BorderRadius.circular(10),
    ),
    child: Icon(icon, color: color, size: 20),
  );
}

String _sessionLabel(String id, AppCopy copy) =>
    copy.text('Mã phiên sạc $id', 'Session ID $id');

String _money(int value, AppCopy copy, {bool signed = false}) =>
    vnd(value, copy: copy, signed: signed);

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
