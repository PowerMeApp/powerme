import 'package:flutter/material.dart';

import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/flow_page.dart';
import '../domain/charging.dart';
import 'charge_energy_label.dart';

String chargeModeLabel(ChargingMode? mode, AppCopy copy) => switch (mode) {
  ChargingMode.autoFull => copy.text('Sạc đầy', 'Full charge'),
  ChargingMode.timed => copy.text('Theo thời gian', 'By time'),
  ChargingMode.energy => copy.text('Theo kWh', 'By energy'),
  ChargingMode.cost => copy.text('Theo số tiền', 'By amount'),
  null => copy.text('Chưa xác định', 'Unknown'),
};

IconData chargeModeIcon(ChargingMode mode) => switch (mode) {
  ChargingMode.autoFull => Icons.battery_charging_full,
  ChargingMode.timed => Icons.schedule_outlined,
  ChargingMode.energy => Icons.bolt_outlined,
  ChargingMode.cost => Icons.account_balance_wallet_outlined,
};

String chargeTargetLabel(ChargingMode? mode, int? limit, AppCopy copy) {
  if (mode == ChargingMode.autoFull) {
    return copy.text(
      'Đến khi xe hoặc trụ kết thúc phiên',
      'Until the vehicle or charger ends the session',
    );
  }
  if (mode == null || limit == null) {
    return copy.text('Chưa xác định', 'Unknown');
  }
  return switch (mode) {
    ChargingMode.timed => copy.text('$limit phút', '$limit min'),
    ChargingMode.energy => chargeEnergyLabel(limit, copy),
    ChargingMode.cost => vnd(limit),
    ChargingMode.autoFull => '',
  };
}

String chargeElapsedLabel(int? seconds) {
  if (seconds == null) return '—';
  final h = (seconds ~/ 3600).toString().padLeft(2, '0');
  final m = ((seconds ~/ 60) % 60).toString().padLeft(2, '0');
  final s = (seconds % 60).toString().padLeft(2, '0');
  return '$h:$m:$s';
}

class ChargeModeChoices extends StatelessWidget {
  const ChargeModeChoices({
    super.key,
    required this.copy,
    required this.selected,
    this.onChanged,
  });

  final AppCopy copy;
  final ChargingMode? selected;
  final ValueChanged<ChargingMode>? onChanged;

  @override
  Widget build(BuildContext context) {
    if (onChanged == null) {
      return InfoCard(
        spacing: 12,
        children: [
          Text(
            copy.text('Chế độ của phiên', 'Session mode'),
            style: Theme.of(context).textTheme.titleMedium,
          ),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final mode in ChargingMode.values)
                Semantics(
                  selected: selected == mode,
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: selected == mode
                          ? PowerMeColors.teal
                          : PowerMeColors.black,
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 10,
                        vertical: 10,
                      ),
                      child: Text(
                        switch (mode) {
                          ChargingMode.autoFull => copy.text('Sạc đầy', 'Full'),
                          ChargingMode.timed => copy.text('Thời gian', 'Time'),
                          ChargingMode.energy => 'kWh',
                          ChargingMode.cost => copy.text('Số tiền', 'Amount'),
                        },
                        style: Theme.of(context).textTheme.labelMedium
                            ?.copyWith(
                              color: selected == mode
                                  ? PowerMeColors.black
                                  : PowerMeColors.muted,
                            ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
          Text(
            copy.text(
              'Chế độ được giữ trong suốt phiên sạc.',
              'The mode stays fixed for this session.',
            ),
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      );
    }
    return LayoutBuilder(
      builder: (context, box) {
        final single =
            box.maxWidth < 280 ||
            MediaQuery.textScalerOf(context).scale(14) > 20;
        return Wrap(
          spacing: 12,
          runSpacing: 12,
          children: [
            for (final mode in ChargingMode.values)
              SizedBox(
                width: single ? box.maxWidth : (box.maxWidth - 12) / 2,
                child: Semantics(
                  selected: selected == mode,
                  child: Material(
                    color: PowerMeColors.graphite,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                      side: BorderSide(
                        color: selected == mode
                            ? PowerMeColors.teal
                            : Theme.of(context).colorScheme.outline,
                      ),
                    ),
                    clipBehavior: Clip.antiAlias,
                    child: InkWell(
                      key: Key('charge-mode-${mode.name}'),
                      onTap: () => onChanged!(mode),
                      child: Padding(
                        padding: const EdgeInsets.all(14),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Icon(
                                  chargeModeIcon(mode),
                                  color: selected == mode
                                      ? PowerMeColors.teal
                                      : PowerMeColors.gold,
                                ),
                                const Spacer(),
                                if (selected == mode)
                                  const Icon(
                                    Icons.check_circle,
                                    color: PowerMeColors.teal,
                                    size: 18,
                                  ),
                              ],
                            ),
                            const SizedBox(height: 12),
                            Text(
                              chargeModeLabel(mode, copy),
                              style: Theme.of(context).textTheme.titleSmall
                                  ?.copyWith(
                                    color: selected == mode
                                        ? PowerMeColors.teal
                                        : null,
                                  ),
                            ),
                            const SizedBox(height: 4),
                            Text(switch (mode) {
                              ChargingMode.autoFull => copy.text(
                                'Xe hoặc trụ xác nhận kết thúc',
                                'Vehicle or charger confirms the end',
                              ),
                              ChargingMode.timed => copy.text(
                                'Mục tiêu theo phút',
                                'Target in minutes',
                              ),
                              ChargingMode.energy => copy.text(
                                'Mục tiêu điện năng',
                                'Target energy',
                              ),
                              ChargingMode.cost => copy.text(
                                'Mục tiêu chi phí tạm tính',
                                'Target estimated cost',
                              ),
                            }, style: Theme.of(context).textTheme.bodySmall),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}
