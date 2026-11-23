import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:dio/dio.dart';
import 'package:driver_app/features/profile/domain/driver_profile.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../test/driver_api_fixture.dart';
import '../test/driver_loyalty_test.dart' show openLocalizedLoyalty;
import '../test/support/loyalty_api_fixture.dart';

void main() {
  for (final (width, scale) in [(390.0, 1.0), (320.0, 2.0)]) {
    for (final language in AppLanguage.values) {
      testWidgets('Capture loyalty $width/$scale ${language.name}', (
        tester,
      ) async {
        final previousHitTestPolicy =
            WidgetController.hitTestWarningShouldBeFatal;
        WidgetController.hitTestWarningShouldBeFatal = true;
        addTearDown(
          () => WidgetController.hitTestWarningShouldBeFatal =
              previousHitTestPolicy,
        );
        await tester.runAsync(_loadFonts);
        tester.view.physicalSize = Size(width, 844);
        tester.view.devicePixelRatio = 1;
        tester.view.padding = const FakeViewPadding(top: 24, bottom: 24);
        tester.platformDispatcher.textScaleFactorTestValue = scale;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        addTearDown(tester.view.resetPadding);
        addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
        final boundaryKey = GlobalKey();
        final manifest = <Map<String, Object>>[];
        const output = String.fromEnvironment(
          'POWERME_LOYALTY_CAPTURE',
          defaultValue: 'build/previews/t145-loyalty',
        );
        final directory =
            '$output/${width.toInt()}-${scale.toInt()}x-${language.name}';
        var scenario = 'available';
        var quoteReads = 0;
        final loading = Completer<ResponseBody>();
        final fixture = loyaltyFixture(
          quote: (_) async {
            quoteReads++;
            if (scenario == 'loading') return loading.future;
            if (scenario == 'error') {
              return reply(503, {'error': 'unavailable'});
            }
            return reply(
              200,
              loyaltyQuote(
                available: scenario == 'zero' ? 0 : 6000,
                maximum: scenario == 'zero' ? 0 : 2500,
                discount: scenario == 'zero' ? 0 : 25000,
              ),
            );
          },
        );
        await openLocalizedLoyalty(
          tester,
          fixture,
          language: language,
          wrap: (app) => RepaintBoundary(key: boundaryKey, child: app),
        );
        await tester.runAsync(() async {
          await precacheImage(
            const AssetImage('assets/brand/powerme-secondary-icon.png'),
            boundaryKey.currentContext!,
          );
        });

        Future<void> capture(String name, {bool busy = false}) async {
          FocusManager.instance.primaryFocus?.unfocus();
          if (busy) {
            await tester.pump(const Duration(milliseconds: 100));
          } else {
            await tester.pumpAndSettle();
          }
          final scroll = tester
              .state<ScrollableState>(find.byType(Scrollable).last)
              .position;
          scroll.jumpTo(0);
          await tester.pump();
          for (var page = 1; page <= 12; page++) {
            expect(tester.takeException(), null, reason: name);
            final offset = scroll.pixels;
            final boundary =
                boundaryKey.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary;
            final path =
                '$directory/$name-${page.toString().padLeft(2, '0')}.png';
            await tester.runAsync(() async {
              final image = await boundary.toImage();
              final bytes = await image.toByteData(
                format: ui.ImageByteFormat.png,
              );
              await File(path).parent.create(recursive: true);
              await File(path).writeAsBytes(bytes!.buffer.asUint8List());
              image.dispose();
            });
            manifest.add({
              'scenario': name,
              'path': path,
              'scrollOffset': offset,
              'width': width,
              'height': 844,
              'textScale': scale,
              'language': language.name,
            });
            if (scroll.pixels >= scroll.maxScrollExtent - 1) break;
            scroll.jumpTo(
              math.min(
                scroll.pixels + scroll.viewportDimension * .75,
                scroll.maxScrollExtent,
              ),
            );
            await tester.pump(const Duration(milliseconds: 100));
          }
        }

        await capture('available');
        for (final next in ['zero', 'error', 'loading']) {
          scenario = next;
          await tester.ensureVisible(find.byKey(const Key('loyalty-refresh')));
          await tester.pumpAndSettle();
          await tester.tap(find.byKey(const Key('loyalty-refresh')));
          await tester.pump();
          await capture(next, busy: next == 'loading');
          expect(find.text('6000'), findsNothing);
          if (next == 'zero') expect(find.text('0'), findsOneWidget);
          if (next == 'error') {
            expect(
              find.textContaining(
                language == AppLanguage.english
                    ? 'Could not load'
                    : 'Chưa tải được điểm',
              ),
              findsOneWidget,
            );
          }
          if (next == 'loading') {
            expect(find.byType(LinearProgressIndicator), findsOneWidget);
          }
        }
        expect(
          fixture.requests.where(
            (r) => r.method != 'GET' && r.path != 'auth/login',
          ),
          isEmpty,
        );
        expect(quoteReads, 4);
        loading.complete(reply(200, loyaltyQuote()));
        await tester.pumpAndSettle();
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
