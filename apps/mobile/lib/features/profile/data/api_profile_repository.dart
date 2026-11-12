import '../../../core/api/driver_account_response.dart';
import '../../../core/api/driver_api_session.dart';
import '../domain/driver_profile.dart';
import '../domain/profile_repository.dart';

class ApiProfileRepository
    implements ProfileRepository, RefreshableProfileRepository {
  ApiProfileRepository(this._session);

  final DriverApiSession _session;

  @override
  DriverProfile read() {
    final account = _session.account;
    return account == null ? DriverProfile.empty : _profile(account);
  }

  @override
  Future<DriverProfile> refresh() async =>
      _profile(await _session.refreshAccount());

  DriverProfile _profile(DriverAccountResponse account) => DriverProfile(
    displayName: account.fullName,
    language: AppLanguage.vietnamese,
    vehicles: List.unmodifiable(
      account.vehicles.map(
        (vehicle) => Vehicle(
          id: vehicle.id,
          brand: vehicle.brand,
          model: vehicle.model,
          connectors: [vehicle.connector],
          plateNumber: vehicle.plate,
        ),
      ),
    ),
    selectedVehicleId: account.vehicles
        .where((vehicle) => vehicle.isDefault)
        .firstOrNull
        ?.id,
  );

  @override
  DriverProfile selectLanguage(AppLanguage language) => _unavailable();

  @override
  Future<DriverProfile> updateName(String name, int revision) async =>
      _unavailable();

  @override
  Future<DriverProfile> saveVehicle(
    VehicleDraft draft,
    String? id,
    int revision,
  ) async => _unavailable();

  @override
  Future<DriverProfile> removeVehicle(String id, int revision) async =>
      _unavailable();

  @override
  Future<DriverProfile> selectVehicle(String id, int revision) async =>
      _unavailable();

  Never _unavailable() =>
      throw const ProfileException(ProfileFailure.unavailable);
}
