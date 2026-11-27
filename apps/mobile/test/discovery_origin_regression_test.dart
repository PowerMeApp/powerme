import 'dart:async';

import 'package:dio/dio.dart';
import 'package:driver_app/app/composition/api_app.dart';
import 'package:driver_app/features/auth/application/auth_controller.dart';
import 'package:driver_app/features/profile/application/profile_controller.dart';
import 'package:driver_app/features/stations/application/station_discovery_controller.dart';
import 'package:driver_app/features/stations/domain/map_location.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'driver_api_fixture.dart';
import 'driver_api_widget_test.dart' show api, enterAccount;
import 'driver_discovery_fixture.dart';

class TestLocation implements MapLocationRepository {
  TestLocation(this.read);
  final Future<MapLocation> Function() read;
  int calls = 0;
  @override
  Future<MapLocation> current() {
    calls++;
    return read();
  }
}

Finder key(String value) => find.byKey(Key(value));

Future<void> tap(WidgetTester tester, String value) async {
  final target = key(value);
  if (target.evaluate().isEmpty) {
    await tester.scrollUntilVisible(
      target,
      160,
      scrollable: find.byType(Scrollable).first,
    );
  }
  await Scrollable.ensureVisible(tester.element(target), alignment: .5);
  await tester.pump();
  await tester.tap(target);
  await tester.pumpAndSettle();
}

Iterable<RequestOptions> searches(DriverApiFixture fixture) =>
    fixture.requests.where((r) => r.path == 'stations');
Iterable<RequestOptions> smart(DriverApiFixture fixture) =>
    searches(fixture).where((r) => r.uri.queryParameters['sort'] == 'smart');

DriverApiFixture fixture({
  Future<ResponseBody?> Function(RequestOptions)? intercept,
}) => DriverApiFixture((r) async {
  final response = await intercept?.call(r);
  if (response != null) return response;
  return switch (r.path) {
    'auth/login' => reply(200, tokens(accessA)),
    'me' => reply(200, account(vehicles: [leafVehicle()])),
    'stations' => reply(
      200,
      page(
        [
          station(
            '31',
            'Trạm theo điểm đi',
            smart: r.uri.queryParameters.containsKey('latitude'),
          ),
        ],
        pageSize: r.uri.queryParameters['sort'] == 'smart' ? 3 : 20,
        rangeKm: r.uri.queryParameters.containsKey('latitude') ? 18.5 : null,
        reason: r.uri.queryParameters.containsKey('latitude')
            ? null
            : 'no_location',
        rankingSource: 'brief',
      ),
    ),
    _ => throw StateError('Unexpected route ${r.path}'),
  };
});

Future<ProviderContainer> login(
  WidgetTester tester,
  DriverApiFixture fixture,
  TestLocation location,
) async {
  await tester.binding.setSurfaceSize(const Size(390, 844));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    ApiApp(config: api, httpAdapter: fixture, locationRepository: location),
  );
  await tester.pumpAndSettle();
  await enterAccount(tester);
  return ProviderScope.containerOf(tester.element(key('station-search-query')));
}

void main() {
  testWidgets('missing origin never requests or renders name-only top three', (
    tester,
  ) async {
    final http = fixture();
    final gps = TestLocation(() async => const MapLocation(10.77, 106.66));
    await login(tester, http, gps);
    expect(gps.calls, 0);
    await tap(tester, 'open-suggestions');
    await tester.enterText(key('suggestion-soc'), '15');
    await tap(tester, 'submit-smart-search');
    expect(smart(http), isEmpty);
    expect(key('discovery-use-location'), findsOneWidget);
    expect(key('suggestion-result-31'), findsNothing);
    expect(gps.calls, 0);
  });

  testWidgets('non VinFast override is visible without opening a fold', (
    tester,
  ) async {
    final http = fixture();
    await login(
      tester,
      http,
      TestLocation(() async => const MapLocation(10.77, 106.66)),
    );
    expect(key('include-vinfast-only').hitTestable(), findsOneWidget);
    expect(find.text('Hiện thêm trạm VinFast'), findsOneWidget);
    expect(
      searches(http).single.uri.queryParameters,
      containsPair('include_vinfast_only', 'false'),
    );
  });

  testWidgets(
    'explicit GPS is shared through search, toggle and suggestions without places',
    (tester) async {
      final http = fixture();
      final gps = TestLocation(() async => const MapLocation(10.77, 106.66));
      await login(tester, http, gps);
      expect(gps.calls, 0);
      await tap(tester, 'open-discovery-origin');
      expect(find.textContaining('PowerMe nhận tọa độ'), findsOneWidget);
      expect(gps.calls, 0);
      await tap(tester, 'discovery-use-location');
      expect(gps.calls, 1);
      expect(find.text('Điểm đi · GPS'), findsOneWidget);
      await tester.ensureVisible(key('station-search-query'));
      await tester.enterText(key('station-search-query'), 'Đông Hòa');
      await tap(tester, 'submit-station-search');
      for (final enabled in [true, false]) {
        await tap(tester, 'include-vinfast-only');
        expect(
          searches(http).last.uri.queryParameters,
          containsPair('include_vinfast_only', '$enabled'),
        );
        expect(
          searches(http).last.uri.queryParameters,
          containsPair('latitude', '10.77'),
        );
        expect(
          searches(http).last.uri.queryParameters,
          containsPair('longitude', '106.66'),
        );
        expect(
          searches(http).last.uri.queryParameters,
          containsPair('q', 'Đông Hòa'),
        );
      }
      await tap(tester, 'open-suggestions');
      await tester.ensureVisible(key('suggestion-soc'));
      await tester.enterText(key('suggestion-soc'), '25,5');
      await tester.pump();
      expect(smart(http), isEmpty);
      expect(
        find.textContaining('PowerMe gửi điểm đi tới Vietmap'),
        findsOneWidget,
      );
      await tap(tester, 'submit-smart-search');
      expect(
        smart(http).last.uri.queryParameters,
        allOf(
          containsPair('latitude', '10.77'),
          containsPair('longitude', '106.66'),
          containsPair('soc_percent', '25.5'),
          containsPair('vehicle_id', '9'),
          containsPair('location_consent', 'true'),
          containsPair('page_size', '3'),
        ),
      );
      expect(http.requests.where((r) => r.path.startsWith('places/')), isEmpty);
      expect(find.textContaining('km đường bộ'), findsNothing);
      for (final enabled in [true, false]) {
        await tap(tester, 'include-vinfast-only');
        final before = smart(http).length;
        expect(key('suggestion-result-31'), findsNothing);
        await tap(tester, 'submit-smart-search');
        expect(smart(http), hasLength(before + 1));
        expect(
          smart(http).last.uri.queryParameters,
          containsPair('include_vinfast_only', '$enabled'),
        );
        expect(
          smart(http).last.uri.queryParameters,
          containsPair('latitude', '10.77'),
        );
      }
      final before = smart(http).length;
      await tap(tester, 'clear-discovery-origin');
      expect(key('suggestion-result-31'), findsNothing);
      expect(smart(http), hasLength(before));
      await tap(tester, 'submit-smart-search');
      expect(smart(http), hasLength(before));
      expect(
        smart(http).every((r) => r.uri.queryParameters.containsKey('latitude')),
        isTrue,
      );
    },
  );

  for (final issue in LocationIssue.values) {
    testWidgets('GPS $issue keeps manual address and name search usable', (
      tester,
    ) async {
      final http = fixture(
        intercept: (r) async => switch (r.path) {
          'places/autocomplete' => reply(200, {
            'value': [place],
          }),
          'places/resolve' => reply(200, {
            'value': {...place, 'latitude': 10.76, 'longitude': 106.65},
          }),
          _ => null,
        },
      );
      final gps = TestLocation(() async => throw LocationFailure(issue));
      final container = await login(tester, http, gps);
      await tap(tester, 'open-discovery-origin');
      await tap(tester, 'discovery-use-location');
      expect(container.read(discoveryContextProvider).origin, isNull);
      expect(key('discovery-address-consent'), findsOneWidget);
      expect(searches(http), hasLength(1));
      await tap(tester, 'discovery-address-consent');
      await tester.ensureVisible(key('discovery-address-query'));
      await tester.enterText(key('discovery-address-query'), 'Võ Văn Tần');
      expect(http.requests.where((r) => r.path.startsWith('places/')), isEmpty);
      await tap(tester, 'submit-discovery-address');
      final address = find.text('12 Võ Văn Tần');
      await tester.ensureVisible(address);
      await tester.tap(address);
      await tester.pumpAndSettle();
      expect(http.requests.where((r) => r.path == 'places/resolve'), isEmpty);
      await tap(tester, 'confirm-discovery-address');
      expect(
        container.read(discoveryContextProvider).origin?.address,
        '12 Võ Văn Tần',
      );
      expect(
        searches(http).last.uri.queryParameters,
        containsPair('latitude', '10.76'),
      );
      await tester.ensureVisible(key('station-search-query'));
      await tester.enterText(key('station-search-query'), 'Tên trạm');
      await tap(tester, 'submit-station-search');
      expect(
        searches(http).last.uri.queryParameters,
        containsPair('q', 'Tên trạm'),
      );
    });
  }

  for (final change in [
    'sheet dismiss',
    'clear',
    'vehicle',
    'logout',
    'unmount',
  ]) {
    testWidgets('late GPS cannot restore origin after $change', (tester) async {
      final pending = Completer<MapLocation>();
      var selected = '9';
      final http = fixture(
        intercept: (r) async => switch (r.path) {
          'me' => reply(
            200,
            account(
              vehicles: [
                leafVehicle(isDefault: selected == '9'),
                leafVehicle(id: '10', isDefault: selected == '10'),
              ],
            ),
          ),
          'vehicles/10' => reply(200, leafVehicle(id: selected = '10')),
          _ => null,
        },
      );
      final gps = TestLocation(() => pending.future);
      final container = await login(tester, http, gps);
      await tap(tester, 'open-discovery-origin');
      await tester.tap(key('discovery-use-location'));
      await tester.pump();
      expect(gps.calls, 1);
      final controller = container.read(discoveryContextProvider.notifier);
      switch (change) {
        case 'sheet dismiss':
          Navigator.of(tester.element(key('discovery-use-location'))).pop();
        case 'clear':
          controller.clearOrigin();
        case 'vehicle':
          unawaited(
            container
                .read(profileControllerProvider.notifier)
                .selectVehicle('10'),
          );
        case 'logout':
          container.read(authControllerProvider.notifier).signOut();
        case 'unmount':
          await tester.pumpWidget(const SizedBox.shrink());
      }
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      pending.complete(const MapLocation(10.77, 106.66));
      await tester.pumpAndSettle();
      if (change != 'unmount') {
        expect(container.read(discoveryContextProvider).origin, isNull);
      }
      expect(
        searches(
          http,
        ).every((r) => !r.uri.queryParameters.containsKey('latitude')),
        isTrue,
      );
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('late address resolve cannot restore a cleared origin', (
    tester,
  ) async {
    final pending = Completer<ResponseBody>();
    final http = fixture(
      intercept: (r) async => switch (r.path) {
        'places/autocomplete' => reply(200, {
          'value': [place],
        }),
        'places/resolve' => pending.future,
        _ => null,
      },
    );
    final container = await login(
      tester,
      http,
      TestLocation(() async => const MapLocation(10.77, 106.66)),
    );
    await tap(tester, 'open-discovery-origin');
    await tap(tester, 'discovery-address-consent');
    await tester.enterText(key('discovery-address-query'), 'Võ Văn Tần');
    await tap(tester, 'submit-discovery-address');
    await tester.ensureVisible(find.text('12 Võ Văn Tần'));
    await tester.tap(find.text('12 Võ Văn Tần'));
    await tester.pumpAndSettle();
    await tester.tap(key('confirm-discovery-address'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    container.read(discoveryContextProvider.notifier).clearOrigin();
    pending.complete(
      reply(200, {
        'value': {...place, 'latitude': 10.77, 'longitude': 106.66},
      }),
    );
    await tester.pumpAndSettle();
    expect(container.read(discoveryContextProvider).origin, isNull);
    expect(searches(http), hasLength(1));
  });

  testWidgets('VinFast profile retains contract default without override', (
    tester,
  ) async {
    final http = fixture(
      intercept: (r) async => r.path == 'me' ? reply(200, account()) : null,
    );
    await login(
      tester,
      http,
      TestLocation(() async => const MapLocation(10.77, 106.66)),
    );
    expect(key('include-vinfast-only'), findsNothing);
    expect(
      searches(http).single.uri.queryParameters,
      containsPair('include_vinfast_only', 'false'),
    );
  });

  testWidgets(
    'default vehicle and logout reset origin and the shared override',
    (tester) async {
      var selected = '9';
      final http = fixture(
        intercept: (r) async => switch (r.path) {
          'me' => reply(
            200,
            account(
              vehicles: [
                leafVehicle(isDefault: selected == '9'),
                leafVehicle(id: '10', isDefault: selected == '10'),
              ],
            ),
          ),
          'vehicles/10' => reply(200, leafVehicle(id: selected = '10')),
          _ => null,
        },
      );
      final container = await login(
        tester,
        http,
        TestLocation(() async => const MapLocation(10.77, 106.66)),
      );
      await tap(tester, 'include-vinfast-only');
      await tap(tester, 'open-discovery-origin');
      await tap(tester, 'discovery-use-location');
      expect(container.read(discoveryContextProvider).origin, isNotNull);
      expect(
        container.read(discoveryContextProvider).includeVinFastOnly,
        isTrue,
      );
      unawaited(
        container.read(profileControllerProvider.notifier).selectVehicle('10'),
      );
      await tester.pumpAndSettle();
      expect(container.read(discoveryVehicleProvider), '10');
      expect(container.read(discoveryContextProvider).origin, isNull);
      expect(
        container.read(discoveryContextProvider).includeVinFastOnly,
        isFalse,
      );
      expect(
        searches(http).last.uri.queryParameters,
        isNot(contains('latitude')),
      );
      await tap(tester, 'include-vinfast-only');
      await tap(tester, 'open-discovery-origin');
      await tap(tester, 'discovery-use-location');
      container.read(authControllerProvider.notifier).signOut();
      await tester.pumpAndSettle();
      expect(container.read(discoveryContextProvider).origin, isNull);
      expect(
        container.read(discoveryContextProvider).includeVinFastOnly,
        isFalse,
      );
    },
  );
}
