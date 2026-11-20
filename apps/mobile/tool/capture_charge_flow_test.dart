import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:driver_app/app/composition/api_app.dart';
import 'package:driver_app/core/api/api_config.dart';
import 'package:driver_app/features/charging/domain/charging.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../test/driver_api_widget_test.dart' show enterAccount;
import '../test/driver_charge_modes_test.dart'
    show tapChargeKey, selectChargeMode;
import '../test/scanner_platform_fake.dart';
import '../test/support/charge_modes_fixture.dart';

void main() {
  for (final (width, scale) in [(390.0, 1.0), (320.0, 2.0)]) {
    testWidgets('Capture ZIP5 charging at $width px / $scale text', (
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
      final manifest = <Map<String, Object>>[];
      final boundaryKey = GlobalKey();
      final directory =
          'build/previews/stitch-charging-zip5/${width.toInt()}-${scale.toInt()}x';

      Future<void> capture(String name) async {
        FocusManager.instance.primaryFocus?.unfocus();
        await tester.pumpAndSettle();
        final scrollables = find.byWidgetPredicate(
          (widget) =>
              widget is Scrollable &&
              (widget.axisDirection == AxisDirection.down ||
                  widget.axisDirection == AxisDirection.up),
        );
        final scroll = tester.state<ScrollableState>(scrollables.last).position;
        scroll.jumpTo(0);
        await tester.pumpAndSettle();
        for (var page = 1; page <= 24; page++) {
          expect(tester.takeException(), isNull, reason: name);
          final offset = scroll.pixels;
          final boundary =
              boundaryKey.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          final path =
              '$directory/$name-${page.toString().padLeft(2, '0')}.png';
          await tester.runAsync(() async {
            final image = await boundary.toImage();
            expect((image.width, image.height), (width.toInt(), 844));
            final data = await image.toByteData(format: ui.ImageByteFormat.png);
            await File(path).parent.create(recursive: true);
            await File(path).writeAsBytes(data!.buffer.asUint8List());
            image.dispose();
          });
          manifest.add({
            'scenario': name,
            'path': path,
            'scrollOffset': offset,
            'width': width,
            'height': 844,
            'textScale': scale,
          });
          if (scroll.pixels >= scroll.maxScrollExtent - 1) break;
          scroll.jumpTo(
            math.min(
              scroll.pixels + scroll.viewportDimension * .75,
              scroll.maxScrollExtent,
            ),
          );
          await tester.pumpAndSettle();
        }
      }

      Future<ChargeModesFixture> fresh() async {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pumpAndSettle();
        final fixture = ChargeModesFixture();
        await tester.pumpWidget(
          RepaintBoundary(
            key: boundaryKey,
            child: ApiApp(
              config: ApiConfig.parse('https://fixture.invalid/api/driver/v1'),
              httpAdapter: fixture.adapter,
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.runAsync(
          () => precacheImage(
            const AssetImage('assets/brand/powerme-secondary-icon.png'),
            boundaryKey.currentContext!,
          ),
        );
        await enterAccount(tester);
        await tapChargeKey(tester, 'nav-charging');
        camera.emit('powerme:connector:PM-T96/2');
        await tester.pumpAndSettle();
        return fixture;
      }

      for (final mode in ChargingMode.values) {
        final fixture = await fresh();
        await selectChargeMode(tester, mode, switch (mode) {
          ChargingMode.autoFull => '',
          ChargingMode.timed => '30',
          ChargingMode.energy => '10',
          ChargingMode.cost => '100000',
        });
        for (final key in [
          'charge-mode-autoFull',
          'charge-mode-timed',
          'charge-mode-energy',
          'charge-mode-cost',
        ]) {
          expect(
            tester.getSize(find.byKey(Key(key))).height,
            greaterThanOrEqualTo(48),
          );
        }
        await capture('M06-${mode.name}');
        await tapChargeKey(tester, 'qr-submit-start');
        if (mode == ChargingMode.timed) await capture('M07-start-pending');
        fixture.confirmed = true;
        await tester.pump(const Duration(milliseconds: 1500));
        await tester.pumpAndSettle();
        expect(find.byKey(const Key('qr-follow-charge')), findsNothing);
        await capture('M08-${mode.name}');
        if (mode == ChargingMode.timed) {
          await tapChargeKey(tester, 'request-stop-charging');
          await capture('M09-A-confirm-stop');
          await tapChargeKey(tester, 'confirm-stop-charging');
          fixture.progress = chargeModeProgress(mode, 30, status: 'stopping');
          await tester.pump(const Duration(seconds: 5));
          await tester.pumpAndSettle();
          await capture('M09-stop-pending');
          fixture.progress = chargeModeProgress(mode, 30, status: 'closed');
          await tester.pump(const Duration(seconds: 5));
          await tester.pumpAndSettle();
          await capture('M09-final-meter');
          fixture.progress = chargeModeProgress(
            mode,
            30,
            status: 'closed',
            settlement: 'posted',
          );
          await tester.pump(const Duration(seconds: 5));
          await tester.pumpAndSettle();
          await capture('M09-settled');
        }
      }
      for (final mode in [
        ChargingMode.timed,
        ChargingMode.energy,
        ChargingMode.cost,
      ]) {
        final fixture = await fresh();
        fixture.cap = mode == ChargingMode.timed
            ? 15
            : mode == ChargingMode.energy
            ? 5000
            : 50000;
        await selectChargeMode(
          tester,
          mode,
          mode == ChargingMode.timed
              ? '30'
              : mode == ChargingMode.energy
              ? '10'
              : '100000',
        );
        await tapChargeKey(tester, 'qr-submit-start');
        await capture('M07-credit-${mode.name}');
        if (mode == ChargingMode.timed) {
          fixture.cap = 0;
          await tapChargeKey(tester, 'qr-accept-charge-limit');
          await capture('M07-credit-zero');
          expect(find.byKey(const Key('qr-accept-charge-limit')), findsNothing);
        }
      }
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpAndSettle();
      await tester.runAsync(
        () => File(
          '$directory/manifest.json',
        ).writeAsString(const JsonEncoder.withIndent('  ').convert(manifest)),
      );
    });
  }
}

Future<void> _loadFonts() async {
  const fonts = String.fromEnvironment('POWERME_PREVIEW_FONTS');
  expect(fonts, isNotEmpty, reason: 'Pass POWERME_PREVIEW_FONTS from the SDK.');
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
