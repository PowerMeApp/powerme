import 'dart:async';

import 'package:dio/dio.dart';
import 'package:driver_app/core/api/driver_api_exception.dart';
import 'package:driver_app/core/api/driver_api_session.dart';
import 'package:driver_app/features/stations/data/api_station_repository.dart';
import 'package:driver_app/features/stations/domain/map_location.dart';
import 'package:driver_app/features/stations/domain/station.dart';
import 'package:driver_app/features/stations/domain/station_discovery.dart';
import 'package:flutter_test/flutter_test.dart';

import 'driver_api_fixture.dart';
import 'driver_api_widget_test.dart' show api;
import 'driver_discovery_fixture.dart';

Future<DriverApiSession> _session(DriverApiFixture transport) async {
  final session = DriverApiSession(api, adapter: transport);
  addTearDown(session.dispose);
  await session.signIn('test@example.invalid', 'fixture password');
  return session;
}

void main() {
  test(
    'station query is owned, encoded and retried with refreshed bearer',
    () async {
      final transport = DriverApiFixture(
        (r) async => switch (r.path) {
          'auth/login' => reply(200, tokens(accessA)),
          'me' => reply(200, account(vehicles: [leafVehicle()])),
          'auth/refresh' => reply(200, tokens(accessB, login: false)),
          'stations' when r.headers['Authorization'] == 'Bearer $accessA' =>
            reply(401, {'error': 'unauthorized'}),
          'stations' => reply(
            200,
            page([station('31', 'Trạm 31')], page: 2, total: 21),
          ),
          _ => throw StateError('Unexpected route'),
        },
      );
      final repo = ApiStationRepository(await _session(transport), '9');
      await expectLater(
        repo.search('10', initialStationSearch),
        throwsA(isA<DriverApiException>()),
      );
      final result = await repo.search('9', (
        text: '  Điện & Sạc  ',
        page: 2,
        availability: SearchAvailability.available,
        includeVinFastOnly: true,
      ));
      final requests = transport.requests
          .where((r) => r.path == 'stations')
          .toList();
      expect(requests, hasLength(2));
      for (final request in requests) {
        expect(request.method, 'GET');
        expect(request.uri.queryParameters, {
          'vehicle_id': '9',
          'q': 'Điện & Sạc',
          'availability': 'available',
          'include_vinfast_only': 'true',
          'page': '2',
          'page_size': '20',
        });
      }
      expect(requests.last.headers['Authorization'], 'Bearer $accessB');
      expect(result.total, 21);
      expect(result.pageCount, 2);
      expect(result.hasNext, false);
      final hit = result.items.single.station;
      expect(hit.address, isNull);
      expect(hit.connectors.map((c) => c.number), [1, 1]);
      expect(hit.connectors.map((c) => c.id), [firstConnector, bestConnector]);
      expect(hit.connectors.first.powerW, isNull);
      expect(hit.connectors.first.updatedAt, isNull);
      expect(hit.connectors.first.quality, DataQuality.stale);
      expect(hit.connectors.last.powerW, 30500);
      expect(hit.availableCount, 1);
    },
  );

  test(
    'smart preserves site order and opaque best connector and validates battery',
    () async {
      final transport = DriverApiFixture(
        (r) async => switch (r.path) {
          'auth/login' => reply(200, tokens(accessA)),
          'me' => reply(200, account()),
          'stations' => reply(
            200,
            page(
              [
                station('31', 'Z', smart: true),
                {
                  ...station('32', 'A', coordinates: false),
                  'connectors': [
                    {
                      'connector_id': '71',
                      'connector_no': 1,
                      'charge_point_id': '73',
                      'connector_type': 'gbt',
                    },
                  ],
                },
              ],
              pageSize: 3,
              rangeKm: 0,
              rankingSource: 'brief',
            ),
          ),
          _ => throw StateError('Unexpected route'),
        },
      );
      final repo = ApiStationRepository(await _session(transport), '9');
      for (final smart in <SmartSearchInput>[
        (soc: -1, target: 80),
        (soc: 80, target: 80),
        (soc: null, target: 81),
        (soc: double.nan, target: 80),
      ]) {
        await expectLater(
          repo.search('9', initialStationSearch, smart: smart),
          throwsA(isA<DriverApiException>()),
        );
      }
      expect(transport.requests.where((r) => r.path == 'stations'), isEmpty);
      final results = await repo.search(
        '9',
        initialStationSearch,
        origin: const DiscoveryOrigin.device(MapLocation(10.77, 106.66)),
        smart: (soc: 0, target: 80),
      );
      expect(
        transport.requests.last.uri.queryParameters,
        containsPair('page_size', '3'),
      );
      expect(
        transport.requests.last.uri.queryParameters,
        containsPair('sort', 'smart'),
      );
      expect(
        transport.requests.last.uri.queryParameters,
        containsPair('soc_percent', '0.0'),
      );
      expect(
        transport.requests.last.uri.queryParameters,
        containsPair('latitude', '10.77'),
      );
      expect(
        transport.requests.last.uri.queryParameters,
        containsPair('longitude', '106.66'),
      );
      expect(results.rangeKm, 0);
      expect(results.rankingSource, StationRankingSource.brief);
      expect(results.items.map((hit) => hit.station.id), ['31', '32']);
      expect(results.items.first.bestConnector!.id, bestConnector);
      expect(results.items.first.roadEstimate, isNull);
      expect(results.items.first.chargeMinutes, 16);
      expect(results.items.first.maxCostVnd, 0);
      expect(results.items.last.station.location, isNull);
      expect(results.items.last.bestConnector, isNull);
    },
  );

  test(
    'address consent, resolved origin and route use distinct queries and validated GeoJSON',
    () async {
      var routeAttempt = 0;
      final transport = DriverApiFixture(
        (r) async => switch (r.path) {
          'auth/login' => reply(200, tokens(accessA)),
          'me' => reply(200, account()),
          'places/autocomplete' => reply(200, {
            'value': [place],
          }),
          'places/resolve' => reply(200, {
            'value': {...place, 'latitude': 10.77, 'longitude': 106.66},
          }),
          'stations/31/route' => switch (++routeAttempt) {
            1 => reply(200, road()),
            2 => reply(
              200,
              road(
                coordinates: [
                  [10.77, 106.66],
                  [10.8, 106.7],
                ],
              ),
            ),
            _ => reply(503, {
              'error': 'provider_unavailable',
              'detail': 'fixture detail',
            }),
          },
          _ => throw StateError('Unexpected route'),
        },
      );
      final repo = ApiStationRepository(await _session(transport), '9');
      final candidate = (await repo.autocomplete('9', 'Võ Văn Tần')).single;
      expect(transport.requests.last.uri.queryParameters, {
        'vehicle_id': '9',
        'q': 'Võ Văn Tần',
        'location_consent': 'true',
      });
      final origin = await repo.resolve('9', candidate);
      expect(transport.requests.last.uri.queryParameters, {
        'vehicle_id': '9',
        'ref_id': 'auto:fixture',
        'location_consent': 'true',
      });
      Future<StationRoadRoute> route() =>
          repo.roadRoute('9', '31', origin, includeVinFastOnly: true);
      final valid = await route();
      expect(transport.requests.last.uri.queryParameters, {
        'vehicle_id': '9',
        'latitude': '10.77',
        'longitude': '106.66',
        'location_consent': 'true',
        'include_vinfast_only': 'true',
      });
      expect(valid.distanceM, 2400.5);
      expect(valid.instructions, isEmpty);
      expect(valid.trafficSegments, isEmpty);
      expect(valid.congestedDistanceM, isNull);
      expect(valid.points.map((p) => (p.latitude, p.longitude)), [
        (10.77, 106.66),
        (10.78, 106.68),
        (10.8, 106.7),
      ]);
      await expectLater(
        route(),
        throwsA(
          isA<DriverApiException>().having(
            (e) => e.problem,
            'problem',
            DriverApiProblem.malformed,
          ),
        ),
      );
      await expectLater(
        route(),
        throwsA(
          isA<DriverApiException>().having(
            (e) => e.code,
            'code',
            'provider_unavailable',
          ),
        ),
      );
    },
  );

  test(
    'valid optional sections preserve inclusive endpoints and route order',
    () async {
      var attempts = 0;
      final transport = DriverApiFixture(
        (r) async => switch (r.path) {
          'auth/login' => reply(200, tokens(accessA)),
          'me' => reply(200, account()),
          'stations/31/route' when ++attempts == 1 => reply(
            200,
            roadWithTraffic(),
          ),
          'stations/31/route' => reply(200, {
            ...road(),
            'instructions': [
              {'start_index': 0, 'end_index': 3, 'sign': -2},
            ],
            'traffic_segments': [
              {'start_index': 0, 'end_index': 2, 'level': 'low'},
              {'start_index': 1, 'end_index': 2, 'level': 'moderate'},
            ],
            'congested_distance_m': 2401,
          }),
          _ => throw StateError('Unexpected route'),
        },
      );
      final repo = ApiStationRepository(await _session(transport), '9');
      Future<StationRoadRoute> getRoute() => repo.roadRoute(
        '9',
        '31',
        const DiscoveryOrigin.device(MapLocation(10.77, 106.66)),
        includeVinFastOnly: false,
      );
      final valid = await getRoute();
      expect(valid.instructions.map((step) => step.sign), [0, -2, 4]);
      expect(valid.instructions[1].distanceM, 108);
      expect(valid.congestedDistanceM, 300);
      expect(roadTrafficSections(valid.points.length, valid.trafficSegments), [
        (start: 0, end: 1, level: RouteTraffic.heavy),
        (start: 1, end: 2, level: RouteTraffic.unknown),
        (start: 2, end: 3, level: RouteTraffic.low),
      ]);
      final fallback = await getRoute();
      expect(fallback.distanceM, 2400.5);
      expect(fallback.durationSeconds, 422);
      expect(fallback.instructions, isEmpty);
      expect(fallback.trafficSegments, isEmpty);
      expect(fallback.congestedDistanceM, isNull);
      expect(
        roadTrafficSections(fallback.points.length, fallback.trafficSegments),
        [(start: 0, end: 2, level: RouteTraffic.unknown)],
      );
    },
  );

  test(
    'late searches cannot replace latest cache and old auth cannot finish a read',
    () async {
      final oldSearch = Completer<ResponseBody>();
      final oldAuth = Completer<ResponseBody>();
      final oldAuthStarted = Completer<void>();
      var logins = 0;
      final transport = DriverApiFixture(
        (r) async => switch (r.path) {
          'auth/login' => reply(200, tokens(++logins == 1 ? accessA : accessB)),
          'me' => reply(200, account(id: logins == 1 ? '81' : '82')),
          'stations' when r.uri.queryParameters['q'] == 'old' =>
            oldSearch.future,
          'stations' when r.uri.queryParameters['q'] == 'private' => () {
            oldAuthStarted.complete();
            return oldAuth.future;
          }(),
          'stations' => reply(200, page([station('31', 'New')])),
          _ => throw StateError('Unexpected route'),
        },
      );
      final session = await _session(transport);
      final repo = ApiStationRepository(session, '9');
      final old = repo.find('9', 'old');
      await repo.find('9', 'new');
      oldSearch.complete(reply(200, page([station('32', 'Old')])));
      await old;
      expect(repo.getById('31')?.name, 'New');
      expect(repo.getById('32'), isNull);
      final pending = expectLater(
        repo.find('9', 'private'),
        throwsA(
          isA<DriverApiException>().having(
            (e) => e.problem,
            'problem',
            DriverApiProblem.ended,
          ),
        ),
      );
      await oldAuthStarted.future;
      repo.dispose();
      await session.signIn('other@example.invalid', 'fixture password');
      oldAuth.complete(reply(200, page([station('32', 'Private')])));
      await pending;
      expect(repo.getById('32'), isNull);
      expect(session.account?.id, '82');
    },
  );
}
