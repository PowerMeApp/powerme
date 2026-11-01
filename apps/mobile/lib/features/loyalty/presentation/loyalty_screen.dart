import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/l10n/app_copy.dart';
import '../../../core/widgets/flow_page.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../profile/application/profile_controller.dart';
import '../application/loyalty_controller.dart';

class LoyaltyScreen extends ConsumerWidget {
  const LoyaltyScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final view = ref.watch(loyaltyProvider);
    final copy = AppCopy(ref.watch(profileControllerProvider).profile.language);
    final s = view.asData?.value;
    final text = Theme.of(context).textTheme;
    return FlowPage(
      title: copy.text('Điểm PowerMe', 'PowerMe points'),
      backTooltip: copy.back,
      children: [
        if (view.isLoading) ...[
          const LinearProgressIndicator(),
          const SizedBox(height: 16),
        ],
        if (view.hasError) FailureNotice(failureText(view.error!)),
        if (s != null) ...[
          Padding(
            padding: const EdgeInsets.only(bottom: 20),
            child: HeroCard(
              accent: PowerMeColors.gold,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(
                    Icons.stars_outlined,
                    color: PowerMeColors.gold,
                    size: 30,
                  ),
                  const SizedBox(height: 12),
                  Text(
                    copy.text('Điểm có thể đổi', 'Redeemable points'),
                    style: const TextStyle(color: PowerMeColors.muted),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    '${s.available}',
                    style: text.headlineLarge?.copyWith(
                      color: PowerMeColors.gold,
                      fontSize: 34,
                      letterSpacing: -.6,
                      fontWeight: FontWeight.w800,
                      fontFeatures: const [FontFeature.tabularFigures()],
                    ),
                  ),
                  const SizedBox(height: 24),
                  MetricGrid(
                    items: [
                      MetricItem(
                        copy.text(
                          'Điểm đang giữ cho lần nạp',
                          'Points reserved for top-up',
                        ),
                        '${s.reserved}',
                        Icons.lock_clock_outlined,
                      ),
                      MetricItem(
                        copy.text(
                          'Hết hạn trong 30 ngày',
                          'Expiring in 30 days',
                        ),
                        '${s.expiringSoon}',
                        Icons.schedule_rounded,
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
          InfoCard(
            spacing: 12,
            children: [
              Text(
                copy.text(
                  'Tích 1 điểm mỗi 1.000 đ chi phí sạc đã ghi sổ. Điểm có hạn 12 tháng; điểm sắp hết hạn được dùng trước. Không tích điểm trên phí giữ chỗ hoặc phiên thanh toán tại trạm.',
                  'Earn 1 point per 1,000 VND of posted charging cost. Points expire in 12 months; oldest points are used first. No points earned on reservation fees or station-paid sessions.',
                ),
              ),
              Text(
                copy.text(
                  'Đổi điểm khi nạp tín dụng: 100 điểm giảm 1.000 đ, tối thiểu 500 điểm và tối đa 50% số tiền nạp.',
                  'Redeem points when topping up credit: 100 points save 1,000 VND, minimum 500 points and up to 50% of the top-up amount.',
                ),
                style: text.bodyMedium?.copyWith(color: PowerMeColors.muted),
              ),
              FilledButton(
                key: const Key('redeem-points'),
                onPressed: () => context.push('/credit'),
                child: Text(
                  copy.text('Đổi điểm khi nạp', 'Redeem points on top-up'),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Text(
            copy.text('Hạn sử dụng điểm', 'Point expiration'),
            style: text.titleLarge,
          ),
          const SizedBox(height: 12),
          if (s.lots.isEmpty)
            InfoCard(
              children: [
                Text(
                  copy.text('Chưa có điểm khả dụng.', 'No available points.'),
                ),
              ],
            )
          else
            InfoCard(
              children: [
                for (final (index, lot) in s.lots.indexed)
                  ValueLine(
                    '${lot.points} ${copy.text('điểm', 'pts')}',
                    ict(lot.expiresAt),
                    showDivider: index != s.lots.length - 1,
                  ),
              ],
            ),
          const SizedBox(height: 12),
          Text(
            copy.text('Lịch sử điểm', 'Point history'),
            style: text.titleLarge,
          ),
          const SizedBox(height: 12),
          if (s.entries.isEmpty)
            InfoCard(
              children: [
                Text(
                  copy.text(
                    'Chưa có giao dịch điểm.',
                    'No point transactions yet.',
                  ),
                ),
              ],
            ),
          for (final e in s.entries)
            InfoCard(
              spacing: 8,
              children: [
                Text(e.label, style: text.titleMedium),
                ValueLine(
                  ict(e.at),
                  '${e.points > 0 ? '+' : ''}${e.points} ${copy.text('điểm', 'pts')}',
                  showDivider: false,
                ),
              ],
            ),
        ],
        OutlinedButton(
          onPressed: () => ref.invalidate(loyaltyProvider),
          child: Text(copy.text('Cập nhật điểm', 'Refresh points')),
        ),
      ],
    );
  }
}
