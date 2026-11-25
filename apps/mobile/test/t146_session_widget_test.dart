import 'dart:async';
import 'package:dio/dio.dart';
import 'package:driver_app/app/composition/api_app.dart';
import 'package:driver_app/app/router.dart';
import 'package:driver_app/core/api/api_config.dart';
import 'package:driver_app/features/auth/application/auth_controller.dart';
import 'package:driver_app/features/charging/application/charge_session_controller.dart';
import 'package:driver_app/features/charging/application/charge_start_controller.dart';
import 'package:driver_app/features/charging/presentation/owned_session_card.dart';
import 'package:driver_app/features/profile/application/profile_controller.dart';
import 'package:driver_app/features/profile/domain/driver_profile.dart';
import 'package:driver_app/features/stations/application/connector_lookup_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'driver_api_fixture.dart';
import 'driver_api_widget_test.dart' show enterAccount;
import 'driver_discovery_fixture.dart' show page;
import 'scanner_platform_fake.dart';
import 't146_session_fixture.dart';

void main() {
  for (final language in AppLanguage.values) {
    for (final narrow in [false, true]) {
      testWidgets(
        'RFID no-vehicle discovery, energy and physical stop: $language narrow=$narrow',
        (tester) async {
          await viewport(tester, narrow);
          var snapshot = externalProgress();
          final fixture = fixtureWith(
            (r) async => switch (r.path) {
              'sessions' => reply(200, ownedPageJson([ownedSessionJson()])),
              'sessions/78/progress' => reply(200, snapshot),
              _ => throw StateError('Unexpected ${r.method} ${r.path}'),
            },
            withVehicle: false,
          );
          await login(tester, fixture);
          final c = container(tester);
          localize(c, language);
          await tester.pumpAndSettle();
          expect(count(fixture, 'sessions'), 0);
          await tap(tester, find.byKey(const Key('nav-charging')));
          expect(path(tester), '/charge-session');
          expect(c.read(chargeStartProvider), isNull);
          expect(
            c.read(selectedChargeSessionProvider)!.summary.vehicleId,
            isNull,
          );
          expect(find.byKey(const Key('request-stop-charging')), findsNothing);
          expect(find.byKey(const Key('retry-stop-charging')), findsNothing);
          await reveal(
            tester,
            find.text(
              language == AppLanguage.vietnamese
                  ? 'Dừng phiên tại trụ'
                  : 'Stop the session at the charger',
            ),
          );
          await reveal(
            tester,
            find.text(
              language == AppLanguage.vietnamese
                  ? 'Chưa rõ xe'
                  : 'Unknown vehicle',
            ),
          );
          // RFID không trừ Charging Credit: tạm tính của CSMS không được hiện như tiền phải trả.
          snapshot = externalProgress(energy: 1800, costEstimate: 45000);
          await tick(tester);
          final notBilled = find.text(
            language == AppLanguage.vietnamese
                ? 'Không tính qua app'
                : 'Not billed in app',
            skipOffstage: false,
          );
          final list = find.byType(Scrollable).last;
          tester.state<ScrollableState>(list).position.jumpTo(0);
          await tester.pump();
          for (var i = 0; i < 40 && notBilled.evaluate().isEmpty; i++) {
            await tester.drag(list, const Offset(0, -250));
            await tester.pump();
          }
          expect(notBilled, findsWidgets);
          expect(find.textContaining('45', skipOffstage: false), findsNothing);
          snapshot = externalProgress(energy: 2500);
          await tick(tester);
          await reveal(
            tester,
            find.text(
              language == AppLanguage.vietnamese ? '2,5 kWh' : '2.5 kWh',
            ),
          );
          snapshot = externalProgress(
            status: 'closed',
            closed: true,
            energy: 2500,
          );
          await tick(tester);
          await reveal(
            tester,
            find.text(
              language == AppLanguage.vietnamese
                  ? 'Bảng kê chưa có.'
                  : 'The statement is not available yet.',
            ),
          );
          expect(
            find.text(
              language == AppLanguage.vietnamese
                  ? 'Tín dụng đã trừ'
                  : 'Credit debited',
            ),
            findsNothing,
          );
          final reads = count(fixture, 'sessions/78/progress');
          await tick(tester, const Duration(seconds: 20));
          expect(count(fixture, 'sessions/78/progress'), reads);
          expect(count(fixture, 'sessions/78/statement'), 0);
          expect(
            fixture.requests
                .where((r) => r.method == 'POST')
                .map((r) => r.path),
            ['auth/login'],
          );
          expect(tester.takeException(), isNull);
          await tap(
            tester,
            find.byKey(const Key('charge-session-return-to-scan')),
          );
          expect(path(tester), '/scan');
          await tester.pumpAndSettle();
          expect(path(tester), '/scan');
          expect(c.read(selectedChargeSessionProvider), isNull);
          await reveal(
            tester,
            find.text(
              language == AppLanguage.vietnamese ? 'Thêm xe' : 'Add vehicle',
            ),
          );
          await tester.pumpWidget(const SizedBox());
        },
      );
    }
  }
  testWidgets(
    'external legacy progress has no stop or statement capability fallback',
    (tester) async {
      var snapshot = externalProgress(
        status: 'closed',
        closed: true,
        statement: true,
      );
      for (final key in [
        'origin',
        'payment_mode',
        'can_stop',
        'statement_available',
      ]) {
        snapshot.remove(key);
      }
      final fixture = fixtureWith(
        (r) async => switch (r.path) {
          'sessions' => reply(200, ownedPageJson([ownedSessionJson()])),
          'sessions/78/progress' => reply(200, snapshot),
          _ => throw StateError('Unexpected ${r.method} ${r.path}'),
        },
        withVehicle: false,
      );
      await login(tester, fixture);
      await tap(tester, find.byKey(const Key('nav-charging')));
      expect(path(tester), '/charge-session');
      await reveal(tester, find.text('Bảng kê chưa có.'));
      expect(find.byKey(const Key('request-stop-charging')), findsNothing);
      expect(find.byKey(const Key('retry-stop-charging')), findsNothing);
      expect(find.text('Bảng kê phiên sạc'), findsNothing);
      expect(count(fixture, 'sessions/78/statement'), 0);
      final before = count(fixture, 'sessions/78/progress');
      await tick(tester, const Duration(seconds: 20));
      expect(count(fixture, 'sessions/78/progress'), before);
      await tester.pumpWidget(const SizedBox());
      snapshot = {...snapshot, 'settlement_state': 'pending'};
      await login(tester, fixture);
      await tap(tester, find.byKey(const Key('nav-charging')));
      final pendingReads = count(fixture, 'sessions/78/progress');
      await tick(tester, const Duration(seconds: 20));
      expect(count(fixture, 'sessions/78/progress'), pendingReads);
      expect(count(fixture, 'sessions/78/statement'), 0);
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets(
    'empty discovery polls only foreground Scan and cancels on leaving/resume',
    (tester) async {
      final blocked = Completer<ResponseBody>();
      var reads = 0;
      final fixture = fixtureWith((r) async {
        if (r.path != 'sessions') throw StateError('Unexpected request');
        return ++reads == 2 ? blocked.future : reply(200, ownedPageJson([]));
      });
      await login(tester, fixture);
      await tap(tester, find.byKey(const Key('nav-charging')));
      expect(reads, 1);
      await tick(tester);
      expect(reads, 2);
      final pending = fixture.requests.lastWhere((r) => r.path == 'sessions');
      await tick(tester, const Duration(seconds: 20));
      expect(reads, 2);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tick(tester, const Duration(seconds: 20));
      expect(reads, 2);
      expect(pending.cancelToken!.isCancelled, true);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(reads, 3);
      blocked.complete(reply(200, ownedPageJson([ownedSessionJson()])));
      await tester.pumpAndSettle();
      expect(path(tester), '/scan');
      await tap(tester, find.byKey(const Key('nav-account')));
      final before = reads;
      await tick(tester, const Duration(seconds: 20));
      expect(reads, before);
      await tap(tester, find.byKey(const Key('nav-charging')));
      expect(reads, before + 1);
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets(
    'multiple active pages require explicit choice and suspend camera',
    (tester) async {
      final fixture = fixtureWith(
        (r) async => switch (r.path) {
          'sessions' => reply(
            200,
            ownedPageJson(
              r.queryParameters['page'] == 1
                  ? List.generate(20, (i) => ownedSessionJson(id: '${100 + i}'))
                  : [ownedSessionJson()],
              total: 21,
              page: r.queryParameters['page'] as int,
            ),
          ),
          'sessions/78/progress' => reply(200, externalProgress()),
          _ => throw StateError('Unexpected request'),
        },
      );
      final camera = await login(tester, fixture);
      await tap(tester, find.byKey(const Key('nav-charging')));
      expect(path(tester), '/scan');
      expect(container(tester).read(confirmedChargeSessionProvider), isNull);
      await tap(tester, find.text('Trang sau'));
      expect(path(tester), '/scan');
      expect(
        fixture.requests
            .lastWhere((r) => r.path == 'sessions')
            .queryParameters['page'],
        2,
      );
      await tap(tester, find.byKey(const Key('open-owned-session-78')));
      expect(path(tester), '/charge-session');
      expect(camera.stops, greaterThanOrEqualTo(camera.starts));
      expect(
        fixture.requests.where((r) => r.method == 'POST').map((r) => r.path),
        ['auth/login'],
      );
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets('late discovery never replaces manual editing or a QR lookup', (
    tester,
  ) async {
    final late = Completer<ResponseBody>();
    final lookup = Completer<ResponseBody>();
    final fixture = fixtureWith(
      (r) async => switch (r.path) {
        'sessions' => late.future,
        'connectors/by-code/PM-T146/2' => lookup.future,
        _ => throw StateError('Unexpected ${r.path}'),
      },
    );
    final camera = await login(tester, fixture);
    await tap(tester, find.byKey(const Key('nav-charging')));
    final field = find.byKey(const Key('qr-manual-reference'));
    await reveal(tester, field);
    await tester.enterText(field, 'PM-T146/2');
    late.complete(reply(200, ownedPageJson([ownedSessionJson()])));
    await tester.pumpAndSettle();
    expect(path(tester), '/scan');
    expect(container(tester).read(selectedChargeSessionProvider), isNull);
    await tester.enterText(field, '');
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pumpAndSettle();
    camera.emit('powerme:connector:PM-T146/2');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(container(tester).read(connectorLookupProvider).busy, true);
    expect(path(tester), '/scan');
    lookup.complete(
      reply(200, {
        'connector_id': '31',
        'display_code': 'PM-T146',
        'connector_no': 2,
        'site_name': 'Trạm QR',
        'is_online': true,
        'status': 'Preparing',
        'reported_issue': false,
      }),
    );
    await tester.pumpAndSettle();
    expect(path(tester), '/scan');
    expect(
      container(tester).read(connectorLookupProvider).connector!.stationName,
      'Trạm QR',
    );
    expect(container(tester).read(selectedChargeSessionProvider), isNull);
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets(
    'history active/review/missing stop cannot open a final statement; settled RFID can',
    (tester) async {
      var row = ownedSessionJson(statement: true, amount: 0);
      var snapshot = externalProgress(
        status: 'closed',
        closed: true,
        statement: true,
      );
      final fixture = fixtureWith(
        (r) async => switch (r.path) {
          'sessions' => reply(200, ownedPageJson([row])),
          'sessions/78/progress' => reply(200, snapshot),
          'sessions/78/statement' => reply(200, {
            'session_id': '78',
            'driver_id': '7',
            'energy_wh': 1200,
            'amount_vnd': 0,
            'earned_points': 0,
            'created_at': '2026-11-24T02:00:00Z',
          }),
          _ => throw StateError('Unexpected ${r.method} ${r.path}'),
        },
      );
      await login(tester, fixture);
      await tap(tester, find.byKey(const Key('nav-history')));
      expect(find.text('Xem bảng kê'), findsNothing);
      for (final next in [
        ownedSessionJson(status: 'review', stopped: true, statement: true),
        ownedSessionJson(status: 'closed', statement: true),
      ]) {
        row = next;
        await tap(tester, find.text('Tải lại lịch sử'));
        expect(find.text('Xem bảng kê'), findsNothing);
      }
      row = ownedSessionJson(
        status: 'closed',
        stopped: true,
        statement: true,
        amount: 0,
      );
      await tap(tester, find.text('Tải lại lịch sử'));
      await tap(tester, find.text('Xem bảng kê'));
      expect(count(fixture, 'sessions/78/statement'), 1);
      expect(find.text('Tín dụng đã trừ'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(BottomSheet),
          matching: find.text('0 đ'),
        ),
        findsOneWidget,
      );
      await tap(tester, find.byTooltip('Đóng bảng kê'));
      await tap(tester, find.byKey(const Key('open-owned-session-78')));
      expect(path(tester), '/charge-session');
      await reveal(tester, find.text('Tín dụng đã trừ'));
      expect(count(fixture, 'sessions/78/statement'), 2);
      expect(find.byKey(const Key('request-stop-charging')), findsNothing);
      final reads = count(fixture, 'sessions/78/progress');
      await tick(tester, const Duration(seconds: 15));
      expect(count(fixture, 'sessions/78/progress'), reads);
      snapshot = externalProgress(
        status: 'review',
        closed: true,
        statement: true,
      );
      expect(
        fixture.requests.where((r) => r.path == 'credit/transactions'),
        isEmpty,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets(
    'history error/retry, null and zero amounts, narrow localized cards',
    (tester) async {
      await viewport(tester, true);
      var failed = true;
      final fixture = fixtureWith(
        (r) async => switch (r.path) {
          'sessions' when failed => reply(503, {'error': 'unavailable'}),
          'sessions' => reply(
            200,
            ownedPageJson([
              ownedSessionJson(status: 'closed', stopped: true),
              ownedSessionJson(
                id: '79',
                status: 'closed',
                stopped: true,
                statement: true,
                amount: 0,
              ),
            ]),
          ),
          _ => throw StateError('Unexpected ${r.path}'),
        },
      );
      await login(tester, fixture);
      await tap(tester, find.byKey(const Key('nav-history')));
      expect(find.text('Chưa tải được lịch sử sạc.'), findsOneWidget);
      failed = false;
      await tap(tester, find.text('Thử lại'));
      await reveal(tester, find.text('Chưa có số tiền bảng kê'));
      await reveal(tester, find.text('0 đ'));
      final cards = find.byType(OwnedSessionCard);
      expect(cards, findsWidgets);
      for (final language in AppLanguage.values) {
        localize(container(tester), language);
        await tester.pumpAndSettle();
        final action = find.byKey(const Key('open-owned-session-79'));
        await reveal(tester, action);
        expect(tester.getSize(action).height, greaterThanOrEqualTo(48));
        expect(tester.takeException(), isNull);
      }
      expect(
        fixture.requests.where((r) => r.path == 'credit/transactions'),
        isEmpty,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets(
    'logout cancels pending history and queued A response never appears for B',
    (tester) async {
      final late = Completer<ResponseBody>();
      var driver = '7';
      final fixture = fixtureWith(
        (r) async => switch (r.path) {
          'me' => reply(200, account(id: driver)),
          'sessions' when driver == '7' => late.future,
          'sessions' => reply(200, ownedPageJson([])),
          _ => throw StateError('Unexpected ${r.path}'),
        },
        overrideMe: true,
      );
      await login(tester, fixture);
      await tap(tester, find.byKey(const Key('nav-history')));
      final request = fixture.requests.lastWhere((r) => r.path == 'sessions');
      container(tester).read(authControllerProvider.notifier).signOut();
      await tester.pumpAndSettle();
      expect(request.cancelToken!.isCancelled, true);
      driver = '8';
      await enterAccount(tester);
      late.complete(reply(200, ownedPageJson([ownedSessionJson()])));
      await tester.pumpAndSettle();
      await tap(tester, find.byKey(const Key('nav-history')));
      expect(find.text('Chưa có phiên sạc.'), findsOneWidget);
      expect(find.text('RFID'), findsNothing);
      expect(container(tester).read(confirmedChargeSessionProvider), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
}

DriverApiFixture fixtureWith(
  Future<ResponseBody> Function(RequestOptions) handler, {
  bool withVehicle = true,
  bool overrideMe = false,
}) => DriverApiFixture(
  (r) async => switch (r.path) {
    'auth/login' => reply(200, tokens(accessA)),
    'me' when !overrideMe => reply(
      200,
      account(id: '7', withVehicle: withVehicle),
    ),
    'stations' => reply(200, page([])),
    _ => handler(r),
  },
);
Future<ScannerPlatformFake> login(
  WidgetTester tester,
  DriverApiFixture fixture, {
  GlobalKey? boundaryKey,
}) async {
  final camera = ScannerPlatformFake();
  final old = MobileScannerPlatform.instance;
  MobileScannerPlatform.instance = camera;
  addTearDown(() => MobileScannerPlatform.instance = old);
  final app = ApiApp(
    config: ApiConfig.parse('https://fixture.invalid/api/driver/v1'),
    httpAdapter: fixture,
  );
  await tester.pumpWidget(
    boundaryKey == null ? app : RepaintBoundary(key: boundaryKey, child: app),
  );
  await tester.pumpAndSettle();
  await enterAccount(tester);
  return camera;
}

Future<void> viewport(WidgetTester tester, bool narrow) async {
  await tester.binding.setSurfaceSize(Size(narrow ? 320 : 390, 844));
  tester.platformDispatcher.textScaleFactorTestValue = narrow ? 2 : 1;
  addTearDown(() async {
    tester.platformDispatcher.clearTextScaleFactorTestValue();
    await tester.binding.setSurfaceSize(null);
  });
}

ProviderContainer container(WidgetTester tester) =>
    ProviderScope.containerOf(tester.element(find.byType(Scaffold).first));
String path(WidgetTester tester) => container(
  tester,
).read(routerProvider).routeInformationProvider.value.uri.path;
int count(DriverApiFixture fixture, String path) =>
    fixture.requests.where((r) => r.path == path).length;
Future<void> tick(
  WidgetTester tester, [
  Duration duration = const Duration(seconds: 5),
]) async {
  await tester.pump(duration);
  await tester.pumpAndSettle();
}

Future<void> reveal(WidgetTester tester, Finder finder) async {
  if (finder.evaluate().isEmpty) {
    tester
        .state<ScrollableState>(find.byType(Scrollable).last)
        .position
        .jumpTo(0);
    await tester.pump();
    if (finder.evaluate().isEmpty) {
      await tester.scrollUntilVisible(
        finder,
        250,
        scrollable: find.byType(Scrollable).last,
        maxScrolls: 100,
      );
    }
  }
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
}

Future<void> tap(WidgetTester tester, Finder finder) async {
  await reveal(tester, finder);
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

void localize(ProviderContainer container, AppLanguage language) {
  final controller = container.read(profileControllerProvider.notifier);
  final p = container.read(profileControllerProvider).profile;
  // Fixture-only language selection; the live API has no language mutation.
  // ignore: invalid_use_of_protected_member, invalid_use_of_visible_for_testing_member
  controller.state = ProfileState(
    DriverProfile(
      displayName: p.displayName,
      language: language,
      email: p.email,
      vehicles: p.vehicles,
      selectedVehicleId: p.selectedVehicleId,
      revision: p.revision,
    ),
  );
}
