import '../../../demo/demo_store.dart';
import '../../auth/domain/auth_scope.dart';
import '../domain/driver_profile.dart';
import '../domain/profile_repository.dart';

class MockProfileRepository implements ProfileRepository {
  MockProfileRepository(this._store, {AuthScope? scope})
    : _scope = scope ?? _store.activeScope;

  final DemoStore _store;
  final AuthScope _scope;

  @override
  DriverProfile read() {
    if (_scope.principalId.isEmpty) return DriverProfile.empty;
    _store.requireScope(_scope);
    return _store.profile;
  }

  @override
  DriverProfile selectLanguage(AppLanguage language) {
    _store.save(_scope, read().withLanguage(language));
    return _store.profile;
  }

  Future<DriverProfile> _change(
    int revision,
    DriverProfile Function(DriverProfile) change,
  ) async {
    await Future<void>.delayed(Duration.zero);
    final profile = read();
    if (profile.revision != revision) {
      throw const ProfileException(ProfileFailure.conflict);
    }
    final next = change(profile);
    _store.save(_scope, next);
    return next;
  }

  @override
  Future<DriverProfile> updateName(String name, int revision) =>
      _change(revision, (profile) {
        if (name.trim().isEmpty || name.trim().length > 80) {
          throw const ProfileException(ProfileFailure.invalid);
        }
        return profile.copyWith(displayName: name.trim());
      });
  @override
  Future<DriverProfile> saveVehicle(
    VehicleDraft draft,
    String? id,
    int revision,
  ) => _change(revision, (profile) {
    if (!draft.valid) throw const ProfileException(ProfileFailure.invalid);
    if (id != null && !profile.vehicles.any((v) => v.id == id)) {
      throw const ProfileException(ProfileFailure.missing);
    }
    final vehicle = Vehicle(
      id: id ?? 'vehicle-${++_store.nextVehicle}',
      brand: draft.brand.trim(),
      model: draft.model.trim(),
      connectors: draft.connectors,
    );
    final vehicles = [...profile.vehicles];
    if (id == null) {
      vehicles.add(vehicle);
    } else {
      vehicles[vehicles.indexWhere((v) => v.id == id)] = vehicle;
    }
    return profile.copyWith(
      vehicles: vehicles,
      selectedVehicleId: profile.selectedVehicle == null
          ? vehicle.id
          : profile.selectedVehicleId,
    );
  });
  @override
  Future<DriverProfile> removeVehicle(String id, int revision) =>
      _change(revision, (profile) {
        if (!profile.vehicles.any((v) => v.id == id)) {
          throw const ProfileException(ProfileFailure.missing);
        }
        final vehicles = profile.vehicles.where((v) => v.id != id).toList();
        return profile.copyWith(
          vehicles: vehicles,
          selectedVehicleId: id == profile.selectedVehicleId
              ? (vehicles.isEmpty ? '' : vehicles.first.id)
              : profile.selectedVehicleId,
        );
      });
  @override
  Future<DriverProfile> selectVehicle(String id, int revision) =>
      _change(revision, (profile) {
        if (!profile.vehicles.any((v) => v.id == id)) {
          throw const ProfileException(ProfileFailure.missing);
        }
        return profile.copyWith(selectedVehicleId: id);
      });
}
