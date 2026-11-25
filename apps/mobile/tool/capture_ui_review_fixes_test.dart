import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import '../test/ui_review_fixes_test.dart' show uiReviewCases;

const _selectedFrames = {
  'station-390-vietnamese',
  'active-stop-390-vietnamese',
  'stop-sheet-390-vietnamese',
  'statement-390-vietnamese',
  'credit-ledger-390-vietnamese',
  'points-minimum-keyboard-390-vietnamese',
  'selected-model-390-vietnamese',
  'vehicle-keyboard-save-390-vietnamese',
  'active-stop-320-vietnamese',
  'active-stop-390-english',
  'active-stop-320-english',
  'retry-stop-320-english',
  'points-minimum-keyboard-320-english',
  'selected-model-320-english',
  'vehicle-keyboard-save-320-english',
};

void main() => uiReviewCases(
  beforeMount: (tester) => tester.runAsync(() async {
    const fonts = String.fromEnvironment('POWERME_PREVIEW_FONTS');
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
  }),
  capture: (tester, key, name) async {
    if (!_selectedFrames.contains(name)) return;
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
    final boundary =
        key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    void repaint(RenderObject object) {
      object.visitChildren(repaint);
      object.markNeedsPaint();
    }

    repaint(boundary);
    await tester.pump(const Duration(milliseconds: 16));
    expect(tester.takeException(), isNull);
    await tester.runAsync(() async {
      final frame = await boundary.toImage();
      final bytes = await frame.toByteData(format: ui.ImageByteFormat.png);
      const output = String.fromEnvironment('POWERME_REVIEW_CAPTURE');
      expect(output, isNotEmpty);
      final file = File('$output/$name.png');
      await file.parent.create(recursive: true);
      await file.writeAsBytes(bytes!.buffer.asUint8List());
      frame.dispose();
    });
  },
);
