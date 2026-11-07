import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../auth/application/auth_controller.dart';
import '../domain/map_location.dart';

final mapLocationRepositoryProvider = Provider<MapLocationRepository>(
  (ref) => throw StateError('Location adapter not composed'),
);
final mapLocationControllerProvider =
    NotifierProvider.autoDispose<MapLocationController, MapLocationState>(
      MapLocationController.new,
    );

class MapLocationState {
  const MapLocationState({this.position, this.busy = false, this.issue});
  final MapLocation? position;
  final bool busy;
  final LocationIssue? issue;
}

class MapLocationController extends Notifier<MapLocationState> {
  int _request = 0;
  @override
  MapLocationState build() {
    ref.watch(authScopeProvider);
    ++_request;
    return const MapLocationState();
  }

  Future<void> locate() async {
    if (state.busy) return;
    final request = ++_request;
    state = const MapLocationState(busy: true);
    try {
      final position = await ref.read(mapLocationRepositoryProvider).current();
      if (ref.mounted && request == _request) {
        state = MapLocationState(position: position);
      }
    } catch (error) {
      if (ref.mounted && request == _request) {
        state = MapLocationState(
          issue: error is LocationFailure
              ? error.issue
              : LocationIssue.unavailable,
        );
      }
    }
  }
}
