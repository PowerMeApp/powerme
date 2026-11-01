import 'map_location.dart';
import 'station_route.dart';

enum StationStatus { available, inUse, freeingSoon, unavailable, offline }

enum DataQuality { observed, stale, unknown }

enum StationFilter { all, available, highPower }

class StationConnector {
  const StationConnector({
    required this.number,
    required this.type,
    required this.powerW,
    required this.status,
    required this.updatedAt,
    required this.quality,
  });
  final DateTime updatedAt;
  final DataQuality quality;
  final int number;
  final String type;
  final int powerW;
  final StationStatus status;
}

class Station {
  const Station({
    required this.id,
    required this.name,
    required this.address,
    required this.status,
    required this.quality,
    required this.updatedAt,
    required this.availableCount,
    required this.connectors,
    this.vinfastOnly = false,
    this.operatorName = 'PowerMe',
    this.tariffVndPerKwh,
    this.reportedIssue = false,
    this.location,
    this.mapX = 0.5,
    this.mapY = 0.5,
  });
  final String id;
  final String name;
  final String address;
  final StationStatus status;
  final DataQuality quality;
  final DateTime updatedAt;
  final int availableCount;
  final List<StationConnector> connectors;
  final bool vinfastOnly;
  final String operatorName;
  final int? tariffVndPerKwh;
  final bool reportedIssue;
  final MapLocation? location;
  final double mapX;
  final double mapY;
}

class StationOption {
  const StationOption({
    required this.station,
    required this.connectorId,
    required this.status,
    required this.updatedAt,
    this.rank,
    this.estimatedTariffVndPerKwh,
    this.etaSeconds,
    this.waitingSeconds,
    this.suggestionReason,
    this.chargingSeconds,
    this.estimatedCostVnd,
    this.estimateSource,
    this.rangeLabel,
    this.roadRoute,
  });
  StationConnector get connector => station.connectors.firstWhere(
    (c) => connectorId == "${station.id}/${c.number}",
  );
  final Station station;
  final String connectorId;
  final StationStatus status;
  final DateTime updatedAt;
  final int? rank;
  final int? estimatedTariffVndPerKwh;
  final int? etaSeconds;
  final int? waitingSeconds;
  final String? suggestionReason;
  final int? chargingSeconds;
  final int? estimatedCostVnd;
  final String? estimateSource;
  final String? rangeLabel;
  final RoadRoute? roadRoute;
}
