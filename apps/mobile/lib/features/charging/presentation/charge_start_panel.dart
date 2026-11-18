import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/l10n/app_copy.dart';
import '../../../core/widgets/flow_page.dart';
import '../../profile/domain/vehicle.dart';
import '../../stations/application/station_discovery_controller.dart';
import '../../stations/domain/connector_lookup.dart';
import '../../stations/domain/station.dart';
import '../../stations/presentation/station_copy.dart';
import '../application/charge_start_controller.dart';
import '../domain/charge_start.dart';
import 'charge_flow_visuals.dart';

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

  @override
  void dispose() {
    _energy.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final copy = widget.copy;
    return Form(
      key: _form,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            copy.text(
              'Cắm đầu sạc vào xe trước khi bắt đầu.',
              'Plug the connector into your vehicle before starting.',
            ),
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 12),
          Text(
            copy.text('Hạn mức điện năng (kWh)', 'Energy limit (kWh)'),
            style: Theme.of(context).textTheme.labelLarge,
          ),
          const SizedBox(height: 6),
          Semantics(
            label: copy.text('Hạn mức điện năng (kWh)', 'Energy limit (kWh)'),
            child: TextFormField(
              key: const Key('qr-charge-energy'),
              controller: _energy,
              keyboardType: const TextInputType.numberWithOptions(
                decimal: true,
              ),
              decoration: const InputDecoration(
                suffixText: 'kWh',
                errorMaxLines: 6,
              ),
              validator: (input) => parseChargeEnergyWh(input ?? '') == null
                  ? copy.text(
                      'Nhập kWh lớn hơn 0, trong phạm vi cho phép và tối đa 3 chữ số thập phân.',
                      'Enter a positive kWh amount within range, with up to 3 decimal places.',
                    )
                  : null,
            ),
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
                      parseChargeEnergyWh(_energy.text)!,
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
