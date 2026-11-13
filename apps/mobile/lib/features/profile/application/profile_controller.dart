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

class ProfileState {
  const ProfileState(this.profile, {this.busy = false, this.failure});
  final DriverProfile profile;
  final bool busy;
  final ProfileFailure? failure;
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
  Future<bool> removeVehicle(String id) =>
      _change((repo, revision) => repo.removeVehicle(id, revision));
  Future<bool> selectVehicle(String id) =>
      _change((repo, revision) => repo.selectVehicle(id, revision));
  Future<bool> refresh() => _change((repo, _) {
    if (repo case RefreshableProfileRepository refreshable) {
      return refreshable.refresh();
    }
    throw const ProfileException(ProfileFailure.unavailable);
  });

  Future<bool> _change(
    Future<DriverProfile> Function(ProfileRepository, int) action,
  ) async {
    if (state.busy) return false;
    final request = ++_request;
    final scope = ref.read(authScopeProvider);
    final profile = state.profile;
    state = ProfileState(profile, busy: true);
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
          failure: error is ProfileException
              ? error.failure
              : ProfileFailure.unavailable,
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
