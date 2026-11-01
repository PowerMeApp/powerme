import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/app_page.dart';
import '../../../core/widgets/flow_page.dart';
import '../../profile/domain/driver_profile.dart';
import '../../profile/presentation/vehicle_fields.dart';
import '../application/auth_controller.dart';
import '../domain/auth_repository.dart';
import 'auth_screen.dart';

class OnboardingScreen extends ConsumerStatefulWidget {
  const OnboardingScreen({super.key});
  @override
  ConsumerState<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends ConsumerState<OnboardingScreen> {
  final _form = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _password = TextEditingController();
  VehicleDraft _vehicle = const VehicleDraft(
    brand: '',
    model: '',
    connectors: [],
  );
  int _step = 0;
  bool _consent = false;
  bool _consentError = false;
  bool _visible = false;
  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  void _next() {
    if (_step == 0) {
      if (!_consent) {
        setState(() => _consentError = true);
        return;
      }
    } else if (!_form.currentState!.validate()) {
      return;
    }
    if (_step < 2) {
      setState(() => _step++);
      return;
    }
    ref
        .read(authControllerProvider.notifier)
        .register(
          Registration(
            displayName: _name.text,
            email: _email.text,
            password: _password.text,
            vehicle: _vehicle,
            consent: _consent,
          ),
        );
  }

  @override
  Widget build(BuildContext context) {
    final auth = ref.watch(authControllerProvider);
    final text = Theme.of(context).textTheme;
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop || auth.busy) return;
        if (_step > 0) {
          setState(() => _step--);
        } else {
          context.go('/login');
        }
      },
      child: Scaffold(
        appBar: AppBar(
          leading: IconButton(
            tooltip: 'Quay lại',
            onPressed: auth.busy
                ? null
                : () {
                    ref.read(authControllerProvider.notifier).clearFailure();
                    if (_step > 0) {
                      setState(() => _step--);
                    } else {
                      context.go('/login');
                    }
                  },
            icon: const Icon(Icons.arrow_back_rounded),
          ),
          title: const Text('Tạo tài khoản'),
        ),
        body: AppPage(
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: StatusBadge(
                'Bước ${_step + 1} / 3',
                color: _step == 2 ? PowerMeColors.teal : PowerMeColors.gold,
              ),
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                for (var i = 0; i < 3; i++) ...[
                  if (i > 0) const SizedBox(width: 6),
                  Expanded(
                    child: Container(
                      height: 6,
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(999),
                        color: i < _step
                            ? PowerMeColors.teal
                            : i == _step
                            ? PowerMeColors.gold
                            : PowerMeColors.outline.withValues(alpha: .5),
                      ),
                    ),
                  ),
                ],
              ],
            ),
            const SizedBox(height: 20),
            HeroCard(
              accent: _step == 2 ? PowerMeColors.teal : PowerMeColors.gold,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Container(
                        width: 40,
                        height: 40,
                        decoration: BoxDecoration(
                          color:
                              (_step == 2
                                      ? PowerMeColors.teal
                                      : PowerMeColors.gold)
                                  .withValues(alpha: .14),
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: Icon(
                          [
                            Icons.verified_user_outlined,
                            Icons.badge_outlined,
                            Icons.electric_car_outlined,
                          ][_step],
                          color: _step == 2
                              ? PowerMeColors.teal
                              : PowerMeColors.gold,
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              [
                                'Quyền riêng tư của bạn',
                                'Thông tin tài khoản',
                                'Xe của bạn',
                              ][_step],
                              style: text.headlineSmall,
                            ),
                            const SizedBox(height: 4),
                            Text(
                              [
                                'Minh bạch dữ liệu trước khi bắt đầu hành trình.',
                                'Thiết lập thông tin định danh và đăng nhập.',
                                'Lưu cấu hình xe để lọc trạm sạc tương thích.',
                              ][_step],
                              style: text.bodyMedium?.copyWith(
                                color: PowerMeColors.muted,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 20),
                  if (_step == 0) ...[
                    Container(
                      padding: const EdgeInsets.all(14),
                      decoration: BoxDecoration(
                        color: PowerMeColors.black,
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(
                          color: PowerMeColors.outline.withValues(alpha: .6),
                        ),
                      ),
                      child: const Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'PowerMe xử lý thông tin tài khoản và xe để cung cấp dịch vụ sạc. Khi bạn sử dụng dịch vụ, thông tin phiên sạc, thanh toán và tín dụng sạc được dùng để vận hành, đối soát và hỗ trợ tài khoản.',
                          ),
                          SizedBox(height: 12),
                          Text(
                            'Bạn có thể xem và cập nhật hồ sơ trong Tài khoản. Chỉ tiếp tục nếu bạn đồng ý với mục đích xử lý dữ liệu trên.',
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 16),
                    Material(
                      color: _consent
                          ? Color.alphaBlend(
                              PowerMeColors.teal.withValues(alpha: .1),
                              PowerMeColors.black,
                            )
                          : PowerMeColors.black,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                        side: BorderSide(
                          color: _consent
                              ? PowerMeColors.teal
                              : PowerMeColors.outline,
                        ),
                      ),
                      clipBehavior: Clip.antiAlias,
                      child: CheckboxListTile(
                        key: const Key('consent'),
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 12,
                          vertical: 4,
                        ),
                        controlAffinity: ListTileControlAffinity.leading,
                        value: _consent,
                        onChanged: (value) => setState(() {
                          _consent = value ?? false;
                          _consentError = false;
                        }),
                        title: const Text(
                          'Tôi đồng ý xử lý dữ liệu cá nhân cho các mục đích trên.',
                        ),
                      ),
                    ),
                    if (_consentError)
                      const FailureNotice(
                        'Cần sự đồng ý của bạn để tạo tài khoản.',
                      ),
                  ] else
                    Form(
                      key: _form,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          if (_step == 1) ...[
                            TextFormField(
                              key: const Key('register-name'),
                              controller: _name,
                              enabled: !auth.busy,
                              maxLength: 80,
                              textInputAction: TextInputAction.next,
                              decoration: const InputDecoration(
                                labelText: 'Họ và tên',
                                fillColor: PowerMeColors.black,
                                prefixIcon: Icon(Icons.person_outline_rounded),
                                counterText: '',
                              ),
                              validator: (value) =>
                                  value == null || value.trim().isEmpty
                                  ? 'Nhập họ và tên.'
                                  : null,
                            ),
                            const SizedBox(height: 16),
                            TextFormField(
                              key: const Key('register-email'),
                              controller: _email,
                              enabled: !auth.busy,
                              keyboardType: TextInputType.emailAddress,
                              textInputAction: TextInputAction.next,
                              decoration: const InputDecoration(
                                labelText: 'Email',
                                fillColor: PowerMeColors.black,
                                prefixIcon: Icon(Icons.mail_outline_rounded),
                              ),
                              validator: (value) =>
                                  RegExp(
                                    r'^[^\s@]+@[^\s@]+\.[^\s@]+$',
                                  ).hasMatch(value?.trim() ?? '')
                                  ? null
                                  : 'Nhập email hợp lệ.',
                            ),
                            const SizedBox(height: 16),
                            TextFormField(
                              key: const Key('register-password'),
                              controller: _password,
                              enabled: !auth.busy,
                              obscureText: !_visible,
                              autocorrect: false,
                              enableSuggestions: false,
                              decoration: InputDecoration(
                                labelText: 'Mật khẩu',
                                fillColor: PowerMeColors.black,
                                helperText: 'Ít nhất 8 ký tự',
                                prefixIcon: const Icon(
                                  Icons.lock_outline_rounded,
                                ),
                                suffixIcon: IconButton(
                                  tooltip: _visible
                                      ? 'Ẩn mật khẩu'
                                      : 'Hiện mật khẩu',
                                  onPressed: () =>
                                      setState(() => _visible = !_visible),
                                  icon: Icon(
                                    _visible
                                        ? Icons.visibility_off_outlined
                                        : Icons.visibility_outlined,
                                  ),
                                ),
                              ),
                              validator: (value) => (value?.length ?? 0) < 8
                                  ? 'Mật khẩu cần ít nhất 8 ký tự.'
                                  : null,
                            ),
                          ] else
                            VehicleFields(
                              copy: const AppCopy(AppLanguage.vietnamese),
                              enabled: !auth.busy,
                              inputFillColor: PowerMeColors.black,
                              vehicle: Vehicle(
                                id: '',
                                brand: _vehicle.brand,
                                model: _vehicle.model,
                                connectors: _vehicle.connectors,
                              ),
                              onChanged: (value) => _vehicle = value,
                            ),
                        ],
                      ),
                    ),
                  if (auth.failure != null)
                    FailureNotice(authFailureText(auth.failure!)),
                  const SizedBox(height: 20),
                  FilledButton(
                    key: const Key('onboarding-next'),
                    onPressed: auth.busy ? null : _next,
                    child: Text(
                      auth.busy
                          ? 'Đang tạo tài khoản…'
                          : _step == 2
                          ? 'Tạo tài khoản'
                          : 'Tiếp tục',
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
