import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/driver_task_page.dart';
import '../../../core/widgets/flow_page.dart';
import '../../profile/application/profile_controller.dart';
import 'points_help.dart';
import '../application/loyalty_controller.dart';

class LoyaltyScreen extends ConsumerStatefulWidget {
  const LoyaltyScreen({super.key});

  @override
  ConsumerState<LoyaltyScreen> createState() => _LoyaltyScreenState();
}

class _LoyaltyScreenState extends ConsumerState<LoyaltyScreen>
    with WidgetsBindingObserver {
  final _route = Object();
  late LoyaltyController _controller;
  late bool _foreground;
  bool _current = false;

  @override
  void initState() {
    super.initState();
    _controller = ref.read(loyaltyControllerProvider.notifier);
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    _foreground = lifecycle == null || lifecycle == AppLifecycleState.resumed;
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _current = ModalRoute.isCurrentOf(context) ?? true;
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
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final copy = AppCopy(ref.watch(profileControllerProvider).profile.language);
    _controller = ref.watch(loyaltyControllerProvider.notifier);
    final view = ref.watch(loyaltyControllerProvider);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _controller.setVisible(_route, _current && _foreground);
    });
    final text = Theme.of(context).textTheme;
    return DriverTaskPage(
      backTooltip: copy.back,
      onBack: () => context.canPop() ? context.pop() : context.go('/profile'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Semantics(
            header: true,
            child: Text(
              copy.text('Điểm PowerMe', 'PowerMe points'),
              style: text.headlineMedium,
            ),
          ),
          const SizedBox(height: 20),
          Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(12),
              gradient: LinearGradient(
                begin: Alignment.bottomLeft,
                end: Alignment.topRight,
                colors: [
                  Color.alphaBlend(
                    PowerMeColors.teal.withValues(alpha: .07),
                    PowerMeColors.graphite,
                  ),
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
                LayoutBuilder(
                  builder: (context, box) {
                    final badge = Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 8,
                      ),
                      decoration: BoxDecoration(
                        color: PowerMeColors.gold.withValues(alpha: .10),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: DriverTaskHeading(
                        copy.text('Điểm thưởng PowerMe', 'PowerMe rewards'),
                        icon: Icons.workspace_premium_outlined,
                      ),
                    );
                    final refresh = IconButton(
                      key: const Key('loyalty-refresh'),
                      constraints: const BoxConstraints(
                        minWidth: 48,
                        minHeight: 48,
                      ),
                      tooltip: view.unavailable
                          ? copy.text('Thử lại', 'Try again')
                          : copy.text('Cập nhật điểm', 'Refresh points'),
                      onPressed: view.loading ? null : _controller.refresh,
                      icon: const Icon(Icons.refresh_rounded),
                    );
                    if (box.maxWidth < 280 ||
                        MediaQuery.textScalerOf(context).scale(14) > 19) {
                      return Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          badge,
                          const SizedBox(height: 8),
                          Align(
                            alignment: Alignment.centerRight,
                            child: refresh,
                          ),
                        ],
                      );
                    }
                    return Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(child: badge),
                        const SizedBox(width: 8),
                        refresh,
                      ],
                    );
                  },
                ),
                const SizedBox(height: 24),
                Text(
                  copy.text('Điểm khả dụng', 'Available points'),
                  style: text.bodyMedium?.copyWith(color: PowerMeColors.muted),
                ),
                const SizedBox(height: 8),
                Semantics(
                  liveRegion: true,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (view.loading) ...[
                        const SizedBox(height: 20),
                        LinearProgressIndicator(
                          semanticsLabel: copy.text(
                            'Đang tải điểm',
                            'Loading points',
                          ),
                        ),
                        const SizedBox(height: 12),
                        Text(copy.text('Đang tải điểm…', 'Loading points…')),
                      ] else if (view.balance case final balance?) ...[
                        Wrap(
                          spacing: 8,
                          runSpacing: 4,
                          crossAxisAlignment: WrapCrossAlignment.end,
                          children: [
                            Text(
                              '${balance.availablePoints}',
                              key: const Key('loyalty-available'),
                              style: text.displaySmall?.copyWith(
                                fontSize: 48,
                                height: 1.15,
                                fontWeight: FontWeight.w700,
                                color: PowerMeColors.gold,
                                fontFeatures: const [
                                  FontFeature.tabularFigures(),
                                ],
                              ),
                            ),
                            Padding(
                              padding: const EdgeInsets.only(bottom: 6),
                              child: Text(
                                copy.text('điểm', 'points'),
                                style: text.titleMedium?.copyWith(
                                  color: PowerMeColors.muted,
                                ),
                              ),
                            ),
                          ],
                        ),
                        if (balance.availablePoints == 0) ...[
                          const SizedBox(height: 12),
                          Text(
                            copy.text(
                              'Bạn chưa có điểm khả dụng.',
                              'You have no available points yet.',
                            ),
                          ),
                        ],
                      ],
                      if (view.unavailable)
                        FailureNotice(
                          copy.text(
                            'Chưa tải được điểm. Hãy thử lại.',
                            'Could not load your points. Please try again.',
                          ),
                        ),
                    ],
                  ),
                ),
                const SizedBox(height: 20),
                Text(
                  copy.text(
                    'Điểm tích từ phiên sạc được ghi trên bảng kê sau quyết toán.',
                    'Points earned from charging appear on your statement after settlement.',
                  ),
                  style: text.bodyMedium?.copyWith(color: PowerMeColors.muted),
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),
          FilledButton.icon(
            key: const Key('redeem-points'),
            onPressed: () => context.push('/credit/top-up'),
            icon: const Icon(Icons.add_card_rounded),
            label: Text(
              copy.text('Đổi điểm khi nạp', 'Redeem points on top-up'),
              textAlign: TextAlign.center,
            ),
          ),
          const SizedBox(height: 24),
          InfoCard(
            spacing: 16,
            children: [
              PointsHelpHeading(copy: copy),
              Text(
                copy.text(
                  'Dùng điểm để giảm số tiền thanh toán khi nạp tín dụng sạc. Chọn số tiền nạp để xem số điểm có thể dùng và mức giảm hiện tại.',
                  'Use points to reduce your payment when topping up charging credit. Choose a top-up amount to see the points you can use and the current discount.',
                ),
              ),
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: PowerMeColors.black,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(
                      Icons.info_outline_rounded,
                      size: 20,
                      color: PowerMeColors.teal,
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        copy.text(
                          'Điểm khả dụng chỉ gồm điểm chưa hết hạn. Điểm không thể chuyển nhượng và không có giá trị quy đổi thành tiền mặt.',
                          'Available points include only unexpired points. Points cannot be transferred or exchanged for cash.',
                        ),
                        style: text.bodySmall,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
