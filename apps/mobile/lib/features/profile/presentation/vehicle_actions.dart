import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../auth/application/auth_controller.dart';
import '../application/profile_controller.dart';
import '../domain/vehicle.dart';
import 'vehicle_visuals.dart';

enum VehicleAction { makeDefault, remove }

class VehicleActionButton extends ConsumerStatefulWidget {
  const VehicleActionButton({
    super.key,
    required this.action,
    required this.vehicle,
    required this.copy,
    this.onRemoved,
  });

  final VehicleAction action;
  final Vehicle vehicle;
  final AppCopy copy;
  final VoidCallback? onRemoved;

  @override
  ConsumerState<VehicleActionButton> createState() =>
      _VehicleActionButtonState();
}

class _VehicleActionButtonState extends ConsumerState<VehicleActionButton> {
  bool _confirming = false;

  Future<void> _run() async {
    if (_confirming) return;
    _confirming = true;
    final scope = ref.read(authScopeProvider);
    final vehicle = widget.vehicle;
    final copy = widget.copy;
    final removal = widget.action == VehicleAction.remove;
    final confirmed = removal
        ? await _confirmRemoval(context, copy, vehicle)
        : await _confirmDefault(context, copy, vehicle);
    _confirming = false;
    if (!mounted ||
        confirmed != true ||
        !identical(scope, ref.read(authScopeProvider))) {
      return;
    }
    final controller = ref.read(profileControllerProvider.notifier);
    final changed = removal
        ? await controller.removeVehicle(vehicle.id)
        : await controller.selectVehicle(vehicle.id);
    if (!mounted ||
        !changed ||
        !identical(scope, ref.read(authScopeProvider))) {
      return;
    }
    final messenger = ScaffoldMessenger.of(context);
    if (removal) widget.onRemoved?.call();
    messenger.showSnackBar(
      SnackBar(
        content: Text(
          removal
              ? copy.text('Đã gỡ xe khỏi hồ sơ.', 'Vehicle removed.')
              : copy.text('Đã đặt xe mặc định.', 'Default vehicle updated.'),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final canChange = ref.watch(
      profileControllerProvider.select((state) => state.canChange),
    );
    final copy = widget.copy;
    if (widget.action == VehicleAction.remove) {
      return TextButton.icon(
        key: Key('remove-${widget.vehicle.id}'),
        style: TextButton.styleFrom(
          foregroundColor: Theme.of(context).colorScheme.error,
        ),
        onPressed: canChange ? _run : null,
        icon: const Icon(Icons.delete_outline_rounded),
        label: Text(copy.text('Gỡ xe', 'Remove vehicle')),
      );
    }
    return OutlinedButton.icon(
      key: Key('select-${widget.vehicle.id}'),
      onPressed: canChange ? _run : null,
      icon: const Icon(Icons.star_outline_rounded, color: PowerMeColors.gold),
      label: Text(copy.text('Đặt mặc định', 'Set as default')),
    );
  }
}

Future<bool?> _confirmDefault(
  BuildContext context,
  AppCopy copy,
  Vehicle vehicle,
) => showModalBottomSheet<bool>(
  context: context,
  isScrollControlled: true,
  useSafeArea: true,
  showDragHandle: true,
  builder: (sheet) => SafeArea(
    top: false,
    child: SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 480),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              VehicleHeading(
                copy.text('Đặt làm xe mặc định', 'Set default vehicle'),
              ),
              const SizedBox(height: 12),
              VehicleHero(copy: copy, vehicle: vehicle, isDefault: false),
              const SizedBox(height: 12),
              Text(
                copy.text(
                  'PowerMe sẽ dùng xe này khi tìm trạm và gợi ý trạm tương thích.',
                  'PowerMe will use this vehicle for station search and suggestions.',
                ),
              ),
              const SizedBox(height: 16),
              FilledButton.icon(
                key: const Key('confirm-default-vehicle'),
                onPressed: () => Navigator.pop(sheet, true),
                icon: const Icon(Icons.check_circle_outline),
                label: Text(
                  copy.text('Xác nhận đặt mặc định', 'Confirm default'),
                ),
              ),
              TextButton(
                key: const Key('cancel-default-vehicle'),
                onPressed: () => Navigator.pop(sheet, false),
                child: Text(copy.text('Giữ nguyên', 'Keep current')),
              ),
            ],
          ),
        ),
      ),
    ),
  ),
);

Future<bool?> _confirmRemoval(
  BuildContext context,
  AppCopy copy,
  Vehicle vehicle,
) => showDialog<bool>(
  context: context,
  builder: (dialog) {
    final colors = Theme.of(dialog).colorScheme;
    return AlertDialog(
      scrollable: true,
      icon: Icon(Icons.warning_amber_rounded, color: colors.error),
      title: Text(
        copy.text('Gỡ xe khỏi hồ sơ?', 'Remove vehicle from profile?'),
      ),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            [
              vehicle.label,
              if (vehicle.plateNumber case final String plate) plate,
            ].join(' · '),
            style: Theme.of(dialog).textTheme.titleMedium,
          ),
          const SizedBox(height: 8),
          Text(
            copy.text(
              'Xe sẽ bị gỡ khỏi danh sách của bạn. Lịch sử sạc vẫn được lưu.',
              'The vehicle will be removed from your list. Charging history is retained.',
            ),
          ),
        ],
      ),
      actions: [
        TextButton(
          key: const Key('cancel-remove-vehicle'),
          onPressed: () => Navigator.pop(dialog, false),
          child: Text(copy.text('Giữ xe', 'Keep vehicle')),
        ),
        FilledButton(
          key: const Key('confirm-remove-vehicle'),
          style: FilledButton.styleFrom(
            backgroundColor: colors.error,
            foregroundColor: colors.onError,
          ),
          onPressed: () => Navigator.pop(dialog, true),
          child: Text(copy.text('Gỡ xe', 'Remove vehicle')),
        ),
      ],
    );
  },
);
