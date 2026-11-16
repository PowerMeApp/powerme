import 'map_location.dart';
import 'station.dart';

enum SearchAvailability {
  all('all'),
  available('available'),
  inUse('in_use'),
  freeingSoon('freeing_soon'),
  unavailable('unavailable'),
  offline('offline');

  const SearchAvailability(this.apiValue);
  final String apiValue;
}

class DiscoveryOrigin {
  const DiscoveryOrigin.device(this.location) : address = null;
  const DiscoveryOrigin.place(this.location, this.address);

  final MapLocation location;
  final String? address;
}

typedef SmartSearchInput = ({double? soc, double target});

const double smartSearchTargetSoc = 80;

bool validSmartSearch(SmartSearchInput input) =>
    input.target.isFinite &&
    input.target > 0 &&
    input.target <= smartSearchTargetSoc &&
    (input.soc == null ||
        (input.soc!.isFinite && input.soc! >= 0 && input.soc! < input.target));

typedef StationSearchQuery = ({
  String text,
  int page,
  SearchAvailability availability,
  bool includeVinFastOnly,
});

const initialStationSearch = (
  text: '',
  page: 1,
  availability: SearchAvailability.all,
  includeVinFastOnly: false,
);

enum SmartUnavailable { noSoc, noLocation, missingVehicleSpecs }

enum StationRankingSource { vietmapRoute, brief }

class StationSearchHit {
  const StationSearchHit({
    required this.station,
    this.bestConnector,
    this.waitMinutes,
    this.chargeMinutes,
    this.maxCostVnd,
    this.roadEstimate,
  });

  final Station station;
  final StationConnector? bestConnector;
  final double? waitMinutes;
  final double? chargeMinutes;
  final int? maxCostVnd;
  final StationRoadEstimate? roadEstimate;
}

typedef StationRoadEstimate = ({
  double distanceM,
  int durationSeconds,
  DateTime computedAt,
  double? congestedDistanceM,
});

class StationSearchPage {
  const StationSearchPage({
    required this.items,
    required this.total,
    required this.page,
    required this.pageSize,
    this.rangeKm,
    this.smartUnavailable,
    this.rankingSource,
  });

  final List<StationSearchHit> items;
  final int total;
  final int page;
  final int pageSize;
  final double? rangeKm;
  final SmartUnavailable? smartUnavailable;
  final StationRankingSource? rankingSource;

  int get pageCount => (total + pageSize - 1) ~/ pageSize;
  bool get hasNext => page < pageCount && page < 100000;
}

class AddressCandidate {
  const AddressCandidate(this.refId, this.display);
  final String refId;
  final String display;
}

enum RouteTraffic { low, moderate, heavy, severe, unknown }

typedef RouteTrafficSegment = ({int start, int end, RouteTraffic level});

typedef RouteInstruction = ({
  int startIndex,
  int endIndex,
  int sign,
  String? text,
  String? streetName,
  double? distanceM,
});

Iterable<RouteTrafficSegment> roadTrafficSections(
  int pointCount,
  List<RouteTrafficSegment> segments,
) sync* {
  var cursor = 0;
  for (final segment in segments) {
    if (cursor < segment.start) {
      yield (start: cursor, end: segment.start, level: RouteTraffic.unknown);
    }
    yield segment;
    cursor = segment.end;
  }
  if (cursor < pointCount - 1) {
    yield (start: cursor, end: pointCount - 1, level: RouteTraffic.unknown);
  }
}

class StationRoadRoute {
  const StationRoadRoute({
    required this.stationId,
    required this.distanceM,
    required this.durationSeconds,
    required this.points,
    required this.computedAt,
    this.instructions = const [],
    this.trafficSegments = const [],
    this.congestedDistanceM,
  });

  final String stationId;
  final double distanceM;
  final int durationSeconds;
  final List<MapLocation> points;
  final DateTime computedAt;
  final List<RouteInstruction> instructions;
  final List<RouteTrafficSegment> trafficSegments;
  final double? congestedDistanceM;
}

abstract interface class StationDiscoveryRepository {
  Future<StationSearchPage> search(
    String vehicleId,
    StationSearchQuery query, {
    DiscoveryOrigin? origin,
    SmartSearchInput? smart,
    bool consentToRoute = false,
    Future<void>? cancelled,
  });

  Future<List<AddressCandidate>> autocomplete(String vehicleId, String text);

  Future<DiscoveryOrigin> resolve(String vehicleId, AddressCandidate candidate);

  Future<StationRoadRoute> roadRoute(
    String vehicleId,
    String stationId,
    DiscoveryOrigin origin, {
    required bool includeVinFastOnly,
    Future<void>? cancelled,
  });
}
