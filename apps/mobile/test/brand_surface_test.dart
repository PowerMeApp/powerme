import 'dart:ui' as ui;

import 'package:driver_app/core/theme/powerme_theme.dart';
import 'package:driver_app/core/widgets/brand_mark.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  for (final surface in [PowerMeColors.black, PowerMeColors.graphite]) {
    testWidgets(
      'Original logos blend black backing into $surface and retain gold/teal',
      (tester) async {
        for (final variant in ['lockup', 'compact', 'service']) {
          final key = GlobalKey();
          await tester.pumpWidget(
            MaterialApp(
              home: Center(
                child: RepaintBoundary(
                  key: key,
                  child: ColoredBox(
                    color: surface,
                    child: SizedBox(
                      width: 300,
                      height: 220,
                      child: Center(
                        child: variant == 'service'
                            ? ChargingMark(size: 120, backgroundColor: surface)
                            : BrandMark(
                                hero: variant == 'lockup',
                                backgroundColor: surface,
                              ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          );
          await tester.runAsync(() async {
            final context = tester.element(find.byType(Image).first);
            for (final image in tester.widgetList<Image>(find.byType(Image))) {
              await precacheImage(image.image, context);
            }
          });
          await tester.pumpAndSettle();
          final boundary =
              key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
          final pixels = await tester.runAsync(() async {
            final image = await boundary.toImage(pixelRatio: 1);
            final data = await image.toByteData(
              format: ui.ImageByteFormat.rawRgba,
            );
            image.dispose();
            return data!.buffer.asUint8List();
          });
          var gold = 0;
          var teal = 0;
          final floor = (surface.r * 255).round() - 1;
          for (var i = 0; i < pixels!.length; i += 4) {
            final r = pixels[i];
            final g = pixels[i + 1];
            final b = pixels[i + 2];
            expect(
              r >= floor && g >= floor && b >= floor,
              isTrue,
              reason: '$variant on $surface has a darker backing pixel',
            );
            if (r > 100 && g > 70 && b < 110) gold++;
            if (r < 60 && g > 80 && b > 70) teal++;
          }
          expect(
            gold,
            greaterThan(20),
            reason: '$variant must retain gold artwork',
          );
          if (variant != 'service') expect(teal, greaterThan(6));
          expect(tester.takeException(), isNull);
        }
      },
    );
  }
}
