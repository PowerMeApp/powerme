import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../theme/powerme_theme.dart';
import 'app_page.dart';

export '../format.dart';
export 'visual_components.dart';

class FlowPage extends StatelessWidget {
  const FlowPage({
    super.key,
    required this.title,
    required this.children,
    this.showBack = true,
    this.backTooltip = 'Quay lại',
  });
  final String title;
  final List<Widget> children;
  final bool showBack;
  final String backTooltip;
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(title),
      automaticallyImplyLeading: false,
      leading: showBack
          ? IconButton(
              tooltip: backTooltip,
              onPressed: () =>
                  context.canPop() ? context.pop() : context.go('/'),
              icon: const Icon(Icons.arrow_back_rounded),
            )
          : null,
    ),
    body: AppPage(children: children),
  );
}

class InfoCard extends StatelessWidget {
  const InfoCard({super.key, required this.children, this.spacing = 12});
  final List<Widget> children;
  final double spacing;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 16),
    child: Card(
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final (index, child) in children.indexed)
              Padding(
                padding: EdgeInsets.only(
                  bottom: index == children.length - 1 ? 0 : spacing,
                ),
                child: child,
              ),
          ],
        ),
      ),
    ),
  );
}

class ValueLine extends StatelessWidget {
  const ValueLine(this.label, this.value, {super.key, this.showDivider = true});
  final String label;
  final String value;
  final bool showDivider;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 4),
    child: LayoutBuilder(
      builder: (context, box) {
        final labelWidget = Text(
          label,
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
        );
        final valueStyle = Theme.of(context).textTheme.titleMedium?.copyWith(
          fontWeight: FontWeight.w700,
          fontFeatures: const [FontFeature.tabularFigures()],
        );
        final valueWidget = Text(value, style: valueStyle);
        final stacked =
            box.maxWidth < 280 ||
            MediaQuery.textScalerOf(context).scale(14) / 14 > 1.3;
        return DecoratedBox(
          decoration: BoxDecoration(
            border: showDivider
                ? Border(
                    bottom: BorderSide(
                      color: Theme.of(
                        context,
                      ).colorScheme.outline.withValues(alpha: .24),
                    ),
                  )
                : null,
          ),
          child: Padding(
            padding: EdgeInsets.only(bottom: showDivider ? 12 : 4, top: 4),
            child: stacked
                ? Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      labelWidget,
                      const SizedBox(height: 4),
                      valueWidget,
                    ],
                  )
                : Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(flex: 5, child: labelWidget),
                      const SizedBox(width: 16),
                      Expanded(
                        flex: 6,
                        child: Text(
                          value,
                          textAlign: TextAlign.right,
                          style: valueStyle,
                        ),
                      ),
                    ],
                  ),
          ),
        );
      },
    ),
  );
}

class FailureNotice extends StatelessWidget {
  const FailureNotice(this.message, {super.key});
  final String? message;
  @override
  Widget build(BuildContext context) =>
      message == null || message!.trim().isEmpty
      ? const SizedBox.shrink()
      : Padding(
          padding: const EdgeInsets.symmetric(vertical: 12),
          child: Semantics(
            liveRegion: true,
            child: Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: PowerMeColors.gold.withValues(alpha: .12),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(
                  color: PowerMeColors.gold.withValues(alpha: .48),
                ),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const ExcludeSemantics(
                    child: Icon(
                      Icons.info_outline_rounded,
                      color: PowerMeColors.gold,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      message!,
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
}
