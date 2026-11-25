import 'package:driver_app/app/composition/api_app.dart';
import 'package:driver_app/app/driver_tab_bar.dart';
import 'package:driver_app/features/profile/application/profile_controller.dart';
import 'package:driver_app/features/stations/presentation/api_discovery_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'driver_api_fixture.dart';
import 'driver_api_widget_test.dart' show api, enterAccount;
import 'driver_discovery_fixture.dart';

Future<void> _tap(WidgetTester tester, String key) async {
  final target = find.byKey(Key(key));
  if (target.evaluate().isEmpty) {
    await tester.scrollUntilVisible(
      target,
      200,
      scrollable: find.byType(Scrollable).first,
    );
  }
  await tester.ensureVisible(target);
  await tester.pump();
  await tester.tap(target);
  await tester.pumpAndSettle();
}

Future<DriverApiFixture> _login(
  WidgetTester tester, {
  bool narrow = false,
}) async {
  await tester.binding.setSurfaceSize(Size(narrow ? 320 : 390, 900));
  tester.platformDispatcher.textScaleFactorTestValue = narrow ? 2 : 1;
  addTearDown(() => tester.binding.setSurfaceSize(null));
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  final vehicles = [
    ownVehicle(model: leaf),
    ownVehicle(id: '10', isDefault: false),
  ];
  final fixture = DriverApiFixture((request) async {
    if (request.path == 'auth/login') return reply(200, tokens(accessA));
    expect(request.headers['Authorization'], 'Bearer $accessA');
    return switch (request.path) {
      'me' => reply(200, account(vehicles: vehicles)),
      'stations' => reply(200, page([station('31', 'Trạm phù hợp')])),
      'credit' => reply(200, {
        'balance_vnd': 125000,
        'held_vnd': 0,
        'available_vnd': 125000,
        'status': 'active',
      }),
      _ => throw StateError(
        'Unexpected request: ${request.method} ${request.path}',
      ),
    };
  });
  await tester.pumpWidget(ApiApp(config: api, httpAdapter: fixture));
  await tester.pumpAndSettle();
  await enterAccount(tester);
  expect(find.byType(ApiDiscoveryScreen), findsOneWidget);
  return fixture;
}

void _expectDiscover(WidgetTester tester, DriverApiFixture fixture) {
  expect(tester.takeException(), isNull);
  final context = tester.element(find.byType(ApiDiscoveryScreen));
  final router = GoRouter.of(context);
  expect(router.routeInformationProvider.value.uri.path, '/discover');
  expect(
    tester.widget<DriverTabBar>(find.byType(DriverTabBar)).selected,
    DriverTab.discover,
  );
  expect(
    ProviderScope.containerOf(
      context,
    ).read(profileControllerProvider).profile.selectedVehicleId,
    '9',
  );
  expect(router.canPop(), isFalse);
  final searches = fixture.requests.where((r) => r.path == 'stations');
  expect(searches, isNotEmpty);
  expect(
    searches.every((r) => r.uri.queryParameters['vehicle_id'] == '9'),
    isTrue,
  );
  expect(
    fixture.requests.where((r) => r.path != 'auth/login' && r.method != 'GET'),
    isEmpty,
  );
}

void main() {
  testWidgets(
    'nondefault vehicle details require choosing a default before finding stations',
    (tester) async {
      final fixture = await _login(tester);
      await _tap(tester, 'nav-account');
      await _tap(tester, 'open-vehicle-garage');
      await _tap(tester, 'vehicle-detail-10');
      await tester.scrollUntilVisible(
        find.byKey(const Key('select-10')),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.byKey(const Key('select-10')), findsOneWidget);
      expect(find.byKey(const Key('find-vehicle-stations')), findsNothing);
      final context = tester.element(find.byKey(const Key('select-10')));
      expect(
        ProviderScope.containerOf(
          context,
        ).read(profileControllerProvider).profile.selectedVehicleId,
        '9',
      );
      expect(
        fixture.requests.where(
          (r) => r.path != 'auth/login' && r.method != 'GET',
        ),
        isEmpty,
      );
      expect(tester.takeException(), isNull);
    },
  );
  for (final narrow in [false, true]) {
    testWidgets(
      'garage Find stations returns to Discover repeatedly (${narrow ? '320/200%' : '390/100%'})',
      (tester) async {
        final fixture = await _login(tester, narrow: narrow);
        for (var visit = 0; visit < 2; visit++) {
          await _tap(tester, 'nav-account');
          await _tap(tester, 'open-vehicle-garage');
          await _tap(tester, 'find-vehicle-stations');
          _expectDiscover(tester, fixture);
          expect(await tester.binding.handlePopRoute(), isFalse);
          await tester.pumpAndSettle();
          _expectDiscover(tester, fixture);
        }
        await _tap(tester, 'nav-account');
        await _tap(tester, 'open-vehicle-garage');
        expect(await tester.binding.handlePopRoute(), isTrue);
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        expect(
          tester.widget<DriverTabBar>(find.byType(DriverTabBar)).selected,
          DriverTab.account,
        );
        await _tap(tester, 'nav-discovery');
        _expectDiscover(tester, fixture);
      },
    );
  }

  testWidgets('default vehicle detail Find stations returns to Discover', (
    tester,
  ) async {
    final fixture = await _login(tester);
    await _tap(tester, 'nav-account');
    await _tap(tester, 'open-vehicle-garage');
    await _tap(tester, 'vehicle-detail-9');
    await _tap(tester, 'find-vehicle-stations');
    _expectDiscover(tester, fixture);
  });

  testWidgets(
    'account Explore stations switches primary tab without a back stack',
    (tester) async {
      final fixture = await _login(tester);
      await _tap(tester, 'nav-account');
      await _tap(tester, 'open-discovery');
      _expectDiscover(tester, fixture);
    },
  );
}
