import 'driver_profile.dart';

abstract interface class ProfileRepository {
  DriverProfile read();
  DriverProfile selectLanguage(AppLanguage language);
  Future<DriverProfile> updateName(String name, int revision);
  Future<DriverProfile> saveVehicle(
    VehicleDraft draft,
    String? id,
    int revision,
  );
  Future<DriverProfile> removeVehicle(String id, int revision);
  Future<DriverProfile> selectVehicle(String id, int revision);
}

abstract interface class RefreshableProfileRepository {
  Future<DriverProfile> refresh();
}

enum ProfileFailure { invalid, conflict, missing, unavailable }

class ProfileException implements Exception {
  const ProfileException(this.failure);
  final ProfileFailure failure;
}
