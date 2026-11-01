import 'package:flutter/material.dart';
import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../domain/vehicle.dart';

class VehicleFields extends StatefulWidget {
  const VehicleFields({
    super.key,
    this.vehicle,
    required this.copy,
    required this.onChanged,
    this.enabled = true,
    this.inputFillColor,
  });
  final Vehicle? vehicle;
  final AppCopy copy;
  final ValueChanged<VehicleDraft> onChanged;
  final bool enabled;
  final Color? inputFillColor;
  @override
  State<VehicleFields> createState() => _VehicleFieldsState();
}

class _VehicleFieldsState extends State<VehicleFields> {
  late final TextEditingController _brand;
  late final TextEditingController _model;
  late final Set<String> _connectors;
  @override
  void initState() {
    super.initState();
    _brand = TextEditingController(text: widget.vehicle?.brand ?? '');
    _model = TextEditingController(text: widget.vehicle?.model ?? '');
    _connectors = {...?widget.vehicle?.connectors};
  }

  @override
  void dispose() {
    _brand.dispose();
    _model.dispose();
    super.dispose();
  }

  void _changed() => widget.onChanged(
    VehicleDraft(
      brand: _brand.text,
      model: _model.text,
      connectors: _connectors.toList(),
    ),
  );
  @override
  Widget build(BuildContext context) {
    final copy = widget.copy;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextFormField(
          key: const Key('vehicle-brand'),
          controller: _brand,
          enabled: widget.enabled,
          maxLength: 60,
          textCapitalization: TextCapitalization.words,
          decoration: InputDecoration(
            labelText: copy.text('Hãng xe', 'Make'),
            fillColor: widget.inputFillColor,
            prefixIcon: const Icon(Icons.directions_car_outlined),
            counterText: '',
          ),
          onChanged: (_) => _changed(),
          validator: (value) => value == null || value.trim().isEmpty
              ? copy.text('Nhập hãng xe.', 'Enter a make.')
              : null,
        ),
        const SizedBox(height: 16),
        TextFormField(
          key: const Key('vehicle-model'),
          controller: _model,
          enabled: widget.enabled,
          maxLength: 80,
          decoration: InputDecoration(
            labelText: copy.text('Dòng xe', 'Model'),
            fillColor: widget.inputFillColor,
            prefixIcon: const Icon(Icons.electric_car_outlined),
            counterText: '',
          ),
          onChanged: (_) => _changed(),
          validator: (value) => value == null || value.trim().isEmpty
              ? copy.text('Nhập dòng xe.', 'Enter a model.')
              : null,
        ),
        const SizedBox(height: 20),
        Text(
          copy.text('Chuẩn cổng sạc của xe', 'Vehicle connector types'),
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 4),
        Text(
          copy.text(
            'Chọn tất cả chuẩn cổng sạc tương thích với xe của bạn.',
            'Select all connector types compatible with your vehicle.',
          ),
          style: Theme.of(
            context,
          ).textTheme.bodyMedium?.copyWith(color: PowerMeColors.muted),
        ),
        const SizedBox(height: 12),
        FormField<bool>(
          validator: (_) => _connectors.isEmpty
              ? copy.text(
                  'Chọn ít nhất một chuẩn cổng.',
                  'Select at least one connector.',
                )
              : null,
          builder: (field) => Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final connector in VehicleDraft.supportedConnectors)
                    FilterChip(
                      key: Key('connector-$connector'),
                      label: Text(connector),
                      backgroundColor: widget.inputFillColor,
                      selected: _connectors.contains(connector),
                      onSelected: widget.enabled
                          ? (selected) {
                              setState(() {
                                selected
                                    ? _connectors.add(connector)
                                    : _connectors.remove(connector);
                              });
                              field.didChange(_connectors.isNotEmpty);
                              _changed();
                            }
                          : null,
                    ),
                ],
              ),
              if (field.hasError) ...[
                const SizedBox(height: 8),
                Text(
                  field.errorText!,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}
