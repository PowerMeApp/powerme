import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/driver_task_page.dart';
import '../../../core/widgets/flow_page.dart';
import '../../profile/application/profile_controller.dart';
import '../../loyalty/presentation/points_help.dart';
import '../application/charging_credit_controller.dart';
import '../application/credit_top_up_controller.dart';
import '../domain/charging_credit.dart';
import '../domain/credit_top_up.dart';

class CreditTopUpScreen extends ConsumerStatefulWidget {
  const CreditTopUpScreen({super.key});

  @override
  ConsumerState<CreditTopUpScreen> createState() => _CreditTopUpScreenState();
}

class _CreditTopUpScreenState extends ConsumerState<CreditTopUpScreen>
    with WidgetsBindingObserver {
  final _route = Object();
  late final CreditTopUpController _controller;
  late final TextEditingController _amount;
  late final TextEditingController _points;
  late bool _foreground;
  bool _current = false;

  @override
  void initState() {
    super.initState();
    _controller = ref.read(creditTopUpProvider.notifier);
    final view = ref.read(creditTopUpProvider);
    _amount = TextEditingController(text: view.amountText);
    _points = TextEditingController(text: view.pointsText);
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    _foreground = lifecycle == null || lifecycle == AppLifecycleState.resumed;
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _current = ModalRoute.isCurrentOf(context) ?? true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _controller.setVisible(_route, _current && _foreground);
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _controller.setVisible(_route, _current && _foreground);
  }

  @override
  void dispose() {
    _controller.setVisible(_route, false);
    WidgetsBinding.instance.removeObserver(this);
    _amount.dispose();
    _points.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final copy = AppCopy(ref.watch(profileControllerProvider).profile.language);
    final view = ref.watch(creditTopUpProvider);
    ref.listen(creditTopUpProvider, (_, next) {
      if (next.amountText != _amount.text) _amount.text = next.amountText;
      if (next.pointsText != _points.text) _points.text = next.pointsText;
    });
    void back() => context.canPop() ? context.pop() : context.go('/credit');
    return DriverTaskPage(
      key: ValueKey((view.tracking, view.order?.status)),
      backTooltip: copy.back,
      onBack: back,
      child: view.tracking ? _status(view, copy, back) : _form(view, copy),
    );
  }

  Widget _form(TopUpView view, AppCopy copy) {
    final locked = view.creating || view.retryCreate;
    final quote = view.quote;
    final amount = parseTopUpInteger(view.amountText);
    final points = parseTopUpInteger(view.pointsText);
    final invalidAmount =
        view.amountText.isNotEmpty && !validTopUpAmount(amount);
    final invalidPoints =
        view.pointsText.isNotEmpty &&
        (points == null || points < 0 || points > (quote?.maxPoints ?? 0));
    final credit = ref.watch(chargingCreditProvider);
    final payable = validTopUpAmount(amount) && !invalidPoints
        ? view.expectedPayableVnd
        : null;
    final route = ModalRoute.of(context);
    final text = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          header: true,
          child: Text(
            copy.text('Nạp tín dụng', 'Top up credit'),
            style: text.headlineMedium,
          ),
        ),
        const SizedBox(height: 8),
        Text(
          copy.text(
            'Nạp tín dụng sạc và dùng điểm PowerMe.',
            'Add charging credit and use your PowerMe points.',
          ),
          style: text.bodyMedium?.copyWith(color: PowerMeColors.muted),
        ),
        const SizedBox(height: 20),
        if (credit.asData?.value.status == CreditStatus.inShortfall)
          FailureNotice(
            copy.text(
              'Số dư tín dụng đang bị thiếu hụt.',
              'Your charging credit has a shortfall.',
            ),
          ),
        Container(
          key: const Key('top-up-credit-balance'),
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(12),
            gradient: LinearGradient(
              begin: Alignment.bottomLeft,
              end: Alignment.topRight,
              colors: [
                PowerMeColors.graphite,
                Color.alphaBlend(
                  PowerMeColors.gold.withValues(alpha: .12),
                  PowerMeColors.graphite,
                ),
              ],
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              DriverTaskHeading(
                copy.text('Tín dụng khả dụng', 'Available credit'),
                icon: Icons.account_balance_wallet_outlined,
              ),
              const SizedBox(height: 12),
              credit.when(
                skipLoadingOnRefresh: false,
                data: (summary) => Text(
                  summary.status == CreditStatus.none
                      ? copy.text(
                          'Chưa có tài khoản tín dụng',
                          'No credit account yet',
                        )
                      : _money(summary.availableVnd, copy),
                  style: text.headlineLarge?.copyWith(
                    color: PowerMeColors.gold,
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
                loading: () => const LinearProgressIndicator(),
                error: (_, _) => Text(
                  copy.text('Chưa tải được số dư', 'Balance unavailable'),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        _TopUpPanel(
          children: [
            DriverTaskHeading(
              copy.text('Số tiền muốn nạp', 'Amount to top up'),
              icon: Icons.add_card_outlined,
            ),
            const SizedBox(height: 16),
            TextField(
              key: const Key('top-up-amount'),
              controller: _amount,
              enabled: !locked,
              keyboardType: TextInputType.number,
              style: text.titleLarge?.copyWith(fontWeight: FontWeight.w700),
              decoration: InputDecoration(
                fillColor: PowerMeColors.black,
                labelText: copy.text('Số tiền (VND)', 'Amount (VND)'),
                helperText:
                    '${_money(minTopUpVnd, copy)} – ${_money(maxTopUpVnd, copy)}',
                helperMaxLines: 3,
                errorMaxLines: 3,
                errorText: invalidAmount
                    ? copy.text(
                        'Nhập từ ${_money(minTopUpVnd, copy)} đến ${_money(maxTopUpVnd, copy)}.',
                        'Enter ${_money(minTopUpVnd, copy)} to ${_money(maxTopUpVnd, copy)}.',
                      )
                    : null,
              ),
              onChanged: _controller.changeAmount,
            ),
            const SizedBox(height: 12),
            LayoutBuilder(
              builder: (context, box) {
                final columns =
                    box.maxWidth >= 300 &&
                        MediaQuery.textScalerOf(context).scale(14) <= 16
                    ? 4
                    : (MediaQuery.textScalerOf(context).scale(14) > 19 ? 1 : 2);
                return Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final preset in [50000, 100000, 200000, 500000])
                      SizedBox(
                        width: (box.maxWidth - (columns - 1) * 8) / columns,
                        child: OutlinedButton(
                          key: Key('top-up-preset-$preset'),
                          style: OutlinedButton.styleFrom(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 4,
                              vertical: 12,
                            ),
                            foregroundColor: amount == preset
                                ? PowerMeColors.teal
                                : PowerMeColors.text,
                            backgroundColor: amount == preset
                                ? PowerMeColors.teal.withValues(alpha: .12)
                                : PowerMeColors.black,
                            side: BorderSide(
                              color: amount == preset
                                  ? PowerMeColors.teal
                                  : PowerMeColors.outline.withValues(alpha: .4),
                            ),
                            textStyle: text.labelSmall?.copyWith(
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          onPressed: locked
                              ? null
                              : () {
                                  FocusScope.of(context).unfocus();
                                  if (view.amountText != '$preset') {
                                    _controller.changeAmount('$preset');
                                  }
                                },
                          child: Text(
                            _money(preset, copy),
                            textAlign: TextAlign.center,
                          ),
                        ),
                      ),
                  ],
                );
              },
            ),
          ],
        ),
        _TopUpPanel(
          children: [
            PointsHelpHeading(copy: copy, icon: Icons.stars_outlined),
            const SizedBox(height: 12),
            if (view.quoting) ...[
              const LinearProgressIndicator(),
              const SizedBox(height: 12),
              Text(copy.text('Đang tải báo giá…', 'Loading quote…')),
            ] else if (view.quoteUnavailable) ...[
              FailureNotice(
                copy.text(
                  'Chưa tải được báo giá.',
                  'The quote is unavailable.',
                ),
              ),
              OutlinedButton(
                onPressed: _controller.retryQuote,
                child: Text(copy.text('Tải lại báo giá', 'Retry quote')),
              ),
            ] else if (quote == null)
              Text(
                copy.text(
                  'Chọn số tiền nạp để xem điểm có thể dùng.',
                  'Choose a top-up amount to see the points you can use.',
                ),
              ),
            if (quote != null) ...[
              ValueLine(
                copy.text('Điểm khả dụng', 'Available points'),
                '${quote.pointsAvailable}',
              ),
              if (quote.maxPoints > 0) ...[
                ValueLine(
                  copy.text('Điểm dùng tối đa', 'Maximum points to use'),
                  '${quote.maxPoints}',
                ),
                ValueLine(
                  copy.text('Mức giảm tối đa', 'Maximum discount'),
                  _money(quote.maxDiscountVnd, copy),
                  showDivider: false,
                ),
                const SizedBox(height: 12),
                TextField(
                  key: const Key('top-up-points'),
                  controller: _points,
                  enabled: !locked,
                  keyboardType: TextInputType.number,
                  style: text.titleLarge?.copyWith(
                    color: PowerMeColors.gold,
                    fontWeight: FontWeight.w700,
                  ),
                  decoration: InputDecoration(
                    fillColor: PowerMeColors.black,
                    labelText: copy.text('Điểm sử dụng', 'Points to use'),
                    helperText: copy.text(
                      'Không bắt buộc · giới hạn theo báo giá hiện tại',
                      'Optional · limited by the current quote',
                    ),
                    helperMaxLines: 3,
                    errorMaxLines: 3,
                    errorText: invalidPoints
                        ? copy.text(
                            'Kiểm tra lại số điểm.',
                            'Check the number of points.',
                          )
                        : null,
                  ),
                  onChanged: _controller.changePoints,
                ),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 4,
                  children: [
                    TextButton(
                      key: const Key('top-up-points-clear'),
                      onPressed: locked
                          ? null
                          : () => _controller.changePoints(''),
                      child: Text(copy.text('Không dùng điểm', 'Clear points')),
                    ),
                    TextButton(
                      key: const Key('top-up-points-max'),
                      onPressed: locked
                          ? null
                          : () =>
                                _controller.changePoints('${quote.maxPoints}'),
                      child: Text(copy.text('Dùng tối đa', 'Use maximum')),
                    ),
                  ],
                ),
              ] else
                Text(
                  copy.text(
                    'Hiện không có điểm dùng được cho giao dịch này.',
                    'No points can be used for this top-up.',
                  ),
                ),
            ],
          ],
        ),
        _TopUpPanel(
          children: [
            DriverTaskHeading(
              copy.text('Báo giá nạp tín dụng', 'Top-up summary'),
              icon: Icons.receipt_long_outlined,
            ),
            const SizedBox(height: 12),
            ValueLine(
              copy.text('Số tiền yêu cầu nạp', 'Requested top-up'),
              validTopUpAmount(amount) ? _money(amount!, copy) : '—',
            ),
            if (quote != null && !invalidPoints)
              ValueLine(
                copy.text('Điểm đã chọn', 'Selected points'),
                '${points ?? 0}',
                showDivider: false,
              ),
            const SizedBox(height: 12),
            Container(
              key: const Key('top-up-payable-summary'),
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: PowerMeColors.black,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    payable != null
                        ? copy.text(
                            'Tổng thanh toán dự kiến',
                            'Estimated total',
                          )
                        : copy.text(
                            'Thanh toán qua VNPay',
                            'Pay through VNPay',
                          ),
                    style: text.bodySmall,
                  ),
                  const SizedBox(height: 8),
                  if (payable != null)
                    Text(
                      _money(payable, copy),
                      key: const Key('top-up-payable'),
                      style: text.headlineSmall?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    )
                  else
                    Text(
                      (view.canCreate || locked) &&
                              !invalidPoints &&
                              !invalidAmount
                          ? copy.text(
                              'Tổng thanh toán sau khi dùng điểm sẽ hiển thị trước khi mở VNPay.',
                              'Your total after applying points will appear before you open VNPay.',
                            )
                          : copy.text(
                              'Chọn số tiền và số điểm hợp lệ để xem thanh toán.',
                              'Choose a valid amount and points to see your payment.',
                            ),
                      key: const Key('top-up-payable-unknown'),
                      style: text.bodyMedium,
                    ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: PowerMeColors.teal.withValues(alpha: .08),
                borderRadius: BorderRadius.circular(12),
              ),
              child: ValueLine(
                copy.text('Tín dụng sạc sẽ nhận', 'Charging credit to receive'),
                validTopUpAmount(amount) ? _money(amount!, copy) : '—',
                showDivider: false,
              ),
            ),
            const SizedBox(height: 12),
            Text(
              copy.text(
                'Tín dụng được cộng đủ số tiền nạp. Điểm chỉ được trừ khi thanh toán được xác nhận thành công.',
                'The full top-up amount is credited. Points are deducted only after payment is confirmed successful.',
              ),
              style: text.bodySmall,
            ),
          ],
        ),
        _TopUpPanel(
          children: [
            DriverTaskHeading(
              copy.text('Phương thức thanh toán', 'Payment method'),
              icon: Icons.credit_card_outlined,
            ),
            const SizedBox(height: 12),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(
                  Icons.account_balance_outlined,
                  color: PowerMeColors.teal,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('VNPay', style: text.titleMedium),
                      const SizedBox(height: 4),
                      Text(
                        copy.text(
                          'Tiếp tục tại cổng thanh toán VNPay.',
                          'Continue at the VNPay payment gateway.',
                        ),
                        style: text.bodySmall,
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ],
        ),
        if (view.issue case final issue?)
          FailureNotice(_issueCopy(issue, copy)),
        FilledButton.icon(
          key: const Key('top-up-create'),
          onPressed: view.canCreate || view.retryCreate
              ? () {
                  FocusScope.of(context).unfocus();
                  _controller.create(
                    shownPayableVnd: payable,
                    isSourceVisible: () =>
                        mounted && _foreground && (route?.isCurrent ?? true),
                  );
                }
              : null,
          icon: const Icon(Icons.lock_outline_rounded),
          label: Text(
            view.creating
                ? copy.text('Đang gửi', 'Submitting')
                : view.retryCreate
                ? copy.text('Thử lại giao dịch này', 'Retry this top-up')
                : view.canCreate && payable == null
                ? copy.text('Xem số tiền thanh toán', 'Review payment amount')
                : copy.text('Thanh toán qua VNPay', 'Pay with VNPay'),
            textAlign: TextAlign.center,
          ),
        ),
      ],
    );
  }

  Widget _status(TopUpView view, AppCopy copy, VoidCallback back) {
    final order = view.order;
    final status = order?.status;
    final pending = status == null || status == TopUpStatus.pending;
    final credited = status == TopUpStatus.credited;
    final (icon, color, title) = switch (status) {
      null || TopUpStatus.pending => (
        Icons.sync_rounded,
        PowerMeColors.gold,
        view.confirming
            ? copy.text('Đang xác nhận thanh toán', 'Confirming payment')
            : copy.text('Giao dịch đang chờ', 'Top-up pending'),
      ),
      TopUpStatus.credited => (
        Icons.check_rounded,
        PowerMeColors.teal,
        copy.text('Nạp tín dụng thành công', 'Top-up successful'),
      ),
      TopUpStatus.failed => (
        Icons.error_outline_rounded,
        Theme.of(context).colorScheme.error,
        copy.text('Thanh toán thất bại', 'Payment failed'),
      ),
      TopUpStatus.expired => (
        Icons.timer_off_outlined,
        PowerMeColors.gold,
        copy.text('Thanh toán hết hạn', 'Payment expired'),
      ),
      TopUpStatus.refunded => (
        Icons.currency_exchange_rounded,
        PowerMeColors.gold,
        copy.text('Giao dịch đã hoàn tiền', 'Top-up refunded'),
      ),
    };
    final message = switch (status) {
      _ when view.confirming => copy.text(
        'VNPay đang xác nhận giao dịch. Bạn có thể kiểm tra lại sau ít phút.',
        'VNPay is confirming the payment. Check again in a few minutes.',
      ),
      null => copy.text('Đang kiểm tra giao dịch.', 'Checking your top-up.'),
      TopUpStatus.pending => copy.text(
        'Giao dịch đang chờ thanh toán hoặc xác nhận từ VNPay.',
        'This top-up is awaiting payment or confirmation from VNPay.',
      ),
      TopUpStatus.credited => copy.text(
        'Tín dụng đã được cộng.',
        'Credit has been added.',
      ),
      TopUpStatus.failed => copy.text(
        'Giao dịch nạp không thành công.',
        'The top-up failed.',
      ),
      TopUpStatus.expired => copy.text(
        'Giao dịch nạp đã hết hạn.',
        'The top-up expired.',
      ),
      TopUpStatus.refunded => copy.text(
        'Giao dịch đã được hoàn tiền.',
        'This top-up was refunded.',
      ),
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DriverTaskStatus(
          icon: icon,
          color: color,
          title: title,
          message: message,
        ),
        if (order != null && credited) ...[
          HeroCard(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                DriverTaskHeading(
                  copy.text('Tín dụng đã cộng', 'Credit added'),
                  icon: Icons.account_balance_wallet_outlined,
                ),
                const SizedBox(height: 4),
                Text(
                  '+${_money(order.amountVnd, copy)}',
                  style: Theme.of(context).textTheme.headlineLarge?.copyWith(
                    color: PowerMeColors.teal,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
        ],
        if (order != null)
          InfoCard(
            spacing: 6,
            children: [
              DriverTaskHeading(
                copy.text('Chi tiết giao dịch', 'Transaction details'),
                icon: Icons.receipt_long_outlined,
              ),
              ValueLine(copy.text('Mã giao dịch', 'Top-up ID'), order.id),
              if (!credited)
                ValueLine(
                  copy.text('Số tiền yêu cầu nạp', 'Requested top-up'),
                  _money(order.amountVnd, copy),
                ),
              if (pending || credited) ...[
                if (order.points > 0)
                  ValueLine(
                    copy.text('Giảm từ điểm', 'Points discount'),
                    _money(order.discountVnd, copy),
                  ),
                ValueLine(
                  credited
                      ? copy.text('Đã thanh toán', 'Amount paid')
                      : copy.text('Số tiền cần thanh toán', 'Amount due'),
                  _money(order.amountPaidVnd, copy),
                ),
              ],
              ValueLine(
                copy.text('Cổng thanh toán', 'Payment gateway'),
                'VNPay',
              ),
              ValueLine(
                copy.text('Thời gian tạo', 'Created at'),
                '${ict(order.createdAt)} ICT',
                showDivider: false,
              ),
            ],
          ),
        if (view.checking) const LinearProgressIndicator(),
        if (view.issue case final issue?)
          FailureNotice(_issueCopy(issue, copy)),
        if (pending) ...[
          FilledButton.icon(
            key: const Key('top-up-check'),
            onPressed: view.checking ? null : _controller.checkStatus,
            icon: const Icon(Icons.refresh_rounded),
            label: Text(
              copy.text('Kiểm tra trạng thái', 'Check status'),
              textAlign: TextAlign.center,
            ),
          ),
          if (view.canPay || view.opening)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: OutlinedButton.icon(
                key: const Key('top-up-pay'),
                onPressed: view.opening ? null : _controller.openPayment,
                icon: const Icon(Icons.open_in_new_rounded),
                label: Text(
                  view.opening
                      ? copy.text('Đang mở VNPay', 'Opening VNPay')
                      : view.issue == TopUpIssue.launchUnavailable
                      ? copy.text('Mở lại VNPay', 'Reopen VNPay')
                      : copy.text(
                          'Tiếp tục thanh toán qua VNPay',
                          'Continue to VNPay',
                        ),
                  textAlign: TextAlign.center,
                ),
              ),
            ),
        ] else ...[
          if (credited)
            FilledButton(
              onPressed: back,
              child: Text(
                copy.text('Hoàn tất và quay lại', 'Done and go back'),
                textAlign: TextAlign.center,
              ),
            )
          else
            FilledButton.icon(
              key: const Key('top-up-new'),
              onPressed: _controller.startAnother,
              icon: const Icon(Icons.add_card_rounded),
              label: Text(
                copy.text('Tạo giao dịch nạp mới', 'Start another top-up'),
                textAlign: TextAlign.center,
              ),
            ),
          const SizedBox(height: 8),
          OutlinedButton(
            key: credited ? const Key('top-up-new') : null,
            onPressed: credited ? _controller.startAnother : back,
            child: Text(
              credited
                  ? copy.text('Nạp lần khác', 'Start another top-up')
                  : copy.back,
              textAlign: TextAlign.center,
            ),
          ),
        ],
      ],
    );
  }
}

String _money(int amount, AppCopy copy) {
  final value = vnd(amount);
  return copy.text(
    value,
    value.replaceAll('.', ',').replaceFirst(' đ', ' VND'),
  );
}

String _issueCopy(TopUpIssue issue, AppCopy copy) => switch (issue) {
  TopUpIssue.uncertain => copy.text(
    'Chưa xác nhận được yêu cầu. Hãy thử lại giao dịch này.',
    'We could not confirm the request. Retry this top-up.',
  ),
  TopUpIssue.rejected => copy.text(
    'Yêu cầu nạp bị từ chối.',
    'The top-up request was rejected.',
  ),
  TopUpIssue.balanceLimit => copy.text(
    'Số dư sau khi nạp vượt giới hạn. Hãy nhập số tiền thấp hơn.',
    'This would exceed the balance limit. Enter a lower amount.',
  ),
  TopUpIssue.quoteChanged => copy.text(
    'Hãy xem lại báo giá và chọn lại số điểm muốn dùng.',
    'Review the refreshed quote and choose your points again.',
  ),
  TopUpIssue.accountClosed => copy.text(
    'Tài khoản tín dụng đã đóng.',
    'Your credit account is closed.',
  ),
  TopUpIssue.keyConflict => copy.text(
    'Yêu cầu bị trùng. Hãy thử lại.',
    'The request conflicted. Try again.',
  ),
  TopUpIssue.paymentUnavailable => copy.text(
    'Thanh toán qua VNPay hiện chưa khả dụng.',
    'VNPay checkout is currently unavailable.',
  ),
  TopUpIssue.statusUnavailable => copy.text(
    'Chưa kiểm tra được trạng thái giao dịch.',
    'The top-up status is unavailable.',
  ),
  TopUpIssue.notFound => copy.text(
    'Không tìm thấy giao dịch trước. Bạn có thể tạo giao dịch mới.',
    'The previous top-up could not be found. You can start a new one.',
  ),
  TopUpIssue.malformed => copy.text(
    'Chưa xác minh được thông tin giao dịch.',
    'The top-up details could not be verified.',
  ),
  TopUpIssue.launchUnavailable => copy.text(
    'Không mở được VNPay. Bạn có thể mở lại từ giao dịch này.',
    'Could not open VNPay. You can reopen it from this top-up.',
  ),
};

class _TopUpPanel extends StatelessWidget {
  const _TopUpPanel({required this.children});
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 16),
    child: Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: PowerMeColors.graphite,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: children,
      ),
    ),
  );
}
