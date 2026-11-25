import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/l10n/app_copy.dart';
import '../../profile/domain/driver_profile.dart';
import '../domain/auth_input.dart';
import '../../../core/widgets/brand_mark.dart';
import '../../../core/widgets/flow_page.dart';
import '../application/auth_controller.dart';
import '../domain/auth_repository.dart';

String authFailureText(
  AuthFailure failure, [
  AppCopy copy = const AppCopy(AppLanguage.vietnamese),
]) {
  final (vi, en) = switch (failure) {
    AuthFailure.invalidCredentials => (
      'Email, số điện thoại hoặc mật khẩu chưa đúng.',
      'Email, phone number or password is incorrect.',
    ),
    AuthFailure.emailInUse => (
      'Email này đã được đăng ký. Hãy đăng nhập hoặc dùng email khác.',
      'This email is already registered. Sign in or use another email.',
    ),
    AuthFailure.phoneInUse => (
      'Số điện thoại này đã được đăng ký. Hãy đăng nhập bằng số này hoặc dùng số khác.',
      'This phone number is already registered. Sign in with it or use another number.',
    ),
    AuthFailure.accountLocked => (
      'Tài khoản đã bị khóa. Vui lòng liên hệ hỗ trợ PowerMe.',
      'Your account is locked. Please contact PowerMe support.',
    ),
    AuthFailure.consentRequired => (
      'Vui lòng đồng ý xử lý dữ liệu để tiếp tục.',
      'Please consent to data processing to continue.',
    ),
    AuthFailure.invalidRegistration => (
      'Vui lòng kiểm tra thông tin tài khoản và xe.',
      'Please check your account and vehicle details.',
    ),
    AuthFailure.expired => (
      'Phiên đăng nhập đã kết thúc. Vui lòng đăng nhập lại.',
      'Your session has ended. Please sign in again.',
    ),
    AuthFailure.unavailable => (
      'Chưa thể đăng nhập. Vui lòng thử lại.',
      'Unable to sign in. Please try again.',
    ),
    AuthFailure.accessDenied => (
      'Tài khoản hiện không có quyền truy cập.',
      'Your account does not have access.',
    ),
    AuthFailure.connection => (
      'Không kết nối được PowerMe. Vui lòng thử lại.',
      'Unable to connect to PowerMe. Please try again.',
    ),
    AuthFailure.rateLimited => (
      'Bạn đã thử quá nhiều lần. Vui lòng thử lại sau.',
      'Too many attempts. Please try again later.',
    ),
    AuthFailure.profileUnavailable => (
      'Chưa tải được thông tin tài khoản. Vui lòng đăng nhập lại.',
      'Unable to load your account. Please sign in again.',
    ),
    AuthFailure.registrationUnavailable => (
      'Đăng ký hiện chưa khả dụng.',
      'Registration is currently unavailable.',
    ),
    AuthFailure.registrationUnconfirmed => (
      'Chưa xác nhận được kết quả đăng ký. Hãy thử đăng nhập trước khi đăng ký lại.',
      'Registration is unconfirmed. Try signing in before registering again.',
    ),
  };
  return copy.text(vi, en);
}

class AuthScreen extends ConsumerStatefulWidget {
  const AuthScreen({
    super.key,
    this.copy = const AppCopy(AppLanguage.vietnamese),
  });
  final AppCopy copy;
  @override
  ConsumerState<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends ConsumerState<AuthScreen> {
  final _form = GlobalKey<FormState>();
  final _identifier = TextEditingController();
  final _password = TextEditingController();
  bool _visible = false;
  @override
  void dispose() {
    _identifier.dispose();
    _password.dispose();
    super.dispose();
  }

  void _submit() {
    final auth = ref.read(authControllerProvider);
    if (auth.busy || auth.restoring) return;
    if (_form.currentState!.validate()) {
      ref
          .read(authControllerProvider.notifier)
          .signIn(_identifier.text, _password.text);
    }
  }

  @override
  Widget build(BuildContext context) {
    final copy = widget.copy;
    final auth = ref.watch(authControllerProvider);
    final registration = ref.watch(registrationOptionsProvider);
    final text = Theme.of(context).textTheme;
    final mutedBody = text.bodyLarge?.copyWith(color: PowerMeColors.muted);
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.light.copyWith(
        statusBarColor: Colors.transparent,
      ),
      child: Scaffold(
        backgroundColor: PowerMeColors.black,
        body: SafeArea(
          child: Align(
            alignment: Alignment.topCenter,
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 480),
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(20, 8, 20, 28),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const _LoginBrand(),
                    const SizedBox(height: 12),
                    Semantics(
                      header: true,
                      child: Text(
                        copy.text('Chào mừng trở lại', 'Welcome back'),
                        style: text.headlineLarge,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      copy.text(
                        'Đăng nhập để tiếp tục hành trình của bạn.',
                        'Sign in to continue your journey.',
                      ),
                      style: mutedBody,
                    ),
                    const SizedBox(height: 24),
                    AutofillGroup(
                      child: Form(
                        key: _form,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            _LoginField(
                              label: copy.text(
                                'Email hoặc số điện thoại',
                                'Email or phone number',
                              ),
                              child: TextFormField(
                                key: const Key('auth-email'),
                                autovalidateMode:
                                    AutovalidateMode.onUserInteraction,
                                controller: _identifier,
                                enabled: !auth.busy,
                                keyboardType: TextInputType.text,
                                autocorrect: false,
                                enableSuggestions: false,
                                autofillHints: const [AutofillHints.username],
                                textInputAction: TextInputAction.next,
                                decoration: _loginInput(
                                  hint: copy.text(
                                    'Email / 0901 234 567',
                                    'Email / +84 901 234 567',
                                  ),
                                  icon: Icons.alternate_email_rounded,
                                ),
                                validator: (value) =>
                                    isEmailInput(value ?? '') ||
                                        isPhoneNumberInput(value ?? '')
                                    ? null
                                    : copy.text(
                                        'Nhập email hoặc số điện thoại hợp lệ.',
                                        'Enter a valid email or phone number.',
                                      ),
                              ),
                            ),
                            const SizedBox(height: 16),
                            _LoginField(
                              label: copy.text('Mật khẩu', 'Password'),
                              child: TextFormField(
                                key: const Key('auth-password'),
                                controller: _password,
                                enabled: !auth.busy,
                                obscureText: !_visible,
                                autocorrect: false,
                                enableSuggestions: false,
                                autofillHints: const [AutofillHints.password],
                                textInputAction: TextInputAction.done,
                                onFieldSubmitted: (_) => _submit(),
                                decoration: _loginInput(
                                  hint: '••••••••',
                                  icon: Icons.lock_outline_rounded,
                                  suffixIcon: IconButton(
                                    tooltip: _visible
                                        ? copy.text(
                                            'Ẩn mật khẩu',
                                            'Hide password',
                                          )
                                        : copy.text(
                                            'Hiện mật khẩu',
                                            'Show password',
                                          ),
                                    onPressed: auth.busy
                                        ? null
                                        : () => setState(
                                            () => _visible = !_visible,
                                          ),
                                    icon: Icon(
                                      _visible
                                          ? Icons.visibility_off_outlined
                                          : Icons.visibility_outlined,
                                      size: 20,
                                    ),
                                  ),
                                ),
                                validator: (value) =>
                                    value == null || value.isEmpty
                                    ? copy.text(
                                        'Nhập mật khẩu.',
                                        'Enter your password.',
                                      )
                                    : null,
                              ),
                            ),
                            if (auth.failure != null)
                              FailureNotice(
                                authFailureText(auth.failure!, copy),
                              ),
                            const SizedBox(height: 24),
                            _LoginSubmit(
                              busy: auth.busy,
                              onPressed: _submit,
                              copy: copy,
                            ),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(height: 16),
                    if (registration.enabled)
                      Wrap(
                        alignment: WrapAlignment.center,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          Text(
                            copy.text(
                              'Chưa có tài khoản?',
                              'Don’t have an account?',
                            ),
                            style: mutedBody,
                          ),
                          TextButton(
                            key: const Key('auth-register'),
                            style: TextButton.styleFrom(
                              foregroundColor: PowerMeColors.gold,
                              padding: const EdgeInsets.symmetric(
                                horizontal: 8,
                              ),
                            ),
                            onPressed: auth.busy
                                ? null
                                : () {
                                    ref
                                        .read(authControllerProvider.notifier)
                                        .clearFailure();
                                    context.go('/register');
                                  },
                            child: Text(
                              copy.text('Đăng ký ngay', 'Register now'),
                            ),
                          ),
                        ],
                      )
                    else
                      Text(
                        copy.text(
                          'Đăng ký hiện chưa khả dụng.',
                          'Registration is currently unavailable.',
                        ),
                        textAlign: TextAlign.center,
                        style: mutedBody,
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _LoginBrand extends StatelessWidget {
  const _LoginBrand();

  @override
  Widget build(BuildContext context) => const Padding(
    padding: EdgeInsets.symmetric(vertical: 12),
    child: Center(child: BrandMark(hero: true)),
  );
}

class _LoginField extends StatelessWidget {
  const _LoginField({required this.label, required this.child});

  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Padding(
        padding: const EdgeInsets.only(left: 4, bottom: 6),
        child: ExcludeSemantics(
          child: Text(label, style: Theme.of(context).textTheme.labelLarge),
        ),
      ),
      Semantics(label: label, child: child),
    ],
  );
}

InputDecoration _loginInput({
  required String hint,
  required IconData icon,
  Widget? suffixIcon,
}) => InputDecoration(
  constraints: const BoxConstraints(minHeight: 52),
  hintText: hint,
  hintMaxLines: 1,
  hintStyle: TextStyle(color: PowerMeColors.muted.withValues(alpha: .68)),
  prefixIcon: Icon(icon, size: 20),
  prefixIconColor: PowerMeColors.muted,
  suffixIcon: suffixIcon,
  errorMaxLines: 3,
);

class _LoginSubmit extends StatelessWidget {
  const _LoginSubmit({
    required this.busy,
    required this.onPressed,
    required this.copy,
  });

  final AppCopy copy;

  final bool busy;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => FilledButton(
    key: const Key('auth-submit'),
    onPressed: busy ? null : onPressed,
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Flexible(
          child: Semantics(
            liveRegion: busy,
            child: Text(
              busy
                  ? copy.text('Đang đăng nhập…', 'Signing in…')
                  : copy.text('ĐĂNG NHẬP', 'SIGN IN'),
              semanticsLabel: busy ? null : copy.text('Đăng nhập', 'Sign in'),
              textAlign: TextAlign.center,
            ),
          ),
        ),
        const SizedBox(width: 8),
        if (busy)
          const ExcludeSemantics(
            child: SizedBox.square(
              dimension: 18,
              child: CircularProgressIndicator(
                color: PowerMeColors.muted,
                strokeWidth: 2,
              ),
            ),
          )
        else
          const Icon(Icons.bolt_rounded, size: 20),
      ],
    ),
  );
}
