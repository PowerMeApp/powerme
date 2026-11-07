import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/l10n/app_copy.dart';
import '../../../core/widgets/flow_page.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../profile/application/profile_controller.dart';
import '../application/history_controller.dart';
import '../../charging/domain/charging.dart';
import '../../charging/presentation/charging_screens.dart';
import '../../payments/domain/payments.dart';
import '../../payments/presentation/payment_screens.dart';

class HistoryScreen extends ConsumerWidget {
  const HistoryScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final view = ref.watch(historyProvider);
    final copy = AppCopy(ref.watch(profileControllerProvider).profile.language);
    final h = view.asData?.value;
    final text = Theme.of(context).textTheme;
    return FlowPage(
      title: copy.text('Lịch sử và hóa đơn', 'History and invoices'),
      backTooltip: copy.back,
      children: [
        if (view.isLoading) ...[
          const LinearProgressIndicator(),
          const SizedBox(height: 16),
        ],
        if (view.hasError) FailureNotice(failureText(view.error!)),
        OutlinedButton(
          onPressed: () => ref.invalidate(historyProvider),
          child: Text(copy.text('Cập nhật lịch sử', 'Refresh history')),
        ),
        if (h != null) ...[
          const SizedBox(height: 24),
          Text(
            copy.text(
              'Phiên sạc và bảng kê',
              'Charging sessions and statements',
            ),
            style: text.titleLarge,
          ),
          const SizedBox(height: 12),
          if (h.sessions.isEmpty)
            InfoCard(
              children: [
                Text(
                  copy.text('Chưa có phiên sạc.', 'No charging sessions yet.'),
                ),
              ],
            ),
          for (final s in h.sessions)
            InfoCard(
              spacing: 10,
              children: [
                Text(s.connectorLabel, style: text.titleMedium),
                Align(
                  alignment: Alignment.centerLeft,
                  child: StatusBadge(
                    sessionLabel(s.state, copy),
                    color: s.state == SessionState.reconciled
                        ? PowerMeColors.teal
                        : PowerMeColors.gold,
                  ),
                ),
                Text(
                  ict(s.observedAt),
                  style: text.bodyMedium?.copyWith(color: PowerMeColors.muted),
                ),
                ValueLine(
                  copy.text('Chi phí / bảng kê', 'Cost / statement'),
                  vnd(s.statement?.debitVnd ?? s.estimatedCostVnd),
                  showDivider: false,
                ),
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton(
                    onPressed: () => context.push('/statement/${s.sessionId}'),
                    child: Text(
                      copy.text('Chi tiết phiên sạc', 'Session details'),
                    ),
                  ),
                ),
              ],
            ),
          const SizedBox(height: 16),
          Text(
            copy.text('Nạp tín dụng và hóa đơn', 'Top-ups and invoices'),
            style: text.titleLarge,
          ),
          const SizedBox(height: 12),
          if (h.orders.isEmpty)
            InfoCard(
              children: [
                Text(
                  copy.text(
                    'Chưa có lần nạp hoặc hóa đơn.',
                    'No top-ups or invoices yet.',
                  ),
                ),
              ],
            ),
          for (final o in h.orders)
            InfoCard(
              spacing: 10,
              children: [
                Text(
                  vnd(o.amountVnd),
                  style: text.titleLarge?.copyWith(color: PowerMeColors.gold),
                ),
                Align(
                  alignment: Alignment.centerLeft,
                  child: StatusBadge(
                    topUpLabel(o.state, copy),
                    color: o.state == TopUpState.posted
                        ? PowerMeColors.teal
                        : PowerMeColors.gold,
                  ),
                ),
                Text(
                  '${copy.text('Hóa đơn', 'Invoice')} · ${invoiceLabel(o.invoice, copy)}',
                  style: text.bodyMedium?.copyWith(color: PowerMeColors.muted),
                ),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    TextButton(
                      onPressed: () => context.push('/invoice/${o.id}'),
                      child: Text(
                        copy.text('Chi tiết hóa đơn', 'Invoice details'),
                      ),
                    ),
                    TextButton(
                      onPressed: () => context.push('/checkout/${o.id}'),
                      child: Text(
                        copy.text('Chi tiết lần nạp', 'Top-up details'),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          const SizedBox(height: 16),
          Text(
            copy.text('Giao dịch tín dụng', 'Credit transactions'),
            style: text.titleLarge,
          ),
          const SizedBox(height: 12),
          if (h.entries.isEmpty)
            InfoCard(
              children: [
                Text(
                  copy.text(
                    'Chưa có giao dịch tín dụng.',
                    'No credit transactions yet.',
                  ),
                ),
              ],
            ),
          for (final entry in h.entries)
            InfoCard(
              spacing: 8,
              children: [
                Text(entry.label, style: text.titleMedium),
                ValueLine(
                  ict(entry.at),
                  vnd(entry.amountVnd),
                  showDivider: false,
                ),
              ],
            ),
        ],
      ],
    );
  }
}

class InvoiceScreen extends ConsumerWidget {
  const InvoiceScreen({super.key, required this.id});
  final String id;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final view = ref.watch(invoiceProvider(id));
    final copy = AppCopy(ref.watch(profileControllerProvider).profile.language);
    final o = view.asData?.value;
    return FlowPage(
      title: copy.text('Hóa đơn lần nạp', 'Top-up invoice'),
      backTooltip: copy.back,
      children: [
        if (view.isLoading) ...[
          const LinearProgressIndicator(),
          const SizedBox(height: 16),
        ],
        if (view.hasError) FailureNotice(failureText(view.error!)),
        if (o != null) ...[
          Align(
            alignment: Alignment.centerLeft,
            child: StatusBadge(
              invoiceLabel(o.invoice, copy),
              color: o.invoice == InvoiceState.issued
                  ? PowerMeColors.teal
                  : PowerMeColors.gold,
            ),
          ),
          const SizedBox(height: 14),
          InfoCard(
            children: [
              ValueLine(copy.text('Lần nạp', 'Top-up'), o.id),
              ValueLine(
                copy.text('Số tiền thu', 'Amount collected'),
                vnd(o.cashVnd),
              ),
              ValueLine(
                copy.text('Tín dụng', 'Credit'),
                topUpLabel(o.state, copy),
                showDivider: false,
              ),
              Text(
                copy.text(
                  'Hóa đơn thuộc lần nạp tín dụng. Bảng kê phiên sạc được lưu riêng.',
                  'This invoice belongs to the credit top-up. Charging session statements are stored separately.',
                ),
                style: const TextStyle(color: PowerMeColors.muted),
              ),
            ],
          ),
          if (o.invoiceText != null) ...[
            InfoCard(children: [SelectableText(o.invoiceText!)]),
            OutlinedButton(
              key: const Key('copy-invoice'),
              onPressed: () async {
                await Clipboard.setData(ClipboardData(text: o.invoiceText!));
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                      content: Text(
                        copy.text(
                          'Đã sao chép nội dung hóa đơn',
                          'Invoice content copied',
                        ),
                      ),
                    ),
                  );
                }
              },
              child: Text(copy.text('Sao chép hóa đơn', 'Copy invoice')),
            ),
            const SizedBox(height: 12),
          ],
        ],
        OutlinedButton(
          onPressed: () => ref.invalidate(invoiceProvider(id)),
          child: Text(copy.text('Kiểm tra hóa đơn', 'Check invoice')),
        ),
      ],
    );
  }
}
