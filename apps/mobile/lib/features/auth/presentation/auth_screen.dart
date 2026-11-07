import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/app_page.dart';
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
    final text = Theme.of(context).textTheme;
    return Scaffold(
      body: AppPage(
        children: [
          const SizedBox(height: 16),
          const Center(child: BrandMark(hero: true)),
          const SizedBox(height: 24),
          HeroCard(
            accent: PowerMeColors.gold,
            child: AutofillGroup(
              child: Form(
                key: _form,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text('Đăng nhập', style: text.headlineLarge),
                    const SizedBox(height: 6),
                    Text(
                      'Chào mừng bạn trở lại PowerMe.',
                      style: text.bodyMedium?.copyWith(
                        color: PowerMeColors.muted,
                      ),
                    ),
                    const SizedBox(height: 20),
                    TextFormField(
                      key: const Key('auth-email'),
                      controller: _email,
                      enabled: !auth.busy,
                      keyboardType: TextInputType.emailAddress,
                      autofillHints: const [AutofillHints.username],
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
                      key: const Key('auth-password'),
                      controller: _password,
                      enabled: !auth.busy,
                      obscureText: !_visible,
                      autocorrect: false,
                      enableSuggestions: false,
                      autofillHints: const [AutofillHints.password],
                      onFieldSubmitted: (_) => _submit(),
                      decoration: InputDecoration(
                        labelText: 'Mật khẩu',
                        fillColor: PowerMeColors.black,
                        prefixIcon: const Icon(Icons.lock_outline_rounded),
                        suffixIcon: IconButton(
                          tooltip: _visible ? 'Ẩn mật khẩu' : 'Hiện mật khẩu',
                          onPressed: () => setState(() => _visible = !_visible),
                          icon: Icon(
                            _visible
                                ? Icons.visibility_off_outlined
                                : Icons.visibility_outlined,
                          ),
                        ),
                      ),
                      validator: (value) => value == null || value.isEmpty
                          ? 'Nhập mật khẩu.'
                          : null,
                    ),
                    if (auth.failure != null)
                      FailureNotice(authFailureText(auth.failure!)),
                    const SizedBox(height: 20),
                    FilledButton(
                      key: const Key('auth-submit'),
                      onPressed: auth.busy ? null : _submit,
                      child: Text(auth.busy ? 'Đang đăng nhập…' : 'Đăng nhập'),
                    ),
                  ],
                ),
              ),
            ),
          ),
          const SizedBox(height: 16),
          OutlinedButton(
            onPressed: auth.busy
                ? null
                : () {
                    ref.read(authControllerProvider.notifier).clearFailure();
                    context.go('/register');
                  },
            child: const Text('Chưa có tài khoản? Đăng ký'),
          ),
        ],
      ),
    );
  }
}
