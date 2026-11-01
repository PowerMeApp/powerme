class MapPoint {
  const MapPoint(this.x, this.y);
  final double x;
  final double y;
}

class MapRoad {
  const MapRoad(this.name, this.points, {this.major = false});
  final String name;
  final List<MapPoint> points;
  final bool major;
}

class RoadMapScene {
  const RoadMapScene({this.roads = const [], this.origin});
  final List<MapRoad> roads;
  final MapPoint? origin;
}

enum TrafficLevel { clear, slow, unknown }

enum RouteReachability { reachable, insufficient, unknown }

class RoadRoute {
  const RoadRoute({
    required this.stationId,
    required this.points,
    required this.distanceM,
    required this.travelSeconds,
    required this.traffic,
    required this.updatedAt,
    this.slowSegments = const [],
    this.trafficDelaySeconds,
    this.batteryAtArrivalPercent,
    this.reachability = RouteReachability.unknown,
    this.via = '',
  });
  final String stationId;
  final List<MapPoint> points;
  final List<List<MapPoint>> slowSegments;
  final int distanceM;
  final int travelSeconds;
  final TrafficLevel traffic;
  final int? trafficDelaySeconds;
  final int? batteryAtArrivalPercent;
  final RouteReachability reachability;
  final String via;
  final DateTime updatedAt;
}

abstract interface class StationRouteRepository {
  RoadMapScene get mapScene;
  Future<RoadRoute?> route(String vehicleId, String stationId, int? battery);
}
