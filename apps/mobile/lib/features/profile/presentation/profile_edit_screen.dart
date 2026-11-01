import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/app_page.dart';
import '../../../core/widgets/flow_page.dart';
import '../application/profile_controller.dart';

class ProfileEditScreen extends ConsumerStatefulWidget {
  const ProfileEditScreen({super.key});
  @override
  ConsumerState<ProfileEditScreen> createState() => _ProfileEditScreenState();
}

class _ProfileEditScreenState extends ConsumerState<ProfileEditScreen> {
  final _form = GlobalKey<FormState>();
  late final TextEditingController _name;
  @override
  void initState() {
    super.initState();
    _name = TextEditingController(
      text: ref.read(profileControllerProvider).profile.displayName,
    );
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(profileControllerProvider);
    final copy = AppCopy(state.profile.language);
    return Scaffold(
      appBar: AppBar(
        title: Text(copy.text('Sửa hồ sơ', 'Edit profile')),
        leading: IconButton(
          tooltip: copy.back,
          onPressed: () =>
              context.canPop() ? context.pop() : context.go('/profile'),
          icon: const Icon(Icons.arrow_back_rounded),
        ),
      ),
      body: AppPage(
        children: [
          InfoCard(
            spacing: 16,
            children: [
              Form(
                key: _form,
                child: TextFormField(
                  key: const Key('profile-name'),
                  controller: _name,
                  maxLength: 80,
                  enabled: !state.busy,
                  decoration: InputDecoration(
                    labelText: copy.text('Họ và tên', 'Full name'),
                    fillColor: PowerMeColors.black,
                    prefixIcon: const Icon(Icons.person_outline_rounded),
                  ),
                  validator: (value) => value == null || value.trim().isEmpty
                      ? copy.text('Nhập họ và tên.', 'Enter your name.')
                      : null,
                ),
              ),
              InputDecorator(
                decoration: const InputDecoration(
                  labelText: 'Email',
                  fillColor: PowerMeColors.black,
                  prefixIcon: Icon(Icons.mail_outline_rounded),
                ),
                child: SelectableText(state.profile.email),
              ),
              if (state.failure != null)
                FailureNotice(
                  copy.text(
                    'Chưa lưu được thay đổi. Vui lòng thử lại.',
                    'Changes could not be saved. Please retry.',
                  ),
                ),
              FilledButton(
                key: const Key('profile-save'),
                onPressed: state.busy
                    ? null
                    : () async {
                        if (!_form.currentState!.validate()) return;
                        final saved = await ref
                            .read(profileControllerProvider.notifier)
                            .updateName(_name.text);
                        if (saved && context.mounted) {
                          context.canPop()
                              ? context.pop()
                              : context.go('/profile');
                        }
                      },
                child: Text(
                  state.busy
                      ? copy.text('Đang lưu…', 'Saving…')
                      : copy.text('Lưu thay đổi', 'Save changes'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
