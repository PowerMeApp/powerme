import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/l10n/app_copy.dart';
import '../../../core/widgets/flow_page.dart';
import '../../profile/domain/vehicle.dart';
import '../../profile/presentation/vehicle_visuals.dart';
import '../../stations/application/station_discovery_controller.dart';
import '../../stations/domain/connector_lookup.dart';
import '../../stations/domain/station.dart';
import '../../stations/presentation/station_copy.dart';
import '../application/charge_start_controller.dart';
import '../domain/charge_start.dart';
import '../domain/charging.dart';
import 'charge_flow_visuals.dart';
import 'charge_mode_widgets.dart';

class ChargeConnectorPanel extends StatelessWidget {
  const ChargeConnectorPanel({
    super.key,
    required this.copy,
    required this.selection,
    required this.connector,
    required this.vehicle,
    required this.onRecheck,
    required this.onRescan,
  });

  final AppCopy copy;
  final DiscoverySession selection;
  final ResolvedConnector connector;
  final Vehicle? vehicle;
  final VoidCallback onRecheck;
  final VoidCallback onRescan;

  @override
  Widget build(BuildContext context) {
    final selected = vehicle;
    final status = connector.status == StationStatus.available
        ? copy.text('Trống', 'Available')
        : connector.canRequestStart
        ? copy.text('Đang chuẩn bị sạc', 'Preparing')
        : statusLabel(connector.status, copy);
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ChargeHeading(
          copy.text('Xác nhận đầu sạc', 'Confirm connector'),
          centered: false,
        ),
        const SizedBox(height: 16),
        InfoCard(
          spacing: 10,
          children: [
            ChargeDetail(
              mark: true,
              title: connector.stationName,
              detail: chargeConnectorLabel(connector, copy),
            ),
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: StatusBadge(
                status,
                color: connector.canRequestStart
                    ? theme.colorScheme.primary
                    : theme.colorScheme.secondary,
              ),
            ),
            if (connector.reportedIssue)
              Text(
                copy.text('Cổng đã được báo lỗi', 'Reported issue'),
                style: theme.textTheme.bodySmall,
              ),
          ],
        ),
        if (selected != null)
          InfoCard(
            spacing: 8,
            children: [
              Text(copy.vehicle, style: theme.textTheme.labelMedium),
              SizedBox(
                width: 120,
                child: VehiclePhoto(
                  copy: copy,
                  imageUrl: selected.imageUrl,
                  imageCredit: selected.imageCredit,
                  compact: true,
                ),
              ),
              ChargeDetail(
                icon: Icons.directions_car_outlined,
                title: [selected.label, ?selected.plateNumber].join(' · '),
                detail: selected.connectors.isEmpty
                    ? copy.text(
                        'Chưa rõ chuẩn sạc',
                        'Connector standard unknown',
                      )
                    : copy.text(
                        'Chuẩn sạc của xe · ${selected.connectors.join(' / ')}',
                        'Vehicle connector standard · ${selected.connectors.join(' / ')}',
                      ),
              ),
            ],
          ),
        if (selected != null && connector.canRequestStart)
          _ChargeStartForm(
            key: ValueKey((selection, connector)),
            copy: copy,
            selection: selection,
            connector: connector,
          )
        else
          OutlinedButton(
            key: const Key('qr-recheck-connector'),
            onPressed: onRecheck,
            child: Text(
              copy.text('Kiểm tra lại cổng sạc', 'Check connector again'),
            ),
          ),
        const SizedBox(height: 8),
        TextButton(
          onPressed: onRescan,
          child: Text(copy.text('Quét lại', 'Scan again')),
        ),
      ],
    );
  }
}

class _ChargeStartForm extends ConsumerStatefulWidget {
  const _ChargeStartForm({
    super.key,
    required this.copy,
    required this.selection,
    required this.connector,
  });

  final AppCopy copy;
  final DiscoverySession selection;
  final ResolvedConnector connector;

  @override
  ConsumerState<_ChargeStartForm> createState() => _ChargeStartFormState();
}

class _ChargeStartFormState extends ConsumerState<_ChargeStartForm> {
  final _form = GlobalKey<FormState>();
  final _energy = TextEditingController();
  ChargingMode _mode = ChargingMode.energy;

  @override
  void initState() {
    super.initState();
    final draft = ref.read(chargeStartDraftProvider);
    _mode = draft.mode;
    _energy.text = draft.input;
  }

  void _saveDraft() =>
      ref.read(chargeStartDraftProvider.notifier).update(_mode, _energy.text);

  @override
  void dispose() {
    _energy.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final copy = widget.copy;
    final unit = switch (_mode) {
      ChargingMode.autoFull => '',
      ChargingMode.timed => copy.text('phút', 'min'),
      ChargingMode.energy => 'kWh',
      ChargingMode.cost => 'VND',
    };
    final presets = switch (_mode) {
      ChargingMode.autoFull => <String>[],
      ChargingMode.timed => ['20', '30', '45', '60'],
      ChargingMode.energy => ['10', '20', '35', '50'],
      ChargingMode.cost => ['50000', '100000', '200000'],
    };
    return Form(
      key: _form,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SizedBox(height: 20),
          Text(
            copy.text('Chọn chế độ sạc', 'Choose charging mode'),
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 8),
          ChargeModeChoices(
            copy: copy,
            selected: _mode,
            onChanged: (mode) {
              setState(() {
                _form.currentState?.reset();
                _mode = mode;
                _energy.text = switch (mode) {
                  ChargingMode.autoFull => '',
                  ChargingMode.timed => '30',
                  ChargingMode.energy => '',
                  ChargingMode.cost => '100000',
                };
                _saveDraft();
              });
            },
          ),
          const SizedBox(height: 20),
          Text(
            copy.text(
              'Cắm đầu sạc vào xe trước khi bắt đầu.',
              'Plug the connector into your vehicle before starting.',
            ),
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 12),
          if (_mode != ChargingMode.autoFull) ...[
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final value in presets)
                  OutlinedButton(
                    key: Key('charge-preset-$value'),
                    onPressed: () => setState(() {
                      _energy.text = value;
                      _saveDraft();
                    }),
                    child: Text(
                      _mode == ChargingMode.cost
                          ? vnd(int.parse(value))
                          : '$value $unit',
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 12),
            Text(
              _mode == ChargingMode.energy
                  ? copy.text('Hạn mức điện năng (kWh)', 'Energy limit (kWh)')
                  : copy.text('Mục tiêu ($unit)', 'Target ($unit)'),
              style: Theme.of(context).textTheme.labelLarge,
            ),
            const SizedBox(height: 6),
            Semantics(
              label: _mode == ChargingMode.energy
                  ? copy.text('Hạn mức điện năng (kWh)', 'Energy limit (kWh)')
                  : copy.text('Mục tiêu ($unit)', 'Target ($unit)'),
              child: TextFormField(
                key: Key(
                  _mode == ChargingMode.energy
                      ? 'qr-charge-energy'
                      : 'qr-charge-limit',
                ),
                controller: _energy,
                keyboardType: TextInputType.numberWithOptions(
                  decimal: _mode == ChargingMode.energy,
                ),
                decoration: InputDecoration(suffixText: unit, errorMaxLines: 6),
                onChanged: (_) {
                  _saveDraft();
                  setState(() {});
                },
                validator: (input) =>
                    parseChargeLimit(_mode, input ?? '') == null
                    ? _mode == ChargingMode.energy
                          ? copy.text(
                              'Nhập kWh lớn hơn 0, trong phạm vi cho phép và tối đa 3 chữ số thập phân.',
                              'Enter a positive kWh amount within range, with up to 3 decimal places.',
                            )
                          : copy.text(
                              'Nhập số nguyên lớn hơn 0 trong phạm vi cho phép.',
                              'Enter a positive whole number within range.',
                            )
                    : null,
              ),
            ),
          ],
          const SizedBox(height: 16),
          InfoCard(
            spacing: 4,
            children: [
              Text(
                copy.text('Tóm tắt phiên sạc', 'Charging summary'),
                style: Theme.of(context).textTheme.titleMedium,
              ),
              ValueLine(
                copy.text('Chế độ đã chọn', 'Selected mode'),
                chargeModeLabel(_mode, copy),
              ),
              ValueLine(
                copy.text('Mục tiêu', 'Target'),
                chargeTargetLabel(
                  _mode,
                  parseChargeLimit(_mode, _energy.text),
                  copy,
                ),
                showDivider: false,
              ),
              if (_mode != ChargingMode.autoFull)
                Text(
                  copy.text(
                    'Kết quả thực tế có thể vượt mục tiêu trong thời gian trụ nhận lệnh dừng.',
                    'Actual usage may exceed the target while the charger processes the stop request.',
                  ),
                  style: Theme.of(context).textTheme.bodySmall,
                ),
            ],
          ),
          const SizedBox(height: 16),
          FilledButton.icon(
            key: const Key('qr-submit-start'),
            icon: const Icon(Icons.bolt_rounded),
            onPressed: () {
              if (!_form.currentState!.validate()) return;
              FocusScope.of(context).unfocus();
              unawaited(
                ref
                    .read(chargeStartProvider.notifier)
                    .start(
                      widget.selection,
                      widget.connector,
                      parseChargeLimit(_mode, _energy.text),
                      mode: _mode,
                    ),
              );
            },
            label: Text(
              copy.text('Bắt đầu sạc', 'Start charging'),
              textAlign: TextAlign.center,
            ),
          ),
        ],
      ),
    );
  }
}
