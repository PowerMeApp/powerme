import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/app_page.dart';
import '../../../core/widgets/flow_page.dart';
import '../application/profile_controller.dart';
import '../domain/driver_profile.dart';
import '../../auth/application/auth_controller.dart';
import '../../payments/application/payments_controller.dart';

class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key, this.readOnly = false});
  final bool readOnly;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(profileControllerProvider);
    final profile = state.profile;
    final copy = AppCopy(profile.language);
    final text = Theme.of(context).textTheme;
    if (readOnly) {
      return AppPage(
        children: [
          Text(copy.profile, style: text.headlineSmall),
          const SizedBox(height: 20),
          HeroCard(
            accent: PowerMeColors.gold,
            child: ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.person_outline_rounded),
              title: Text(profile.displayName, style: text.titleLarge),
              subtitle: const Text('Tài xế'),
            ),
          ),
          const SizedBox(height: 20),
          Text('Xe của bạn', style: text.titleMedium),
          const SizedBox(height: 12),
          InfoCard(
            children: [
              if (profile.vehicles.isEmpty)
                const Text('Chưa có xe trong hồ sơ.'),
              for (final vehicle in profile.vehicles)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.directions_car_outlined),
                  title: Text(vehicle.label),
                  subtitle: Text(
                    [
                      if (vehicle.plateNumber case final String plate) plate,
                      ...vehicle.connectors,
                      if (profile.selectedVehicleId == vehicle.id)
                        'Xe mặc định',
                    ].join(' · '),
                  ),
                ),
            ],
          ),
          if (state.failure != null)
            const FailureNotice('Chưa tải được hồ sơ mới. Vui lòng thử lại.'),
          const SizedBox(height: 16),
          OutlinedButton.icon(
            key: const Key('refresh-profile'),
            onPressed: state.busy
                ? null
                : () => ref.read(profileControllerProvider.notifier).refresh(),
            icon: const Icon(Icons.refresh),
            label: Text(state.busy ? 'Đang tải hồ sơ…' : 'Tải lại hồ sơ'),
          ),
          _SignOutButton(copy: copy),
        ],
      );
    }
    final paymentState = ref.watch(paymentsControllerProvider);
    return AppPage(
      children: [
        if (paymentState.closure != null)
          InfoCard(
            children: [
              Text(
                copy.text(
                  'Đã ghi nhận yêu cầu đóng tài khoản. Phần tín dụng còn lại sẽ được kiểm tra hoàn về nguồn thanh toán.',
                  'Account closure request recorded. Remaining credit will be reviewed for refund to the payment source.',
                ),
              ),
            ],
          ),
        FailureNotice(paymentState.error),
        Text(copy.profile, style: text.headlineSmall),
        const SizedBox(height: 20),
        HeroCard(
          accent: PowerMeColors.gold,
          child: Row(
            children: [
              const CircleAvatar(
                radius: 24,
                backgroundColor: PowerMeColors.gold,
                foregroundColor: PowerMeColors.black,
                child: Icon(Icons.person_outline_rounded),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(profile.displayName, style: text.titleLarge),
                    const SizedBox(height: 4),
                    Text(
                      copy.text('Tài xế', 'Driver'),
                      style: text.bodyMedium?.copyWith(
                        color: PowerMeColors.muted,
                      ),
                    ),
                  ],
                ),
              ),
              IconButton(
                key: const Key('edit-profile'),
                tooltip: copy.text('Sửa hồ sơ', 'Edit profile'),
                onPressed: state.busy
                    ? null
                    : () => context.push('/profile/edit'),
                icon: const Icon(
                  Icons.edit_outlined,
                  color: PowerMeColors.teal,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 20),
        InfoCard(
          spacing: 0,
          children: [
            MenuRow(
              label: copy.text('Tín dụng sạc', 'Charging credit'),
              icon: Icons.account_balance_wallet_outlined,
              onTap: () => context.push('/credit'),
            ),
            const Divider(height: 1),
            MenuRow(
              label: copy.text('Lịch sử và hóa đơn', 'History and invoices'),
              icon: Icons.receipt_long_outlined,
              onTap: () => context.push('/history'),
            ),
            const Divider(height: 1),
            MenuRow(
              label: copy.text('Điểm PowerMe', 'PowerMe points'),
              icon: Icons.stars_outlined,
              onTap: () => context.push('/loyalty'),
            ),
            // const Divider(height: 1),
            // MenuRow(
            //   label: copy.text('Giữ chỗ của tôi', 'My reservations'),
            //   icon: Icons.bookmark_border_rounded,
            //   onTap: () => context.push('/reserve'),
            // ),
          ],
        ),
        const SizedBox(height: 12),
        Text(copy.vehicle, style: text.titleMedium),
        const SizedBox(height: 12),
        if (profile.vehicles.isEmpty)
          InfoCard(
            children: [
              Text(
                copy.text('Bạn chưa thêm xe nào.', 'You have no vehicles yet.'),
              ),
            ],
          ),
        for (final vehicle in profile.vehicles) ...[
          Card(
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(14),
              side: BorderSide(
                color: profile.vehicleId == vehicle.id
                    ? PowerMeColors.teal.withValues(alpha: .48)
                    : PowerMeColors.outline.withValues(alpha: .5),
              ),
            ),
            child: Padding(
              padding: const EdgeInsets.all(18),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(
                    width: 40,
                    height: 40,
                    decoration: BoxDecoration(
                      color: PowerMeColors.black,
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(
                        color:
                            (profile.vehicleId == vehicle.id
                                    ? PowerMeColors.teal
                                    : PowerMeColors.gold)
                                .withValues(alpha: .35),
                      ),
                    ),
                    child: Icon(
                      Icons.directions_car_outlined,
                      size: 20,
                      color: profile.vehicleId == vehicle.id
                          ? PowerMeColors.teal
                          : PowerMeColors.gold,
                    ),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(vehicle.label, style: text.titleMedium),
                        const SizedBox(height: 8),
                        Wrap(
                          spacing: 6,
                          runSpacing: 6,
                          children: [
                            for (final c in vehicle.connectors)
                              Container(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 9,
                                  vertical: 4,
                                ),
                                decoration: BoxDecoration(
                                  color: PowerMeColors.black,
                                  borderRadius: BorderRadius.circular(8),
                                  border: Border.all(
                                    color: PowerMeColors.outline.withValues(
                                      alpha: .55,
                                    ),
                                  ),
                                ),
                                child: Text(
                                  c,
                                  style: text.labelMedium?.copyWith(
                                    color: PowerMeColors.muted,
                                  ),
                                ),
                              ),
                          ],
                        ),
                        const SizedBox(height: 12),
                        Wrap(
                          spacing: 8,
                          runSpacing: 8,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          children: [
                            OutlinedButton(
                              key: Key('select-${vehicle.id}'),
                              onPressed:
                                  state.busy || profile.vehicleId == vehicle.id
                                  ? null
                                  : () => ref
                                        .read(
                                          profileControllerProvider.notifier,
                                        )
                                        .selectVehicle(vehicle.id),
                              child: Text(
                                profile.vehicleId == vehicle.id
                                    ? copy.text('Đang dùng', 'Selected')
                                    : copy.text('Chọn xe', 'Select'),
                              ),
                            ),
                            IconButton(
                              key: Key('edit-${vehicle.id}'),
                              tooltip: copy.text('Sửa xe', 'Edit vehicle'),
                              onPressed: state.busy
                                  ? null
                                  : () => context.push(
                                      '/vehicles/${vehicle.id}/edit',
                                    ),
                              icon: const Icon(Icons.edit_outlined),
                            ),
                            IconButton(
                              key: Key('remove-${vehicle.id}'),
                              tooltip: copy.text('Xóa xe', 'Remove vehicle'),
                              onPressed: state.busy
                                  ? null
                                  : () async {
                                      final remove = await showDialog<bool>(
                                        context: context,
                                        builder: (dialogContext) => AlertDialog(
                                          title: Text(
                                            copy.text(
                                              'Xóa xe?',
                                              'Remove vehicle?',
                                            ),
                                          ),
                                          content: Text(vehicle.label),
                                          actions: [
                                            TextButton(
                                              onPressed: () => Navigator.pop(
                                                dialogContext,
                                                false,
                                              ),
                                              child: Text(
                                                copy.text(
                                                  'Giữ xe',
                                                  'Keep vehicle',
                                                ),
                                              ),
                                            ),
                                            TextButton(
                                              onPressed: () => Navigator.pop(
                                                dialogContext,
                                                true,
                                              ),
                                              child: Text(
                                                copy.text('Xóa', 'Remove'),
                                              ),
                                            ),
                                          ],
                                        ),
                                      );
                                      if (remove == true && context.mounted) {
                                        await ref
                                            .read(
                                              profileControllerProvider
                                                  .notifier,
                                            )
                                            .removeVehicle(vehicle.id);
                                      }
                                    },
                              icon: const Icon(Icons.delete_outline),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 14),
        ],
        OutlinedButton.icon(
          key: const Key('add-vehicle'),
          onPressed: state.busy ? null : () => context.push('/vehicles/new'),
          icon: const Icon(Icons.add),
          label: Text(copy.text('Thêm xe', 'Add vehicle')),
        ),
        if (state.failure != null)
          FailureNotice(
            copy.text(
              'Chưa lưu được thay đổi. Vui lòng thử lại.',
              'Changes could not be saved. Please retry.',
            ),
          ),
        const SizedBox(height: 28),
        Text(copy.languageTitle, style: text.titleMedium),
        const SizedBox(height: 12),
        for (final language in AppLanguage.values) ...[
          Semantics(
            selected: profile.language == language,
            child: OutlinedButton(
              key: Key('language-${language.name}'),
              style: OutlinedButton.styleFrom(
                minimumSize: const Size(48, 56),
                padding: const EdgeInsets.all(16),
                foregroundColor: profile.language == language
                    ? PowerMeColors.teal
                    : PowerMeColors.text,
                side: BorderSide(
                  color: profile.language == language
                      ? PowerMeColors.teal
                      : PowerMeColors.outline,
                ),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
              onPressed: state.busy
                  ? null
                  : () => ref
                        .read(profileControllerProvider.notifier)
                        .selectLanguage(language),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      language == AppLanguage.vietnamese
                          ? 'Tiếng Việt'
                          : 'English',
                    ),
                  ),
                  const SizedBox(width: 8),
                  Icon(
                    profile.language == language
                        ? Icons.check_circle_outline_rounded
                        : Icons.circle_outlined,
                    size: 22,
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 10),
        ],
        const SizedBox(height: 20),
        _SignOutButton(copy: copy),
        const SizedBox(height: 8),
        TextButton(
          key: const Key('request-closure'),
          onPressed: paymentState.busy
              ? null
              : () async {
                  final accepted = await showDialog<bool>(
                    context: context,
                    builder: (ctx) => AlertDialog(
                      title: Text(
                        copy.text(
                          'Yêu cầu đóng tài khoản?',
                          'Request account closure?',
                        ),
                      ),
                      content: Text(
                        copy.text(
                          'Tài khoản chỉ được đóng sau khi kiểm tra phiên sạc, lần nạp và hoàn tín dụng còn lại về nguồn thanh toán. Điểm còn lại sẽ không được giữ khi tài khoản đóng.',
                          'Your account can only be closed after checking active sessions, top-ups, and refunding remaining credit to the payment source. Remaining points will not be kept once closed.',
                        ),
                      ),
                      actions: [
                        TextButton(
                          onPressed: () => Navigator.pop(ctx, false),
                          child: Text(
                            copy.text('Giữ tài khoản', 'Keep account'),
                          ),
                        ),
                        FilledButton(
                          onPressed: () => Navigator.pop(ctx, true),
                          child: Text(
                            copy.text('Gửi yêu cầu', 'Submit request'),
                          ),
                        ),
                      ],
                    ),
                  );
                  if (accepted == true && context.mounted) {
                    await ref
                        .read(paymentsControllerProvider.notifier)
                        .closeAccount();
                  }
                },
          child: Text(
            copy.text('Yêu cầu đóng tài khoản', 'Request account closure'),
          ),
        ),
      ],
    );
  }
}

class _SignOutButton extends ConsumerWidget {
  const _SignOutButton({required this.copy});
  final AppCopy copy;

  @override
  Widget build(BuildContext context, WidgetRef ref) => OutlinedButton.icon(
    key: const Key('logout'),
    onPressed: () async {
      final scope = ref.read(authControllerProvider).scope;
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: Text(copy.text('Đăng xuất?', 'Sign out?')),
          content: Text(
            copy.text(
              'Bạn có thể đăng nhập lại để tiếp tục.',
              'You can sign in again to continue.',
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: Text(copy.text('Ở lại', 'Stay')),
            ),
            TextButton(
              key: const Key('confirm-logout'),
              onPressed: () => Navigator.pop(dialogContext, true),
              child: Text(copy.text('Đăng xuất', 'Sign out')),
            ),
          ],
        ),
      );
      if (confirmed == true &&
          context.mounted &&
          identical(scope, ref.read(authControllerProvider).scope)) {
        ref.read(authControllerProvider.notifier).signOut();
      }
    },
    icon: const Icon(Icons.logout),
    label: Text(copy.text('Đăng xuất', 'Sign out')),
  );
}
