import 'package:dio/dio.dart';
import 'package:driver_app/app/router.dart';
import 'package:driver_app/core/format.dart';
import 'package:driver_app/core/l10n/app_copy.dart';
import 'package:driver_app/core/widgets/app_page.dart';
import 'package:driver_app/features/charging/domain/charging.dart';
import 'package:driver_app/features/charging/presentation/charge_session_readout.dart';
import 'package:driver_app/features/charging/presentation/charge_statement_card.dart';
import 'package:driver_app/features/payments/domain/credit_top_up.dart';
import 'package:driver_app/features/profile/domain/driver_profile.dart';
import 'package:driver_app/features/stations/application/station_discovery_controller.dart';
import 'package:driver_app/features/stations/domain/station.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'driver_api_fixture.dart';
import 'scanner_platform_fake.dart';
import 'support/charge_modes_fixture.dart';
import 'support/ui_consistency_fixture.dart';

void main() {
  test(
    'localized integer money preserves signs, zero, null and legacy default',
    () {
      expect(vnd(32000), '32.000 đ');
      for (final language in AppLanguage.values) {
        final copy = AppCopy(language);
        final amount = copy.text('32.000 đ', '32,000 VND');
        expect(vnd(32000, copy: copy), amount);
        expect(vnd(32000, copy: copy, signed: true), '+$amount');
        expect(vnd(-32000, copy: copy), '−$amount');
        expect(vnd(-32000, copy: copy, signed: true), '−$amount');
        expect(vnd(0, copy: copy, signed: true), copy.text('0 đ', '0 VND'));
        expect(vnd(null, copy: copy), copy.text('Chưa xác định', 'Unknown'));
      }
      for (final maximum in [0, 499, 500, 2500]) {
        expect(validTopUpPoints(0, maximum), isTrue);
        expect(validTopUpPoints(1, maximum), isFalse);
        expect(validTopUpPoints(499, maximum), isFalse);
        expect(validTopUpPoints(500, maximum), maximum >= 500);
        expect(validTopUpPoints(maximum + 1, maximum), isFalse);
      }
    },
  );
  uiReviewCases();
}

void uiReviewCases({
  Future<void> Function(WidgetTester)? beforeMount,
  Future<void> Function(WidgetTester, GlobalKey, String)? capture,
}) {
  for (final (width, scale, language) in [
    (390.0, 1.0, AppLanguage.vietnamese),
    (320.0, 2.0, AppLanguage.vietnamese),
    (390.0, 1.0, AppLanguage.english),
    (320.0, 2.0, AppLanguage.english),
  ]) {
    testWidgets(
      'review fixes actual API routes $width/$scale ${language.name}',
      (tester) async {
        await beforeMount?.call(tester);
        tester.view.physicalSize = Size(width, 844);
        tester.view.devicePixelRatio = 1;
        tester.view.padding = const FakeViewPadding(top: 24, bottom: 24);
        tester.platformDispatcher.textScaleFactorTestValue = scale;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        addTearDown(tester.view.resetPadding);
        addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
        final copy = AppCopy(language);
        final money = copy.text('32.000 đ', '32,000 VND');
        final maximumMoney = copy.text('51.000 đ', '51,000 VND');
        final charging = ChargeModesFixture()..confirmed = true;
        final previous = MobileScannerPlatform.instance;
        final camera = ScannerPlatformFake();
        MobileScannerPlatform.instance = camera;
        addTearDown(() => MobileScannerPlatform.instance = previous);
        final boundary = GlobalKey();
        var lookupCount = 0;
        var writeCount = 0;
        var stops = 0;
        final container = await mountConsistencyApp(
          tester,
          boundaryKey: boundary,
          language: language,
          chargeFixture: charging,
          intercept: (request) async {
            if (request.path == 'me') {
              return reply(
                200,
                account(
                  id: '7',
                  vehicles: [ownVehicle(model: leaf)],
                ),
              );
            }
            if (request.path.startsWith('connectors/')) {
              lookupCount++;
            }
            if (request.path == 'charges' && request.method == 'POST') {
              writeCount++;
            }
            if (request.path == 'sessions/78/stop') {
              stops++;
              throw DioException(
                requestOptions: request,
                type: DioExceptionType.receiveTimeout,
              );
            }
            if (request.path == 'credit') {
              return reply(200, {
                'balance_vnd': 32000,
                'held_vnd': 0,
                'available_vnd': 32000,
                'status': 'active',
              });
            }
            if (request.path == 'credit/transactions') {
              return reply(200, {
                'items': [
                  {
                    'transaction_type': 'top_up',
                    'amount_vnd': 32000,
                    'created_at': '2026-11-19T01:00:00Z',
                    'session_id': null,
                  },
                  {
                    'transaction_type': 'session_debit',
                    'amount_vnd': -32000,
                    'created_at': '2026-11-19T01:00:00Z',
                    'session_id': '78',
                  },
                ],
                'total': 2,
                'page': 1,
                'page_size': 20,
              });
            }
            if (request.path == 'vehicle-models') {
              return reply(200, {
                'items': [
                  leaf,
                  vf8,
                  for (var i = 20; i < 26; i++)
                    {
                      ...leaf,
                      'vehicle_model_id': '$i',
                      'model_name': 'Leaf $i',
                    },
                ],
              });
            }
            return null;
          },
        );
        final router = container.read(routerProvider);
        Future<void> frame(String name) async => capture?.call(
          tester,
          boundary,
          '$name-${width.toInt()}-${language.name}',
        );
        Future<void> reveal(Finder target) async {
          await tester.pumpAndSettle();
          if (target.evaluate().isEmpty) {
            final pageScroll = find
                .descendant(
                  of: find.byType(AppPage),
                  matching: find.byType(Scrollable),
                )
                .first;
            // A lazy target may sit above the retained page position.
            tester.state<ScrollableState>(pageScroll).position.jumpTo(0);
            await tester.pumpAndSettle();
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
        }

        Future<void> tap(String key) async {
          final target = find.byKey(Key(key));
          await reveal(target);
          await tester.tap(target);
          await tester.pumpAndSettle();
        }

        container
            .read(selectedDiscoveryStationProvider.notifier)
            .select(
              const Station(
                id: '31',
                name: 'PowerMe Võ Văn Tần',
                address: null,
                status: StationStatus.unknown,
                quality: DataQuality.stale,
                updatedAt: null,
                availableCount: 0,
                connectors: [],
              ),
            );
        router.go('/station/31');
        await tester.pumpAndSettle();
        await reveal(find.byKey(const Key('station-scan-qr')));
        await frame('station');
        await tap('station-scan-qr');
        expect(router.routeInformationProvider.value.uri.path, '/scan');
        await reveal(find.byKey(const Key('qr-manual-reference')));
        expect(find.byKey(const Key('qr-manual-reference')), findsOneWidget);
        expect(lookupCount, 0);
        expect(writeCount, 0);
        // Restore the camera after checking the manual field below it.
        await reveal(find.byType(MobileScanner));
        expect(find.byType(MobileScanner).hitTestable(), findsOneWidget);
        camera.emit('powerme:connector:PM-T96/2');
        await tester.pumpAndSettle();
        expect(lookupCount, 1);
        expect(writeCount, 0);
        await tap('charge-mode-cost');
        await reveal(find.byKey(const Key('qr-charge-limit')));
        await tester.enterText(
          find.byKey(const Key('qr-charge-limit')),
          '32000',
        );
        await tester.pumpAndSettle();
        await tap('qr-submit-start');
        final stop = find.byKey(const Key('request-stop-charging'));
        expect(stop.hitTestable(), findsOneWidget);
        expect(tester.getSize(stop).height, greaterThanOrEqualTo(48));
        expect(
          tester.getBottomLeft(stop).dy,
          lessThanOrEqualTo(
            tester.getTopLeft(find.byKey(const Key('nav-charging'))).dy,
          ),
        );
        expect(
          find.ancestor(of: stop, matching: find.byType(Scrollable)),
          findsNothing,
        );
        await frame('active-stop');
        await reveal(find.byType(ChargeSessionMetrics));
        expect(find.text(money), findsWidgets);
        expect(find.text(maximumMoney), findsWidgets);
        expect(stop.hitTestable(), findsOneWidget);
        await tester.tap(stop);
        await tester.pumpAndSettle();
        await tester.ensureVisible(
          find.byKey(const Key('confirm-stop-charging')),
        );
        await tester.pumpAndSettle();
        expect(
          find.byKey(const Key('confirm-stop-charging')).hitTestable(),
          findsOneWidget,
        );
        await frame('stop-sheet');
        await tap('continue-charging');
        expect(stops, 0);
        await tester.tap(stop);
        await tester.pumpAndSettle();
        await tap('confirm-stop-charging');
        final retry = find.byKey(const Key('retry-stop-charging'));
        expect(retry.hitTestable(), findsOneWidget);
        expect(tester.getSize(retry).height, greaterThanOrEqualTo(48));
        await frame('retry-stop');
        charging.progress = chargeModeProgress(
          ChargingMode.cost,
          32000,
          status: 'closed',
          settlement: 'posted',
        );
        await tester.pump(const Duration(seconds: 5));
        await tester.pumpAndSettle();
        expect(stop, findsNothing);
        expect(retry, findsNothing);
        await reveal(find.byType(ChargeStatementCard));
        expect(find.text(money), findsWidgets);
        await frame('statement');
        router.go('/profile');
        await tester.pumpAndSettle();
        expect(find.text(money), findsWidgets);
        router.go('/credit');
        await tester.pumpAndSettle();
        expect(find.text(money), findsWidgets);
        await reveal(find.text('+$money'));
        expect(find.text('−$money'), findsWidgets);
        await frame('credit-ledger');
        router.go('/credit/top-up');
        await tester.pumpAndSettle();
        expect(find.text(money), findsWidgets);
        await tap('top-up-preset-50000');
        await tester.pump(const Duration(milliseconds: 400));
        await tester.pumpAndSettle();
        final points = find.byKey(const Key('top-up-points'));
        await reveal(points);
        await tester.enterText(points, '499');
        await tester.pumpAndSettle();
        await tester.showKeyboard(points);
        tester.view.viewInsets = const FakeViewPadding(bottom: 240);
        addTearDown(tester.view.resetViewInsets);
        await reveal(points);
        await frame('points-minimum-keyboard');
        tester.view.resetViewInsets();
        FocusManager.instance.primaryFocus?.unfocus();
        await tester.pumpAndSettle();
        router.go('/vehicles/new');
        await tester.pumpAndSettle();
        await tap('vehicle-model-${leaf['vehicle_model_id']}');
        expect(find.byKey(const Key('vehicle-model-search')), findsNothing);
        expect(find.byKey(const Key('vehicle-model-25')), findsNothing);
        final plate = find.byKey(const Key('vehicle-plate'));
        await reveal(plate);
        await tester.enterText(plate, '30A-123.45');
        await tap('vehicle-make-default');
        await tap('change-vehicle-model');
        await tap('cancel-vehicle-model-change');
        expect(find.byKey(const Key('vehicle-model-search')), findsNothing);
        await tap('change-vehicle-model');
        await tap('vehicle-model-${vf8['vehicle_model_id']}');
        expect(find.byKey(const Key('vehicle-model-search')), findsNothing);
        expect(
          tester.widget<TextFormField>(plate).controller!.text,
          '30A-123.45',
        );
        expect(
          tester
              .widget<CheckboxListTile>(
                find.byKey(const Key('vehicle-make-default')),
              )
              .value,
          isTrue,
        );
        await reveal(find.byKey(const Key('change-vehicle-model')));
        await frame('selected-model');
        await reveal(plate);
        await tester.showKeyboard(plate);
        tester.view.viewInsets = const FakeViewPadding(bottom: 240);
        addTearDown(tester.view.resetViewInsets);
        await reveal(find.byKey(const Key('vehicle-save')));
        expect(
          find.byKey(const Key('vehicle-save')).hitTestable(),
          findsOneWidget,
        );
        await frame('vehicle-keyboard-save');
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pumpAndSettle();
      },
    );
  }
}
