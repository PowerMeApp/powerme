import 'dart:async';
import 'package:driver_app/demo/demo_store.dart';
import 'package:driver_app/features/auth/domain/auth_scope.dart';
import 'package:driver_app/features/profile/application/profile_controller.dart';
import 'package:driver_app/features/profile/data/mock_profile_repository.dart';
import 'package:driver_app/features/profile/domain/driver_profile.dart';
import 'package:driver_app/features/stations/application/stations_controller.dart';
import 'package:driver_app/features/stations/data/mock_station_repository.dart';
import 'package:driver_app/features/stations/domain/station.dart';
import 'package:driver_app/features/stations/domain/station_repository.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'Search accent folding, connector identity, compatibility and vehicle rejection',
    () async {
      final store = DemoStore();
      final repo = MockStationRepository(store);
      final results = await repo.find('vehicle-ioniq5', 'nguyen hue');
      expect(results.length, 2);
      expect(results.map((o) => o.connectorId).toSet().length, 2);
      expect(results.first.updatedAt, results.first.connector.updatedAt);
      expect(results.first.etaSeconds, isNull);
      await expectLater(repo.find('other-vehicle', ''), throwsStateError);
      expect((await repo.suggest('vehicle-ioniq5')).length, 3);
      store.profile = DriverProfile(
        displayName: 'An',
        vehicles: [
          Vehicle(
            id: 'other',
            brand: 'Nissan',
            model: 'Leaf',
            connectors: ['CHAdeMO'],
          ),
        ],
        selectedVehicleId: 'other',
        language: AppLanguage.vietnamese,
      );
      expect((await repo.find('other', '')).map((o) => o.station.id), [
        'station-powerme-airport',
      ]);
      expect(repo.getById('station-powerme-landmark'), isNull);
      expect(repo.getById('station-powerme-center'), isNull);
    },
  );
  test(
    'Available filter includes busy-first/free-second and excludes stale; groups station once',
    () async {
      final options = await MockStationRepository(
        DemoStore(),
      ).find('vehicle-ioniq5', 'nguyen hue');
      final mixed = options.reversed.toList();
      expect(mixed.first.status, StationStatus.inUse);
      final state = StationsState(
        options: mixed,
        filter: StationFilter.available,
      );
      expect(state.visible.single.status, StationStatus.available);
      expect(state.listings.single.available, 1);
      expect(StationsState(options: mixed).stations.length, 1);
      final original = options.first.station;
      final stale = Station(
        id: 'stale',
        name: 'Stale',
        address: '',
        status: StationStatus.available,
        quality: DataQuality.stale,
        updatedAt: original.updatedAt,
        availableCount: 1,
        connectors: [
          StationConnector(
            number: 1,
            type: 'CCS2',
            powerW: 120000,
            status: StationStatus.available,
            updatedAt: original.updatedAt,
            quality: DataQuality.stale,
          ),
        ],
      );
      expect(
        StationsState(
          filter: StationFilter.available,
          options: [
            StationOption(
              station: stale,
              connectorId: 'stale/1',
              status: StationStatus.available,
              updatedAt: stale.updatedAt,
            ),
          ],
        ).visible,
        isEmpty,
      );
    },
  );
  test(
    'Late query, scope generation, vehicle change, error/retry and dispose guards',
    () async {
      final store = DemoStore();
      final repo = PendingRepository();
      final scope = StateProviderForTest();
      final container = ProviderContainer(
        overrides: [
          profileRepositoryProvider.overrideWithValue(
            MockProfileRepository(store),
          ),
          stationRepositoryProvider.overrideWithValue(repo),
          localScopeProvider.overrideWith((ref) => ref.watch(scope.provider)),
        ],
      );
      final subscription = container.listen(
        stationsControllerProvider,
        (_, _) {},
      );
      final controller = container.read(stationsControllerProvider.notifier);
      await Future<void>.delayed(Duration.zero);
      repo.requests.removeAt(0).complete([]);
      await Future<void>.delayed(Duration.zero);
      final a = controller.find('vehicle-ioniq5', 'A');
      final b = controller.find('vehicle-ioniq5', 'B');
      repo.requests[1].complete([]);
      await b;
      repo.requests[0].completeError(StateError('old'));
      await a;
      expect(container.read(stationsControllerProvider).query, 'B');
      expect(container.read(stationsControllerProvider).failed, isFalse);
      repo.requests.clear();
      final oldScope = controller.find('vehicle-ioniq5', 'old scope');
      container.read(scope.provider.notifier).next();
      await container.pump();
      repo.requests[0].completeError(StateError('late scope'));
      await oldScope;
      expect(
        container.read(stationsControllerProvider).query,
        isNot('old scope'),
      );
      repo.requests.last.complete([]);
      await Future<void>.delayed(Duration.zero);
      repo.requests.clear();
      final oldVehicle = controller.find('vehicle-ioniq5', 'old vehicle');
      store.profile = DriverProfile(
        displayName: 'An',
        vehicles: [
          Vehicle(
            id: 'new',
            brand: 'Nissan',
            model: 'Leaf',
            connectors: ['CHAdeMO'],
          ),
        ],
        selectedVehicleId: 'new',
        language: AppLanguage.vietnamese,
      );
      container.invalidate(profileControllerProvider);
      await container.pump();
      repo.requests[0].completeError(StateError('late vehicle'));
      await oldVehicle;
      expect(
        container.read(stationsControllerProvider).query,
        isNot('old vehicle'),
      );
      expect(repo.vehicles.last, 'new');
      repo.requests.last.completeError(StateError('offline'));
      await Future<void>.delayed(Duration.zero);
      expect(container.read(stationsControllerProvider).failed, isTrue);
      repo.requests.clear();
      final retry = controller.find('new', 'retry');
      repo.requests.single.complete([]);
      await retry;
      expect(container.read(stationsControllerProvider).failed, isFalse);
      repo.requests.clear();
      final beforeClear = controller.find('new', 'before clear');
      controller.clear();
      repo.requests[1].complete([]);
      await Future<void>.delayed(Duration.zero);
      repo.requests[0].completeError(StateError('late cleared search'));
      await beforeClear;
      expect(container.read(stationsControllerProvider).query, '');
      expect(container.read(stationsControllerProvider).failed, isFalse);
      repo.requests.clear();
      final disposed = controller.find('new', 'disposed');
      subscription.close();
      container.dispose();
      repo.requests.single.complete([]);
      await disposed;
    },
  );
}

class PendingRepository implements StationRepository {
  final requests = <Completer<List<StationOption>>>[];
  final vehicles = <String>[];
  @override
  Future<List<StationOption>> find(String vehicleId, String query) {
    vehicles.add(vehicleId);
    final c = Completer<List<StationOption>>();
    requests.add(c);
    return c.future;
  }

  @override
  Station? getById(String id) => null;
  @override
  Future<List<StationOption>> suggest(String vehicleId) =>
      throw UnsupportedError('pending');
}

class StateProviderForTest {
  final provider = NotifierProvider<TestScope, AuthScope>(TestScope.new);
}

class TestScope extends Notifier<AuthScope> {
  @override
  AuthScope build() => const AuthScope(principalId: 'same', generation: 1);
  void next() => state = AuthScope(
    principalId: state.principalId,
    generation: state.generation + 1,
  );
}
