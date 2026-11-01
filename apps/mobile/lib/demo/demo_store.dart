import '../features/stations/data/dong_hoa_station_fixtures.dart';
import '../features/profile/domain/driver_profile.dart';
import '../features/auth/domain/auth_scope.dart';
import '../features/stations/domain/station.dart';
import 'money_store.dart';

class DemoStore {
  DemoStore({DriverProfile? profile})
    : profile =
          profile ??
          DriverProfile(
            displayName: 'Minh Nguyễn',
            email: 'minh@powerme.local',
            vehicles: [
              Vehicle(
                id: 'vehicle-ioniq5',
                brand: 'Hyundai',
                model: 'IONIQ 5',
                connectors: ['CCS2', 'Type 2'],
              ),
            ],
            selectedVehicleId: 'vehicle-ioniq5',
            language: AppLanguage.vietnamese,
          ) {
    profiles['driver-minh'] = this.profile;
    profiles['driver-an'] = DriverProfile(
      displayName: 'An Trần',
      email: 'an@powerme.local',
      language: AppLanguage.vietnamese,
      vehicles: [
        Vehicle(
          id: 'vehicle-leaf',
          brand: 'Nissan',
          model: 'Leaf',
          connectors: ['CHAdeMO', 'Type 2'],
        ),
      ],
      selectedVehicleId: 'vehicle-leaf',
    );
  }
  DriverProfile profile;
  final profiles = <String, DriverProfile>{};
  AuthScope activeScope = const AuthScope(
    principalId: 'driver-minh',
    generation: 1,
  );
  int nextVehicle = 0;
  final money = MoneyStore();
  final connectorClaimOwners = <String, String>{};
  final reportedConnectors = <String>{};
  final connectorUpdatedAt = <String, DateTime>{};
  final connectorOverrides = <String, StationStatus>{};
  void bind(AuthScope scope) {
    activeScope = scope;
    profile = profiles[scope.principalId] ?? DriverProfile.empty;
  }

  void requireScope(AuthScope scope) {
    if (scope.principalId.isEmpty ||
        scope.principalId != activeScope.principalId ||
        scope.generation != activeScope.generation ||
        !profiles.containsKey(scope.principalId)) {
      throw StateError('Expired profile scope.');
    }
  }

  void save(AuthScope scope, DriverProfile value) {
    requireScope(scope);
    profiles[scope.principalId] = value;
    profile = value;
  }

  final stations = List<Station>.unmodifiable([
    ...dongHoaStations,
    Station(
      id: 'station-powerme-center',
      tariffVndPerKwh: 4500,
      mapX: 0.65,
      mapY: 0.72,
      name: 'PowerMe Nguyễn Huệ',
      address: '12 Nguyễn Huệ, Quận 1, TP. Hồ Chí Minh',
      status: StationStatus.available,
      quality: DataQuality.observed,
      updatedAt: DateTime.utc(2026, 10, 28, 3, 16),
      availableCount: 1,
      connectors: [
        StationConnector(
          number: 1,
          type: 'CCS2',
          powerW: 120000,
          status: StationStatus.available,
          updatedAt: DateTime.utc(2026, 10, 28, 3, 16),
          quality: DataQuality.observed,
        ),
        StationConnector(
          number: 2,
          type: 'CCS2',
          powerW: 120000,
          status: StationStatus.inUse,
          updatedAt: DateTime.utc(2026, 10, 28, 3, 16),
          quality: DataQuality.observed,
        ),
      ],
    ),
    Station(
      id: 'station-powerme-landmark',
      name: 'PowerMe Landmark 81',
      vinfastOnly: true,
      address: '208 Nguyễn Hữu Cảnh, Bình Thạnh, TP. Hồ Chí Minh',
      status: StationStatus.available,
      quality: DataQuality.observed,
      updatedAt: DateTime.utc(2026, 10, 28, 3, 13),
      availableCount: 2,
      connectors: [
        StationConnector(
          number: 1,
          type: 'CCS2',
          powerW: 160000,
          status: StationStatus.available,
          updatedAt: DateTime.utc(2026, 10, 28, 3, 13),
          quality: DataQuality.observed,
        ),
        StationConnector(
          number: 2,
          type: 'Type 2',
          powerW: 22000,
          status: StationStatus.available,
          updatedAt: DateTime.utc(2026, 10, 28, 3, 13),
          quality: DataQuality.observed,
        ),
      ],
    ),
    Station(
      id: 'station-powerme-airport',
      tariffVndPerKwh: 3900,
      reportedIssue: true,
      mapX: 0.22,
      mapY: 0.18,
      name: 'PowerMe Tân Sơn Nhất',
      address: 'Trường Sơn, Tân Bình, TP. Hồ Chí Minh',
      status: StationStatus.inUse,
      quality: DataQuality.stale,
      updatedAt: DateTime.utc(2026, 10, 28, 2, 58),
      availableCount: 0,
      connectors: [
        StationConnector(
          number: 1,
          type: 'CCS2',
          powerW: 60000,
          status: StationStatus.inUse,
          updatedAt: DateTime.utc(2026, 10, 28, 2, 58),
          quality: DataQuality.stale,
        ),
        StationConnector(
          number: 2,
          type: 'CHAdeMO',
          powerW: 60000,
          status: StationStatus.offline,
          updatedAt: DateTime.utc(2026, 10, 28, 2, 58),
          quality: DataQuality.stale,
        ),
      ],
    ),
    for (final entry in [
      (
        'station-evone-thao-dien',
        'EV One Thảo Điền',
        'EV One',
        'Thảo Điền, Thủ Đức',
        4200,
        0.82,
        0.35,
      ),
      (
        'station-evercharge-bach-dang',
        'EverCharge Bạch Đằng',
        'EverCharge',
        'Bạch Đằng, Bình Thạnh',
        4800,
        0.43,
        0.48,
      ),
    ])
      Station(
        id: entry.$1,
        name: entry.$2,
        operatorName: entry.$3,
        address: entry.$4,
        tariffVndPerKwh: entry.$5,
        mapX: entry.$6,
        mapY: entry.$7,
        status: StationStatus.available,
        quality: DataQuality.observed,
        updatedAt: DateTime.utc(2026, 10, 29, 3, 16),
        availableCount: 1,
        connectors: [
          StationConnector(
            number: 1,
            type: 'CCS2',
            powerW: 120000,
            status: StationStatus.available,
            updatedAt: DateTime.utc(2026, 10, 29, 3, 16),
            quality: DataQuality.observed,
          ),
        ],
      ),
  ]);
}
