import 'dart:async';

import 'package:dio/dio.dart';
import 'package:driver_app/app/composition/api_app.dart';
import 'package:driver_app/app/composition/vietmap_config.dart';
import 'package:driver_app/core/theme/powerme_theme.dart';
import 'package:driver_app/core/widgets/flow_page.dart';
import 'package:driver_app/features/auth/application/auth_controller.dart';
import 'package:driver_app/features/profile/application/profile_controller.dart';
import 'package:driver_app/features/stations/domain/map_location.dart';
import 'package:driver_app/features/stations/presentation/road_map_canvas.dart';
import 'package:driver_app/features/stations/presentation/vietmap_surface.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'driver_api_fixture.dart';
import 'driver_api_widget_test.dart' show api, enterAccount;
import 'driver_discovery_fixture.dart';

Future<void> _login(
  WidgetTester tester,
  DriverApiFixture fixture, {
  MapLocationRepository? location,
  VietmapConfig? tiles,
  Size size = const Size(440, 1000),
  double scale = 1,
}) async {
  await tester.binding.setSurfaceSize(size);
  tester.platformDispatcher.textScaleFactorTestValue = scale;
  addTearDown(() => tester.binding.setSurfaceSize(null));
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  await tester.pumpWidget(
    ApiApp(
      config: api,
      httpAdapter: fixture,
      locationRepository: location,
      vietmapConfig: tiles,
    ),
  );
  await tester.pumpAndSettle();
  await enterAccount(tester);
}

Finder _key(String value) => find.byKey(Key(value));

Future<void> _tap(
  WidgetTester tester,
  Finder finder, {
  bool settle = true,
}) async {
  await tester.ensureVisible(finder);
  await tester.pump();
  await tester.tap(finder);
  if (settle) await tester.pumpAndSettle();
}

Future<void> _text(WidgetTester tester, String key, String value) async {
  final finder = _key(key);
  await tester.ensureVisible(finder);
  await tester.enterText(finder, value);
  await tester.pump();
}

Iterable<RequestOptions> _requests(DriverApiFixture fixture, String path) =>
    fixture.requests.where((r) => r.path == path);

class _DeviceLocation implements MapLocationRepository {
  _DeviceLocation(this.read);
  final Future<MapLocation> Function() read;
  int calls = 0;
  @override
  Future<MapLocation> current() {
    ++calls;
    return read();
  }
}

void main() {
  testWidgets('Discover and suggestions guide edits for invalid_search', (
    tester,
  ) async {
    final fixture = DriverApiFixture(
      (r) async => switch (r.path) {
        'auth/login' => reply(200, tokens(accessA)),
        'me' => reply(200, account(vehicles: [leafVehicle()])),
        'stations' => reply(400, {'error': 'invalid_search'}),
        _ => throw StateError('Unexpected route'),
      },
    );
    await _login(tester, fixture);
    expect(find.text('Thử lại'), findsNothing);
    await _tap(tester, find.text('Sửa từ khóa'));
    expect(tester.testTextInput.isVisible, isTrue);
    expect(_requests(fixture, 'stations'), hasLength(1));
    await _tap(tester, _key('open-suggestions'));
    await _text(tester, 'suggestion-soc', '15');
    await _tap(tester, _key('submit-smart-search'));
    expect(find.text('Thử lại'), findsNothing);
    final before = _requests(fixture, 'stations').length;
    await _tap(tester, find.text('Sửa mức pin'));
    expect(tester.testTextInput.isVisible, isTrue);
    expect(_requests(fixture, 'stations'), hasLength(before));
  });

  testWidgets('missing and rejected map keys do not offer Retry', (
    tester,
  ) async {
    final location = _DeviceLocation(
      () async => const MapLocation(10.77, 106.66),
    );
    final fixture = DriverApiFixture(
      (r) async => switch (r.path) {
        'auth/login' => reply(200, tokens(accessA)),
        'me' => reply(200, account(vehicles: [leafVehicle()])),
        'stations' => reply(200, page([station('31', 'Trạm thử')])),
        'places/autocomplete' => reply(503, {
          'error': 'provider_unavailable',
          'detail': 'unconfigured',
        }),
        'stations/31/route' => reply(503, {
          'error': 'provider_unavailable',
          'detail': 'credentials',
        }),
        _ => throw StateError('Unexpected route'),
      },
    );
    await _login(tester, fixture, location: location);
    await _tap(tester, find.text('Điểm đi và bộ lọc'));
    expect(find.textContaining('PowerMe nhận tọa độ'), findsOneWidget);
    await _tap(tester, _key('discovery-address-consent'));
    await _text(tester, 'discovery-address-query', 'Võ Văn Tần');
    await _tap(tester, _key('submit-discovery-address'));
    expect(find.textContaining('chưa được PowerMe bật'), findsOneWidget);
    expect(find.text('Thử lại'), findsNothing);
    await _tap(tester, _key('submit-discovery-address'));
    expect(_requests(fixture, 'places/autocomplete'), hasLength(1));
    await _tap(tester, _key('discovery-use-location'));
    final search = _requests(fixture, 'stations').last.uri.queryParameters;
    expect(search, containsPair('latitude', '10.77'));
    expect(search, isNot(contains('location_consent')));
    expect(_key('clear-discovery-origin'), findsOneWidget);
    await _tap(tester, _key('clear-discovery-origin'));
    expect(
      _requests(fixture, 'stations').last.uri.queryParameters,
      isNot(contains('latitude')),
    );
    final locationButton = _key('discovery-use-location');
    if (locationButton.evaluate().isEmpty) {
      final filters = find.text('Điểm đi và bộ lọc');
      await tester.scrollUntilVisible(
        filters,
        200,
        scrollable: find.byType(Scrollable).first,
      );
      if (locationButton.evaluate().isEmpty) await _tap(tester, filters);
    }
    await _tap(tester, locationButton);
    await tester.scrollUntilVisible(
      _key('station-result-31'),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    await _tap(tester, _key('station-result-31'));
    await _tap(tester, _key('request-station-route'));
    expect(find.textContaining('liên hệ hỗ trợ PowerMe'), findsOneWidget);
    expect(find.text('Thử lại'), findsNothing);
    expect(_key('request-station-route'), findsNothing);
  });

  testWidgets(
    'configured map shows route geometry, traffic legend and manual maneuvers',
    (tester) async {
      var origin = const MapLocation(10.77, 106.66);
      final location = _DeviceLocation(() async => origin);
      final fixture = DriverApiFixture(
        (r) async => switch (r.path) {
          'auth/login' => reply(200, tokens(accessA)),
          'me' => reply(200, account()),
          'stations' when r.uri.queryParameters['q']!.isEmpty => reply(
            200,
            page([]),
          ),
          'stations' => reply(200, page([station('31', 'Trạm Vietmap')])),
          'stations/31/route' => reply(200, roadWithTraffic()),
          _ => throw StateError('Unexpected route'),
        },
      );
      await _login(
        tester,
        fixture,
        tiles: const VietmapConfig('fixture tile'),
        location: location,
        size: const Size(390, 844),
      );
      final map = find.byType(VietmapSurface);
      final filters = find.text('Điểm đi và bộ lọc');
      final suggestions = _key('open-suggestions');
      final toggle = _key('toggle-station-map');
      expect(tester.getCenter(suggestions).dy, tester.getCenter(toggle).dy);
      expect(tester.getSize(toggle).height, greaterThanOrEqualTo(48));
      expect(find.text('Xem danh sách'), findsOneWidget);
      expect(tester.getSize(map).height, lessThan(120));
      expect(
        tester.getTopLeft(map).dy,
        lessThan(tester.getTopLeft(filters).dy),
      );
      final initialMap = tester.widget<VietmapSurface>(map);
      expect(initialMap.origin, isNull);
      expect(initialMap.stations, isEmpty);
      expect(
        _requests(fixture, 'stations').single.uri.queryParameters,
        isNot(contains('latitude')),
      );
      await _text(tester, 'station-search-query', 'Vietmap');
      await _tap(tester, _key('submit-station-search'));
      expect(tester.widget<VietmapSurface>(map).stations.single.id, '31');
      await _tap(tester, filters);
      await _tap(tester, _key('discovery-use-location'));
      await _tap(tester, filters);
      await tester.scrollUntilVisible(
        _key('station-result-31'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await _tap(tester, _key('station-result-31'));
      expect(map, findsNothing);
      expect(_requests(fixture, 'stations/31/route'), isEmpty);
      await _tap(tester, _key('request-station-route'));
      final routeMap = tester.widget<VietmapSurface>(map);
      expect(routeMap.routePoints.map((p) => (p.latitude, p.longitude)), [
        (10.77, 106.66),
        (10.77, 106.67),
        (10.78, 106.68),
        (10.8, 106.7),
      ]);
      expect(routeMap.trafficSegments.map((segment) => segment.level.name), [
        'heavy',
        'low',
      ]);
      expect(routeMap.stations.single.id, '31');
      expect(routeMap.maneuver, isNull);
      expect(tester.getSize(map).height, lessThan(120));
      expect(
        tester.getTopLeft(map).dy,
        lessThan(tester.getTopLeft(find.text('Quãng đường bộ')).dy),
      );
      final frame = _key('route-map-frame');
      for (final label in ['Ùn tắc nặng', 'Chưa có dữ liệu', 'Ít ùn tắc']) {
        expect(
          find.descendant(of: frame, matching: find.text(label)),
          findsOneWidget,
        );
        expect(find.text(label), findsOneWidget);
      }
      expect(_key('route-traffic-sections'), findsNothing);
      expect(find.text('Chỉ đường từng chặng'), findsNothing);
      expect(find.text('Rẽ trái'), findsNothing);
      final start = _key('route-preview-start');
      final previous = _key('route-preview-previous');
      final next = _key('route-preview-next');
      final end = _key('route-preview-end');
      await _tap(tester, start);
      expect(find.text('Xem trước · Chặng 1/3'), findsOneWidget);
      expect(tester.widget<OutlinedButton>(previous).onPressed, isNull);
      expect(tester.widget<VietmapSurface>(map).maneuver, (
        point: routeMap.routePoints[0],
        icon: Icons.straight,
      ));
      await _tap(tester, next);
      expect(find.text('Rẽ trái'), findsOneWidget);
      expect(find.text('Đi về phía trạm sạc'), findsOneWidget);
      expect(find.text('Võ Văn Tần'), findsOneWidget);
      expect(find.text('108 m đến chỉ dẫn tiếp theo'), findsOneWidget);
      expect(tester.widget<VietmapSurface>(map).maneuver, (
        point: routeMap.routePoints[1],
        icon: Icons.turn_left,
      ));
      await tester.binding.setSurfaceSize(const Size(320, 640));
      tester.platformDispatcher.textScaleFactorTestValue = 2;
      await tester.pumpAndSettle();
      await _tap(tester, next);
      expect(find.text('Đến điểm sạc'), findsOneWidget);
      expect(tester.widget<VietmapSurface>(map).maneuver, (
        point: routeMap.routePoints[2],
        icon: Icons.flag_outlined,
      ));
      expect(tester.widget<OutlinedButton>(next).onPressed, isNull);
      await _tap(tester, previous);
      expect(find.text('Rẽ trái'), findsOneWidget);
      await _tap(tester, end);
      expect(tester.widget<VietmapSurface>(map).maneuver, isNull);
      expect(_requests(fixture, 'stations/31/route'), hasLength(1));
      expect(location.calls, 1);
      await _tap(tester, start);
      await _tap(tester, find.text('Điểm đi'));
      origin = const MapLocation(10.78, 106.66);
      await _tap(tester, _key('discovery-use-location'));
      final scrollable = find.byType(Scrollable).first;
      tester.state<ScrollableState>(scrollable).position.jumpTo(0);
      await tester.pumpAndSettle();
      expect(frame, findsNothing);
      final requestRoute = _key('request-station-route');
      await tester.scrollUntilVisible(
        requestRoute,
        160,
        scrollable: scrollable,
      );
      await _tap(tester, requestRoute);
      expect(start, findsOneWidget);
      expect(tester.widget<VietmapSurface>(map).maneuver, isNull);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
    variant: const TargetPlatformVariant({TargetPlatform.windows}),
  );

  testWidgets('map and list share query, status filter and page', (
    tester,
  ) async {
    final fixture = DriverApiFixture(
      (r) async => switch (r.path) {
        'auth/login' => reply(200, tokens(accessA)),
        'me' => reply(200, account()),
        'stations' => reply(
          200,
          page(
            [station('31', 'PowerMe Đông Hòa')],
            page: int.parse(r.uri.queryParameters['page']!),
            total: 21,
          ),
        ),
        _ => throw StateError('Unexpected route'),
      },
    );
    await _login(tester, fixture, size: const Size(390, 844));
    await _text(tester, 'station-search-query', 'Đông Hòa');
    await tester.testTextInput.receiveAction(TextInputAction.search);
    await tester.pumpAndSettle();
    await _tap(tester, _key('station-availability-available'));
    await _tap(tester, _key('next-station-page'));
    final search = _requests(fixture, 'stations');
    final requestCount = search.length;
    expect(
      search.last.uri.queryParameters,
      containsPair('availability', 'available'),
    );
    expect(search.last.uri.queryParameters, containsPair('q', 'Đông Hòa'));
    expect(search.last.uri.queryParameters, containsPair('page', '2'));
    expect(_key('station-map-results'), findsOneWidget);
    await _tap(tester, _key('toggle-station-map'));
    expect(find.text('Xem bản đồ'), findsOneWidget);
    expect(_key('station-map-results'), findsNothing);
    expect(_key('station-result-31'), findsOneWidget);
    expect(search, hasLength(requestCount));
    await _tap(tester, _key('clear-station-search'));
    expect(search.last.uri.queryParameters, containsPair('q', ''));
    expect(search.last.uri.queryParameters, containsPair('page', '1'));
    expect(
      search.last.uri.queryParameters,
      containsPair('availability', 'available'),
    );
  });

  testWidgets(
    'connector status and availability remain distinct at 320px and 200%',
    (tester) async {
      final entry = station(
        '31',
        'Trạm PowerMe Nhà Văn hóa Sinh viên Đông Hòa',
      );
      final connectors = entry['connectors']! as List<Map<String, Object?>>;
      connectors.first['driver_status'] = 'available';
      final fixture = DriverApiFixture(
        (r) async => switch (r.path) {
          'auth/login' => reply(200, tokens(accessA)),
          'me' => reply(200, account()),
          'stations' => reply(200, page([entry])),
          _ => throw StateError('Unexpected route'),
        },
      );
      await _login(tester, fixture, size: const Size(320, 740), scale: 2);
      await _tap(tester, _key('toggle-station-map'));
      await tester.scrollUntilVisible(
        _key('station-result-31').hitTestable(),
        220,
        scrollable: find.byType(Scrollable).first,
      );
      await _tap(tester, _key('station-result-31'));
      expect(find.text('1 cổng khả dụng'), findsOneWidget);
      await tester.scrollUntilVisible(find.text('Hiện chưa khả dụng'), 240);
      final staleCard = find.byKey(const ValueKey<String?>(firstConnector));
      final statePill = find.descendant(
        of: staleCard,
        matching: find.byType(StatusBadge),
      );
      expect(tester.widget<StatusBadge>(statePill).color, PowerMeColors.muted);
      expect(find.text('Dữ liệu có thể đã cũ'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('discovery and QR require a vehicle, then discovery can search', (
    tester,
  ) async {
    final vehicles = <Map<String, Object?>>[];
    final fixture = DriverApiFixture(
      (r) async => switch ((r.method, r.path)) {
        ('POST', 'auth/login') => reply(200, tokens(accessA)),
        ('GET', 'me') => reply(200, account(vehicles: vehicles)),
        ('GET', 'vehicle-models') => reply(200, {
          'items': [leaf],
        }),
        ('POST', 'vehicles') => reply(
          201,
          (vehicles..add(leafVehicle())).single,
        ),
        ('GET', 'stations') => reply(200, page([])),
        _ => throw StateError('Unexpected route'),
      },
    );
    await _login(tester, fixture);
    expect(find.text('Thêm xe để tìm trạm tương thích.'), findsOneWidget);
    expect(_requests(fixture, 'stations'), isEmpty);
    await _tap(tester, _key('nav-charging'));
    expect(find.text('Thêm xe để kiểm tra cổng sạc phù hợp.'), findsOneWidget);
    expect(_key('qr-manual-reference'), findsNothing);
    await _tap(tester, _key('nav-discovery'));
    await _tap(tester, _key('discovery-vehicle-required'));
    await _text(tester, 'vehicle-plate', '51K-901.01');
    await _tap(tester, _key('vehicle-model-${leaf['vehicle_model_id']}'));
    await _tap(tester, _key('vehicle-save'));
    expect(
      _requests(fixture, 'stations').single.uri.queryParameters['vehicle_id'],
      '9',
    );
    expect(find.textContaining('Không tìm thấy trạm'), findsOneWidget);
    expect(
      fixture.requests.any((r) => r.path.startsWith('connectors/')),
      false,
    );
  });

  testWidgets(
    'pages, explicit address consent, selected route and list-only summary',
    (tester) async {
      var routes = 0;
      final location = _DeviceLocation(
        () async => throw const LocationFailure(LocationIssue.denied),
      );
      final fixture = DriverApiFixture((r) async {
        final query = r.uri.queryParameters;
        return switch (r.path) {
          'auth/login' => reply(200, tokens(accessA)),
          'me' => reply(200, account(vehicles: [leafVehicle()])),
          'stations' when query['page'] == '2' => reply(
            200,
            page([station('32', 'Trạm trang sau')], page: 2, total: 21),
          ),
          'stations' => reply(
            200,
            page([station('31', 'Trạm Võ Văn Tần')], total: 21),
          ),
          'places/autocomplete' => reply(200, {
            'value': [place],
          }),
          'places/resolve' => reply(200, {
            'value': {...place, 'latitude': 10.77, 'longitude': 106.66},
          }),
          'stations/31/route' when ++routes == 1 => reply(503, {
            'error': 'provider_unavailable',
          }),
          'stations/31/route' => reply(200, road()),
          _ => throw StateError('Unexpected route'),
        };
      });
      await _login(tester, fixture, location: location);
      expect(location.calls, 0);
      expect(
        _requests(fixture, 'stations').single.uri.queryParameters,
        isNot(contains('latitude')),
      );
      expect(find.byType(RoadMapCanvas), findsNothing);
      await _tap(tester, _key('next-station-page'));
      expect(find.text('Trạm trang sau'), findsOneWidget);
      await _text(tester, 'station-search-query', 'Võ Văn Tần');
      await _tap(tester, _key('submit-station-search'));
      expect(
        _requests(fixture, 'stations').last.uri.queryParameters,
        containsPair('q', 'Võ Văn Tần'),
      );
      expect(
        _requests(fixture, 'stations').last.uri.queryParameters,
        containsPair('page', '1'),
      );
      await _tap(tester, find.text('Điểm đi và bộ lọc'));
      await _tap(tester, _key('discovery-use-location'));
      expect(location.calls, 1);
      expect(find.textContaining('chưa cấp quyền vị trí'), findsOneWidget);
      expect(
        _requests(
          fixture,
          'stations',
        ).every((r) => !r.uri.queryParameters.containsKey('latitude')),
        true,
      );
      await _tap(tester, _key('include-vinfast-only'));
      expect(
        _requests(fixture, 'stations').last.uri.queryParameters,
        containsPair('include_vinfast_only', 'true'),
      );
      await _tap(tester, _key('discovery-address-consent'));
      await _text(tester, 'discovery-address-query', 'Võ Văn Tần');
      expect(_requests(fixture, 'places/autocomplete'), isEmpty);
      await _tap(tester, _key('submit-discovery-address'));
      expect(
        _requests(fixture, 'places/autocomplete').single.uri.queryParameters,
        containsPair('location_consent', 'true'),
      );
      await _tap(tester, find.text('12 Võ Văn Tần'));
      expect(_requests(fixture, 'places/resolve'), isEmpty);
      await _tap(tester, _key('confirm-discovery-address'));
      expect(
        _requests(fixture, 'places/resolve').single.uri.queryParameters,
        containsPair('location_consent', 'true'),
      );
      expect(
        _requests(fixture, 'stations').last.uri.queryParameters,
        containsPair('latitude', '10.77'),
      );
      expect(_requests(fixture, 'stations/31/route'), isEmpty);
      await _tap(tester, _key('station-result-31'));
      expect(find.text('Trụ TRU-11 · Cổng 1'), findsOneWidget);
      expect(find.text('Trụ TRU-12 · Cổng 1'), findsOneWidget);
      expect(find.textContaining('Dữ liệu có thể đã cũ'), findsOneWidget);
      expect(_requests(fixture, 'stations/31/route'), isEmpty);
      await _tap(tester, _key('request-station-route'));
      expect(
        find.textContaining('Chưa lấy được dữ liệu bản đồ'),
        findsOneWidget,
      );
      await _tap(tester, find.text('Thử lại'));
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
      expect(_key('route-preview-start'), findsNothing);
      expect(
        find.text('Chưa có chỉ dẫn từng chặng cho tuyến này.'),
        findsOneWidget,
      );
      expect(find.text('2,4 km'), findsOneWidget);
      expect(find.text('Bản đồ hiện không khả dụng.'), findsOneWidget);
      expect(_requests(fixture, 'stations/31/route').last.uri.queryParameters, {
        'vehicle_id': '9',
        'latitude': '10.77',
        'longitude': '106.66',
        'location_consent': 'true',
        'include_vinfast_only': 'true',
      });
    },
  );

  testWidgets(
    'inline road asks once per request and never renders screening distance',
    (tester) async {
      final fixture = DriverApiFixture(
        (r) async => switch (r.path) {
          'auth/login' => reply(200, tokens(accessA)),
          'me' => reply(200, account(vehicles: [leafVehicle()])),
          'stations' => reply(
            200,
            page([station('31', 'PowerMe Đông Hòa')..['distance_m'] = 9900]),
          ),
          'stations/31/route' => reply(200, road()),
          _ => throw StateError('Unexpected route'),
        },
      );
      await _login(
        tester,
        fixture,
        location: _DeviceLocation(() async => const MapLocation(10.77, 106.66)),
        size: const Size(320, 640),
        scale: 2,
      );
      await _tap(tester, _key('nav-discovery'));
      final action = _key('station-road-31');
      await tester.scrollUntilVisible(
        action,
        180,
        scrollable: find.byType(Scrollable).first,
      );
      await _tap(tester, action);
      await _tap(tester, _key('discovery-use-location'));
      final disclosure = find.textContaining('gửi điểm đi tới Vietmap');
      expect(disclosure, findsNothing);
      expect(find.textContaining('9,9 km'), findsNothing);
      await _tap(tester, _key('station-road-31'));
      expect(disclosure, findsOneWidget);
      expect(_requests(fixture, 'stations/31/route'), isEmpty);
      await _tap(tester, find.text('Hủy'));
      expect(disclosure, findsNothing);
      expect(_requests(fixture, 'stations/31/route'), isEmpty);
      await _tap(tester, _key('station-road-31'));
      await _tap(tester, _key('confirm-inline-road'));
      expect(_requests(fixture, 'stations/31/route'), hasLength(1));
      expect(find.text('2,4 km đường bộ · 8 phút ước tính'), findsOneWidget);
      expect(find.textContaining('9,9 km'), findsNothing);
      expect(disclosure, findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'suggestions use compatible stations for blank or high battery without Vietmap consent',
    (tester) async {
      final location = _DeviceLocation(
        () async => const MapLocation(10.77, 106.66),
      );
      final fixture = DriverApiFixture(
        (r) async => switch (r.path) {
          'auth/login' => reply(200, tokens(accessA)),
          'me' => reply(200, account(vehicles: [leafVehicle()])),
          'stations' when r.uri.queryParameters['sort'] == 'smart' => reply(
            200,
            page(
              [station('31', 'Trạm dự phòng')],
              pageSize: 3,
              reason: 'no_soc',
            ),
          ),
          'stations' => reply(200, page([])),
          _ => throw StateError('Unexpected route'),
        },
      );
      final smartRequests = _requests(
        fixture,
        'stations',
      ).where((r) => r.uri.queryParameters['sort'] == 'smart');
      final field = _key('suggestion-soc');
      final submit = _key('submit-smart-search');
      final disclosure = find.textContaining('PowerMe gửi điểm đi tới Vietmap');
      final missing = find.text('Chưa nhập mức pin.');
      final atTarget = find.textContaining('Pin đã đạt 80% trở lên');
      final fallbackStation = find.text('Trạm dự phòng');
      final origin = find.text('Điểm đi');
      final useLocation = _key('discovery-use-location');
      Future<void> reveal(Finder finder, double delta) =>
          tester.scrollUntilVisible(
            finder,
            delta,
            scrollable: find.byType(Scrollable).first,
          );

      await _login(
        tester,
        fixture,
        location: location,
        size: const Size(320, 844),
        scale: 2,
      );
      await _tap(tester, _key('open-suggestions'));
      expect(find.byType(TextField), findsOneWidget);
      expect(find.textContaining('Không bắt buộc'), findsOneWidget);
      expect(smartRequests, isEmpty);
      await reveal(origin, 160);
      await _tap(tester, origin);
      await reveal(useLocation, 160);
      await _tap(tester, useLocation);
      await reveal(origin, -160);
      await _tap(tester, origin);
      await reveal(submit, -160);
      expect(disclosure, findsNothing);
      expect(smartRequests, isEmpty);

      await _tap(tester, submit);
      await reveal(missing, 160);
      expect(missing, findsOneWidget);
      await reveal(fallbackStation, 160);
      expect(fallbackStation, findsOneWidget);
      expect(smartRequests, hasLength(1));
      for (final (index, value) in ['80', '100'].indexed) {
        await reveal(field, -160);
        await _text(tester, 'suggestion-soc', value);
        expect(smartRequests, hasLength(index + 1));
        await _tap(tester, submit);
        expect(tester.widget<TextField>(field).controller?.text, value);
        expect(disclosure, findsNothing);
        await reveal(atTarget, 160);
        expect(atTarget, findsOneWidget);
        expect(missing, findsNothing);
        await reveal(fallbackStation, 160);
        expect(fallbackStation, findsOneWidget);
      }
      expect(smartRequests, hasLength(3));
      for (final request in smartRequests) {
        final query = request.uri.queryParameters;
        expect(query, containsPair('target_soc_percent', '80.0'));
        expect(query, containsPair('latitude', '10.77'));
        expect(query, isNot(contains('soc_percent')));
        expect(query, isNot(contains('location_consent')));
      }

      await reveal(field, -160);
      await _text(tester, 'suggestion-soc', '');
      await reveal(atTarget, 160);
      expect(atTarget, findsOneWidget);
      expect(missing, findsNothing);
      await reveal(field, -160);
      for (final value in ['-1', '101', 'NaN', 'Infinity', 'abc']) {
        await _text(tester, 'suggestion-soc', value);
        await _tap(tester, submit);
        expect(find.textContaining('từ 0% đến 100%'), findsOneWidget);
        expect(disclosure, findsNothing);
      }
      expect(smartRequests, hasLength(3));
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'suggestions send zero and decimal battery and require explicit Vietmap consent',
    (tester) async {
      final location = _DeviceLocation(
        () async => const MapLocation(10.77, 106.66),
      );
      final fixture = DriverApiFixture((r) async {
        final query = r.uri.queryParameters;
        return switch (r.path) {
          'auth/login' => reply(200, tokens(accessA)),
          'me' => reply(200, account(vehicles: [leafVehicle()])),
          'stations' when query['sort'] != 'smart' => reply(200, page([])),
          'stations' when !query.containsKey('soc_percent') => reply(
            200,
            page(
              [station('31', 'Trạm dự phòng')],
              pageSize: 3,
              reason: 'no_soc',
            ),
          ),
          'stations' when !query.containsKey('latitude') => reply(
            200,
            page(
              [station('31', 'Trạm dự phòng')],
              pageSize: 3,
              reason: 'no_location',
            ),
          ),
          'stations' => reply(
            200,
            page(
              [
                {
                  ...station('31', 'Trạm gợi ý', smart: true),
                  if (query['location_consent'] == 'true')
                    'road_estimate': {
                      'distance_m': 4200,
                      'duration_s': 700,
                      'computed_at': '2026-11-13T01:30:00Z',
                      'congested_distance_m': 650,
                    },
                },
              ],
              pageSize: 3,
              rangeKm: 18.5,
              rankingSource: query['location_consent'] == 'true'
                  ? 'vietmap_route'
                  : 'brief',
            ),
          ),
          _ => throw StateError('Unexpected route'),
        };
      });
      await _login(tester, fixture, location: location);
      await _tap(tester, _key('open-suggestions'));
      await _text(tester, 'suggestion-soc', '0');
      await _tap(tester, _key('submit-smart-search'));
      expect(find.textContaining('Chưa chọn điểm đi.'), findsOneWidget);
      final zero = _requests(fixture, 'stations').last.uri.queryParameters;
      expect(zero, containsPair('soc_percent', '0.0'));
      expect(zero, containsPair('target_soc_percent', '80.0'));
      expect(zero, isNot(contains('latitude')));
      expect(zero, isNot(contains('location_consent')));
      await _tap(tester, find.text('Điểm đi'));
      await _tap(tester, _key('discovery-use-location'));
      expect(location.calls, 1);
      expect(
        _requests(fixture, 'stations').last.uri.queryParameters,
        isNot(contains('location_consent')),
      );
      expect(find.textContaining('đường bộ'), findsNothing);
      final requestCount = _requests(fixture, 'stations').length;
      await _text(tester, 'suggestion-soc', '25,5');
      expect(_requests(fixture, 'stations'), hasLength(requestCount));
      expect(
        find.textContaining('PowerMe gửi điểm đi tới Vietmap'),
        findsOneWidget,
      );
      await _tap(tester, _key('submit-smart-search'));
      final decimal = _requests(fixture, 'stations').last.uri.queryParameters;
      expect(decimal, containsPair('soc_percent', '25.5'));
      expect(decimal, containsPair('target_soc_percent', '80.0'));
      expect(decimal, containsPair('latitude', '10.77'));
      expect(decimal, containsPair('location_consent', 'true'));
      await tester.scrollUntilVisible(
        _key('top-station-suggestion'),
        220,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();
      expect(find.text('Trạm gợi ý'), findsOneWidget);
      expect(find.text('Gợi ý hàng đầu'), findsOneWidget);
      expect(find.text('4,2 km đường bộ · 12 phút ước tính'), findsOneWidget);
      expect(find.text('650 m ùn tắc nặng trở lên'), findsOneWidget);
      expect(find.textContaining('Trụ TRU-12 · Cổng 1'), findsOneWidget);
      expect(find.text('24.5 phút'), findsNothing);
      expect(find.text('0 phút'), findsOneWidget);
      expect(find.text('16 phút'), findsOneWidget);
      await tester.scrollUntilVisible(
        _key('suggestion-result-31').hitTestable(),
        320,
        scrollable: find.byType(Scrollable).first,
      );
      await _tap(tester, _key('suggestion-result-31'));
      expect(find.text('Cổng tương thích'), findsOneWidget);
      expect(fixture.requests.any((r) => r.path.endsWith('/route')), false);
    },
  );

  testWidgets(
    'late search and location cannot replace a newer query or cross vehicles or auth',
    (tester) async {
      final oldQuery = Completer<ResponseBody>();
      final oldVehicle = Completer<ResponseBody>();
      final oldLocation = Completer<MapLocation>();
      final location = _DeviceLocation(() => oldLocation.future);
      var vehicle = '9';
      var accountId = '81';
      final fixture = DriverApiFixture((r) async {
        final query = r.uri.queryParameters;
        return switch ((r.method, r.path)) {
          ('POST', 'auth/login') => reply(
            200,
            tokens(accountId == '81' ? accessA : accessB),
          ),
          ('GET', 'me') => reply(
            200,
            account(
              id: accountId,
              vehicles: [
                leafVehicle(isDefault: vehicle == '9'),
                leafVehicle(id: '10', isDefault: vehicle == '10'),
              ],
            ),
          ),
          ('PATCH', 'vehicles/10') => reply(
            200,
            leafVehicle(id: vehicle = '10'),
          ),
          ('GET', 'stations') when query['q'] == 'old' => oldQuery.future,
          ('GET', 'stations') when query['q'] == 'old vehicle' =>
            oldVehicle.future,
          ('GET', 'stations') => reply(
            200,
            page([station('31', 'Kết quả ${query['vehicle_id']}')]),
          ),
          _ => throw StateError('Unexpected route'),
        };
      });
      await _login(tester, fixture, location: location);
      final container = ProviderScope.containerOf(
        tester.element(_key('station-search-query')),
      );
      await _text(tester, 'station-search-query', 'old');
      await _tap(tester, _key('submit-station-search'), settle: false);
      await tester.pump(const Duration(milliseconds: 100));
      await _text(tester, 'station-search-query', 'new');
      await _tap(tester, _key('submit-station-search'));
      oldQuery.complete(reply(200, page([station('32', 'Kết quả cũ')])));
      await tester.pumpAndSettle();
      expect(find.text('Kết quả cũ'), findsNothing);
      await _tap(tester, find.text('Điểm đi và bộ lọc'));
      await _tap(tester, _key('discovery-use-location'), settle: false);
      await tester.pump(const Duration(milliseconds: 100));
      await tester.scrollUntilVisible(
        _key('station-search-query'),
        -200,
        scrollable: find.byType(Scrollable).first,
      );
      await _text(tester, 'station-search-query', 'old vehicle');
      await _tap(tester, _key('submit-station-search'), settle: false);
      await tester.pump(const Duration(milliseconds: 100));
      unawaited(
        container.read(profileControllerProvider.notifier).selectVehicle('10'),
      );
      await tester.pumpAndSettle();
      oldLocation.complete(const MapLocation(10.77, 106.66));
      oldVehicle.complete(reply(200, page([station('32', 'Kết quả xe cũ')])));
      await tester.pumpAndSettle();
      expect(find.text('Kết quả 10'), findsOneWidget);
      expect(find.text('Kết quả xe cũ'), findsNothing);
      final newest = _requests(fixture, 'stations').last;
      expect(newest.uri.queryParameters, containsPair('q', ''));
      expect(newest.uri.queryParameters, isNot(contains('latitude')));
      await _tap(tester, _key('station-result-31'));
      final router = GoRouter.of(tester.element(find.text('Cổng tương thích')));
      container.read(authControllerProvider.notifier).signOut();
      await tester.pumpAndSettle();
      accountId = '82';
      await enterAccount(tester);
      router.go('/station/31');
      await tester.pumpAndSettle();
      expect(find.textContaining('Hãy chọn trạm từ kết quả'), findsOneWidget);
    },
  );
}
