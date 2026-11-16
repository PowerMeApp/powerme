import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/flow_page.dart';
import '../application/profile_controller.dart';
import '../domain/vehicle.dart';
import 'vehicle_actions.dart';
import 'vehicle_management_feedback.dart';
import 'vehicle_visuals.dart';

class _GarageHeading extends StatelessWidget {
  const _GarageHeading(this.label, {this.description, this.prominent = false});

  final String label;
  final String? description;
  final bool prominent;

  @override
  Widget build(BuildContext context) {
    final type = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Semantics(
          header: true,
          child: Text(
            label,
            style: prominent ? type.headlineLarge : type.titleLarge,
          ),
        ),
        if (description case final subtitle?) ...[
          const SizedBox(height: 4),
          Text(subtitle, style: type.bodySmall),
        ],
      ],
    );
  }
}

class VehicleDashboard extends ConsumerWidget {
  const VehicleDashboard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(profileControllerProvider);
    final profile = state.profile;
    final copy = AppCopy(profile.language);
    final selected = profile.selectedVehicle;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _GarageHeading(copy.text('Xe của tôi', 'My vehicles'), prominent: true),
        const SizedBox(height: 12),
        if (profile.vehicles.isEmpty)
          _EmptyGarage(copy: copy, enabled: state.canChange)
        else ...[
          if (selected != null) ...[
            VehicleHero(copy: copy, vehicle: selected, isDefault: true),
            const SizedBox(height: 12),
            _SpecificationPanel(copy: copy, vehicle: selected),
            const SizedBox(height: 12),
            _FindStationsButton(copy: copy, vehicle: selected),
            const SizedBox(height: 8),
            _DetailsButton(copy: copy, vehicle: selected),
          ],
          const SizedBox(height: 16),
          InfoCard(
            spacing: 0,
            children: [
              MenuRow(
                label: copy.text('Nhà xe của bạn', 'Your garage'),
                icon: Icons.garage_outlined,
                onTap: () => context.push('/vehicles'),
                key: const Key('open-vehicle-garage'),
              ),
              const Divider(),
              _AddVehicleButton(copy: copy, enabled: state.canChange),
            ],
          ),
        ],
        const SizedBox(height: 8),
        const VehicleProfileFeedback(showReload: true),
      ],
    );
  }
}

class VehicleGarageScreen extends ConsumerWidget {
  const VehicleGarageScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(profileControllerProvider);
    final profile = state.profile;
    final copy = AppCopy(profile.language);
    final selected = profile.selectedVehicle;
    final others = profile.vehicles.where(
      (vehicle) => vehicle.id != selected?.id,
    );
    return _VehiclePage(
      title: copy.text('Quản lý xe', 'Vehicle garage'),
      fallback: '/profile',
      children: [
        _GarageHeading(
          copy.text('Xe của tôi', 'My vehicles'),
          prominent: true,
          description: copy.text(
            '${profile.vehicles.length} phương tiện',
            '${profile.vehicles.length} vehicles',
          ),
        ),
        const SizedBox(height: 12),
        const VehicleProfileFeedback(),
        if (profile.vehicles.isEmpty)
          _EmptyGarage(copy: copy, enabled: state.canChange)
        else ...[
          if (selected != null) ...[
            VehicleHero(copy: copy, vehicle: selected, isDefault: true),
            const SizedBox(height: 12),
            VehicleSpecifications.saved(copy: copy, vehicle: selected),
            const SizedBox(height: 12),
            _FindStationsButton(copy: copy, vehicle: selected),
            const SizedBox(height: 8),
            _DetailsButton(copy: copy, vehicle: selected),
            const SizedBox(height: 20),
          ],
          if (others.isNotEmpty) ...[
            _GarageHeading(copy.text('Xe khác trong nhà xe', 'Other vehicles')),
            const SizedBox(height: 8),
            for (final vehicle in others) ...[
              InfoCard(
                key: ValueKey(vehicle.id),
                children: [
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: SizedBox(
                      width: 60,
                      child: VehiclePhoto(
                        copy: copy,
                        imageUrl: vehicle.imageUrl,
                        compact: true,
                      ),
                    ),
                    title: Text(
                      vehicle.label,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    subtitle: Text(
                      [
                        if (vehicle.plateNumber case final String plate) plate,
                        ...vehicle.connectors,
                      ].join(' · '),
                    ),
                    onTap: () => context.push('/vehicles/${vehicle.id}'),
                  ),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      VehicleActionButton(
                        action: VehicleAction.makeDefault,
                        vehicle: vehicle,
                        copy: copy,
                      ),
                      _DetailsButton(copy: copy, vehicle: vehicle),
                    ],
                  ),
                ],
              ),
              const SizedBox(height: 8),
            ],
          ],
          _AddVehicleButton(copy: copy, enabled: state.canChange),
        ],
      ],
    );
  }
}

class ApiVehicleDetailScreen extends ConsumerWidget {
  const ApiVehicleDetailScreen({
    super.key,
    required this.id,
    this.manage = false,
  });

  final String id;
  final bool manage;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(profileControllerProvider);
    final profile = state.profile;
    final copy = AppCopy(profile.language);
    final vehicle = profile.vehicles
        .where((vehicle) => vehicle.id == id)
        .firstOrNull;
    final isDefault = profile.selectedVehicleId == id;
    final title = manage
        ? copy.text('Quản lý xe', 'Manage vehicle')
        : copy.text('Chi tiết xe', 'Vehicle details');
    return _VehiclePage(
      title: title,
      fallback: '/vehicles',
      children: [
        const VehicleProfileFeedback(),
        if (vehicle == null) ...[
          InfoCard(
            children: [
              Text(
                copy.text(
                  'Xe không có trong hồ sơ của bạn.',
                  'This vehicle is not in your profile.',
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          OutlinedButton(
            onPressed: () => context.go('/vehicles'),
            child: Text(copy.text('Về nhà xe', 'Back to garage')),
          ),
        ] else ...[
          if (!manage) ...[
            OutlinedButton.icon(
              key: const Key('manage-vehicle'),
              onPressed: () => context.push('/vehicles/$id/manage'),
              icon: const Icon(Icons.tune_rounded),
              label: Text(copy.text('Quản lý xe', 'Manage vehicle')),
            ),
            const SizedBox(height: 12),
          ],
          VehicleHero(copy: copy, vehicle: vehicle, isDefault: isDefault),
          const SizedBox(height: 16),
          InfoCard(
            children: [
              _GarageHeading(
                copy.text('Định danh phương tiện', 'Vehicle identity'),
                description: manage
                    ? copy.text(
                        'Thông tin xe đã đăng ký chỉ có thể xem.',
                        'Registered vehicle information is read-only.',
                      )
                    : null,
              ),
              ValueLine(copy.text('Hãng xe', 'Make'), vehicle.brand),
              ValueLine(copy.text('Mẫu xe', 'Model'), vehicle.model),
              ValueLine(
                copy.text('Biển số', 'Plate number'),
                vehicle.plateNumber ??
                    copy.text('Chưa có dữ liệu', 'Unavailable'),
              ),
            ],
          ),
          const SizedBox(height: 12),
          _SpecificationPanel(copy: copy, vehicle: vehicle),
          const SizedBox(height: 16),
          if (manage)
            InfoCard(
              children: [
                _GarageHeading(copy.text('Thao tác với xe', 'Vehicle actions')),
                if (!isDefault)
                  VehicleActionButton(
                    action: VehicleAction.makeDefault,
                    vehicle: vehicle,
                    copy: copy,
                  ),
                VehicleActionButton(
                  action: VehicleAction.remove,
                  vehicle: vehicle,
                  copy: copy,
                  onRemoved: () => context.go('/vehicles'),
                ),
              ],
            )
          else ...[
            if (isDefault)
              _FindStationsButton(copy: copy, vehicle: vehicle)
            else
              InfoCard(
                children: [
                  Text(
                    copy.text(
                      'Đặt xe này làm mặc định để tìm trạm phù hợp.',
                      'Set this as your default vehicle to find compatible stations.',
                    ),
                  ),
                  VehicleActionButton(
                    action: VehicleAction.makeDefault,
                    vehicle: vehicle,
                    copy: copy,
                  ),
                ],
              ),
          ],
        ],
      ],
    );
  }
}

class VehicleProfileFeedback extends ConsumerWidget {
  const VehicleProfileFeedback({super.key, this.showReload = false});

  final bool showReload;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(profileControllerProvider);
    final copy = AppCopy(state.profile.language);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (state.failure case final failure?)
          FailureNotice(vehicleManagementMessage(copy, failure)),
        if (showReload || (state.failure?.needsRefresh ?? false))
          OutlinedButton.icon(
            key: const Key('refresh-profile'),
            onPressed: state.busy
                ? null
                : () => ref.read(profileControllerProvider.notifier).refresh(),
            icon: const Icon(Icons.refresh),
            label: Text(
              state.busy
                  ? copy.text('Đang cập nhật hồ sơ…', 'Updating profile…')
                  : copy.text('Tải lại hồ sơ', 'Reload profile'),
            ),
          )
        else if (state.busy)
          const LinearProgressIndicator(),
      ],
    );
  }
}

class _VehiclePage extends StatelessWidget {
  const _VehiclePage({
    required this.title,
    required this.fallback,
    required this.children,
  });

  final String title;
  final String fallback;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => FlowPage(
    title: title,
    backLocation: fallback,
    children: [
      Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: children,
      ),
    ],
  );
}

class _SpecificationPanel extends StatelessWidget {
  const _SpecificationPanel({required this.copy, required this.vehicle});

  final AppCopy copy;
  final Vehicle vehicle;

  @override
  Widget build(BuildContext context) => InfoCard(
    children: [
      _GarageHeading(
        copy.text('Thông số sạc và pin', 'Charging and battery specifications'),
      ),
      VehicleSpecifications.saved(copy: copy, vehicle: vehicle),
    ],
  );
}

class _EmptyGarage extends StatelessWidget {
  const _EmptyGarage({required this.copy, required this.enabled});

  final AppCopy copy;
  final bool enabled;

  @override
  Widget build(BuildContext context) => HeroCard(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Icon(
          Icons.electric_car_outlined,
          color: PowerMeColors.teal,
          size: 48,
        ),
        const SizedBox(height: 12),
        Text(
          copy.text('Chưa có xe trong hồ sơ.', 'No vehicles yet.'),
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 6),
        Text(
          copy.text(
            'Thêm xe để PowerMe hiển thị các cổng sạc tương thích.',
            'Add a vehicle to see compatible charging connectors.',
          ),
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall,
        ),
        const SizedBox(height: 16),
        _AddVehicleButton(copy: copy, enabled: enabled, first: true),
      ],
    ),
  );
}

class _AddVehicleButton extends StatelessWidget {
  const _AddVehicleButton({
    required this.copy,
    required this.enabled,
    this.first = false,
  });

  final AppCopy copy;
  final bool enabled;
  final bool first;

  @override
  Widget build(BuildContext context) => FilledButton.icon(
    key: const Key('add-vehicle'),
    onPressed: enabled ? () => context.push('/vehicles/new') : null,
    icon: const Icon(Icons.add_rounded),
    label: Text(
      first
          ? copy.text('Thêm xe đầu tiên', 'Add your first vehicle')
          : copy.text('Thêm xe mới', 'Add a vehicle'),
    ),
  );
}

class _DetailsButton extends StatelessWidget {
  const _DetailsButton({required this.copy, required this.vehicle});

  final AppCopy copy;
  final Vehicle vehicle;

  @override
  Widget build(BuildContext context) => OutlinedButton.icon(
    key: Key('vehicle-detail-${vehicle.id}'),
    onPressed: () => context.push('/vehicles/${vehicle.id}'),
    icon: const Icon(Icons.info_outline_rounded),
    label: Text(copy.text('Chi tiết', 'Details')),
  );
}

class _FindStationsButton extends ConsumerWidget {
  const _FindStationsButton({required this.copy, required this.vehicle});

  final AppCopy copy;
  final Vehicle vehicle;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final enabled = ref.watch(
      profileControllerProvider.select(
        (state) =>
            state.canChange && state.profile.selectedVehicleId == vehicle.id,
      ),
    );
    return FilledButton.icon(
      key: const Key('find-vehicle-stations'),
      onPressed: enabled ? () => context.push('/discover') : null,
      icon: const Icon(Icons.near_me_outlined),
      label: Text(copy.text('Tìm trạm phù hợp', 'Find compatible stations')),
    );
  }
}
