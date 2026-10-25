// Uses the compatible RadioListTile API while supporting the current SDK.
// The control is isolated here so it can migrate to RadioGroup later.
// ignore_for_file: deprecated_member_use

import 'package:flutter/material.dart';

import '../../../core/theme/app_theme.dart';

class ReservationScreen extends StatefulWidget {
  const ReservationScreen({required this.stationId, super.key});

  final String stationId;

  @override
  State<ReservationScreen> createState() => _ReservationScreenState();
}

class _ReservationScreenState extends State<ReservationScreen> {
  String? _selectedSlot;
  bool _submitting = false;
  String? _status;

  Future<void> _confirm() async {
    if (_selectedSlot == null) {
      setState(() => _status = 'Hãy chọn một khung giờ hợp lệ.');
      return;
    }
    setState(() {
      _submitting = true;
      _status = null;
    });
    await Future<void>.delayed(const Duration(milliseconds: 450));
    if (!mounted) return;
    setState(() {
      _submitting = false;
      _status = 'Yêu cầu đặt chỗ đang chờ server mô phỏng xác nhận.';
    });
  }

  @override
  Widget build(BuildContext context) {
    const slots = ['09:00 – 09:30', '10:00 – 10:30', '11:30 – 12:00'];
    return Scaffold(
      appBar: AppBar(title: const Text('Đặt chỗ')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
          children: [
            Text(
              'Giữ một đầu sạc',
              style: Theme.of(
                context,
              ).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 6),
            Text(
              'Station: ${widget.stationId}',
              style: const TextStyle(color: BrandColors.muted, fontSize: 12),
            ),
            const SizedBox(height: 22),
            const Text(
              'Chọn khung giờ',
              style: TextStyle(fontWeight: FontWeight.w700, fontSize: 17),
            ),
            const SizedBox(height: 10),
            for (final slot in slots) ...[
              Card(
                child: RadioListTile<String>(
                  value: slot,
                  groupValue: _selectedSlot,
                  onChanged: (value) => setState(() => _selectedSlot = value),
                  title: Text(slot),
                  subtitle: const Text('Slot fixture · cần xác nhận server'),
                ),
              ),
              const SizedBox(height: 8),
            ],
            const SizedBox(height: 12),
            const Card(
              child: Padding(
                padding: EdgeInsets.all(16),
                child: Text(
                  'Chính sách thời lượng, no-show và giữ chỗ vật lý chưa được nhóm chốt. Màn demo không tuyên bố đã khóa trụ thật.',
                  style: TextStyle(color: BrandColors.muted, height: 1.4),
                ),
              ),
            ),
            const SizedBox(height: 16),
            if (_status != null) ...[
              Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: BrandColors.warning.withValues(alpha: .12),
                  borderRadius: BorderRadius.circular(14),
                ),
                child: Text(
                  _status!,
                  style: const TextStyle(color: BrandColors.warning),
                ),
              ),
              const SizedBox(height: 12),
            ],
            FilledButton(
              onPressed: _submitting ? null : _confirm,
              child: _submitting
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Xác nhận đặt chỗ mô phỏng'),
            ),
          ],
        ),
      ),
    );
  }
}
