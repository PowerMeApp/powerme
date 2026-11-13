import '../../../core/api/driver_account_response.dart';
import '../../../core/api/driver_api_exception.dart';
import '../../../core/api/driver_api_session.dart';
import '../domain/driver_profile.dart';
import '../domain/profile_repository.dart';

class ApiProfileRepository
    implements
        ProfileRepository,
        RefreshableProfileRepository,
        VehicleManagementRepository {
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
          isVinFast: vehicle.isVinFast,
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
  Future<List<VehicleModel>> listModels() async => [
    for (final model in await _session.listVehicleModels())
      VehicleModel(
        id: model.modelId,
        brand: model.brand,
        model: model.model,
        connector: model.connector,
        batteryCapacityKwh: model.batteryCapacityKwh,
        ratedRangeKm: model.ratedRangeKm,
        maxDcKw: model.maxDcKw,
      ),
  ];

  @override
  Future<DriverProfile> addVehicle(VehicleRegistration registration) {
    if (!VehicleRegistration.acceptsPlate(registration.plateNumber)) {
      throw const ProfileException(ProfileFailure.invalidPlate);
    }
    return _change(
      () => _session.addVehicle(
        plateNumber: registration.plateNumber,
        modelId: registration.modelId,
        makeDefault: registration.makeDefault,
      ),
    );
  }

  @override
  Future<DriverProfile> removeVehicle(String id, int revision) =>
      _change(() => _session.removeVehicle(id));

  @override
  Future<DriverProfile> selectVehicle(String id, int revision) =>
      _change(() => _session.setDefaultVehicle(id));

  Future<DriverProfile> _change(
    Future<DriverAccountResponse> Function() write,
  ) async {
    try {
      return _profile(await write());
    } on DriverApiException catch (error) {
      throw ProfileException(switch (error) {
        DriverApiException(problem: DriverApiProblem.accountRefreshRequired) =>
          ProfileFailure.mutationNeedsRefresh,
        DriverApiException(status: 400, code: 'invalid_plate_number') =>
          ProfileFailure.invalidPlate,
        DriverApiException(status: 400, code: 'unknown_vehicle_model') =>
          ProfileFailure.unknownModel,
        DriverApiException(status: 409, code: 'plate_taken') =>
          ProfileFailure.plateTaken,
        DriverApiException(status: 409, code: 'vehicle_in_use') =>
          ProfileFailure.vehicleInUse,
        DriverApiException(status: 404) => ProfileFailure.vehicleMissing,
        DriverApiException(problem: DriverApiProblem.ended) =>
          ProfileFailure.unavailable,
        DriverApiException(status: final int status)
            when status >= 400 && status < 500 =>
          ProfileFailure.unavailable,
        _ => ProfileFailure.mutationUnconfirmed,
      });
    }
  }

  Never _unavailable() =>
      throw const ProfileException(ProfileFailure.unavailable);
}
