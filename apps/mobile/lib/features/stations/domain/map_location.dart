class MapLocation {
  const MapLocation(this.latitude, this.longitude);
  final double latitude;
  final double longitude;
  bool get valid =>
      latitude.isFinite &&
      longitude.isFinite &&
      latitude.abs() <= 90 &&
      longitude.abs() <= 180;
}

enum LocationIssue { serviceOff, denied, deniedForever, unavailable }

class LocationFailure implements Exception {
  const LocationFailure(this.issue);
  final LocationIssue issue;
}

abstract interface class MapLocationRepository {
  Future<MapLocation> current();
}
