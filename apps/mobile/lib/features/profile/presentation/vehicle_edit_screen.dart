import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/app_page.dart';
import '../../../core/widgets/flow_page.dart';
import '../application/profile_controller.dart';
import '../domain/vehicle.dart';
import 'vehicle_fields.dart';

class VehicleEditScreen extends ConsumerStatefulWidget {
  const VehicleEditScreen({super.key, this.id});
  final String? id;
  @override
  ConsumerState<VehicleEditScreen> createState() => _VehicleEditScreenState();
}

class _VehicleEditScreenState extends ConsumerState<VehicleEditScreen> {
  final _form = GlobalKey<FormState>();
  Vehicle? _vehicle;
  late VehicleDraft _draft;
  @override
  void initState() {
    super.initState();
    for (final vehicle
        in ref.read(profileControllerProvider).profile.vehicles) {
      if (vehicle.id == widget.id) _vehicle = vehicle;
    }
    _draft = VehicleDraft(
      brand: _vehicle?.brand ?? '',
      model: _vehicle?.model ?? '',
      connectors: _vehicle?.connectors ?? [],
    );
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(profileControllerProvider);
    final copy = AppCopy(state.profile.language);
    final missing =
        widget.id != null &&
        !state.profile.vehicles.any((v) => v.id == widget.id);
    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          tooltip: copy.back,
          onPressed: () =>
              context.canPop() ? context.pop() : context.go('/profile'),
          icon: const Icon(Icons.arrow_back_rounded),
        ),
        title: Text(
          widget.id == null
              ? copy.text('Thêm xe', 'Add vehicle')
              : copy.text('Sửa xe', 'Edit vehicle'),
        ),
      ),
      body: AppPage(
        children: [
          if (missing) ...[
            Text(
              copy.text(
                'Không tìm thấy xe trong tài khoản của bạn.',
                'This vehicle is not in your account.',
              ),
            ),
            TextButton(
              onPressed: () => context.go('/profile'),
              child: Text(copy.profile),
            ),
          ] else
            InfoCard(
              spacing: 16,
              children: [
                Form(
                  key: _form,
                  child: VehicleFields(
                    vehicle: _vehicle,
                    copy: copy,
                    enabled: !state.busy,
                    inputFillColor: PowerMeColors.black,
                    onChanged: (draft) => _draft = draft,
                  ),
                ),
                if (state.failure != null)
                  FailureNotice(
                    copy.text(
                      'Chưa lưu được xe. Vui lòng kiểm tra và thử lại.',
                      'Vehicle could not be saved. Please check and retry.',
                    ),
                  ),
                FilledButton(
                  key: const Key('vehicle-save'),
                  onPressed: state.busy
                      ? null
                      : () async {
                          if (!_form.currentState!.validate()) return;
                          final saved = await ref
                              .read(profileControllerProvider.notifier)
                              .saveVehicle(_draft, widget.id);
                          if (saved && context.mounted) {
                            context.canPop()
                                ? context.pop()
                                : context.go('/profile');
                          }
                        },
                  child: Text(
                    state.busy
                        ? copy.text('Đang lưu…', 'Saving…')
                        : copy.text('Lưu xe', 'Save vehicle'),
                  ),
                ),
              ],
            ),
        ],
      ),
    );
  }
}
