import 'package:driver_app/demo/demo_store.dart';
import 'package:driver_app/features/stations/data/mock_station_repository.dart';
import 'package:driver_app/features/stations/application/stations_controller.dart';
import 'package:driver_app/features/stations/domain/station.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'Two geolocated Dong Hoa pillars retain canonical connectors and metadata',
    () async {
      final store = DemoStore();
      final repo = MockStationRepository(store);
      final options = await repo.find('vehicle-ioniq5', 'dong hoa');
      expect(options.length, 2);
      expect(options.map((o) => o.connectorId).toSet().length, 2);
      for (final option in options) {
        final station = repo.getById(option.station.id)!;
        expect(station.location, same(option.station.location));
        expect((station.location!.latitude - 10.87534).abs(), lessThan(.001));
        expect((station.location!.longitude - 106.80003).abs(), lessThan(.001));
        expect(option.connector.type, 'CCS2');
        expect(option.connectorId, '${station.id}/1');
        expect(await repo.route('vehicle-ioniq5', station.id, 50), isNull);
      }
      expect(store.stations.where((s) => s.location != null).length, 2);
      expect(repo.getById('station-powerme-center'), isNotNull);
    },
  );

  test(
    'Search and power/available filters produce the same marker candidates as lists',
    () async {
      final store = DemoStore();
      final repo = MockStationRepository(store);
      final options = await repo.find('vehicle-ioniq5', 'dong hoa');
      expect(StationsState(options: options).stations.length, 2);
      expect(
        StationsState(
          options: options,
          filter: StationFilter.highPower,
        ).stations.single.id,
        'station-powerme-nvhs-01',
      );
      store.connectorOverrides['station-powerme-nvhs-01/1'] =
          StationStatus.inUse;
      final refreshed = await repo.find('vehicle-ioniq5', 'dong hoa');
      expect(
        StationsState(
          options: refreshed,
          filter: StationFilter.available,
        ).stations.single.id,
        'station-powerme-nvhs-02',
      );
      expect(
        (await repo.find('vehicle-ioniq5', 'dong hoa 02')).single.station.id,
        'station-powerme-nvhs-02',
      );
    },
  );
}
