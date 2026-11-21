import 'package:flutter/material.dart';

import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/driver_task_page.dart';

class PointsHelpHeading extends StatelessWidget {
  const PointsHelpHeading({
    super.key,
    required this.copy,
    this.icon = Icons.auto_awesome_outlined,
  });

  final AppCopy copy;
  final IconData icon;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Expanded(
        child: DriverTaskHeading(
          copy.text('Sử dụng điểm PowerMe', 'Use PowerMe points'),
          icon: icon,
        ),
      ),
      const SizedBox(width: 8),
      IconButton(
        key: const Key('points-help'),
        tooltip: copy.text(
          'Cách sử dụng điểm PowerMe',
          'How to use PowerMe points',
        ),
        constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
        color: PowerMeColors.teal,
        icon: const Icon(Icons.help_outline_rounded),
        onPressed: () {
          FocusScope.of(context).unfocus();
          showModalBottomSheet<void>(
            context: context,
            isScrollControlled: true,
            useSafeArea: true,
            showDragHandle: true,
            builder: (context) => Padding(
              padding: EdgeInsets.only(
                bottom: MediaQuery.viewInsetsOf(context).bottom,
              ),
              child: _PointsHelpSheet(copy: copy),
            ),
          );
        },
      ),
    ],
  );
}

class _PointsHelpSheet extends StatelessWidget {
  const _PointsHelpSheet({required this.copy});

  final AppCopy copy;

  @override
  Widget build(BuildContext context) => SafeArea(
    top: false,
    child: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Flexible(
          child: SingleChildScrollView(
            key: const Key('points-help-content'),
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Semantics(
                  header: true,
                  child: Text(
                    copy.text(
                      'Cách sử dụng điểm PowerMe',
                      'How to use PowerMe points',
                    ),
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                ),
                const SizedBox(height: 16),
                Text(
                  copy.text(
                    'Bạn cần ít nhất 500 điểm còn hạn và mỗi lần đổi phải dùng tối thiểu 500 điểm. Dưới 500 điểm, bạn vẫn có thể nạp tín dụng không dùng điểm.',
                    'You need at least 500 unexpired points, and each redemption must use at least 500 points. With fewer than 500 points, you can still top up without using points.',
                  ),
                ),
                const SizedBox(height: 16),
                Text(
                  copy.text(
                    'Điểm tích từ phiên sạc được ghi trên bảng kê sau quyết toán.',
                    'Points earned from charging appear on your statement after settlement.',
                  ),
                ),
                const SizedBox(height: 16),
                Text(
                  copy.text(
                    '1. Mở Nạp tín dụng và chọn số tiền muốn nạp.',
                    '1. Open Top up credit and choose the amount to add.',
                  ),
                ),
                const SizedBox(height: 12),
                Text(
                  copy.text(
                    '2. Nhập số điểm muốn dùng hoặc chọn Dùng tối đa. Chọn Không dùng điểm để chỉ thanh toán bằng tiền. Số điểm được dùng và mức giảm theo báo giá hiện tại.',
                    '2. Enter points to use or choose Use maximum. Choose Clear points to pay with money only. The points you can use and the discount depend on the current quote.',
                  ),
                ),
                const SizedBox(height: 12),
                Text(
                  copy.text(
                    '3. Kiểm tra tóm tắt trước khi thanh toán qua VNPay. Khi dùng điểm, số tiền phải trả được giảm. Tín dụng được cộng đủ số tiền yêu cầu nạp. Điểm chỉ bị trừ khi thanh toán được xác nhận thành công.',
                    '3. Review the summary before paying through VNPay. Using points reduces the amount you pay. The full requested top-up amount is added as credit. Points are deducted only when payment is confirmed successful.',
                  ),
                ),
                const SizedBox(height: 16),
                Text(
                  copy.text(
                    'Điểm khả dụng chỉ gồm điểm chưa hết hạn. Điểm không thể chuyển nhượng hoặc đổi thành tiền mặt.',
                    'Available points include only unexpired points. Points cannot be transferred or exchanged for cash.',
                  ),
                ),
              ],
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
          child: FilledButton(
            key: const Key('points-help-close'),
            onPressed: () => Navigator.of(context).pop(),
            child: Text(copy.text('Đã hiểu', 'Got it')),
          ),
        ),
      ],
    ),
  );
}
