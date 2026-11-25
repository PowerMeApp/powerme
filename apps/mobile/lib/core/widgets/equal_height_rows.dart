import 'package:flutter/widgets.dart';

/// Sizes each small row to its tallest cell, with a full-width final singleton.
class EqualHeightRows extends StatelessWidget {
  const EqualHeightRows({
    super.key,
    required this.columns,
    required this.children,
    this.spacing = 12,
    this.runSpacing = 12,
    this.equalizeGroup = false,
  }) : assert(columns > 0);

  final int columns;
  final List<Widget> children;
  final double spacing;
  final double runSpacing;
  final bool equalizeGroup;

  @override
  Widget build(BuildContext context) {
    Widget row(int start) => Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (
          var i = start;
          i < start + columns && i < children.length;
          i++
        ) ...[
          if (i > start) SizedBox(width: spacing),
          Expanded(child: children[i]),
        ],
      ],
    );
    final rows = Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (var start = 0; start < children.length; start += columns) ...[
          if (start > 0) SizedBox(height: runSpacing),
          if (columns == 1 || start == children.length - 1)
            children[start]
          else if (equalizeGroup)
            Expanded(child: row(start))
          else
            IntrinsicHeight(child: row(start)),
        ],
      ],
    );
    return equalizeGroup && columns > 1 ? IntrinsicHeight(child: rows) : rows;
  }
}
