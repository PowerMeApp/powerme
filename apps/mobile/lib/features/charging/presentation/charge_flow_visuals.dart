import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/brand_mark.dart';
import '../../../core/widgets/flow_page.dart';
import '../../stations/domain/connector_lookup.dart';

class ChargeFlowPage extends StatelessWidget {
  const ChargeFlowPage({
    super.key,
    required this.title,
    required this.children,
    this.showBack = true,
    this.backTooltip = 'Quay lại',
    this.backLocation = '/',
    this.onBack,
    this.action,
  });

  final String title;
  final List<Widget> children;
  final Widget? action;
  final bool showBack;
  final String backTooltip;
  final String backLocation;
  final VoidCallback? onBack;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Theme(
      data: theme.copyWith(
        appBarTheme: theme.appBarTheme.copyWith(
          titleTextStyle: theme.textTheme.titleLarge,
        ),
      ),
      child: FlowPage(
        title: title,
        showBack: showBack,
        backTooltip: backTooltip,
        backLocation: backLocation,
        onBack: onBack,
        action: action,
        children: children,
      ),
    );
  }
}

class ChargeHeading extends StatelessWidget {
  const ChargeHeading(this.label, {super.key, this.centered = true});

  final String label;
  final bool centered;

  @override
  Widget build(BuildContext context) => Semantics(
    header: true,
    child: Text(
      label,
      textAlign: centered ? TextAlign.center : TextAlign.start,
      style: Theme.of(
        context,
      ).textTheme.headlineSmall?.copyWith(color: PowerMeColors.gold),
    ),
  );
}

String chargeConnectorLabel(ResolvedConnector connector, AppCopy copy) =>
    copy.text(
      'Trụ ${connector.displayCode} · Cổng ${connector.number}',
      'Charger ${connector.displayCode} · Connector ${connector.number}',
    );

class ChargeContextCard extends StatelessWidget {
  const ChargeContextCard({
    super.key,
    required this.copy,
    required this.connector,
    this.vehicle,
  });

  final AppCopy copy;
  final ResolvedConnector connector;
  final String? vehicle;

  @override
  Widget build(BuildContext context) => InfoCard(
    spacing: 10,
    children: [
      ChargeDetail(
        icon: Icons.ev_station_outlined,
        title: connector.stationName,
        detail: chargeConnectorLabel(connector, copy),
      ),
      if (vehicle != null) ...[
        const Divider(),
        ChargeDetail(
          icon: Icons.directions_car_outlined,
          title: vehicle!,
          detail: copy.vehicle,
        ),
      ],
    ],
  );
}

class ChargeDetail extends StatelessWidget {
  const ChargeDetail({
    super.key,
    this.icon,
    this.mark = false,
    required this.title,
    required this.detail,
  });

  final IconData? icon;
  final bool mark;
  final String title;
  final String detail;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ExcludeSemantics(
          child: SizedBox(
            width: 40,
            height: 40,
            child: Center(
              child: mark
                  ? const ChargingMark(
                      size: 38,
                      backgroundColor: PowerMeColors.graphite,
                    )
                  : Icon(icon, color: theme.colorScheme.secondary),
            ),
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: theme.textTheme.titleMedium),
              const SizedBox(height: 2),
              Text(detail, style: theme.textTheme.bodySmall),
            ],
          ),
        ),
      ],
    );
  }
}

class ChargeMilestones extends StatelessWidget {
  const ChargeMilestones({
    super.key,
    required this.title,
    required this.steps,
    this.compact = false,
  });

  final String title;
  final bool compact;
  final List<({String label, String state, IconData icon, Color color})> steps;

  @override
  Widget build(BuildContext context) => InfoCard(
    spacing: 12,
    children: [
      Text(title, style: Theme.of(context).textTheme.titleMedium),
      if (compact &&
          MediaQuery.sizeOf(context).width >= 360 &&
          MediaQuery.textScalerOf(context).scale(14) <= 18)
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final step in steps)
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 3),
                  child: Column(
                    children: [
                      CircleAvatar(
                        radius: 16,
                        backgroundColor: step.color.withValues(alpha: .13),
                        child: Icon(step.icon, size: 18, color: step.color),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        step.label,
                        textAlign: TextAlign.center,
                        style: Theme.of(context).textTheme.labelSmall,
                      ),
                      const SizedBox(height: 4),
                      Text(
                        step.state,
                        textAlign: TextAlign.center,
                        style: Theme.of(
                          context,
                        ).textTheme.bodySmall?.copyWith(color: step.color),
                      ),
                    ],
                  ),
                ),
              ),
          ],
        )
      else
        for (final step in steps)
          LayoutBuilder(
            builder: (context, box) {
              final theme = Theme.of(context);
              final stackLabels =
                  box.maxWidth < 285 ||
                  MediaQuery.textScalerOf(context).scale(14) > 18;
              final label = Text(step.label, style: theme.textTheme.labelLarge);
              final state = Text(
                step.state,
                style: theme.textTheme.bodySmall?.copyWith(color: step.color),
              );
              return Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  ExcludeSemantics(
                    child: Container(
                      width: 32,
                      height: 32,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: step.color.withValues(alpha: .13),
                      ),
                      child: Icon(step.icon, size: 18, color: step.color),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: stackLabels
                        ? Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [label, state],
                          )
                        : Padding(
                            padding: const EdgeInsets.only(top: 6),
                            child: Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Expanded(flex: 3, child: label),
                                const SizedBox(width: 8),
                                Expanded(flex: 2, child: state),
                              ],
                            ),
                          ),
                  ),
                ],
              );
            },
          ),
    ],
  );
}

enum ChargeRingPhase { energy, starting, stopping }

class ChargeRing extends StatelessWidget {
  const ChargeRing({
    super.key,
    required this.icon,
    this.energy,
    this.label,
    this.fraction,
    this.phase = ChargeRingPhase.energy,
  });

  final IconData icon;
  final String? energy;
  final String? label;
  final double? fraction;
  final ChargeRingPhase phase;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final largeText =
        MediaQuery.textScalerOf(context).scale(14) > 18 ||
        (energy?.length ?? 0) > 12;
    final readout = Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (label != null)
          Text(
            label!,
            textAlign: TextAlign.center,
            style: theme.textTheme.labelMedium,
          ),
        if (energy != null)
          Text(
            energy!,
            textAlign: TextAlign.center,
            style: theme.textTheme.headlineLarge?.copyWith(
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
      ],
    );
    return LayoutBuilder(
      builder: (context, box) {
        final diameter = math.min(
          box.maxWidth,
          phase == ChargeRingPhase.energy ? 316.0 : 208.0,
        );
        return Column(
          children: [
            SizedBox.square(
              dimension: diameter,
              child: CustomPaint(
                painter: _RingPainter(
                  teal: theme.colorScheme.primary,
                  gold: theme.colorScheme.secondary,
                  track: theme.colorScheme.outline,
                  fraction: fraction,
                  phase: phase,
                ),
                child: Center(
                  child: SizedBox(
                    width: diameter * .72,
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        ExcludeSemantics(
                          child: Icon(
                            icon,
                            color: theme.colorScheme.secondary,
                            size: phase == ChargeRingPhase.energy ? 26 : 40,
                          ),
                        ),
                        if (!largeText && label != null) ...[
                          const SizedBox(height: 6),
                          readout,
                        ],
                      ],
                    ),
                  ),
                ),
              ),
            ),
            if (largeText && label != null) ...[
              const SizedBox(height: 8),
              readout,
            ],
          ],
        );
      },
    );
  }
}

class _RingPainter extends CustomPainter {
  const _RingPainter({
    required this.teal,
    required this.gold,
    required this.track,
    required this.fraction,
    required this.phase,
  });

  final Color teal;
  final Color gold;
  final Color track;
  final double? fraction;
  final ChargeRingPhase phase;

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final radius = size.shortestSide / 2;
    canvas.drawCircle(
      center,
      radius,
      Paint()
        ..shader = RadialGradient(
          colors: [
            teal.withValues(alpha: .06),
            teal.withValues(alpha: .12),
            teal.withValues(alpha: 0),
          ],
          stops: const [0, .76, 1],
        ).createShader(Rect.fromCircle(center: center, radius: radius)),
    );
    final ring = Rect.fromCircle(center: center, radius: radius * .84);
    final stroke = Paint()
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round;

    if (phase == ChargeRingPhase.starting) {
      stroke.strokeWidth = 2;
      const turn = math.pi * 2;
      final inner = Rect.fromCircle(center: center, radius: radius * .67);
      for (var tick = 0; tick < 24; tick++) {
        final angle = tick * turn / 24;
        canvas.drawArc(ring, angle, .075, false, stroke..color = teal);
        canvas.drawArc(
          inner,
          angle + .12,
          .023,
          false,
          stroke..color = gold.withValues(alpha: .55),
        );
      }
      return;
    }

    if (phase == ChargeRingPhase.stopping) {
      stroke.strokeWidth = 4;
      canvas.drawOval(ring, stroke..color = teal.withValues(alpha: .85));
      return;
    }

    stroke.strokeWidth = 9;
    canvas.drawOval(ring, stroke..color = track);
    final fill = fraction;
    if (fill != null && fill > 0) {
      canvas.drawArc(
        ring,
        -math.pi / 2,
        fill * math.pi * 2,
        false,
        stroke..color = teal,
      );
    }
  }

  @override
  bool shouldRepaint(_RingPainter oldDelegate) =>
      teal != oldDelegate.teal ||
      gold != oldDelegate.gold ||
      track != oldDelegate.track ||
      fraction != oldDelegate.fraction ||
      phase != oldDelegate.phase;
}
