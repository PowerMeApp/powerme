import 'package:flutter/material.dart';

import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/flow_page.dart';
import '../domain/vehicle.dart';

class VehicleHeading extends StatelessWidget {
  const VehicleHeading(this.label, {super.key, this.description});

  final String label;
  final String? description;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Semantics(
          header: true,
          child: Text(
            label,
            style: text.headlineSmall?.copyWith(
              fontFamily: 'serif',
              color: PowerMeColors.gold,
              letterSpacing: .4,
            ),
          ),
        ),
        if (description case final String subtitle) ...[
          const SizedBox(height: 6),
          Text(subtitle, style: text.bodySmall),
        ],
      ],
    );
  }
}

class VehiclePhoto extends StatelessWidget {
  const VehiclePhoto({
    super.key,
    required this.copy,
    required this.imageUrl,
    this.imageCredit,
    this.compact = false,
  });

  final AppCopy copy;
  final String? imageUrl;
  final String? imageCredit;
  final bool compact;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      AspectRatio(
        aspectRatio: compact ? 1.5 : 1.8,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(10),
          child: switch (imageUrl) {
            final String url => Image.network(
              url,
              fit: BoxFit.cover,
              excludeFromSemantics: true,
              frameBuilder: (context, image, frame, synchronous) =>
                  synchronous || frame != null ? image : _illustration(context),
              errorBuilder: (context, error, stack) => _illustration(context),
            ),
            null => _illustration(context),
          },
        ),
      ),
      if (imageCredit case final String credit) ...[
        const SizedBox(height: 6),
        Text(credit, style: Theme.of(context).textTheme.bodySmall),
      ],
    ],
  );

  Widget _illustration(BuildContext context) => Stack(
    fit: StackFit.expand,
    children: [
      Image.asset(
        'assets/vehicles/ev-illustration.webp',
        fit: BoxFit.cover,
        excludeFromSemantics: true,
      ),
      if (!compact)
        Padding(
          padding: const EdgeInsets.all(8),
          child: Align(
            alignment: Alignment.bottomRight,
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: PowerMeColors.black.withValues(alpha: .86),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                child: Text(
                  copy.text('Ảnh minh họa', 'Illustration'),
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ),
            ),
          ),
        ),
    ],
  );
}

class VehicleHero extends StatelessWidget {
  const VehicleHero({
    super.key,
    required this.copy,
    required this.vehicle,
    required this.isDefault,
  });

  final AppCopy copy;
  final Vehicle vehicle;
  final bool isDefault;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return HeroCard(
      accent: isDefault ? PowerMeColors.gold : PowerMeColors.teal,
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          VehiclePhoto(
            copy: copy,
            imageUrl: vehicle.imageUrl,
            imageCredit: vehicle.imageCredit,
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              if (isDefault)
                StatusBadge(
                  copy.text('Xe mặc định', 'Default vehicle'),
                  color: PowerMeColors.gold,
                ),
              if (vehicle.plateNumber case final String plate)
                Text(
                  plate,
                  style: text.labelMedium?.copyWith(
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
            ],
          ),
          const SizedBox(height: 8),
          Text(vehicle.label, style: text.headlineSmall),
        ],
      ),
    );
  }
}

class VehicleSpecifications extends StatelessWidget {
  const VehicleSpecifications({
    super.key,
    required this.copy,
    required this.connectors,
    required this.batteryCapacityKwh,
    required this.ratedRangeKm,
    required this.maxDcKw,
  });

  VehicleSpecifications.saved({
    super.key,
    required this.copy,
    required Vehicle vehicle,
  }) : connectors = vehicle.connectors,
       batteryCapacityKwh = vehicle.batteryCapacityKwh,
       ratedRangeKm = vehicle.ratedRangeKm,
       maxDcKw = vehicle.maxDcKw;

  final AppCopy copy;
  final List<String> connectors;
  final num? batteryCapacityKwh;
  final int? ratedRangeKm;
  final num? maxDcKw;

  @override
  Widget build(BuildContext context) {
    final unknown = copy.text('Chưa có dữ liệu', 'Unavailable');
    String measure(num? value, String unit) =>
        value == null ? unknown : '$value $unit';
    return MetricGrid(
      items: [
        MetricItem(
          copy.text('Chuẩn cổng', 'Connector type'),
          connectors.isEmpty ? unknown : connectors.join(' · '),
          Icons.ev_station_outlined,
        ),
        MetricItem(
          copy.text('Công suất DC tối đa', 'Max DC power'),
          measure(maxDcKw, 'kW'),
          Icons.bolt_rounded,
        ),
        MetricItem(
          copy.text('Dung lượng pin', 'Battery capacity'),
          measure(batteryCapacityKwh, 'kWh'),
          Icons.battery_charging_full_outlined,
        ),
        MetricItem(
          copy.text('Tầm hoạt động công bố', 'Rated range'),
          measure(ratedRangeKm, 'km'),
          Icons.route_outlined,
        ),
      ],
    );
  }
}
