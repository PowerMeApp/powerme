import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/formatters.dart';
import '../../../core/theme/app_theme.dart';
import '../../../ui/core/status_pill.dart';
import '../../charging/presentation/charging_controller.dart';
import '../domain/payment_models.dart';
import 'payment_controller.dart';

class PaymentScreen extends ConsumerWidget {
  const PaymentScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final payment = ref.watch(paymentControllerProvider);
    final summary = ref.watch(chargingControllerProvider).summary;
    final amount = summary?.amountVnd ?? payment.billAmountVnd;
    final controller = ref.read(paymentControllerProvider.notifier);
    return Scaffold(
      appBar: AppBar(title: const Text('Thanh toán')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
          children: [
            const Text(
              'Bill phiên sạc',
              style: TextStyle(fontSize: 24, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 6),
            const Text(
              'Thông tin thanh toán mô phỏng, chưa kết nối provider thật.',
              style: TextStyle(color: BrandColors.muted),
            ),
            const SizedBox(height: 20),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Tạm tính',
                      style: TextStyle(color: BrandColors.muted),
                    ),
                    const SizedBox(height: 5),
                    Text(
                      AppFormatters.money(amount),
                      style: const TextStyle(
                        fontSize: 30,
                        fontWeight: FontWeight.w700,
                        color: BrandColors.gold,
                      ),
                    ),
                    const SizedBox(height: 16),
                    const Divider(color: Color(0xFF2B2F3A)),
                    const SizedBox(height: 12),
                    const Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text('Phương thức'),
                        Text(
                          'Visa •••• 4242',
                          style: TextStyle(fontWeight: FontWeight.w700),
                        ),
                      ],
                    ),
                    const SizedBox(height: 9),
                    const Text(
                      'Số thẻ thật không được lưu trong ứng dụng.',
                      style: TextStyle(color: BrandColors.muted, fontSize: 12),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),
            if (payment.status != PaymentStatus.idle)
              _PaymentStatus(status: payment.status, message: payment.message),
            if (payment.status == PaymentStatus.idle ||
                payment.canCreateAttempt) ...[
              FilledButton.icon(
                onPressed: () => controller.createAttempt(amount),
                icon: const Icon(Icons.open_in_new),
                label: const Text('Tạo payment attempt mô phỏng'),
              ),
              const SizedBox(height: 10),
            ],
            if (payment.status == PaymentStatus.pending) ...[
              OutlinedButton.icon(
                onPressed: controller.simulatePaid,
                icon: const Icon(Icons.verified_outlined),
                label: const Text('Mô phỏng callback hợp lệ'),
              ),
              const SizedBox(height: 10),
              OutlinedButton.icon(
                onPressed: controller.simulateFailed,
                icon: const Icon(Icons.error_outline),
                label: const Text('Mô phỏng thanh toán thất bại'),
              ),
              const SizedBox(height: 10),
              OutlinedButton.icon(
                onPressed: controller.simulateClosedCheckout,
                icon: const Icon(Icons.close),
                label: const Text('Mô phỏng đóng checkout'),
              ),
              const SizedBox(height: 10),
              TextButton.icon(
                onPressed: controller.simulateUnknown,
                icon: const Icon(Icons.help_outline),
                label: const Text('Mô phỏng kết quả chưa rõ'),
              ),
            ],
            if (payment.status == PaymentStatus.unknown ||
                payment.status == PaymentStatus.closed) ...[
              OutlinedButton.icon(
                onPressed: controller.queryStatus,
                icon: const Icon(Icons.refresh),
                label: const Text('Tra cứu attempt hiện có'),
              ),
            ],
            if (payment.status == PaymentStatus.paid) ...[
              FilledButton.icon(
                onPressed: () => context.go('/history'),
                icon: const Icon(Icons.history),
                label: const Text('Xem lịch sử'),
              ),
              const SizedBox(height: 10),
            ],
            const SizedBox(height: 16),
            const Text(
              'Return từ checkout chỉ điều hướng; trạng thái paid phải đến từ server/callback đã xác minh.',
              textAlign: TextAlign.center,
              style: TextStyle(
                color: BrandColors.muted,
                fontSize: 12,
                height: 1.4,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _PaymentStatus extends StatelessWidget {
  const _PaymentStatus({required this.status, required this.message});

  final PaymentStatus status;
  final String? message;

  @override
  Widget build(BuildContext context) {
    final (label, color, icon) = switch (status) {
      PaymentStatus.pending => (
        'Đang chờ callback',
        BrandColors.warning,
        Icons.hourglass_top,
      ),
      PaymentStatus.paid => (
        'Đã xác nhận thanh toán',
        BrandColors.teal,
        Icons.check_circle_outline,
      ),
      PaymentStatus.failed => (
        'Thanh toán thất bại',
        BrandColors.danger,
        Icons.error_outline,
      ),
      PaymentStatus.closed => (
        'Checkout đã đóng',
        BrandColors.warning,
        Icons.close,
      ),
      PaymentStatus.unknown => (
        'Chưa rõ kết quả',
        BrandColors.warning,
        Icons.help_outline,
      ),
      PaymentStatus.expired => (
        'Attempt hết hạn',
        BrandColors.muted,
        Icons.timer_off_outlined,
      ),
      PaymentStatus.idle => (
        'Chưa tạo attempt',
        BrandColors.muted,
        Icons.info_outline,
      ),
    };
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            StatusPill(label: label, color: color, icon: icon),
            if (message != null) ...[
              const SizedBox(height: 10),
              Text(
                message!,
                style: const TextStyle(color: BrandColors.muted, height: 1.35),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
