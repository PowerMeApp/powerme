import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/app_page.dart';
import '../../../core/widgets/brand_mark.dart';
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
  static final _emailPattern = RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$');
  static final _controlCharacters = RegExp(r'[\x00-\x1f\x7f]');
  final _form = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _confirmPassword = TextEditingController();
  VehicleDraft _vehicle = const VehicleDraft(
    brand: '',
    model: '',
    connectors: [],
  );
  int _step = 0;
  bool _consent = false;
  bool _consentError = false;
  bool _visible = false;
  bool _confirmVisible = false;
  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    _password.dispose();
    _confirmPassword.dispose();
    super.dispose();
  }

  void _next(bool needsVehicle) {
    if (_step == 0) {
      if (!_consent) {
        setState(() => _consentError = true);
        return;
      }
    } else if (!_form.currentState!.validate()) {
      return;
    }
    if (_step < (needsVehicle ? 2 : 1)) {
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
            vehicle: needsVehicle ? _vehicle : null,
            consent: _consent,
          ),
        );
  }

  void _back() {
    ref.read(authControllerProvider.notifier).clearFailure();
    if (_step > 0) {
      setState(() => _step--);
    } else {
      context.go('/login');
    }
  }

  void _login() {
    ref.read(authControllerProvider.notifier).clearFailure();
    context.go('/login');
  }

  @override
  Widget build(BuildContext context) {
    final auth = ref.watch(authControllerProvider);
    final needsVehicle = ref.watch(registrationOptionsProvider).needsVehicle;
    final stepCount = needsVehicle ? 3 : 2;
    final lastStep = _step == stepCount - 1;
    final registrationUnconfirmed =
        auth.failure == AuthFailure.registrationUnconfirmed;
    final text = Theme.of(context).textTheme;
    final action = auth.busy
        ? 'Đang tạo tài khoản…'
        : registrationUnconfirmed
        ? 'Về đăng nhập'
        : lastStep
        ? 'Tạo tài khoản'
        : 'Tiếp tục';

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
          centerTitle: true,
          leadingWidth: 68,
          leading: Padding(
            padding: const EdgeInsets.only(left: 20),
            child: IconButton.filledTonal(
              tooltip: 'Quay lại',
              style: IconButton.styleFrom(
                backgroundColor: PowerMeColors.graphite,
                foregroundColor: PowerMeColors.text,
              ),
              onPressed: auth.busy ? null : _back,
              icon: const Icon(Icons.arrow_back_rounded, size: 20),
            ),
          ),
          title: const SizedBox(
            width: 138,
            height: 40,
            child: FittedBox(child: BrandMark()),
          ),
        ),
        body: AppPage(
          key: ValueKey(_step),
          children: [
            Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'Bước ${_step + 1} / $stepCount',
                  style: text.labelMedium?.copyWith(color: PowerMeColors.gold),
                ),
                const SizedBox(height: 6),
                Semantics(
                  header: true,
                  child: Text(
                    _step == 2 ? 'Xe của bạn' : 'Tạo tài khoản',
                    style: text.headlineLarge,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  [
                    'Đọc và xác nhận mục đích xử lý dữ liệu của PowerMe.',
                    'Nhập thông tin để tạo tài khoản PowerMe.',
                    'Lưu cấu hình xe để lọc trạm sạc tương thích.',
                  ][_step],
                  style: text.bodyMedium?.copyWith(color: PowerMeColors.muted),
                ),
                const SizedBox(height: 20),
                if (_step == 0)
                  _consentCard(needsVehicle: needsVehicle, busy: auth.busy)
                else
                  _accountForm(needsVehicle: needsVehicle, busy: auth.busy),
                if (_step == 0 && _consentError)
                  const FailureNotice(
                    'Cần sự đồng ý của bạn để tạo tài khoản.',
                  ),
                if (auth.failure != null)
                  FailureNotice(
                    !needsVehicle &&
                            auth.failure == AuthFailure.invalidRegistration
                        ? 'Vui lòng kiểm tra thông tin tài khoản.'
                        : authFailureText(auth.failure!),
                  ),
                const SizedBox(height: 20),
                FilledButton(
                  key: const Key('onboarding-next'),
                  onPressed: auth.busy
                      ? null
                      : registrationUnconfirmed
                      ? _login
                      : () => _next(needsVehicle),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Flexible(
                        child: Text(action, textAlign: TextAlign.center),
                      ),
                      if (!auth.busy) ...[
                        const SizedBox(width: 8),
                        const Icon(Icons.arrow_forward_rounded, size: 18),
                      ],
                    ],
                  ),
                ),
                const SizedBox(height: 10),
                Wrap(
                  alignment: WrapAlignment.center,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Text(
                      'Đã có tài khoản?',
                      style: text.bodyMedium?.copyWith(
                        color: PowerMeColors.muted,
                      ),
                    ),
                    TextButton(
                      style: TextButton.styleFrom(
                        foregroundColor: PowerMeColors.gold,
                      ),
                      onPressed: auth.busy ? null : _login,
                      child: const Text('Đăng nhập'),
                    ),
                  ],
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _consentCard({required bool needsVehicle, required bool busy}) {
    final text = Theme.of(context).textTheme;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Align(
              alignment: Alignment.centerLeft,
              child: Icon(
                Icons.verified_user_outlined,
                color: PowerMeColors.gold,
                size: 24,
              ),
            ),
            const SizedBox(height: 12),
            Text('Quyền riêng tư của bạn', style: text.titleLarge),
            const SizedBox(height: 8),
            const Text(
              'PowerMe xử lý thông tin tài khoản và xe để cung cấp dịch vụ sạc. Khi bạn sử dụng dịch vụ, thông tin phiên sạc, thanh toán và tín dụng sạc được dùng để vận hành, đối soát và hỗ trợ tài khoản.',
            ),
            const SizedBox(height: 12),
            Text(
              needsVehicle
                  ? 'Bạn có thể xem và cập nhật hồ sơ trong Tài khoản. Chỉ tiếp tục nếu bạn đồng ý với mục đích xử lý dữ liệu trên.'
                  : 'Bạn có thể xem hồ sơ trong Tài khoản. Chỉ tiếp tục nếu bạn đồng ý với mục đích xử lý dữ liệu trên.',
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
                  color: _consent ? PowerMeColors.teal : PowerMeColors.outline,
                ),
              ),
              clipBehavior: Clip.antiAlias,
              child: CheckboxListTile(
                key: const Key('consent'),
                contentPadding: const EdgeInsets.fromLTRB(6, 4, 12, 4),
                controlAffinity: ListTileControlAffinity.leading,
                value: _consent,
                onChanged: busy
                    ? null
                    : (value) => setState(() {
                        _consent = value ?? false;
                        _consentError = false;
                      }),
                title: const Text(
                  'Tôi đồng ý xử lý dữ liệu cá nhân cho các mục đích trên.',
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _accountForm({required bool needsVehicle, required bool busy}) => Form(
    key: _form,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_step == 1) ...[
          _fieldLabel(
            'Họ và tên',
            TextFormField(
              key: const Key('register-name'),
              controller: _name,
              enabled: !busy,
              maxLength: needsVehicle ? 80 : 100,
              textInputAction: TextInputAction.next,
              decoration: _fieldDecoration(
                hint: 'Nguyễn Văn A',
                icon: Icons.person_outline_rounded,
                counterText: '',
              ),
              validator: (value) {
                final name = value?.trim() ?? '';
                if (name.isEmpty) return 'Nhập họ và tên.';
                if (!needsVehicle &&
                    (name.runes.length > 100 ||
                        _controlCharacters.hasMatch(name))) {
                  return 'Nhập họ và tên hợp lệ, tối đa 100 ký tự.';
                }
                return null;
              },
            ),
          ),
          const SizedBox(height: 16),
          _fieldLabel(
            'Email',
            TextFormField(
              key: const Key('register-email'),
              controller: _email,
              enabled: !busy,
              keyboardType: TextInputType.emailAddress,
              textInputAction: TextInputAction.next,
              decoration: _fieldDecoration(
                hint: 'example@powerme.vn',
                icon: Icons.mail_outline_rounded,
              ),
              validator: (value) {
                final email = value?.trim() ?? '';
                if (!_emailPattern.hasMatch(email)) {
                  return 'Nhập email hợp lệ.';
                }
                if (needsVehicle) return null;
                final normalized = email.toLowerCase();
                if (normalized.length > 254 ||
                    normalized.indexOf('@') > 64 ||
                    normalized.endsWith('.') ||
                    _controlCharacters.hasMatch(normalized)) {
                  return 'Nhập email hợp lệ.';
                }
                return null;
              },
            ),
          ),
          const SizedBox(height: 16),
          _fieldLabel(
            'Mật khẩu',
            TextFormField(
              key: const Key('register-password'),
              controller: _password,
              enabled: !busy,
              textInputAction: TextInputAction.next,
              obscureText: !_visible,
              autocorrect: false,
              enableSuggestions: false,
              decoration: _fieldDecoration(
                hint: 'Nhập mật khẩu',
                icon: Icons.lock_outline_rounded,
                suffixIcon: IconButton(
                  tooltip: _visible ? 'Ẩn mật khẩu' : 'Hiện mật khẩu',
                  onPressed: busy
                      ? null
                      : () => setState(() => _visible = !_visible),
                  icon: Icon(
                    _visible
                        ? Icons.visibility_off_outlined
                        : Icons.visibility_outlined,
                  ),
                ),
              ),
              validator: (value) {
                final length = needsVehicle
                    ? value?.length ?? 0
                    : value?.runes.length ?? 0;
                if (length < 8) {
                  return 'Mật khẩu cần ít nhất 8 ký tự.';
                }
                if (!needsVehicle && length > 128) {
                  return 'Mật khẩu tối đa 128 ký tự.';
                }
                return null;
              },
            ),
          ),
          const SizedBox(height: 6),
          Text(
            needsVehicle ? 'Ít nhất 8 ký tự.' : 'Dùng từ 8 đến 128 ký tự.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: 16),
          _fieldLabel(
            'Xác nhận mật khẩu',
            TextFormField(
              key: const Key('register-confirm-password'),
              controller: _confirmPassword,
              enabled: !busy,
              obscureText: !_confirmVisible,
              autocorrect: false,
              enableSuggestions: false,
              decoration: _fieldDecoration(
                hint: 'Nhập lại mật khẩu',
                icon: Icons.verified_user_outlined,
                suffixIcon: IconButton(
                  tooltip: _confirmVisible
                      ? 'Ẩn mật khẩu nhập lại'
                      : 'Hiện mật khẩu nhập lại',
                  onPressed: busy
                      ? null
                      : () =>
                            setState(() => _confirmVisible = !_confirmVisible),
                  icon: Icon(
                    _confirmVisible
                        ? Icons.visibility_off_outlined
                        : Icons.visibility_outlined,
                  ),
                ),
              ),
              validator: (value) {
                if (value == null || value.isEmpty) {
                  return 'Vui lòng nhập lại mật khẩu.';
                }
                if (value != _password.text) {
                  return 'Mật khẩu nhập lại không khớp.';
                }
                return null;
              },
            ),
          ),
        ] else
          VehicleFields(
            copy: const AppCopy(AppLanguage.vietnamese),
            enabled: !busy,
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
  );

  Widget _fieldLabel(String label, Widget field) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      ExcludeSemantics(
        child: Text(label, style: Theme.of(context).textTheme.labelLarge),
      ),
      const SizedBox(height: 5),
      Semantics(label: label, child: field),
    ],
  );

  InputDecoration _fieldDecoration({
    required String hint,
    required IconData icon,
    String? counterText,
    Widget? suffixIcon,
  }) => InputDecoration(
    constraints: const BoxConstraints(minHeight: 52),
    hintText: hint,
    hintMaxLines: 1,
    hintStyle: TextStyle(color: PowerMeColors.muted.withValues(alpha: .68)),
    prefixIcon: Icon(icon, size: 20),
    prefixIconColor: PowerMeColors.muted,
    counterText: counterText,
    suffixIcon: suffixIcon,
    errorMaxLines: 3,
  );
}
