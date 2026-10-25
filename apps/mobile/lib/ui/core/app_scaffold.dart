import 'package:flutter/material.dart';

import 'brand_mark.dart';

class AppScaffold extends StatelessWidget {
  const AppScaffold({
    required this.title,
    required this.body,
    this.actions = const [],
    super.key,
  });

  final String title;
  final Widget body;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Row(
          children: [
            const BrandMark(variant: BrandMarkVariant.compact),
            const SizedBox(width: 12),
            Text(title),
          ],
        ),
        actions: actions,
      ),
      body: SafeArea(child: body),
    );
  }
}
