import 'package:flutter/material.dart';
import '../theme/powerme_theme.dart';

class HeroCard extends StatelessWidget {
  const HeroCard({
    super.key,
    required this.child,
    this.accent = PowerMeColors.teal,
    this.padding = const EdgeInsets.all(20),
  });
  final Widget child;
  final Color accent;
  final EdgeInsetsGeometry padding;
  @override
  Widget build(BuildContext context) => Container(
    padding: padding,
    decoration: BoxDecoration(
      borderRadius: BorderRadius.circular(14),
      gradient: LinearGradient(
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
        stops: const [0.0, 0.45, 1.0],
        colors: [
          Color.alphaBlend(
            accent.withValues(alpha: .16),
            PowerMeColors.graphite,
          ),
          Color.alphaBlend(
            accent.withValues(alpha: .05),
            PowerMeColors.graphite,
          ),
          PowerMeColors.graphite,
        ],
      ),
      border: Border.all(color: accent.withValues(alpha: .42)),
    ),
    child: child,
  );
}

class StatusBadge extends StatelessWidget {
  const StatusBadge(this.label, {super.key, this.color = PowerMeColors.teal});
  final String label;
  final Color color;
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 6),
    decoration: BoxDecoration(
      color: color.withValues(alpha: .12),
      borderRadius: BorderRadius.circular(999),
      border: Border.all(color: color.withValues(alpha: .34)),
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 6,
          height: 6,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: 7),
        Flexible(
          child: Text(
            label,
            style: Theme.of(context).textTheme.labelMedium?.copyWith(
              color: color,
              fontWeight: FontWeight.w700,
              letterSpacing: .2,
            ),
          ),
        ),
      ],
    ),
  );
}

class MetricItem {
  const MetricItem(this.label, this.value, this.icon);
  final String label, value;
  final IconData icon;
}

class MetricGrid extends StatelessWidget {
  const MetricGrid({super.key, required this.items});
  final List<MetricItem> items;
  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, box) {
      final stacked =
          box.maxWidth < 300 ||
          MediaQuery.sizeOf(context).width < 340 ||
          MediaQuery.textScalerOf(context).scale(14) / 14 > 1.3;
      final width = stacked ? box.maxWidth : (box.maxWidth - 12) / 2;
      return Wrap(
        spacing: 12,
        runSpacing: 12,
        children: [
          for (final item in items)
            Container(
              width: width,
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: PowerMeColors.black.withValues(alpha: .62),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(
                  color: PowerMeColors.outline.withValues(alpha: .42),
                ),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Icon(item.icon, size: 17, color: PowerMeColors.gold),
                      const SizedBox(width: 7),
                      Expanded(
                        child: Text(
                          item.label,
                          style: Theme.of(context).textTheme.bodySmall
                              ?.copyWith(
                                color: PowerMeColors.muted,
                                fontWeight: FontWeight.w500,
                              ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Text(
                    item.value,
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w700,
                      fontFeatures: const [FontFeature.tabularFigures()],
                    ),
                  ),
                ],
              ),
            ),
        ],
      );
    },
  );
}

class QuickAction {
  const QuickAction(
    this.label,
    this.icon,
    this.onTap, {
    this.key,
    this.selected = false,
  });
  final String label;
  final IconData icon;
  final VoidCallback onTap;
  final Key? key;
  final bool selected;
}

class QuickActions extends StatelessWidget {
  const QuickActions({super.key, required this.actions});
  final List<QuickAction> actions;
  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, box) {
      final large = MediaQuery.textScalerOf(context).scale(14) / 14 > 1.3;
      final count = large
          ? 1
          : box.maxWidth < 340
          ? 2
          : actions.length <= 4
          ? 4
          : 3;
      return Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          for (final action in actions)
            SizedBox(
              width: (box.maxWidth - 8 * (count - 1)) / count,
              child: Material(
                color: action.selected
                    ? PowerMeColors.teal.withValues(alpha: .12)
                    : PowerMeColors.graphite,
                borderRadius: BorderRadius.circular(12),
                child: InkWell(
                  key: action.key,
                  onTap: action.onTap,
                  borderRadius: BorderRadius.circular(12),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 10,
                    ),
                    child: Column(
                      children: [
                        Icon(action.icon, color: PowerMeColors.teal, size: 23),
                        const SizedBox(height: 8),
                        Text(
                          action.label,
                          textAlign: TextAlign.center,
                          style: Theme.of(context).textTheme.labelLarge,
                        ),
                      ],
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

class MenuRow extends StatelessWidget {
  const MenuRow({
    super.key,
    required this.label,
    required this.icon,
    required this.onTap,
  });
  final String label;
  final IconData icon;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => ListTile(
    contentPadding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
    minTileHeight: 56,
    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
    leading: Container(
      width: 36,
      height: 36,
      decoration: BoxDecoration(
        color: PowerMeColors.black,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: PowerMeColors.gold.withValues(alpha: .32)),
      ),
      child: Icon(icon, size: 19, color: PowerMeColors.gold),
    ),
    title: Text(label, style: Theme.of(context).textTheme.titleMedium),
    trailing: const Icon(
      Icons.chevron_right_rounded,
      color: PowerMeColors.muted,
    ),
    onTap: onTap,
  );
}
