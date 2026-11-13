import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/brand_mark.dart';
import '../../../core/widgets/flow_page.dart';
import '../application/auth_controller.dart';
import '../domain/auth_repository.dart';

String authFailureText(AuthFailure failure) => switch (failure) {
  AuthFailure.invalidCredentials => 'Email hoặc mật khẩu chưa đúng.',
  AuthFailure.emailInUse =>
    'Email này đã được đăng ký. Hãy đăng nhập hoặc dùng email khác.',
  AuthFailure.consentRequired => 'Vui lòng đồng ý xử lý dữ liệu để tiếp tục.',
  AuthFailure.invalidRegistration =>
    'Vui lòng kiểm tra thông tin tài khoản và xe.',
  AuthFailure.expired => 'Phiên đăng nhập đã kết thúc. Vui lòng đăng nhập lại.',
  AuthFailure.unavailable => 'Chưa thể đăng nhập. Vui lòng thử lại.',
  AuthFailure.accessDenied => 'Tài khoản hiện không có quyền truy cập.',
  AuthFailure.connection => 'Không kết nối được PowerMe. Vui lòng thử lại.',
  AuthFailure.rateLimited => 'Bạn đã thử quá nhiều lần. Vui lòng thử lại sau.',
  AuthFailure.profileUnavailable =>
    'Chưa tải được thông tin tài khoản. Vui lòng đăng nhập lại.',
  AuthFailure.registrationUnavailable => 'Đăng ký hiện chưa khả dụng.',
  AuthFailure.registrationUnconfirmed =>
    'Chưa xác nhận được kết quả đăng ký. Hãy thử đăng nhập trước khi đăng ký lại.',
};

class AuthScreen extends ConsumerStatefulWidget {
  const AuthScreen({super.key});
  @override
  ConsumerState<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends ConsumerState<AuthScreen> {
  final _form = GlobalKey<FormState>();
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _visible = false;
  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  void _submit() {
    if (_form.currentState!.validate()) {
      ref
          .read(authControllerProvider.notifier)
          .signIn(_email.text, _password.text);
    }
  }

  @override
  Widget build(BuildContext context) {
    final auth = ref.watch(authControllerProvider);
    final registration = ref.watch(registrationOptionsProvider);
    final text = Theme.of(context).textTheme;
    final mutedBody = text.bodyMedium?.copyWith(color: PowerMeColors.muted);
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
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const _LoginBrand(),
                    Semantics(
                      header: true,
                      child: Text('Chào mừng trở lại', style: text.titleLarge),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'Đăng nhập để tiếp tục hành trình của bạn.',
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
                              label: 'Email',
                              child: TextFormField(
                                key: const Key('auth-email'),
                                controller: _email,
                                enabled: !auth.busy,
                                keyboardType: TextInputType.emailAddress,
                                autofillHints: const [AutofillHints.username],
                                textInputAction: TextInputAction.next,
                                decoration: _loginInput(
                                  hint: 'email@example.com',
                                  icon: Icons.alternate_email_rounded,
                                ),
                                validator: (value) =>
                                    RegExp(
                                      r'^[^\s@]+@[^\s@]+\.[^\s@]+$',
                                    ).hasMatch(value?.trim() ?? '')
                                    ? null
                                    : 'Nhập email hợp lệ.',
                              ),
                            ),
                            const SizedBox(height: 16),
                            _LoginField(
                              label: 'Mật khẩu',
                              child: TextFormField(
                                key: const Key('auth-password'),
                                controller: _password,
                                enabled: !auth.busy,
                                obscureText: !_visible,
                                autocorrect: false,
                                enableSuggestions: false,
                                autofillHints: const [AutofillHints.password],
                                onFieldSubmitted: (_) => _submit(),
                                decoration: _loginInput(
                                  hint: '••••••••',
                                  icon: Icons.lock_outline_rounded,
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
                                      size: 20,
                                    ),
                                  ),
                                ),
                                validator: (value) =>
                                    value == null || value.isEmpty
                                    ? 'Nhập mật khẩu.'
                                    : null,
                              ),
                            ),
                            if (auth.failure != null)
                              FailureNotice(authFailureText(auth.failure!)),
                            const SizedBox(height: 24),
                            _LoginSubmit(busy: auth.busy, onPressed: _submit),
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
                          Text('Chưa có tài khoản?', style: mutedBody),
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
                            child: const Text('Đăng ký ngay'),
                          ),
                        ],
                      )
                    else
                      Text(
                        'Đăng ký hiện chưa khả dụng.',
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
  Widget build(BuildContext context) => ShaderMask(
    // Screen blending lights the logo's black backing along with the surface.
    blendMode: BlendMode.screen,
    shaderCallback: (bounds) =>
        RadialGradient(
          colors: [
            PowerMeColors.teal.withValues(alpha: .14),
            Colors.transparent,
          ],
        ).createShader(
          Rect.fromCircle(
            center: bounds.center - const Offset(40, 7),
            radius: 92,
          ),
        ),
    child: ShaderMask(
      blendMode: BlendMode.screen,
      shaderCallback: (bounds) =>
          RadialGradient(
            colors: [
              PowerMeColors.gold.withValues(alpha: .15),
              Colors.transparent,
            ],
          ).createShader(
            Rect.fromCircle(
              center: bounds.center + const Offset(40, 8),
              radius: 76,
            ),
          ),
      child: const ColoredBox(
        color: PowerMeColors.black,
        child: SizedBox(
          height: 204,
          child: Center(child: BrandMark(hero: true)),
        ),
      ),
    ),
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
          child: Text(
            label.toUpperCase(),
            style: Theme.of(context).textTheme.labelMedium?.copyWith(
              color: PowerMeColors.muted,
              letterSpacing: .8,
            ),
          ),
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
  const _LoginSubmit({required this.busy, required this.onPressed});

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
              busy ? 'Đang đăng nhập…' : 'ĐĂNG NHẬP',
              semanticsLabel: busy ? null : 'Đăng nhập',
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
