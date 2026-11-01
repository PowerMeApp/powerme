class MapLocation {
  const MapLocation(this.latitude, this.longitude);
  final double latitude;
  final double longitude;
}

enum LocationIssue { serviceOff, denied, deniedForever, unavailable }

class LocationFailure implements Exception {
  const LocationFailure(this.issue);
  final LocationIssue issue;
}

abstract interface class MapLocationRepository {
  Future<MapLocation> current();
}
