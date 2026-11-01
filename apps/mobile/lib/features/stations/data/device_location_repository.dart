import 'package:geolocator/geolocator.dart';
import '../domain/map_location.dart';

class DeviceLocationRepository implements MapLocationRepository {
  @override
  Future<MapLocation> current() async {
    if (!await Geolocator.isLocationServiceEnabled()) {
      throw const LocationFailure(LocationIssue.serviceOff);
    }
    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }
    if (permission == LocationPermission.deniedForever) {
      throw const LocationFailure(LocationIssue.deniedForever);
    }
    if (permission != LocationPermission.whileInUse &&
        permission != LocationPermission.always) {
      throw const LocationFailure(LocationIssue.denied);
    }
    try {
      final position = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 15),
        ),
      );
      return MapLocation(position.latitude, position.longitude);
    } catch (_) {
      throw const LocationFailure(LocationIssue.unavailable);
    }
  }
}
