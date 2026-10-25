import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/station_models.dart';

final stationRepositoryProvider = Provider<FakeStationRepository>(
  (ref) => FakeStationRepository(),
);
final stationsProvider = Provider<List<Station>>(
  (ref) => ref.watch(stationRepositoryProvider).stations,
);
final stationByIdProvider = Provider.family<Station?, String>((ref, id) {
  for (final station in ref.watch(stationsProvider)) {
    if (station.id == id) return station;
  }
  return null;
});

class FakeStationRepository {
  List<Station> get stations {
    final now = DateTime.now().toUtc();
    return [
      Station(
        id: 'station-powerme-center',
        name: 'PowerMe Nguyễn Huệ',
        address: '12 Nguyễn Huệ, Quận 1, TP. Hồ Chí Minh',
        distanceKm: 1.2,
        availability: StationAvailability.available,
        updatedAt: now.subtract(const Duration(minutes: 2)),
        connectors: [
          Connector(
            id: 'connector-01',
            type: ConnectorType.ccs2,
            powerKw: 120,
            availability: StationAvailability.available,
          ),
          Connector(
            id: 'connector-02',
            type: ConnectorType.ccs2,
            powerKw: 120,
            availability: StationAvailability.busy,
          ),
        ],
      ),
      Station(
        id: 'station-powerme-landmark',
        name: 'PowerMe Landmark 81',
        address: '208 Nguyễn Hữu Cảnh, Bình Thạnh, TP. Hồ Chí Minh',
        distanceKm: 3.8,
        availability: StationAvailability.available,
        updatedAt: now.subtract(const Duration(minutes: 5)),
        connectors: [
          Connector(
            id: 'connector-11',
            type: ConnectorType.ccs2,
            powerKw: 160,
            availability: StationAvailability.available,
          ),
          Connector(
            id: 'connector-12',
            type: ConnectorType.type2,
            powerKw: 22,
            availability: StationAvailability.available,
          ),
        ],
      ),
      Station(
        id: 'station-powerme-airport',
        name: 'PowerMe Tân Sơn Nhất',
        address: 'Trường Sơn, Tân Bình, TP. Hồ Chí Minh',
        distanceKm: 7.4,
        availability: StationAvailability.busy,
        updatedAt: now.subtract(const Duration(minutes: 18)),
        connectors: [
          Connector(
            id: 'connector-21',
            type: ConnectorType.ccs2,
            powerKw: 60,
            availability: StationAvailability.busy,
          ),
          Connector(
            id: 'connector-22',
            type: ConnectorType.chademo,
            powerKw: 60,
            availability: StationAvailability.offline,
          ),
        ],
      ),
    ];
  }
}
