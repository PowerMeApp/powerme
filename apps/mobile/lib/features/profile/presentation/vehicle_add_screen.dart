import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/app_page.dart';
import '../../../core/widgets/flow_page.dart';
import '../application/profile_controller.dart';
import '../application/vehicle_catalog.dart';
import '../domain/profile_repository.dart';
import '../domain/vehicle.dart';
import 'vehicle_management_feedback.dart';

class VehicleAddScreen extends ConsumerStatefulWidget {
  const VehicleAddScreen({super.key});

  @override
  ConsumerState<VehicleAddScreen> createState() => _VehicleAddScreenState();
}

class _VehicleAddScreenState extends ConsumerState<VehicleAddScreen> {
  final _form = GlobalKey<FormState>();
  final _plate = TextEditingController();
  final _search = TextEditingController();
  String? _brand;
  String? _modelId;
  bool _modelRequired = false;
  bool _makeDefault = false;

  @override
  void dispose() {
    _plate.dispose();
    _search.dispose();
    super.dispose();
  }

  void _back() => context.canPop() ? context.pop() : context.go('/profile');

  Future<void> _save() async {
    final catalog = ref.read(vehicleModelsProvider);
    final state = ref.read(profileControllerProvider);
    final models = catalog.asData?.value;
    if (!state.canChange || catalog.isLoading || models == null) return;
    final model = VehicleCatalog(models).find(_modelId);
    final validPlate = _form.currentState!.validate();
    setState(() => _modelRequired = model == null);
    if (!validPlate || model == null) return;
    FocusScope.of(context).unfocus();
    final saved = await ref
        .read(profileControllerProvider.notifier)
        .addVehicle(
          VehicleRegistration(
            plateNumber: _plate.text,
            modelId: model.id,
            makeDefault: _makeDefault,
          ),
        );
    if (saved && mounted && ModalRoute.isCurrentOf(context) == true) _back();
  }

  void _reloadModels() {
    setState(() => _modelId = null);
    ref.invalidate(vehicleModelsProvider);
  }

  Future<void> _reloadProfile() async {
    final loaded = await ref.read(profileControllerProvider.notifier).refresh();
    if (loaded && mounted && ModalRoute.isCurrentOf(context) == true) _back();
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(profileControllerProvider);
    final catalog = ref.watch(vehicleModelsProvider);
    ref.listen(vehicleModelsProvider, (_, next) {
      final models = next.asData?.value;
      if (next.isLoading || models == null) return;
      final available = VehicleCatalog(models);
      if (_modelId != null && available.find(_modelId) == null) {
        setState(() {
          _modelId = null;
          _modelRequired = true;
        });
      }
      if (_brand != null && !available.brands.contains(_brand)) {
        setState(() => _brand = null);
      }
    });
    final copy = AppCopy(state.profile.language);
    final text = Theme.of(context).textTheme;
    final models = catalog.asData?.value ?? const [];
    final available = VehicleCatalog(models);
    final selected = available.find(_modelId);
    final needsRefresh = state.failure?.needsRefresh == true;
    final canSave = state.canChange && !catalog.isLoading && models.isNotEmpty;

    return Scaffold(
      appBar: AppBar(
        leadingWidth: 68,
        leading: Padding(
          padding: const EdgeInsets.only(left: 20),
          child: IconButton.filledTonal(
            tooltip: copy.back,
            style: IconButton.styleFrom(
              backgroundColor: PowerMeColors.graphite,
              foregroundColor: PowerMeColors.text,
            ),
            onPressed: state.busy ? null : _back,
            icon: const Icon(Icons.arrow_back_rounded, size: 20),
          ),
        ),
      ),
      body: AppPage(
        children: [
          Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Semantics(
                header: true,
                child: Text(
                  copy.text('Thêm xe', 'Add vehicle'),
                  style: text.headlineLarge,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                copy.text(
                  'Chọn mẫu xe và nhập biển số để thêm vào hồ sơ.',
                  'Select a model and enter its plate number.',
                ),
                style: text.bodyMedium?.copyWith(color: PowerMeColors.muted),
              ),
              const SizedBox(height: 20),
              if (catalog.isLoading)
                Center(
                  child: CircularProgressIndicator(
                    semanticsLabel: copy.text(
                      'Đang tải danh mục mẫu xe',
                      'Loading vehicle models',
                    ),
                  ),
                )
              else if (models.isEmpty)
                FailureNotice(
                  catalog.hasError
                      ? copy.text(
                          'Chưa tải được danh mục mẫu xe.',
                          'Could not load the vehicle catalog.',
                        )
                      : copy.text(
                          'Danh mục chưa có mẫu xe.',
                          'The vehicle catalog is empty.',
                        ),
                )
              else
                _catalogPicker(copy, available, enabled: canSave),
              if (state.failure != null)
                FailureNotice(vehicleManagementMessage(copy, state.failure!)),
              if (!catalog.isLoading &&
                  !needsRefresh &&
                  (models.isEmpty ||
                      state.failure == ProfileFailure.unknownModel))
                OutlinedButton.icon(
                  key: const Key('reload-vehicle-models'),
                  onPressed: state.busy ? null : _reloadModels,
                  icon: const Icon(Icons.refresh),
                  label: Text(copy.text('Tải lại danh mục', 'Reload catalog')),
                ),
              const SizedBox(height: 20),
              _vehicleDetails(
                copy,
                selected: selected,
                enabled: state.canChange,
                canSetDefault: canSave && state.profile.vehicles.isNotEmpty,
                showDefault: state.profile.vehicles.isNotEmpty,
              ),
              if (needsRefresh)
                OutlinedButton.icon(
                  key: const Key('refresh-profile'),
                  onPressed: state.busy ? null : _reloadProfile,
                  icon: const Icon(Icons.refresh),
                  label: Text(copy.text('Tải lại hồ sơ', 'Reload profile')),
                )
              else
                FilledButton(
                  key: const Key('vehicle-save'),
                  onPressed: canSave ? _save : null,
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Flexible(
                        child: Text(
                          state.busy
                              ? copy.text('Đang lưu…', 'Saving…')
                              : copy.text('Lưu xe', 'Save vehicle'),
                          textAlign: TextAlign.center,
                        ),
                      ),
                      if (!state.busy) ...[
                        const SizedBox(width: 8),
                        const Icon(Icons.arrow_forward_rounded, size: 18),
                      ],
                    ],
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _catalogPicker(
    AppCopy copy,
    VehicleCatalog catalog, {
    required bool enabled,
  }) {
    final text = Theme.of(context).textTheme;
    final matches = catalog.matching(query: _search.text, brand: _brand);
    return Column(
      key: const Key('vehicle-model-catalog'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          key: const Key('vehicle-model-search'),
          controller: _search,
          enabled: enabled,
          textInputAction: TextInputAction.search,
          onChanged: (_) => setState(() {}),
          decoration: InputDecoration(
            labelText: copy.text(
              'Tìm hãng hoặc mẫu xe',
              'Search makes or models',
            ),
            prefixIcon: const Icon(Icons.search_rounded, size: 20),
            suffixIcon: _search.text.isEmpty
                ? null
                : IconButton(
                    tooltip: copy.text('Xóa tìm kiếm', 'Clear search'),
                    onPressed: enabled ? () => setState(_search.clear) : null,
                    icon: const Icon(Icons.close_rounded, size: 20),
                  ),
          ),
        ),
        const SizedBox(height: 8),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: [
              for (final brand in [null, ...catalog.brands])
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: ChoiceChip(
                    label: Text(brand ?? copy.text('Tất cả', 'All')),
                    selected: _brand == brand,
                    labelStyle: text.labelMedium?.copyWith(
                      color: _brand == brand
                          ? PowerMeColors.teal
                          : PowerMeColors.text,
                    ),
                    shape: const StadiumBorder(),
                    materialTapTargetSize: MaterialTapTargetSize.padded,
                    onSelected: enabled
                        ? (_) => setState(() => _brand = brand)
                        : null,
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        Semantics(
          header: true,
          child: Text(
            copy.text('Mẫu xe', 'Vehicle models'),
            style: text.titleMedium,
          ),
        ),
        if (matches.isEmpty) ...[
          const SizedBox(height: 8),
          Semantics(
            liveRegion: true,
            child: Text(
              copy.text(
                'Không tìm thấy mẫu xe phù hợp.',
                'No matching models.',
              ),
              style: text.bodyMedium?.copyWith(color: PowerMeColors.muted),
            ),
          ),
        ],
        for (final model in matches) ...[
          const SizedBox(height: 8),
          _ModelCard(
            key: ValueKey('vehicle-model-${model.id}'),
            model: model,
            selected: model.id == _modelId,
            onTap: enabled
                ? () {
                    FocusScope.of(context).unfocus();
                    setState(() {
                      _modelId = model.id;
                      _modelRequired = false;
                    });
                  }
                : null,
          ),
        ],
      ],
    );
  }

  Widget _vehicleDetails(
    AppCopy copy, {
    required VehicleModel? selected,
    required bool enabled,
    required bool canSetDefault,
    required bool showDefault,
  }) {
    final text = Theme.of(context).textTheme;
    return InfoCard(
      spacing: 12,
      children: [
        if (selected != null)
          _VehicleSpecs(copy: copy, model: selected)
        else if (_modelRequired)
          FailureNotice(copy.text('Chọn mẫu xe.', 'Select a model.')),
        Form(
          key: _form,
          child: TextFormField(
            key: const Key('vehicle-plate'),
            controller: _plate,
            enabled: enabled,
            textCapitalization: TextCapitalization.characters,
            autocorrect: false,
            decoration: InputDecoration(
              labelText: copy.text('Biển số xe', 'Plate number'),
              hintText: '51K-901.01',
              prefixIcon: const Icon(Icons.pin_outlined, size: 20),
              errorMaxLines: 4,
            ),
            validator: (value) => VehicleRegistration.acceptsPlate(value ?? '')
                ? null
                : vehicleManagementMessage(copy, ProfileFailure.invalidPlate),
          ),
        ),
        if (showDefault)
          CheckboxListTile(
            key: const Key('vehicle-make-default'),
            contentPadding: EdgeInsets.zero,
            controlAffinity: ListTileControlAffinity.leading,
            title: Text(
              copy.text('Đặt làm xe mặc định', 'Set as default vehicle'),
              style: text.bodyMedium,
            ),
            value: _makeDefault,
            onChanged: canSetDefault
                ? (value) => setState(() => _makeDefault = value == true)
                : null,
          ),
      ],
    );
  }
}

class _ModelCard extends StatelessWidget {
  const _ModelCard({
    super.key,
    required this.model,
    required this.selected,
    required this.onTap,
  });

  final VehicleModel model;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Semantics(
      selected: selected,
      button: true,
      enabled: onTap != null,
      child: Material(
        color: selected
            ? Color.alphaBlend(
                PowerMeColors.teal.withValues(alpha: .08),
                PowerMeColors.graphite,
              )
            : PowerMeColors.graphite,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: BorderSide(
            color: selected ? PowerMeColors.teal : PowerMeColors.outline,
          ),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Row(
              children: [
                ExcludeSemantics(
                  child: Container(
                    width: 40,
                    height: 40,
                    decoration: BoxDecoration(
                      color: PowerMeColors.black,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Icon(
                      Icons.electric_car_outlined,
                      size: 22,
                      color: selected ? PowerMeColors.teal : PowerMeColors.gold,
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    '${model.brand} ${model.model}',
                    style: text.titleMedium,
                  ),
                ),
                const SizedBox(width: 8),
                ExcludeSemantics(
                  child: Icon(
                    selected
                        ? Icons.check_circle_rounded
                        : Icons.radio_button_unchecked_rounded,
                    size: 22,
                    color: selected ? PowerMeColors.teal : PowerMeColors.muted,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _VehicleSpecs extends StatelessWidget {
  const _VehicleSpecs({required this.copy, required this.model});

  final AppCopy copy;
  final VehicleModel model;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final unknown = copy.text('Chưa có dữ liệu', 'Unavailable');
    String measure(num? value, String unit) =>
        value == null ? unknown : '$value $unit';
    final specs = [
      (
        copy.text('Dung lượng pin', 'Battery capacity'),
        measure(model.batteryCapacityKwh, 'kWh'),
      ),
      (
        copy.text('Tầm hoạt động', 'Rated range'),
        measure(model.ratedRangeKm, 'km'),
      ),
      (
        copy.text('Công suất DC tối đa', 'Max DC power'),
        measure(model.maxDcKw, 'kW'),
      ),
      (copy.text('Cổng sạc', 'Connector'), model.connector),
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          copy.text('Thông số mẫu xe', 'Model specifications'),
          style: text.titleMedium,
        ),
        const SizedBox(height: 4),
        Text(
          '${model.brand} ${model.model}',
          style: text.bodyMedium?.copyWith(color: PowerMeColors.teal),
        ),
        const SizedBox(height: 8),
        for (final (label, value) in specs)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Wrap(
              alignment: WrapAlignment.spaceBetween,
              spacing: 12,
              runSpacing: 2,
              children: [
                Text(
                  label,
                  style: text.bodyMedium?.copyWith(color: PowerMeColors.muted),
                ),
                Text(value, style: text.bodyMedium),
              ],
            ),
          ),
      ],
    );
  }
}
