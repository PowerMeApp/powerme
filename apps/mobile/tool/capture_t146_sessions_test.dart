import 'dart:io';
import 'dart:ui' as ui;
import 'package:driver_app/features/profile/domain/driver_profile.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import '../test/driver_api_fixture.dart';
import '../test/t146_session_fixture.dart';
import '../test/t146_session_widget_test.dart' as journey;

void main() {
  for (final narrow in [false, true]) {
    for (final language in AppLanguage.values) {
      testWidgets('T146 capture narrow=$narrow $language', (tester) async {
        await tester.runAsync(loadFonts);
        await journey.viewport(tester, narrow);
        final fixture = journey.fixtureWith(
          (r) async => switch (r.path) {
            'sessions' when r.queryParameters['view'] == 'active' => reply(
              200,
              ownedPageJson([ownedSessionJson()]),
            ),
            'sessions' => reply(
              200,
              ownedPageJson([
                ownedSessionJson(status: 'closed', stopped: true),
                ownedSessionJson(
                  id: '79',
                  origin: 'app_qr',
                  status: 'closed',
                  stopped: true,
                  statement: true,
                  amount: 45000,
                ),
              ]),
            ),
            'sessions/78/progress' => reply(
              200,
              externalProgress(energy: 2500),
            ),
            _ => throw StateError('Unexpected request'),
          },
          withVehicle: false,
        );
        final boundary = GlobalKey();
        await journey.login(tester, fixture, boundaryKey: boundary);
        journey.localize(journey.container(tester), language);
        await tester.pumpAndSettle();
        await journey.tap(tester, find.byKey(const Key('nav-charging')));
        Future<void> capture(String name) async {
          final position = tester
              .state<ScrollableState>(find.byType(Scrollable).last)
              .position;
          position.jumpTo(0);
          await tester.pumpAndSettle();
          await tester.runAsync(() async {
            final frame =
                await (boundary.currentContext!.findRenderObject()!
                        as RenderRepaintBoundary)
                    .toImage();
            final bytes = await frame.toByteData(
              format: ui.ImageByteFormat.png,
            );
            const output = String.fromEnvironment('T146_CAPTURE_DIR');
            expect(output, isNotEmpty);
            final file = File(
              '$output/${narrow ? '320-2x' : '390-1x'}-${language.name}-$name.png',
            );
            await file.parent.create(recursive: true);
            await file.writeAsBytes(bytes!.buffer.asUint8List());
            frame.dispose();
          });
          expect(tester.takeException(), isNull);
        }

        await capture('rfid-active');
        await journey.tap(tester, find.byKey(const Key('nav-history')));
        await capture('history');
        await tester.pumpWidget(const SizedBox());
      });
    }
  }
}

Future<void> loadFonts() async {
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
