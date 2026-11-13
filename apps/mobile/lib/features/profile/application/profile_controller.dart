import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/driver_profile.dart';
import '../domain/profile_repository.dart';
import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_scope.dart';

final profileRepositoryProvider = Provider<ProfileRepository>(
  (ref) => throw StateError('Select a profile adapter in app composition.'),
);

final profileControllerProvider =
    NotifierProvider<ProfileController, ProfileState>(ProfileController.new);

final vehicleModelsProvider = FutureProvider.autoDispose<List<VehicleModel>>((
  ref,
) {
  final scope = ref.watch(authScopeProvider);
  final repo = ref.watch(profileRepositoryProvider);
  if (scope == signedOutScope) return const [];
  if (repo case VehicleManagementRepository vehicles) {
    return vehicles.listModels();
  }
  throw const ProfileException(ProfileFailure.unavailable);
}, retry: (_, _) => null);

class ProfileState {
  const ProfileState(this.profile, {this.busy = false, this.failure});
  final DriverProfile profile;
  final bool busy;
  final ProfileFailure? failure;
  bool get canChange => !busy && !(failure?.needsRefresh ?? false);
}

class ProfileController extends Notifier<ProfileState> {
  int _request = 0;
  @override
  ProfileState build() {
    ref.watch(authScopeProvider);
    ++_request;
    return ProfileState(ref.watch(profileRepositoryProvider).read());
  }

  void selectLanguage(AppLanguage language) {
    if (state.busy) return;
    state = ProfileState(
      ref.read(profileRepositoryProvider).selectLanguage(language),
    );
  }

  Future<bool> updateName(String name) =>
      _change((repo, revision) => repo.updateName(name, revision));
  Future<bool> saveVehicle(VehicleDraft draft, String? id) =>
      _change((repo, revision) => repo.saveVehicle(draft, id, revision));
  Future<bool> addVehicle(VehicleRegistration registration) =>
      _change((repo, _) {
        if (repo case VehicleManagementRepository vehicles) {
          return vehicles.addVehicle(registration);
        }
        throw const ProfileException(ProfileFailure.unavailable);
      });
  Future<bool> removeVehicle(String id) =>
      _change((repo, revision) => repo.removeVehicle(id, revision));
  Future<bool> selectVehicle(String id) =>
      _change((repo, revision) => repo.selectVehicle(id, revision));
  Future<bool> refresh() => _change((repo, _) {
    if (repo case RefreshableProfileRepository refreshable) {
      return refreshable.refresh();
    }
    throw const ProfileException(ProfileFailure.unavailable);
  }, reading: true);

  Future<bool> _change(
    Future<DriverProfile> Function(ProfileRepository, int) action, {
    bool reading = false,
  }) async {
    if (state.busy || (!reading && !state.canChange)) return false;
    final scope = ref.read(authScopeProvider);
    if (scope == signedOutScope) return false;
    final request = ++_request;
    final profile = state.profile;
    final recovery = state.failure?.needsRefresh == true ? state.failure : null;
    state = ProfileState(profile, busy: true, failure: recovery);
    try {
      final next = await action(
        ref.read(profileRepositoryProvider),
        profile.revision,
      );
      if (!_current(scope, request)) return false;
      state = ProfileState(next);
      return true;
    } catch (error) {
      if (_current(scope, request)) {
        state = ProfileState(
          ref.read(profileRepositoryProvider).read(),
          failure:
              recovery ??
              (error is ProfileException
                  ? error.failure
                  : ProfileFailure.unavailable),
        );
      }
      return false;
    }
  }

  bool _current(AuthScope scope, int request) =>
      ref.mounted &&
      request == _request &&
      identical(scope, ref.read(authScopeProvider));
}
