import '../domain/map_location.dart';
import '../domain/station.dart';

// WP3: owner-approved area; these coordinates represent simulated pillars only.
final dongHoaStations = List<Station>.unmodifiable([
  for (final site in [
    (
      'station-powerme-nvhs-01',
      'PowerMe Đông Hòa 01',
      10.87505,
      106.79965,
      120000,
    ),
    (
      'station-powerme-nvhs-02',
      'PowerMe Đông Hòa 02',
      10.87585,
      106.80055,
      60000,
    ),
  ])
    Station(
      id: site.$1,
      name: site.$2,
      address: 'Gần Nhà Văn hóa Sinh viên · Khu đô thị ĐHQG TP.HCM, Đông Hòa',
      location: MapLocation(site.$3, site.$4),
      tariffVndPerKwh: 4500,
      status: StationStatus.available,
      quality: DataQuality.observed,
      updatedAt: DateTime.utc(2026, 10, 30, 3, 16),
      availableCount: 1,
      connectors: [
        StationConnector(
          number: 1,
          type: 'CCS2',
          powerW: site.$5,
          status: StationStatus.available,
          quality: DataQuality.observed,
          updatedAt: DateTime.utc(2026, 10, 30, 3, 16),
        ),
      ],
    ),
]);
