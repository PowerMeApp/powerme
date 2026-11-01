import '../domain/station_route.dart';
import 'road_route_fixtures.dart';
import '../../../demo/demo_store.dart';
import '../../auth/domain/auth_scope.dart';
import '../domain/station.dart';
import '../domain/station_repository.dart';
import '../domain/station_actions.dart';

class MockStationRepository
    implements
        StationRepository,
        StationSuggestionPreferences,
        StationRouteRepository {
  MockStationRepository(
    this._store, {
    AuthScope? scope,
    this.showRestricted = false,
  }) : _scope = scope ?? _store.activeScope;
  final DemoStore _store;
  final AuthScope _scope;
  final bool showRestricted;
  SuggestionMode suggestionMode = SuggestionMode.fastest;
  int? suggestionBattery;
  int? suggestionTarget;
  @override
  void configureSuggestions(SuggestionMode mode, int? battery, int? target) {
    suggestionMode = mode;
    suggestionBattery = battery;
    suggestionTarget = target;
  }

  @override
  Future<List<StationOption>> find(String vehicleId, String query) async {
    _store.requireScope(_scope);
    final vehicle = _store.profile;
    if (vehicle.vehicleId != vehicleId) {
      throw StateError('Vehicle not in local scope.');
    }
    final normalized = _fold(query.trim());
    final matches = _store.stations.map(observed).where((station) {
      final matches = _fold(
        '${station.name} ${station.address}',
      ).contains(normalized);
      return matches &&
          (!station.vinfastOnly || vehicle.isVinFast || showRestricted) &&
          station.connectors.any(
            (c) => vehicle.compatibleConnectors.contains(c.type),
          );
    });
    return List.unmodifiable(
      matches.expand(
        (station) => station.connectors
            .where((c) => vehicle.compatibleConnectors.contains(c.type))
            .map(
              (connector) => StationOption(
                station: station,
                connectorId: '${station.id}/${connector.number}',
                status: connector.status,
                updatedAt: connector.updatedAt,
              ),
            ),
      ),
    );
  }

  @override
  Future<List<StationOption>> suggest(String vehicleId) async {
    final mode = suggestionMode;
    final batteryPercent = suggestionBattery;
    final targetPercent = suggestionTarget;

    _store.requireScope(_scope);
    final target = targetPercent ?? 80;
    if (batteryPercent != null &&
            (batteryPercent < 1 || batteryPercent > 100) ||
        target < 1 ||
        target > 100 ||
        batteryPercent != null && target <= batteryPercent) {
      throw StateError('Kiểm tra mức pin và mục tiêu.');
    }
    final candidates = await MockStationRepository(
      _store,
      scope: _scope,
    ).find(vehicleId, '');
    _store.requireScope(_scope);
    final vehicle = _store.profile.selectedVehicle!;
    final known = vehicle.model == 'IONIQ 5' || vehicle.model == 'Leaf';
    final capacityWh = vehicle.model == 'Leaf' ? 40000 : 72600;
    final rangeKm = vehicle.model == 'Leaf' ? 270 : 430;
    final estimates = <StationOption>[];
    for (final o in candidates) {
      if (o.station.vinfastOnly ||
          o.status != StationStatus.available ||
          o.connector.quality != DataQuality.observed ||
          _store.connectorOverrides.containsKey(o.connectorId)) {
        continue;
      }
      final road = await route(vehicleId, o.station.id, batteryPercent);
      if (road == null || road.reachability == RouteReachability.insufficient) {
        continue;
      }
      final distanceM = road.distanceM;
      final hasRange = known && batteryPercent != null;
      if (hasRange && distanceM * 100 > batteryPercent * rangeKm * 800) {
        continue;
      }
      final energyWh = hasRange
          ? (capacityWh * (target - batteryPercent) / 100).ceil()
          : null;
      final vehiclePowerW = vehicle.model == 'Leaf' ? 50000 : 150000;
      final powerW = o.connector.powerW < vehiclePowerW
          ? o.connector.powerW
          : vehiclePowerW;
      final seconds = energyWh == null
          ? null
          : (energyWh * 3600 / powerW).ceil();
      final tariff = o.station.tariffVndPerKwh;
      final cost = energyWh == null || tariff == null
          ? null
          : (energyWh * tariff / 1000).ceil();
      estimates.add(
        StationOption(
          station: o.station,
          connectorId: o.connectorId,
          status: o.status,
          updatedAt: o.updatedAt,
          estimatedTariffVndPerKwh: tariff,
          etaSeconds: road.travelSeconds,
          roadRoute: road,
          waitingSeconds: 0,
          chargingSeconds: seconds,
          estimatedCostVnd: cost,
          estimateSource: hasRange
              ? 'Ước tính đến $target% · công suất xe và cổng'
              : 'Chưa đủ thông tin xe hoặc mức pin để ước tính',
          rangeLabel: hasRange
              ? 'Đường bộ ${distanceM / 1000} km · trong tầm pin dự kiến'
              : 'Chưa xác định tầm hoạt động',
          suggestionReason: switch (mode) {
            SuggestionMode.fastest =>
              'Tổng thời gian di chuyển, chờ và sạc ngắn hơn',
            SuggestionMode.cheapest => 'Chi phí năng lượng ước tính thấp hơn',
            SuggestionMode.nearest =>
              'Đường bộ ngắn hơn trong các trạm phù hợp tầm pin',
          },
        ),
      );
    }
    int total(StationOption o) =>
        o.etaSeconds! + (o.waitingSeconds ?? 0) + (o.chargingSeconds ?? 0);
    estimates.sort(
      (a, b) => mode == SuggestionMode.nearest
          ? a.roadRoute!.distanceM.compareTo(b.roadRoute!.distanceM)
          : mode == SuggestionMode.cheapest &&
                a.estimatedCostVnd != null &&
                b.estimatedCostVnd != null
          ? a.estimatedCostVnd!.compareTo(b.estimatedCostVnd!)
          : total(a).compareTo(total(b)),
    );
    return [
      for (var i = 0; i < estimates.length && i < 3; i++)
        StationOption(
          station: estimates[i].station,
          connectorId: estimates[i].connectorId,
          status: estimates[i].status,
          updatedAt: estimates[i].updatedAt,
          rank: i + 1,
          roadRoute: estimates[i].roadRoute,
          etaSeconds: estimates[i].etaSeconds,
          waitingSeconds: estimates[i].waitingSeconds,
          chargingSeconds: estimates[i].chargingSeconds,
          estimatedCostVnd: estimates[i].estimatedCostVnd,
          estimatedTariffVndPerKwh: estimates[i].estimatedTariffVndPerKwh,
          estimateSource: estimates[i].estimateSource,
          rangeLabel: estimates[i].rangeLabel,
          suggestionReason: estimates[i].suggestionReason,
        ),
    ];
  }

  @override
  RoadMapScene get mapScene => roadMapScene;

  @override
  Future<RoadRoute?> route(
    String vehicleId,
    String stationId,
    int? battery,
  ) async {
    _store.requireScope(_scope);
    if (vehicleId != _store.profile.vehicleId) {
      throw StateError('Xe không thuộc lượt tìm hiện tại.');
    }
    if (battery != null && (battery < 1 || battery > 100)) {
      throw StateError('Mức pin cần từ 1 đến 100%.');
    }
    if (getById(stationId) == null) return null;
    final fixture = roadRouteFixtures[stationId];
    if (fixture == null) return null;
    final vehicle = _store.profile.selectedVehicle;
    final known = vehicle?.model == 'IONIQ 5' || vehicle?.model == 'Leaf';
    final use = vehicle?.model == 'Leaf'
        ? fixture.batteryUse * 2
        : fixture.batteryUse;
    final arrival = !known || battery == null ? null : battery - use;
    return RoadRoute(
      stationId: stationId,
      points: List.unmodifiable(fixture.points),
      slowSegments: List.unmodifiable(fixture.slow),
      distanceM: fixture.distanceM,
      travelSeconds: fixture.seconds,
      trafficDelaySeconds: fixture.delay,
      traffic: fixture.delay > 0 ? TrafficLevel.slow : TrafficLevel.clear,
      batteryAtArrivalPercent: arrival == null || arrival < 0 ? null : arrival,
      reachability: arrival == null
          ? RouteReachability.unknown
          : arrival < 1
          ? RouteReachability.insufficient
          : RouteReachability.reachable,
      via: fixture.via,
      updatedAt: DateTime.utc(2026, 10, 30, 3, 16),
    );
  }

  @override
  Station? getById(String id) {
    if (_scope.principalId.isEmpty) return null;
    _store.requireScope(_scope);
    for (final station in _store.stations) {
      if (station.id == id &&
          (!station.vinfastOnly ||
              _store.profile.isVinFast ||
              showRestricted) &&
          station.connectors.any(
            (c) => _store.profile.compatibleConnectors.contains(c.type),
          )) {
        return observed(station);
      }
    }
    return null;
  }

  Station observed(Station s) {
    final connectors = s.connectors.map((c) {
      final id = '${s.id}/${c.number}';
      return StationConnector(
        number: c.number,
        type: c.type,
        powerW: c.powerW,
        status: _store.connectorOverrides[id] ?? c.status,
        updatedAt: _store.connectorUpdatedAt[id] ?? c.updatedAt,
        quality: c.quality,
      );
    }).toList();
    return Station(
      id: s.id,
      name: s.name,
      address: s.address,
      status: s.status,
      quality: s.quality,
      updatedAt: s.updatedAt,
      availableCount: connectors
          .where((c) => c.status == StationStatus.available)
          .length,
      connectors: List.unmodifiable(connectors),
      vinfastOnly: s.vinfastOnly,
      operatorName: s.operatorName,
      tariffVndPerKwh: s.tariffVndPerKwh,
      reportedIssue:
          s.reportedIssue ||
          connectors.any(
            (c) => _store.reportedConnectors.contains('${s.id}/${c.number}'),
          ),
      location: s.location,
      mapX: s.mapX,
      mapY: s.mapY,
    );
  }

  String _fold(String text) {
    var result = text.toLowerCase();
    const accents = {
      'a': 'àáạảãâầấậẩẫăằắặẳẵ',
      'e': 'èéẹẻẽêềếệểễ',
      'i': 'ìíịỉĩ',
      'o': 'òóọỏõôồốộổỗơờớợởỡ',
      'u': 'ùúụủũưừứựửữ',
      'y': 'ỳýỵỷỹ',
      'd': 'đ',
    };
    for (final group in accents.entries) {
      for (final rune in group.value.runes) {
        result = result.replaceAll(String.fromCharCode(rune), group.key);
      }
    }
    return result;
  }
}
