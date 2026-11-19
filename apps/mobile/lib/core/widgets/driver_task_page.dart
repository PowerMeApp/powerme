import 'package:flutter/material.dart';

import '../theme/powerme_theme.dart';
import 'app_page.dart';
import 'brand_mark.dart';

class DriverTaskPage extends StatelessWidget {
  const DriverTaskPage({
    super.key,
    required this.backTooltip,
    required this.onBack,
    required this.child,
  });

  final String backTooltip;
  final VoidCallback onBack;
  final Widget child;

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      centerTitle: true,
      automaticallyImplyLeading: false,
      leading: IconButton(
        tooltip: backTooltip,
        onPressed: onBack,
        icon: const Icon(Icons.arrow_back_rounded),
      ),
      title: const BrandMark(),
    ),
    body: AppPage(children: [child]),
  );
}

class DriverTaskHeading extends StatelessWidget {
  const DriverTaskHeading(this.label, {super.key, this.icon});

  final String label;
  final IconData? icon;

  @override
  Widget build(BuildContext context) => Semantics(
    header: true,
    child: Row(
      children: [
        if (icon != null) ...[
          Icon(icon, color: PowerMeColors.gold, size: 20),
          const SizedBox(width: 10),
        ],
        Expanded(
          child: Text(label, style: Theme.of(context).textTheme.titleMedium),
        ),
      ],
    ),
  );
}

class DriverTaskStatus extends StatelessWidget {
  const DriverTaskStatus({
    super.key,
    required this.icon,
    required this.color,
    required this.title,
    required this.message,
  });

  final IconData icon;
  final Color color;
  final String title;
  final String message;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(6, 12, 6, 24),
      child: Semantics(
        liveRegion: true,
        child: Column(
          children: [
            Container(
              width: 92,
              height: 92,
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: color.withValues(alpha: .05),
                shape: BoxShape.circle,
                border: Border.all(color: color.withValues(alpha: .24)),
              ),
              child: DecoratedBox(
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: color.withValues(alpha: .1),
                  border: Border.all(color: color.withValues(alpha: .52)),
                ),
                child: Icon(icon, color: color, size: 34),
              ),
            ),
            const SizedBox(height: 20),
            Semantics(
              header: true,
              child: Text(
                title,
                textAlign: TextAlign.center,
                style: theme.textTheme.headlineSmall,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              message,
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
