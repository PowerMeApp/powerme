import 'dart:io';
import 'package:mobile_scanner/mobile_scanner.dart';
import '../test/scanner_platform_fake.dart';
import 'dart:convert';
import 'dart:ui' as ui;

import '../test/support/driver_app_test_harness.dart';
import 'package:driver_app/app/powerme_app.dart';
import 'package:driver_app/app/router.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import '../test/test_helpers.dart';
import 'package:driver_app/features/profile/application/profile_controller.dart';
import 'package:driver_app/features/profile/domain/driver_profile.dart';
import 'package:driver_app/features/stations/application/station_actions_controller.dart';
import 'package:driver_app/features/stations/domain/station_actions.dart';
import 'package:driver_app/features/stations/application/station_route_controller.dart';
import 'package:driver_app/features/charging/application/charging_controller.dart';
import 'package:driver_app/features/payments/application/payments_controller.dart';
import 'package:driver_app/features/support/application/support_controller.dart';

void main() {
  const fonts = String.fromEnvironment('POWERME_PREVIEW_FONTS');
  testWidgets('Capture local demo previews with existing SDK fonts', (
    tester,
  ) async {
    expect(
      fonts,
      isNotEmpty,
      reason: 'Pass POWERME_PREVIEW_FONTS; see README.',
    );
    await tester.runAsync(() async {
      final loader = FontLoader('Roboto');
      for (final weight in ['regular', 'medium', 'bold']) {
        loader.addFont(
          File(
            '$fonts/roboto-$weight.ttf',
          ).readAsBytes().then(ByteData.sublistView),
        );
      }
      await loader.load();
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
    var now = DateTime.utc(2026, 10, 29, 3);
    final boundaryKey = GlobalKey();
    await tester.pumpWidget(
      RepaintBoundary(
        key: boundaryKey,
        child: DriverAppTestHarness(clock: () => now),
      ),
    );
    await tester.pumpAndSettle();
    await tester.runAsync(() async {
      final context = tester.element(find.byType(Image));
      for (final name in [
        'powerme-wordmark',
        'powerme-master-icon',
        'powerme-master-lockup',
        'powerme-secondary-icon',
      ]) {
        await precacheImage(AssetImage('assets/brand/$name.png'), context);
      }
    });
    await tester.pumpAndSettle();

    final captured = <String>[];
    Future<void> capture(String name) async {
      captured.add(name);
      final boundary =
          boundaryKey.currentContext!.findRenderObject()!
              as RenderRepaintBoundary;
      await tester.runAsync(() async {
        final image = await boundary.toImage(pixelRatio: 2);
        final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
        final output = File('build/previews/$name.png');
        await output.parent.create(recursive: true);
        await output.writeAsBytes(bytes!.buffer.asUint8List());
        image.dispose();
      });
    }

    await capture('login-vi');
    final container = ProviderScope.containerOf(
      tester.element(find.byType(PowerMeApp)),
    );
    final router = container.read(routerProvider);
    router.go('/register');
    await tester.pumpAndSettle();
    await capture('onboarding-consent-vi');
    await tester.tap(find.byKey(const Key('consent')));
    await tester.ensureVisible(find.byKey(const Key('onboarding-next')));
    await tester.tap(find.byKey(const Key('onboarding-next')));
    await tester.pumpAndSettle();
    await capture('onboarding-account-vi');
    await tester.enterText(
      find.byKey(const Key('register-name')),
      'Lan Nguyễn',
    );
    await tester.enterText(
      find.byKey(const Key('register-email')),
      'lan@example.test',
    );
    await tester.enterText(
      find.byKey(const Key('register-password')),
      'PowerMe123!',
    );
    final confirmation = find.byKey(const Key('register-confirm-password'));
    await tester.ensureVisible(confirmation);
    await tester.enterText(confirmation, 'PowerMe123!');
    final next = find.byKey(const Key('onboarding-next'));
    await tester.ensureVisible(next);
    await tester.tap(next);
    await tester.pumpAndSettle();
    await capture('onboarding-vehicle-vi');
    router.go('/login');
    await tester.pumpAndSettle();
    await signIn(tester);
    await capture('discovery-vi');
    final camera = ScannerPlatformFake()..deny = true;
    MobileScannerPlatform.instance = camera;
    container.read(routerProvider).go('/scan');
    await tester.pumpAndSettle();
    await capture('qr-connect-vi');
    container.read(routerProvider).go('/');
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      find.byKey(const Key('jump-to-stations')),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(find.byKey(const Key('jump-to-stations')));
    await tester.pumpAndSettle();
    await capture('home-list-vi');
    router.push('/station/station-powerme-center');
    await tester.pumpAndSettle();
    await capture('station-detail-vi');
    await tester.tap(find.byTooltip('Quay lại'));
    await tester.pumpAndSettle();
    final open = find.byKey(const Key('nav-account'));
    await tester.tap(open);
    await tester.pumpAndSettle();
    await capture('account-vi');
    router.push('/profile/edit');
    await tester.pumpAndSettle();
    await capture('profile-edit-vi');
    router.pop();
    await tester.pumpAndSettle();
    router.push('/vehicles/vehicle-ioniq5/edit');
    await tester.pumpAndSettle();
    await capture('vehicle-edit-vi');
    router.pop();
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      find.byKey(const Key('language-english')).hitTestable(),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(find.byKey(const Key('language-english')));
    await tester.pumpAndSettle();
    await capture('account-en');
    container
        .read(profileControllerProvider.notifier)
        .selectLanguage(AppLanguage.vietnamese);
    Future<void> page(String path) async {
      router.go(path);
      await tester.pumpAndSettle();
    }

    Future<void> advance(int seconds) async {
      now = now.add(Duration(seconds: seconds));
      await tester.pump(const Duration(seconds: 2));
      await tester.pumpAndSettle();
    }

    Future<void> bottom(String name) async {
      await tester.drag(find.byType(ListView).first, const Offset(0, -550));
      await tester.pumpAndSettle();
      await capture(name);
    }

    await page('/charging');
    await capture('session-empty-vi');
    // await page('/reserve');
    // await capture('reservation-empty-vi');
    await page('/report?connector=station-powerme-center%2F1');
    await capture('report-vi');
    await container
        .read(supportControllerProvider.notifier)
        .submit('station-powerme-center/1', 'Cáp / đầu nối', '');
    await tester.pumpAndSettle();
    await capture('report-error-vi');
    await container
        .read(supportControllerProvider.notifier)
        .submit(
          'station-powerme-center/1',
          'Cáp / đầu nối',
          'Đầu nối cần kiểm tra trước khi sử dụng.',
        );
    await tester.pumpAndSettle();
    await capture('report-saved-vi');
    // await page('/reserve?connector=station-powerme-center%2F1');
    // await capture('reservation-quote-vi');
    // await container.read(reservationControllerProvider.notifier).confirm();
    // await tester.pumpAndSettle();
    // await capture('reservation-active-vi');
    await page('/suggestions');
    await container
        .read(suggestionControllerProvider.notifier)
        .search(SuggestionMode.fastest, 30, 80);
    await tester.pumpAndSettle();
    await capture('suggestions-vi');
    await bottom('suggestions-results-vi');
    await page('/start?connector=station-powerme-center%2F1');
    await tester.ensureVisible(find.byKey(const Key('check-start')));
    await tester.tap(find.byKey(const Key('check-start')));
    await tester.pumpAndSettle();
    await capture('start-session-vi');
    await bottom('start-confirm-vi');
    final charging = container.read(chargingControllerProvider.notifier);
    await charging.startPrepared();
    await page('/charging');
    await capture('session-pending-vi');
    await advance(20);
    await capture('session-active-vi');
    await bottom('session-active-controls-vi');
    await charging.stopCurrent();
    await advance(1);
    await page('/charging');
    await capture('session-stopping-vi');
    final sessionId = container
        .read(chargingControllerProvider)
        .session!
        .sessionId;
    await advance(1);
    await page('/statement/$sessionId');
    await capture('statement-pending-vi');
    await advance(3);
    container.invalidate(statementProvider(sessionId));
    await tester.pumpAndSettle();
    await capture('statement-vi');
    await bottom('statement-totals-vi');
    await page('/credit');
    await capture('credit-vi');
    await bottom('credit-topup-vi');
    final pay = container.read(paymentsControllerProvider.notifier);
    await pay.create('100000', '500');
    await tester.pumpAndSettle();
    final order = container.read(paymentsControllerProvider).order!;
    await page('/checkout/${order.id}');
    await capture('checkout-pending-vi');
    await pay.checkout(order.id, order.attemptId);
    await advance(8);
    await pay.refresh(orderId: order.id);
    await tester.pumpAndSettle();
    await capture('checkout-posted-vi');
    await page('/history');
    await capture('history-vi');
    await bottom('history-topups-vi');
    await page('/invoice/${order.id}');
    await capture('invoice-vi');
    await page('/loyalty');
    await capture('loyalty-vi');
    await bottom('loyalty-history-vi');
    await page('/');
    container.read(stationRouteControllerProvider.notifier).clear();
    router.go('/charging');
    await tester.pumpAndSettle();
    router.go('/');
    await tester.pumpAndSettle();
    await capture('home-map-vi');
    await tester.tap(find.byKey(const Key('pin-station-powerme-center')));
    await tester.pumpAndSettle();
    await capture('home-map-selected-vi');
    await container
        .read(stationRouteControllerProvider.notifier)
        .preview('station-powerme-center', battery: 30);
    router.go('/charging');
    await tester.pumpAndSettle();
    router.go('/');
    await tester.pumpAndSettle();
    await capture('navigation-route-vi');
    await tester.tap(find.byKey(const Key('expand-map-sheet')));
    await tester.pumpAndSettle();
    await capture('navigation-route-details-vi');
    await page('/suggestions?mode=nearest');
    await container
        .read(suggestionControllerProvider.notifier)
        .search(SuggestionMode.nearest, 30, 80);
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      find
          .byKey(const Key('suggestion-route-station-powerme-center/1'))
          .hitTestable(),
      140,
      scrollable: find.byType(Scrollable).first,
    );
    await capture('suggestions-nearest-vi');
    await tester.runAsync(
      () => File('build/previews/manifest.json').writeAsString(
        jsonEncode({
          'viewport': '390x844',
          'pixelRatio': 2,
          'images': captured.map((n) => '$n.png').toList(),
        }),
      ),
    );
    expect(tester.takeException(), isNull);
  });
}
