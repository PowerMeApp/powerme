import 'dart:io';
import 'dart:ui' as ui;
import '../test/support/driver_app_test_harness.dart';
import 'package:driver_app/app/composition/vietmap_config.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import '../test/test_helpers.dart';

void main() {
  testWidgets(
    'Capture unconfigured Vietmap without replacing existing previews',
    (tester) async {
      await tester.runAsync(() async {
        const fonts = 'E:/MobileDev/Flutter/bin/cache/artifacts/material_fonts';
        final text = FontLoader('Roboto');
        for (final weight in ['regular', 'medium', 'bold']) {
          text.addFont(
            File(
              '$fonts/roboto-$weight.ttf',
            ).readAsBytes().then(ByteData.sublistView),
          );
        }
        await text.load();
        final icons = FontLoader('MaterialIcons')
          ..addFont(
            File(
              '$fonts/materialicons-regular.otf',
            ).readAsBytes().then(ByteData.sublistView),
          );
        await icons.load();
      });
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final key = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: key,
          child: const DriverAppTestHarness(mapConfig: VietmapConfig('')),
        ),
      );
      await tester.pumpAndSettle();
      await signIn(tester);
      await tester.runAsync(() async {
        final context = tester.element(find.byType(Image).first);
        for (final name in ['powerme-master-icon', 'powerme-wordmark']) {
          await precacheImage(AssetImage('assets/brand/$name.png'), context);
        }
      });
      await tester.pumpAndSettle();
      expect(find.text('Chưa thể mở bản đồ.'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.runAsync(() async {
        final boundary =
            key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        final image = await boundary.toImage(pixelRatio: 2);
        final data = await image.toByteData(format: ui.ImageByteFormat.png);
        final file = File('build/previews/vietmap-key-required-vi.png');
        await file.parent.create(recursive: true);
        await file.writeAsBytes(data!.buffer.asUint8List());
        image.dispose();
      });
      await tester.pumpWidget(const SizedBox());
      await tester.pump();
    },
  );
}
