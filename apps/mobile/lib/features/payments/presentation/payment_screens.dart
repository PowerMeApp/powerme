import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/l10n/app_copy.dart';
import '../../../core/widgets/flow_page.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../profile/application/profile_controller.dart';
import '../../profile/domain/driver_profile.dart';
import '../application/payments_controller.dart';
import '../domain/payments.dart';

String topUpLabel(
  TopUpState s, [
  AppCopy copy = const AppCopy(AppLanguage.vietnamese),
]) => switch (s) {
  TopUpState.pending => copy.text('Chờ thanh toán', 'Awaiting payment'),
  TopUpState.unknown => copy.text(
    'Chưa rõ kết quả · đang kiểm tra',
    'Result unknown · checking',
  ),
  TopUpState.verified => copy.text(
    'Đã xác nhận thanh toán · chờ ghi tín dụng',
    'Payment verified · awaiting credit posting',
  ),
  TopUpState.posted => copy.text('Đã ghi tín dụng', 'Credit posted'),
  TopUpState.failed => copy.text('Thanh toán bị từ chối', 'Payment declined'),
  TopUpState.expired => copy.text('Lần nạp đã hết hạn', 'Top-up expired'),
  TopUpState.refundPending => copy.text(
    'Thanh toán đến trễ · chờ hoàn về nguồn',
    'Late payment · awaiting refund to source',
  ),
  TopUpState.refunded => copy.text(
    'Đã hoàn về nguồn thanh toán',
    'Refunded to payment source',
  ),
};
String invoiceLabel(
  InvoiceState s, [
  AppCopy copy = const AppCopy(AppLanguage.vietnamese),
]) => switch (s) {
  InvoiceState.pending => copy.text('Đang chờ phát hành', 'Pending issuance'),
  InvoiceState.issued => copy.text('Đã phát hành', 'Issued'),
  InvoiceState.failed => copy.text(
    'Chưa phát hành được · chờ xử lý',
    'Issuance failed · under review',
  ),
};

class CreditScreen extends ConsumerStatefulWidget {
  const CreditScreen({super.key});
  @override
  ConsumerState<CreditScreen> createState() => _CreditScreenState();
}

class _CreditScreenState extends ConsumerState<CreditScreen> {
  final amount = TextEditingController(text: '200000');
  final points = TextEditingController();
  @override
  void initState() {
    super.initState();
    Future.microtask(() {
      if (mounted) ref.read(paymentsControllerProvider.notifier).refresh();
    });
  }

  @override
  void dispose() {
    amount.dispose();
    points.dispose();
    super.dispose();
  }

  Future<void> create() async {
    await ref
        .read(paymentsControllerProvider.notifier)
        .create(amount.text, points.text);
    if (!mounted) return;
    final state = ref.read(paymentsControllerProvider);
    if (state.error == null && state.order != null) {
      context.push('/checkout/${state.order!.id}');
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(paymentsControllerProvider);
    final c = ref.read(paymentsControllerProvider.notifier);
    final copy = AppCopy(ref.watch(profileControllerProvider).profile.language);
    final credit = s.credit;
    final text = Theme.of(context).textTheme;
    return FlowPage(
      title: copy.text('Tín dụng sạc', 'Charging credit'),
      backTooltip: copy.back,
      children: [
        if (s.busy) ...[
          const LinearProgressIndicator(),
          const SizedBox(height: 16),
        ],
        if (credit != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 20),
            child: HeroCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    copy.text('Tín dụng khả dụng', 'Available credit'),
                    style: const TextStyle(color: PowerMeColors.muted),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    vnd(credit.availableVnd),
                    style: text.headlineLarge?.copyWith(
                      color: PowerMeColors.teal,
                      fontSize: 32,
                      letterSpacing: -.6,
                      fontWeight: FontWeight.w800,
                      fontFeatures: const [FontFeature.tabularFigures()],
                    ),
                  ),
                  const SizedBox(height: 24),
                  MetricGrid(
                    items: [
                      MetricItem(
                        copy.text('Số dư đã ghi sổ', 'Posted balance'),
                        vnd(credit.balanceVnd),
                        Icons.account_balance_wallet_outlined,
                      ),
                      MetricItem(
                        copy.text('Điểm có thể đổi', 'Redeemable points'),
                        '${credit.availablePoints}',
                        Icons.stars_outlined,
                      ),
                    ],
                  ),
                  if (credit.balanceVnd < 0)
                    Padding(
                      padding: const EdgeInsets.only(top: 16),
                      child: Text(
                        copy.text(
                          'Số dư đang âm. Lần nạp tiếp theo sẽ bù phần còn thiếu trước.',
                          'Balance is negative. The next top-up will cover the shortfall first.',
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        InfoCard(
          spacing: 14,
          children: [
            Text(
              copy.text('Nạp tín dụng', 'Top up credit'),
              style: text.titleLarge,
            ),
            TextField(
              key: const Key('topup-amount'),
              controller: amount,
              keyboardType: TextInputType.number,
              decoration: InputDecoration(
                labelText: copy.text('Số tiền nạp (đ)', 'Top-up amount (VND)'),
                fillColor: PowerMeColors.black,
                prefixIcon: const Icon(Icons.payments_outlined),
              ),
            ),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final value in [50000, 100000, 200000, 500000])
                  ActionChip(
                    backgroundColor: PowerMeColors.black,
                    label: Text(vnd(value)),
                    onPressed: () => amount.text = '$value',
                  ),
              ],
            ),
            TextField(
              key: const Key('topup-points'),
              controller: points,
              keyboardType: TextInputType.number,
              decoration: InputDecoration(
                labelText: copy.text(
                  'Điểm muốn đổi · có thể bỏ trống',
                  'Points to redeem · optional',
                ),
                fillColor: PowerMeColors.black,
                prefixIcon: const Icon(Icons.stars_outlined),
              ),
            ),
            Text(
              copy.text(
                '100 điểm giảm 1.000 đ; đổi từ 500 điểm, theo bội 100, tối đa 50% số tiền nạp. Tín dụng nhận đủ mệnh giá nạp.',
                '100 points save 1,000 VND; redeem from 500 points in multiples of 100, up to 50% of the top-up amount. You receive full face value credit.',
              ),
              style: text.bodyMedium?.copyWith(color: PowerMeColors.muted),
            ),
            if (credit != null)
              Text(
                copy.text(
                  'Mỗi lần ${vnd(credit.minimumTopUpVnd)}–${vnd(credit.maximumTopUpVnd)}. Số dư tối đa ${vnd(credit.balanceCapVnd)}.',
                  'Per top-up ${vnd(credit.minimumTopUpVnd)}–${vnd(credit.maximumTopUpVnd)}. Maximum balance ${vnd(credit.balanceCapVnd)}.',
                ),
                style: text.bodyMedium?.copyWith(color: PowerMeColors.muted),
              ),
            FilledButton(
              key: const Key('create-topup'),
              onPressed: s.busy ? null : create,
              child: Text(copy.text('Tiếp tục đến VNPay', 'Continue to VNPay')),
            ),
          ],
        ),
        FailureNotice(s.error),
        OutlinedButton(
          key: const Key('refresh-credit'),
          onPressed: s.busy ? null : () => c.refresh(),
          child: Text(copy.text('Cập nhật tín dụng', 'Refresh credit')),
        ),
        const SizedBox(height: 8),
        TextButton(
          onPressed: () => context.push('/loyalty'),
          child: Text(
            copy.text('Điểm và hạn sử dụng', 'Points and expiration'),
          ),
        ),
        const SizedBox(height: 20),
        Text(copy.text('Các lần nạp', 'Top-ups'), style: text.titleLarge),
        const SizedBox(height: 12),
        if (credit != null && credit.orders.isEmpty)
          InfoCard(
            children: [
              Text(copy.text('Chưa có lần nạp nào.', 'No top-ups yet.')),
            ],
          ),
        for (final o in credit?.orders ?? <TopUpOrder>[])
          InfoCard(
            spacing: 10,
            children: [
              Text(
                '${vnd(o.amountVnd)} · ${ict(o.createdAt)}',
                style: text.titleMedium,
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
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  TextButton(
                    onPressed: () => context.push('/checkout/${o.id}'),
                    child: Text(copy.text('Kiểm tra lần nạp', 'Check top-up')),
                  ),
                  TextButton(
                    onPressed: () => context.push('/invoice/${o.id}'),
                    child: Text(
                      '${copy.text('Hóa đơn', 'Invoice')} · ${invoiceLabel(o.invoice, copy)}',
                    ),
                  ),
                ],
              ),
            ],
          ),
      ],
    );
  }
}

class CheckoutScreen extends ConsumerStatefulWidget {
  const CheckoutScreen({super.key, required this.id});
  final String id;
  @override
  ConsumerState<CheckoutScreen> createState() => _CheckoutScreenState();
}

class _CheckoutScreenState extends ConsumerState<CheckoutScreen> {
  @override
  void initState() {
    super.initState();
    Future.microtask(() {
      if (mounted) {
        ref
            .read(paymentsControllerProvider.notifier)
            .refresh(orderId: widget.id);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(paymentsControllerProvider);
    final c = ref.read(paymentsControllerProvider.notifier);
    final copy = AppCopy(ref.watch(profileControllerProvider).profile.language);
    final o = s.order?.id == widget.id ? s.order : null;
    return FlowPage(
      title: copy.text('Thanh toán VNPay', 'VNPay checkout'),
      backTooltip: copy.back,
      children: [
        if (s.busy) ...[
          const LinearProgressIndicator(),
          const SizedBox(height: 16),
        ],
        if (o != null) ...[
          Align(
            alignment: Alignment.centerLeft,
            child: StatusBadge(
              topUpLabel(o.state, copy),
              color: o.creditPosted ? PowerMeColors.teal : PowerMeColors.gold,
            ),
          ),
          const SizedBox(height: 14),
          InfoCard(
            children: [
              ValueLine(
                copy.text('Tín dụng sẽ nhận', 'Credit to receive'),
                vnd(o.amountVnd),
              ),
              ValueLine(
                copy.text('Số tiền thanh toán', 'Amount to pay'),
                vnd(o.cashVnd),
              ),
              ValueLine(
                copy.text('Điểm sử dụng', 'Points used'),
                '${o.points}',
              ),
              ValueLine(copy.text('Mã lần nạp', 'Top-up ID'), o.id),
              ValueLine(
                copy.text('Hóa đơn', 'Invoice'),
                invoiceLabel(o.invoice, copy),
                showDivider: false,
              ),
            ],
          ),
          if (o.open && !o.checkoutOpened) ...[
            FilledButton(
              key: const Key('pay-checkout'),
              onPressed: s.busy ? null : () => c.checkout(o.id, o.attemptId),
              child: Text(
                copy.text('Tiếp tục thanh toán', 'Proceed to payment'),
              ),
            ),
            const SizedBox(height: 12),
          ],
          if (o.checkoutOpened && o.open) ...[
            Text(
              copy.text(
                'Đang chờ kết quả thanh toán. Bạn có thể quay lại và kiểm tra bằng mã lần nạp này.',
                'Awaiting payment result. You can return later and check with this top-up ID.',
              ),
            ),
            const SizedBox(height: 12),
          ],
          if (o.creditPosted) ...[
            FilledButton(
              key: const Key('back-credit'),
              onPressed: () =>
                  context.canPop() ? context.pop() : context.go('/credit'),
              child: Text(copy.back),
            ),
            const SizedBox(height: 12),
          ],
          if (!o.creditPosted) ...[
            Text(
              copy.text(
                'Chỉ khi giao dịch được xác nhận và ghi sổ, tín dụng mới được cập nhật.',
                'Credit is updated only after the transaction is verified and posted.',
              ),
              style: const TextStyle(color: PowerMeColors.muted),
            ),
            const SizedBox(height: 12),
          ],
          if (o.state == TopUpState.refundPending) ...[
            Text(
              copy.text(
                'Khoản thanh toán đến sau khi hết hạn được chuyển xử lý hoàn về nguồn; tín dụng chưa được cộng.',
                'Payments received after expiration are routed for refund to source; credit is not added.',
              ),
            ),
            const SizedBox(height: 12),
          ],
          if (o.creditPosted) ...[
            TextButton(
              onPressed: () => context.push('/invoice/${o.id}'),
              child: Text(
                copy.text('Xem hóa đơn lần nạp', 'View top-up invoice'),
              ),
            ),
            const SizedBox(height: 8),
          ],
        ],
        FailureNotice(s.error),
        OutlinedButton(
          key: const Key('query-payment'),
          onPressed: s.busy ? null : () => c.refresh(orderId: widget.id),
          child: Text(copy.text('Kiểm tra kết quả', 'Check result')),
        ),
        const SizedBox(height: 8),
        TextButton(
          key: const Key('close-checkout'),
          onPressed: () =>
              context.canPop() ? context.pop() : context.go('/credit'),
          child: Text(
            copy.text('Đóng và kiểm tra sau', 'Close and check later'),
          ),
        ),
      ],
    );
  }
}

class CreditSummary extends ConsumerWidget {
  const CreditSummary({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(paymentsControllerProvider);
    final copy = AppCopy(ref.watch(profileControllerProvider).profile.language);
    return HeroCard(
      accent: PowerMeColors.gold,
      padding: const EdgeInsets.all(16),
      child: LayoutBuilder(
        builder: (context, box) {
          final balance = Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                copy.text('Tín dụng khả dụng', 'Available credit'),
                style: const TextStyle(color: PowerMeColors.muted),
              ),
              const SizedBox(height: 4),
              Text(
                vnd(s.credit?.availableVnd),
                style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                  fontWeight: FontWeight.w800,
                ),
              ),
            ],
          );
          final topup = FilledButton.tonalIcon(
            style: FilledButton.styleFrom(
              backgroundColor: PowerMeColors.gold.withValues(alpha: .16),
              foregroundColor: PowerMeColors.gold,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              textStyle: Theme.of(context).textTheme.labelLarge,
            ),
            onPressed: () => context.push('/credit'),
            icon: const Icon(Icons.add_rounded, size: 18),
            label: Text(copy.text('Nạp tín dụng', 'Top up credit')),
          );
          return box.maxWidth < 300 ||
                  MediaQuery.textScalerOf(context).scale(14) / 14 > 1.3
              ? Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [balance, const SizedBox(height: 12), topup],
                )
              : Row(
                  children: [
                    Expanded(child: balance),
                    const SizedBox(width: 8),
                    topup,
                  ],
                );
        },
      ),
    );
  }
}
