import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/format.dart';
import '../../auth/application/auth_controller.dart';
import '../../profile/application/profile_controller.dart';
import '../domain/station_route.dart';
import 'stations_controller.dart';

final roadMapSceneProvider = Provider<RoadMapScene>((ref) {
  final repository = ref.watch(stationRepositoryProvider);
  return repository is StationRouteRepository
      ? (repository as StationRouteRepository).mapScene
      : const RoadMapScene();
});

final stationRouteControllerProvider =
    NotifierProvider<StationRouteController, StationRouteState>(
      StationRouteController.new,
    );

class StationRouteState {
  const StationRouteState({
    this.stationId,
    this.route,
    this.loading = false,
    this.requested = false,
    this.error,
  });
  final String? stationId;
  final RoadRoute? route;
  final bool loading;
  final bool requested;
  final String? error;
}

class StationRouteController extends Notifier<StationRouteState> {
  int _request = 0;
  @override
  StationRouteState build() {
    ref.watch(authScopeProvider);
    ref.watch(stationRepositoryProvider);
    ref.watch(
      profileControllerProvider.select((p) => p.profile.selectedVehicle),
    );
    ++_request;
    return const StationRouteState();
  }

  void select(String stationId) {
    ++_request;
    state = StationRouteState(stationId: stationId);
  }

  void clear() {
    ++_request;
    state = const StationRouteState();
  }

  Future<void> preview(String stationId, {int? battery}) async {
    final n = ++_request;
    final scope = ref.read(authScopeProvider);
    final vehicleId = ref.read(profileControllerProvider).profile.vehicleId;
    state = StationRouteState(
      stationId: stationId,
      loading: true,
      requested: true,
    );
    try {
      final repository = ref.read(stationRepositoryProvider);
      final route = repository is StationRouteRepository
          ? await (repository as StationRouteRepository).route(
              vehicleId,
              stationId,
              battery,
            )
          : null;
      if (!ref.mounted ||
          n != _request ||
          !identical(scope, ref.read(authScopeProvider)) ||
          vehicleId != ref.read(profileControllerProvider).profile.vehicleId) {
        return;
      }
      state = StationRouteState(
        stationId: stationId,
        route: route,
        requested: true,
      );
    } catch (e) {
      if (ref.mounted &&
          n == _request &&
          identical(scope, ref.read(authScopeProvider)) &&
          vehicleId == ref.read(profileControllerProvider).profile.vehicleId) {
        state = StationRouteState(
          stationId: stationId,
          requested: true,
          error: failureText(e),
        );
      }
    }
  }
}
