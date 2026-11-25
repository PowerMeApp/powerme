import 'package:driver_app/app/router.dart';
import 'package:driver_app/core/format.dart';
import 'package:driver_app/core/l10n/app_copy.dart';
import 'package:driver_app/core/theme/powerme_theme.dart';
import 'package:driver_app/core/widgets/app_page.dart';
import 'package:driver_app/core/widgets/visual_components.dart';
import 'package:driver_app/features/charging/domain/charge_session.dart';
import 'package:driver_app/features/charging/domain/charging.dart';
import 'package:driver_app/features/charging/presentation/charge_mode_widgets.dart';
import 'package:driver_app/features/charging/presentation/charge_session_readout.dart';
import 'package:driver_app/features/profile/domain/driver_profile.dart';
import 'package:driver_app/features/stations/presentation/road_format.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'scanner_platform_fake.dart';

import 'support/ui_consistency_fixture.dart';

void main() {
  for (final language in AppLanguage.values) {
    final copy = AppCopy(language);
    test(
      'estimated minutes use ceiling and preserve unknowns: ${language.name}',
      () {
        for (final (value, expected) in [
          (0, 0),
          (.00001, 1),
          (1, 1),
          (1.000001, 2),
          (16.123456789, 17),
        ]) {
          expect(
            estimatedMinutes(value, copy),
            copy.text('$expected phút', '$expected min'),
          );
        }
        for (final value in [
          null,
          -1,
          double.nan,
          double.infinity,
          double.negativeInfinity,
        ]) {
          expect(
            estimatedMinutes(value, copy),
            copy.text('Chưa xác định', 'Unknown'),
          );
        }
        expect(roadTravelTime(0, copy), copy.text('0 phút', '0 min'));
        expect(roadTravelTime(60, copy), copy.text('1 phút', '1 min'));
        expect(roadTravelTime(61, copy), copy.text('2 phút', '2 min'));
      },
    );
  }
  test('measured charging clock retains seconds', () {
    expect(chargeElapsedLabel(null), '—');
    expect(chargeElapsedLabel(0), '00:00:00');
    expect(chargeElapsedLabel(59), '00:00:59');
    expect(chargeElapsedLabel(3671), '01:01:11');
    expect(chargeElapsedLabel(360071), '100:01:11');
  });

  for (final (width, scale) in [(390.0, 1.0), (320.0, 2.0)]) {
    for (final language in AppLanguage.values) {
      final copy = AppCopy(language);
      testWidgets(
        'comparable cells and actions $width/$scale ${language.name}',
        (tester) async {
          await tester.binding.setSurfaceSize(Size(width, 1500));
          addTearDown(() => tester.binding.setSurfaceSize(null));
          Future<void> mount(Widget child) => tester.pumpWidget(
            MaterialApp(
              theme: powerMeTheme(),
              home: MediaQuery(
                data: MediaQueryData(
                  size: Size(width, 1500),
                  textScaler: TextScaler.linear(scale),
                ),
                child: Scaffold(
                  body: SingleChildScrollView(
                    padding: const EdgeInsets.all(20),
                    child: child,
                  ),
                ),
              ),
            ),
          );
          List<Size> cells() {
            final layout = tester.widget<EqualHeightRows>(
              find.byType(EqualHeightRows).first,
            );
            return [
              for (final child in layout.children)
                tester.getSize(find.byWidget(child)),
            ];
          }

          await mount(
            MetricGrid(
              items: [
                MetricItem(
                  copy.text('Chờ ước tính', 'Estimated wait'),
                  '6 min',
                  Icons.schedule,
                ),
                MetricItem(
                  copy.text('Chi phí tối đa ước tính', 'Estimated upper cost'),
                  'Chưa xác định\nAwaiting update',
                  Icons.payments,
                ),
                MetricItem(
                  copy.text('Sạc ước tính', 'Estimated charging'),
                  '17 min',
                  Icons.bolt,
                ),
              ],
            ),
          );
          final metrics = cells();
          if (scale == 1) {
            expect(metrics[0], metrics[1]);
            expect(metrics[2].width, closeTo(width - 40, .01));
          } else {
            expect(metrics.every((s) => s.width == width - 40), isTrue);
          }
          var taps = 0;
          await mount(
            QuickActions(
              actions: [
                QuickAction(
                  copy.text('Gợi ý', 'Suggestions'),
                  Icons.bolt,
                  () => taps++,
                ),
                QuickAction(
                  copy.text(
                    'Thông tin trạm và cổng sạc',
                    'Station and connector information',
                  ),
                  Icons.ev_station,
                  () => taps++,
                  key: const Key('long-action'),
                ),
              ],
            ),
          );
          final actions = cells();
          if (scale == 1) expect(actions[0], actions[1]);
          expect(actions.every((s) => s.height >= 48), isTrue);
          await tester.ensureVisible(find.byKey(const Key('long-action')));
          await tester.tap(find.byKey(const Key('long-action')));
          expect(taps, 1);
          ChargingMode? selected;
          await mount(
            ChargeModeChoices(
              copy: copy,
              selected: ChargingMode.energy,
              onChanged: (mode) => selected = mode,
            ),
          );
          final modes = [
            for (final mode in ChargingMode.values)
              tester.getSize(find.byKey(Key('charge-mode-${mode.name}'))),
          ];
          if (scale == 1) {
            expect(
              modes.toSet(),
              hasLength(1),
              reason: 'All four cards in the 2×2 group must match.',
            );
          }
          expect(modes.every((s) => s.height >= 48), isTrue);
          for (final mode in ChargingMode.values) {
            final target = find.byKey(Key('charge-mode-${mode.name}'));
            await tester.ensureVisible(target);
            await tester.tap(target);
            expect(selected, mode);
          }
          await mount(
            ChargeSessionMetrics(
              copy: copy,
              progress: ChargeProgress(
                status: SessionState.active,
                settlement: SettlementState.pending,
                connection: ConnectionState.online,
                quality: DataQuality.observed,
                updatedAt: DateTime.utc(2026, 11, 23),
                limitValue: 10000,
                billingMode: ChargingMode.energy,
                elapsedSeconds: 3671,
                consumedWh: 10230,
                meterStopWh: null,
                energyWh: null,
                estimatedCostVnd: null,
                costEstimateVnd: 32000,
                billingReviewRequired: false,
              ),
              includeEnergy: true,
            ),
          );
          final charge = cells();
          if (scale == 1) expect(charge.toSet(), hasLength(1));
          expect(find.text('01:01:11'), findsOneWidget);
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'API suggestions and top-up presentation $width/$scale ${language.name}',
        (tester) async {
          await tester.binding.setSurfaceSize(Size(width, 844));
          tester.platformDispatcher.textScaleFactorTestValue = scale;
          addTearDown(() => tester.binding.setSurfaceSize(null));
          addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
          final previousCamera = MobileScannerPlatform.instance;
          final camera = ScannerPlatformFake();
          MobileScannerPlatform.instance = camera;
          addTearDown(() => MobileScannerPlatform.instance = previousCamera);
          final container = await mountConsistencyApp(
            tester,
            boundaryKey: GlobalKey(),
            language: language,
          );
          Finder scrollable() => find
              .descendant(
                of: find.byType(AppPage),
                matching: find.byType(Scrollable),
              )
              .first;
          Future<void> reveal(Finder target) async {
            if (target.evaluate().isEmpty) {
              await tester.scrollUntilVisible(
                target,
                180,
                scrollable: scrollable(),
              );
            }
            await tester.ensureVisible(target);
            await tester.pump();
          }

          final submit = find.byKey(const Key('submit-smart-search'));
          await reveal(find.byKey(const Key('suggestion-soc')));
          await tester.enterText(find.byKey(const Key('suggestion-soc')), '30');
          await reveal(submit);
          await tester.tap(submit);
          await tester.pumpAndSettle();
          await reveal(find.byType(MetricGrid));
          expect(find.text(copy.text('6 phút', '6 min')), findsOneWidget);
          expect(find.text(copy.text('17 phút', '17 min')), findsOneWidget);
          expect(find.textContaining('16.123456789'), findsNothing);
          container.read(routerProvider).go('/scan');
          await tester.pumpAndSettle();
          camera.emit('powerme:connector:PM-T96/2');
          await tester.pumpAndSettle();
          final chargePresets = [
            for (final value in ['10', '20', '35', '50'])
              find.byKey(Key('charge-preset-$value')),
          ];
          await reveal(chargePresets.first);
          final chargeSizes = chargePresets.map(tester.getSize).toList();
          expect(chargeSizes.toSet(), hasLength(1));
          expect(chargeSizes.every((s) => s.height >= 48), isTrue);
          if (scale == 1) {
            for (final button in chargePresets) {
              final label = find.descendant(
                of: button,
                matching: find.byType(Text),
              );
              final text = tester.widget<Text>(label).data!;
              final paragraph = tester.renderObject<RenderParagraph>(label);
              final lines = paragraph
                  .getBoxesForSelection(
                    TextSelection(baseOffset: 0, extentOffset: text.length),
                  )
                  .map((box) => box.top)
                  .toSet();
              expect(
                lines,
                hasLength(1),
                reason: '$text must keep its amount and unit together.',
              );
            }
          }
          await reveal(chargePresets.last);
          await tester.tap(chargePresets.last);
          await tester.pump();
          expect(
            tester
                .widget<TextFormField>(
                  find.byKey(const Key('qr-charge-energy')),
                )
                .controller!
                .text,
            '50',
          );
          container.read(routerProvider).go('/credit/top-up');
          await tester.pumpAndSettle();
          final presets = [
            for (final value in [50000, 100000, 200000, 500000])
              find.byKey(Key('top-up-preset-$value')),
          ];
          await reveal(presets.first);
          final sizes = presets.map(tester.getSize).toList();
          if (scale == 1) {
            expect(sizes.toSet(), hasLength(1));
          } else {
            expect(sizes.map((s) => s.width).toSet(), hasLength(1));
          }
          expect(sizes.every((s) => s.height >= 48), isTrue);
          await reveal(presets[1]);
          await tester.tap(presets[1]);
          await tester.pumpAndSettle();
          final input = tester.widget<TextField>(
            find.byKey(const Key('top-up-amount')),
          );
          expect(input.controller!.text, '100000');
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox.shrink());
          await tester.pumpAndSettle();
        },
      );
    }
  }
}
