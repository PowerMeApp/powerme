import 'package:flutter/material.dart';

import '../../../core/theme/app_theme.dart';

class SupportScreen extends StatefulWidget {
  const SupportScreen({super.key});

  @override
  State<SupportScreen> createState() => _SupportScreenState();
}

class _SupportScreenState extends State<SupportScreen> {
  final _descriptionController = TextEditingController();
  String _category = 'Phiên sạc';
  bool _sending = false;
  bool _submitted = false;
  String? _error;

  @override
  void dispose() {
    _descriptionController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_descriptionController.text.trim().length < 10) {
      setState(() => _error = 'Mô tả cần ít nhất 10 ký tự.');
      return;
    }
    setState(() {
      _sending = true;
      _error = null;
    });
    await Future<void>.delayed(const Duration(milliseconds: 450));
    if (!mounted) return;
    setState(() {
      _sending = false;
      _submitted = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Báo sự cố')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
          children: [
            Text(
              'Cần PowerMe hỗ trợ?',
              style: Theme.of(
                context,
              ).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 6),
            const Text(
              'Mô tả ngắn gọn để đội hỗ trợ xác định đúng trạm hoặc phiên.',
              style: TextStyle(color: BrandColors.muted, height: 1.35),
            ),
            const SizedBox(height: 22),
            if (_submitted) ...[
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(20),
                  child: Column(
                    children: [
                      const Icon(
                        Icons.check_circle_outline,
                        color: BrandColors.teal,
                        size: 46,
                      ),
                      const SizedBox(height: 12),
                      const Text(
                        'Đã ghi nhận trong fixture mô phỏng',
                        style: TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w700,
                        ),
                        textAlign: TextAlign.center,
                      ),
                      const SizedBox(height: 8),
                      const Text(
                        'Ticket thật chỉ được tạo sau khi server lưu thành công; bản demo không tự sinh ticket ID.',
                        textAlign: TextAlign.center,
                        style: TextStyle(color: BrandColors.muted, height: 1.4),
                      ),
                    ],
                  ),
                ),
              ),
            ] else ...[
              DropdownButtonFormField<String>(
                initialValue: _category,
                decoration: const InputDecoration(
                  labelText: 'Loại sự cố',
                  prefixIcon: Icon(Icons.category_outlined),
                ),
                items: const [
                  DropdownMenuItem(
                    value: 'Phiên sạc',
                    child: Text('Phiên sạc'),
                  ),
                  DropdownMenuItem(
                    value: 'Trạm/đầu sạc',
                    child: Text('Trạm/đầu sạc'),
                  ),
                  DropdownMenuItem(
                    value: 'Thanh toán',
                    child: Text('Thanh toán'),
                  ),
                  DropdownMenuItem(value: 'Khác', child: Text('Khác')),
                ],
                onChanged: (value) =>
                    setState(() => _category = value ?? _category),
              ),
              const SizedBox(height: 14),
              TextField(
                controller: _descriptionController,
                maxLines: 6,
                maxLength: 500,
                decoration: const InputDecoration(
                  labelText: 'Mô tả',
                  hintText:
                      'Ví dụ: phiên vẫn hiển thị đang sạc sau khi tôi đã dừng...',
                ),
              ),
              if (_error != null) ...[
                const SizedBox(height: 8),
                Text(
                  _error!,
                  style: const TextStyle(color: BrandColors.danger),
                ),
              ],
              const SizedBox(height: 14),
              OutlinedButton.icon(
                onPressed: () => ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(
                    content: Text(
                      'Đính kèm ảnh là tùy chọn và chưa bật trong bản mô phỏng.',
                    ),
                  ),
                ),
                icon: const Icon(Icons.attach_file),
                label: const Text('Đính kèm ảnh (tùy chọn)'),
              ),
              const SizedBox(height: 12),
              FilledButton(
                onPressed: _sending ? null : _submit,
                child: _sending
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('Gửi báo cáo'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
