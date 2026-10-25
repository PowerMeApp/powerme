import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/theme/app_theme.dart';
import '../../../ui/core/brand_mark.dart';

class ScanScreen extends StatefulWidget {
  const ScanScreen({super.key});

  @override
  State<ScanScreen> createState() => _ScanScreenState();
}

class _ScanScreenState extends State<ScanScreen> {
  final _codeController = TextEditingController(text: 'DEMO-A');
  bool _cameraDenied = false;
  String? _error;

  @override
  void dispose() {
    _codeController.dispose();
    super.dispose();
  }

  void _resolve() {
    final code = _codeController.text.trim().toUpperCase();
    if (code == 'DEMO-A' || code == 'CONNECTOR-01') {
      context.go('/discover/station/station-powerme-center');
      return;
    }
    setState(() => _error = 'Không tìm thấy đầu sạc trong hệ thống mô phỏng.');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Quét mã trụ')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 24),
          children: [
            const BrandMark(variant: BrandMarkVariant.charging),
            const SizedBox(height: 20),
            Text(
              'Xác định đúng đầu sạc',
              style: Theme.of(
                context,
              ).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 6),
            const Text(
              'QR chỉ được resolve thành ID trụ/connector; không mở URL tùy ý.',
              style: TextStyle(color: BrandColors.muted, height: 1.4),
            ),
            const SizedBox(height: 24),
            Container(
              height: 220,
              decoration: BoxDecoration(
                color: BrandColors.graphite,
                borderRadius: BorderRadius.circular(24),
                border: Border.all(
                  color: BrandColors.teal.withValues(alpha: .6),
                  width: 2,
                ),
              ),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(
                    _cameraDenied
                        ? Icons.no_photography_outlined
                        : Icons.qr_code_scanner,
                    color: BrandColors.teal,
                    size: 58,
                  ),
                  const SizedBox(height: 12),
                  Text(
                    _cameraDenied ? 'Camera bị từ chối' : 'Khung quét mô phỏng',
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 5),
                  Text(
                    _cameraDenied
                        ? 'Dùng mã thủ công bên dưới.'
                        : 'Camera thật sẽ được nối sau.',
                    style: const TextStyle(color: BrandColors.muted),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),
            OutlinedButton.icon(
              onPressed: () => setState(() => _cameraDenied = !_cameraDenied),
              icon: Icon(
                _cameraDenied ? Icons.camera_alt_outlined : Icons.camera_alt,
              ),
              label: Text(
                _cameraDenied
                    ? 'Mô phỏng cho phép camera'
                    : 'Mô phỏng từ chối camera',
              ),
            ),
            const SizedBox(height: 24),
            TextField(
              controller: _codeController,
              textCapitalization: TextCapitalization.characters,
              decoration: const InputDecoration(
                labelText: 'Nhập mã đầu sạc',
                hintText: 'DEMO-A',
                prefixIcon: Icon(Icons.tag),
              ),
              onChanged: (_) {
                if (_error != null) setState(() => _error = null);
              },
            ),
            if (_error != null) ...[
              const SizedBox(height: 10),
              Text(_error!, style: const TextStyle(color: BrandColors.danger)),
            ],
            const SizedBox(height: 14),
            FilledButton.icon(
              onPressed: _resolve,
              icon: const Icon(Icons.search),
              label: const Text('Resolve mã mô phỏng'),
            ),
          ],
        ),
      ),
    );
  }
}
