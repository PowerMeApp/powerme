import 'dart:io';
import 'dart:ui' as ui;
import 'package:driver_app/app/router.dart';
import 'package:driver_app/core/widgets/app_page.dart';
import 'package:driver_app/core/widgets/visual_components.dart';
import 'package:driver_app/features/charging/presentation/charge_mode_widgets.dart';
import 'package:driver_app/features/charging/presentation/charge_session_readout.dart';
import 'package:driver_app/features/profile/domain/driver_profile.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import '../test/driver_charge_modes_test.dart' show tapChargeKey;
import '../test/scanner_platform_fake.dart';
import '../test/support/ui_consistency_fixture.dart';

void main() {
  for (final (width, scale, language) in [
    (390.0, 1.0, AppLanguage.vietnamese),
    (320.0, 2.0, AppLanguage.vietnamese),
    (320.0, 2.0, AppLanguage.english),
  ]) {
    testWidgets('UI consistency $width/$scale ${language.name}', (
      tester,
    ) async {
      await tester.runAsync(_loadFonts);
      tester.view.physicalSize = Size(width, 844);
      tester.view.devicePixelRatio = 1;
      tester.view.padding = const FakeViewPadding(top: 24, bottom: 24);
      tester.platformDispatcher.textScaleFactorTestValue = scale;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPadding);
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      final previous = MobileScannerPlatform.instance;
      final camera = ScannerPlatformFake();
      MobileScannerPlatform.instance = camera;
      addTearDown(() => MobileScannerPlatform.instance = previous);
      final key = GlobalKey();
      final container = await mountConsistencyApp(
        tester,
        boundaryKey: key,
        language: language,
      );
      final router = container.read(routerProvider);
      await tester.runAsync(() async {
        for (final asset in [
          'powerme-master-icon.png',
          'powerme-wordmark.png',
          'powerme-secondary-icon.png',
        ]) {
          await precacheImage(
            AssetImage('assets/brand/$asset'),
            key.currentContext!,
          );
        }
      });
      await tester.pumpAndSettle();
      const output = String.fromEnvironment('POWERME_CONSISTENCY_CAPTURE');
      expect(output, isNotEmpty);
      Future<void> capture(String name, Finder target) async {
        if (target.evaluate().isEmpty) {
          await tester.scrollUntilVisible(
            target,
            220,
            scrollable: find
                .descendant(
                  of: find.byType(AppPage),
                  matching: find.byType(Scrollable),
                )
                .first,
          );
        }
        await tester.ensureVisible(target);
        await tester.pumpAndSettle();
        void repaint(RenderObject object) {
          object.visitChildren(repaint);
          object.markNeedsPaint();
        }

        final boundary =
            key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        repaint(boundary);
        await tester.pump(const Duration(milliseconds: 16));
        expect(tester.takeException(), isNull);
        await tester.runAsync(() async {
          final frame = await boundary.toImage();
          final png = await frame.toByteData(format: ui.ImageByteFormat.png);
          final path = '$output/$name-${width.toInt()}-${language.name}.png';
          await File(path).parent.create(recursive: true);
          await File(path).writeAsBytes(png!.buffer.asUint8List());
          frame.dispose();
        });
      }

      if (width == 390) {
        await tester.enterText(find.byKey(const Key('suggestion-soc')), '30');
        await tapChargeKey(tester, 'submit-smart-search');
        await capture('suggestions', find.byType(MetricGrid));
        router.go('/vehicles/9');
        await tester.pumpAndSettle();
        await capture('vehicle', find.byType(MetricGrid));
      }
      if (language == AppLanguage.vietnamese) {
        router.go('/scan');
        await tester.pumpAndSettle();
        camera.emit('powerme:connector:PM-T96/2');
        await tester.pumpAndSettle();
        await capture('charging-modes', find.byType(ChargeModeChoices));
        if (width == 390) {
          await tester.enterText(
            find.byKey(const Key('qr-charge-energy')),
            '10',
          );
          await tapChargeKey(tester, 'qr-submit-start');
          await capture('active-metrics', find.byType(ChargeSessionMetrics));
        }
      }
      if (width == 390 || language == AppLanguage.english) {
        router.go('/credit/top-up');
        await tester.pumpAndSettle();
        await capture(
          'top-up-presets',
          find.byKey(const Key('top-up-preset-50000')),
        );
      }
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpAndSettle();
    });
  }
}

Future<void> _loadFonts() async {
  const fonts = String.fromEnvironment('POWERME_PREVIEW_FONTS');
  expect(fonts, isNotEmpty);
  for (final family in ['Roboto', 'Ahem']) {
    final loader = FontLoader(family);
    for (final weight in ['regular', 'medium', 'bold']) {
      loader.addFont(
        File(
          '$fonts/roboto-$weight.ttf',
        ).readAsBytes().then(ByteData.sublistView),
      );
    }
    await loader.load();
  }
  await (FontLoader('MaterialIcons')..addFont(
        File(
          '$fonts/materialicons-regular.otf',
        ).readAsBytes().then(ByteData.sublistView),
      ))
      .load();
}
