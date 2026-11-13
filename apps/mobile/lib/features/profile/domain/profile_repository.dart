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

abstract interface class VehicleManagementRepository {
  Future<List<VehicleModel>> listModels();
  Future<DriverProfile> addVehicle(VehicleRegistration registration);
}

enum ProfileFailure {
  invalid,
  conflict,
  missing,
  unavailable,
  invalidPlate,
  unknownModel,
  plateTaken,
  vehicleInUse,
  vehicleMissing,
  mutationUnconfirmed,
  mutationNeedsRefresh;

  bool get needsRefresh =>
      this == mutationUnconfirmed ||
      this == mutationNeedsRefresh ||
      this == vehicleMissing;
}

class ProfileException implements Exception {
  const ProfileException(this.failure);
  final ProfileFailure failure;
}
