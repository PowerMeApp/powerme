import 'dart:ui' show SemanticsAction, Tristate;

import 'package:driver_app/app/driver_tab_bar.dart';
import 'package:driver_app/core/l10n/app_copy.dart';
import 'package:driver_app/core/theme/powerme_theme.dart';
import 'package:driver_app/features/profile/domain/driver_profile.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('five tabs fit at 320px and 200%, with one large Charge target', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(320, 560));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final semantics = tester.ensureSemantics();
    final selected = <DriverTab>[];

    await tester.pumpWidget(
      MaterialApp(
        theme: powerMeTheme(),
        home: MediaQuery(
          data: const MediaQueryData(
            padding: EdgeInsets.only(bottom: 24),
            textScaler: TextScaler.linear(2),
          ),
          child: Scaffold(
            bottomNavigationBar: DriverTabBar(
              copy: AppCopy(AppLanguage.vietnamese),
              selected: DriverTab.charging,
              hasSession: false,
              onSelect: selected.add,
            ),
          ),
        ),
      ),
    );

    final charge = find.byKey(const Key('nav-charging'));
    final highlight = find.byKey(const Key('nav-charging-highlight'));
    expect(tester.getSize(highlight), const Size(64, 60));
    expect(tester.getBottomLeft(charge).dy, lessThan(536));
    for (final tab in DriverTab.values.where((t) => t != DriverTab.charging)) {
      final size = tester.getSize(find.byKey(Key(tab.key)));
      expect(size.width, greaterThanOrEqualTo(48));
      expect(size.height, greaterThanOrEqualTo(48));
      expect(tester.getBottomLeft(find.byKey(Key(tab.key))).dy, lessThan(536));
    }
    expect(find.bySemanticsLabel('Sạc'), findsOneWidget);
    final node = tester.getSemantics(charge).getSemanticsData();
    expect(node.flagsCollection.isSelected, Tristate.isTrue);
    expect(node.hasAction(SemanticsAction.tap), isTrue);
    await tester.tap(highlight);
    await tester.tap(find.text('Sạc'));
    expect(selected, [DriverTab.charging, DriverTab.charging]);
    semantics.dispose();
    expect(tester.takeException(), isNull);
  });
}
