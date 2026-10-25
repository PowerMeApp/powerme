import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/theme/app_theme.dart';
import '../../../ui/core/app_scaffold.dart';
import '../../../ui/core/brand_mark.dart';
import '../../../ui/core/status_pill.dart';
import '../../auth/presentation/auth_controller.dart';

class AccountScreen extends ConsumerWidget {
  const AccountScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authControllerProvider);
    return AppScaffold(
      title: 'Tài khoản',
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
        children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(18),
              child: Row(
                children: [
                  const CircleAvatar(
                    radius: 28,
                    backgroundColor: BrandColors.teal,
                    child: Icon(
                      Icons.person,
                      color: BrandColors.richBlack,
                      size: 30,
                    ),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Minh Nguyễn',
                          style: Theme.of(context).textTheme.titleLarge
                              ?.copyWith(fontWeight: FontWeight.w700),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          auth.email ?? 'driver.demo@powerme.local',
                          style: const TextStyle(
                            color: BrandColors.muted,
                            fontSize: 12,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const BrandMark(variant: BrandMarkVariant.compact),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          const Text(
            'Xe và thanh toán',
            style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 10),
          Card(
            child: Column(
              children: [
                const ListTile(
                  leading: Icon(
                    Icons.directions_car_outlined,
                    color: BrandColors.teal,
                  ),
                  title: Text('VinFast VF 8'),
                  subtitle: Text('CCS2 · Xe mặc định'),
                  trailing: Icon(Icons.chevron_right),
                ),
                const Divider(height: 1, color: Color(0xFF2B2F3A)),
                const ListTile(
                  leading: Icon(
                    Icons.credit_card_outlined,
                    color: BrandColors.gold,
                  ),
                  title: Text('Visa •••• 4242'),
                  subtitle: Text('Token provider còn hiệu lực'),
                  trailing: Icon(Icons.chevron_right),
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),
          const Text(
            'PowerMe membership',
            style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 10),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Row(
                    children: [
                      Icon(Icons.stars_outlined, color: BrandColors.gold),
                      SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          'Điểm PowerMe',
                          style: TextStyle(fontWeight: FontWeight.w700),
                        ),
                      ),
                      Text(
                        '1.280 điểm',
                        style: TextStyle(
                          color: BrandColors.gold,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  const Text(
                    'Ledger và điều kiện đổi điểm do server quyết định.',
                    style: TextStyle(color: BrandColors.muted, fontSize: 12),
                  ),
                  const SizedBox(height: 12),
                  OutlinedButton(
                    onPressed: () => _showLoyalty(context),
                    child: const Text('Xem quyền lợi'),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 20),
          const Text(
            'Hỗ trợ và phiên đăng nhập',
            style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 10),
          Card(
            child: Column(
              children: [
                ListTile(
                  leading: const Icon(Icons.support_agent_outlined),
                  title: const Text('Báo sự cố'),
                  subtitle: const Text('Gửi ticket cho trạm hoặc phiên sạc'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => context.push('/support'),
                ),
                ListTile(
                  leading: const Icon(
                    Icons.timer_off_outlined,
                    color: BrandColors.warning,
                  ),
                  title: const Text('Mô phỏng hết phiên'),
                  subtitle: const Text(
                    'Kiểm tra route bảo vệ và màn đăng nhập',
                  ),
                  onTap: () => ref
                      .read(authControllerProvider.notifier)
                      .markSessionExpired(),
                ),
                ListTile(
                  leading: const Icon(Icons.logout, color: BrandColors.danger),
                  title: const Text(
                    'Đăng xuất',
                    style: TextStyle(color: BrandColors.danger),
                  ),
                  onTap: () {
                    ref.read(authControllerProvider.notifier).signOut();
                    context.go('/auth');
                  },
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  void _showLoyalty(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      builder: (_) => const SafeArea(
        child: Padding(
          padding: EdgeInsets.all(22),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Quyền lợi thành viên',
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
              ),
              SizedBox(height: 12),
              StatusPill(
                label: 'Bronze · dữ liệu mô phỏng',
                color: BrandColors.gold,
                icon: Icons.stars_outlined,
              ),
              SizedBox(height: 12),
              Text(
                'Chính sách tích/đổi điểm chưa được chốt. Màn hình chỉ hiển thị ledger mẫu, không tự trừ điểm.',
                style: TextStyle(color: BrandColors.muted, height: 1.4),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
