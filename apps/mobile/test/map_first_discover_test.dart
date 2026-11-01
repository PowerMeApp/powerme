import 'dart:async';
import 'package:driver_app/app/composition/vietmap_config.dart';
import 'package:driver_app/features/stations/presentation/vietmap_surface.dart';
import 'package:driver_app/features/stations/domain/station.dart';
import 'package:driver_app/app/composition/demo_app.dart';
import 'package:driver_app/app/powerme_app.dart';
import 'package:driver_app/demo/demo_store.dart';
import 'package:driver_app/features/auth/application/auth_controller.dart';
import 'package:driver_app/features/auth/domain/auth_scope.dart';
import 'package:driver_app/features/profile/application/profile_controller.dart';
import 'package:driver_app/features/profile/data/mock_profile_repository.dart';
import 'package:driver_app/features/profile/domain/vehicle.dart';
import 'package:driver_app/features/stations/application/station_actions_controller.dart';
import 'package:driver_app/features/stations/application/station_route_controller.dart';
import 'package:driver_app/features/stations/application/stations_controller.dart';
import 'package:driver_app/features/stations/data/mock_station_repository.dart';
import 'package:driver_app/features/stations/domain/station_actions.dart';
import 'package:driver_app/features/stations/domain/station_route.dart';
import 'package:driver_app/features/stations/presentation/road_map_canvas.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'test_helpers.dart';

class _DelayedRoads extends MockStationRepository {
  _DelayedRoads(super.store);
  final pending = <Completer<RoadRoute?>>[];
  @override
  Future<RoadRoute?> route(String vehicleId, String stationId, int? battery) {
    final value = Completer<RoadRoute?>();
    pending.add(value);
    return value.future;
  }
}

class _Scope extends Notifier<AuthScope> {
  @override
  AuthScope build() =>
      const AuthScope(principalId: 'driver-minh', generation: 1);
  void next() => state = AuthScope(
    principalId: state.principalId,
    generation: state.generation + 1,
  );
}

void main() {
  WidgetController.hitTestWarningShouldBeFatal = true;
  test(
    'Every route follows declared roads, has traffic ETA and never fabricates missing route',
    () async {
      final repo = MockStationRepository(DemoStore(), showRestricted: true);
      for (final id in [
        'station-powerme-center',
        'station-evone-thao-dien',
        'station-evercharge-bach-dang',
        'station-powerme-airport',
      ]) {
        final route = (await repo.route('vehicle-ioniq5', id, 30))!;
        expect(route.points.length, greaterThan(2));
        expect(route.travelSeconds, greaterThan(route.trafficDelaySeconds!));
        expect(route.reachability, RouteReachability.reachable);
        expect(route.batteryAtArrivalPercent, lessThan(30));
        for (var i = 0; i < route.points.length - 1; i++) {
          final a = route.points[i];
          final b = route.points[i + 1];
          expect(a.x == b.x || a.y == b.y, isTrue);
          bool onSegment(MapPoint p, MapPoint c, MapPoint d) =>
              c.x == d.x &&
                  p.x == c.x &&
                  p.y >= (c.y < d.y ? c.y : d.y) &&
                  p.y <= (c.y > d.y ? c.y : d.y) ||
              c.y == d.y &&
                  p.y == c.y &&
                  p.x >= (c.x < d.x ? c.x : d.x) &&
                  p.x <= (c.x > d.x ? c.x : d.x);
          expect(
            repo.mapScene.roads.any((r) {
              for (var j = 0; j < r.points.length - 1; j++) {
                if (onSegment(a, r.points[j], r.points[j + 1]) &&
                    onSegment(b, r.points[j], r.points[j + 1])) {
                  return true;
                }
              }
              return false;
            }),
            isTrue,
            reason: '$id segment $i must lie on a declared road',
          );
        }
      }
      expect(
        await repo.route('vehicle-ioniq5', 'station-powerme-landmark', 30),
        isNull,
      );
      expect(await repo.route('vehicle-ioniq5', 'missing', 30), isNull);
      expect(
        (await repo.route(
          'vehicle-ioniq5',
          'station-powerme-center',
          null,
        ))!.batteryAtArrivalPercent,
        isNull,
      );
      expect(
        (await repo.route(
          'vehicle-ioniq5',
          'station-powerme-center',
          1,
        ))!.reachability,
        RouteReachability.insufficient,
      );
      await expectLater(
        repo.route('not-owned', 'station-powerme-center', 30),
        throwsStateError,
      );
      await expectLater(
        repo.route('vehicle-ioniq5', 'station-powerme-center', 101),
        throwsStateError,
      );
    },
  );

  test(
    'Nearest road is adapter-ranked; fastest still includes travel, wait and charging',
    () async {
      final repo = MockStationRepository(DemoStore());
      repo.configureSuggestions(SuggestionMode.nearest, 30, 80);
      final nearest = await repo.suggest('vehicle-ioniq5');
      expect(nearest.map((o) => o.roadRoute!.distanceM), [3500, 5000, 8500]);
      expect(nearest.first.roadRoute!.batteryAtArrivalPercent, 28);
      expect(nearest.first.etaSeconds, 660);
      repo.configureSuggestions(SuggestionMode.fastest, 30, 80);
      final fastest = await repo.suggest('vehicle-ioniq5');
      final times = fastest
          .map((o) => o.etaSeconds! + o.waitingSeconds! + o.chargingSeconds!)
          .toList();
      expect(times, orderedEquals([...times]..sort()));
      repo.configureSuggestions(SuggestionMode.nearest, 1, 80);
      expect(await repo.suggest('vehicle-ioniq5'), isEmpty);
    },
  );

  test(
    'Late route cannot overwrite station, cleared state, changed vehicle/auth or disposed controller',
    () async {
      final store = DemoStore();
      final repo = _DelayedRoads(store);
      final scopes = NotifierProvider<_Scope, AuthScope>(_Scope.new);
      final container = ProviderContainer(
        overrides: [
          authScopeProvider.overrideWith((ref) => ref.watch(scopes)),
          profileRepositoryProvider.overrideWithValue(
            MockProfileRepository(store),
          ),
          stationRepositoryProvider.overrideWithValue(repo),
        ],
      );
      final sub = container.listen(stationRouteControllerProvider, (_, _) {});
      final c = container.read(stationRouteControllerProvider.notifier);
      final a = c.preview('station-powerme-center');
      c.select('station-evone-thao-dien');
      repo.pending[0].complete(null);
      await a;
      expect(
        container.read(stationRouteControllerProvider).stationId,
        'station-evone-thao-dien',
      );
      final b = c.preview('station-powerme-center');
      c.clear();
      repo.pending[1].complete(null);
      await b;
      expect(container.read(stationRouteControllerProvider).stationId, isNull);
      final profile = container.read(profileControllerProvider.notifier);
      expect(
        await profile.saveVehicle(
          const VehicleDraft(
            brand: 'Nissan',
            model: 'Leaf',
            connectors: ['CHAdeMO'],
          ),
          null,
        ),
        isTrue,
      );
      final otherVehicle = container
          .read(profileControllerProvider)
          .profile
          .vehicles
          .last
          .id;
      final changedVehicle = c.preview('station-powerme-center');
      expect(await profile.selectVehicle(otherVehicle), isTrue);
      await container.pump();
      repo.pending[2].completeError(StateError('old vehicle response'));
      await changedVehicle;
      expect(container.read(stationRouteControllerProvider).stationId, isNull);
      expect(container.read(stationRouteControllerProvider).error, isNull);
      final d = c.preview('station-powerme-center');
      container.read(scopes.notifier).next();
      await container.pump();
      repo.pending[3].completeError(StateError('old response'));
      await d;
      expect(container.read(stationRouteControllerProvider).error, isNull);
      final e = c.preview('station-powerme-center');
      sub.close();
      container.dispose();
      repo.pending[4].complete(null);
      await e;
    },
  );

  Future<ProviderContainer> boot(
    WidgetTester tester, {
    bool narrow = false,
  }) async {
    tester.view.physicalSize = Size(narrow ? 320 : 390, 844);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = narrow ? 2 : 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(const DemoApp());
    await tester.pumpAndSettle();
    await signIn(tester);
    return ProviderScope.containerOf(tester.element(find.byType(PowerMeApp)));
  }

  Future<void> reveal(WidgetTester tester, Finder finder) async {
    final handle = find.byKey(const Key('expand-map-sheet')).hitTestable();
    if (handle.evaluate().isNotEmpty) {
      await tester.tap(handle);
      await tester.pumpAndSettle();
    }
    await tester.scrollUntilVisible(
      finder.hitTestable(),
      120,
      scrollable: find
          .descendant(
            of: find.byType(ListView),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    await tester.pumpAndSettle();
  }

  testWidgets(
    'Vietmap marker selection opens Dong Hoa sheet/detail/start and filters pins',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      // No provider network or key: exercise the native surface's selection wiring.
      await tester.pumpWidget(const DemoApp(mapConfig: VietmapConfig('')));
      await tester.pumpAndSettle();
      await signIn(tester);
      final container = ProviderScope.containerOf(
        tester.element(find.byType(PowerMeApp)),
      );
      final stations = container.read(stationsControllerProvider.notifier);
      await stations.find('vehicle-ioniq5', 'dong hoa');
      await tester.pumpAndSettle();
      VietmapSurface surface() => tester.widget(find.byType(VietmapSurface));
      expect(surface().stations.length, 2);
      surface().onSelect!('station-powerme-nvhs-02');
      await tester.pumpAndSettle();
      expect(surface().selectedId, 'station-powerme-nvhs-02');
      await reveal(tester, find.byKey(const Key('map-station-detail')));
      await tester.tap(find.byKey(const Key('map-station-detail')));
      await tester.pumpAndSettle();
      expect(find.text('PowerMe Đông Hòa 02'), findsWidgets);
      Navigator.of(
        tester.element(find.text('PowerMe Đông Hòa 02').first),
      ).pop();
      await tester.pumpAndSettle();
      await reveal(
        tester,
        find.byKey(const Key('map-start-station-powerme-nvhs-02/1')),
      );
      await tester.tap(
        find.byKey(const Key('map-start-station-powerme-nvhs-02/1')),
      );
      await tester.pumpAndSettle();
      expect(find.text('Bắt đầu sạc'), findsWidgets);
      Navigator.of(tester.element(find.text('Bắt đầu sạc').first)).pop();
      await tester.pumpAndSettle();
      stations.selectFilter(StationFilter.highPower);
      await tester.pumpAndSettle();
      expect(surface().stations.single.id, 'station-powerme-nvhs-01');
      expect(surface().selectedId, isNull);
      expect(container.read(stationRouteControllerProvider).route, isNull);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'Map dominates first screen, station pin opens selection and road preview with three tabs',
    (tester) async {
      final container = await boot(tester);
      expect(
        tester.getSize(find.byType(RoadMapCanvas)).height,
        greaterThan(350),
      );
      expect(find.byType(NavigationBar), findsOneWidget);
      await tester.tap(find.byKey(const Key('pin-station-powerme-center')));
      await tester.pumpAndSettle();
      await reveal(tester, find.byKey(const Key('preview-road-route')));
      await tester.tap(find.byKey(const Key('preview-road-route')));
      await tester.pumpAndSettle();
      expect(
        container.read(stationRouteControllerProvider).route!.distanceM,
        3500,
      );
      expect(find.text('11 phút'), findsOneWidget);
      await reveal(tester, find.byKey(const Key('map-station-detail')));
      await tester.tap(find.byKey(const Key('map-station-detail')));
      await tester.pumpAndSettle();
      expect(find.text('Cổng 01 · CCS2'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  for (final narrow in [false, true]) {
    testWidgets(
      'Suggestions input to road route, battery/traffic, missing route and scaling narrow=$narrow',
      (tester) async {
        final container = await boot(tester, narrow: narrow);
        await reveal(
          tester,
          find.byKey(const Key('nearest-station-suggestions')),
        );
        await tester.tap(find.byKey(const Key('nearest-station-suggestions')));
        await tester.pumpAndSettle();
        await reveal(
          tester,
          find.widgetWithText(ChoiceChip, 'Gần nhất đường bộ'),
        );
        final nearest = tester.widget<ChoiceChip>(
          find.widgetWithText(ChoiceChip, 'Gần nhất đường bộ'),
        );
        expect(nearest.selected, isTrue);
        await reveal(tester, find.byKey(const Key('find-suggestions')));
        await tester.tap(find.byKey(const Key('find-suggestions')));
        await tester.pumpAndSettle();
        expect(
          container
              .read(suggestionControllerProvider)
              .options
              .first
              .roadRoute!
              .batteryAtArrivalPercent,
          28,
        );
        final openRoute = find.byKey(
          const Key('suggestion-route-station-powerme-center/1'),
        );
        await reveal(tester, openRoute);
        await tester.tap(openRoute);
        await tester.pumpAndSettle();
        expect(find.byType(NavigationBar), findsOneWidget);
        expect(
          container
              .read(stationRouteControllerProvider)
              .route!
              .batteryAtArrivalPercent,
          28,
        );
        await reveal(tester, find.text('Pin dự kiến khi đến: 28%'));
        expect(find.text('Có đoạn đi chậm'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await container
            .read(stationRouteControllerProvider.notifier)
            .preview('station-powerme-landmark');
        container.read(showRestrictedProvider.notifier).select(true);
        await tester.pumpAndSettle();
        // No line is invented when a known station has no road fixture.
        await container
            .read(stationRouteControllerProvider.notifier)
            .preview('station-powerme-landmark');
        await tester.pumpAndSettle();
        expect(container.read(stationRouteControllerProvider).route, isNull);
        await reveal(tester, find.textContaining('Chưa có lộ trình đường bộ'));
        expect(
          find.textContaining('Chưa có lộ trình đường bộ'),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
      },
    );
  }
}
