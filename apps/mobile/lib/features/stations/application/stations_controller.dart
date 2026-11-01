import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/domain/auth_scope.dart';
import '../../auth/application/auth_controller.dart';
import '../../profile/application/profile_controller.dart';
import '../domain/station.dart';
import '../domain/station_repository.dart';

final localScopeProvider = authScopeProvider;
final stationRepositoryProvider = Provider<StationRepository>(
  (ref) => throw StateError('Select a station adapter in app composition.'),
);
final stationsControllerProvider =
    NotifierProvider<StationsController, StationsState>(StationsController.new);
final stationDetailProvider = Provider.family<Station?, String>((ref, id) {
  ref.watch(localScopeProvider);
  ref.watch(profileControllerProvider.select((p) => p.profile.selectedVehicle));
  return ref.watch(stationRepositoryProvider).getById(id);
});

class StationsState {
  StationsState({
    this.query = '',
    this.filter = StationFilter.all,
    this.options = const [],
    this.loading = false,
    this.failed = false,
  }) : visible = options
           .where(
             (option) => switch (filter) {
               StationFilter.all => true,
               StationFilter.available =>
                 option.status == StationStatus.available &&
                     option.connector.quality == DataQuality.observed,
               StationFilter.highPower => option.connector.powerW >= 120000,
             },
           )
           .toList(growable: false) {
    final map = <String, Station>{
      for (final o in visible) o.station.id: o.station,
    };
    stations = map.values.toList(growable: false);
    final byStation = <String, List<StationOption>>{};
    for (final o in options) {
      (byStation[o.station.id] ??= <StationOption>[]).add(o);
    }
    listings = [
      for (final station in stations)
        StationListing(station, byStation[station.id] ?? const []),
    ];
  }
  final String query;
  final StationFilter filter;
  final List<StationOption> options;
  final bool loading;
  final bool failed;
  final List<StationOption> visible;
  late final List<Station> stations;
  late final List<StationListing> listings;
}

class StationsController extends Notifier<StationsState> {
  int _request = 0;
  int _suggestRequest = 0;
  List<StationOption> suggestions = const [];

  @override
  StationsState build() {
    ref.watch(stationRepositoryProvider);
    ref.watch(localScopeProvider);
    final vehicleId =
        ref
            .watch(
              profileControllerProvider.select(
                (p) => p.profile.selectedVehicle,
              ),
            )
            ?.id ??
        '';
    final request = ++_request;
    if (vehicleId.isEmpty || ref.read(localScopeProvider).principalId.isEmpty) {
      return StationsState();
    }
    Future.microtask(() {
      if (ref.mounted && request == _request) find(vehicleId, '');
    });
    return StationsState(loading: true);
  }

  Future<void> find(String vehicleId, String query) async {
    final request = ++_request;
    final scope = ref.read(localScopeProvider);
    final repository = ref.read(stationRepositoryProvider);
    final filter = state.filter;
    state = StationsState(query: query, filter: filter, loading: true);
    try {
      final options = await repository.find(vehicleId, query);
      if (!_current(request, scope, vehicleId)) return;
      state = StationsState(
        query: query,
        filter: state.filter,
        options: options,
      );
    } catch (_) {
      if (!_current(request, scope, vehicleId)) return;
      state = StationsState(query: query, filter: state.filter, failed: true);
    }
  }

  bool _current(int request, AuthScope scope, String vehicleId) =>
      ref.mounted &&
      request == _request &&
      identical(scope, ref.read(localScopeProvider)) &&
      vehicleId == ref.read(profileControllerProvider).profile.vehicleId;

  void selectFilter(StationFilter filter) => state = StationsState(
    query: state.query,
    filter: filter,
    options: state.options,
    loading: state.loading,
    failed: state.failed,
  );

  void clear() {
    selectFilter(StationFilter.all);
    find(ref.read(profileControllerProvider).profile.vehicleId, '');
  }

  Future<void> suggest(String vehicleId) async {
    final n = ++_suggestRequest;
    final scope = ref.read(localScopeProvider);
    final options = await ref
        .read(stationRepositoryProvider)
        .suggest(vehicleId);
    if (!ref.mounted ||
        n != _suggestRequest ||
        !identical(scope, ref.read(localScopeProvider)) ||
        vehicleId != ref.read(profileControllerProvider).profile.vehicleId) {
      throw StateError('Lượt tìm đã thay đổi.');
    }
    suggestions = options;
  }
}

class StationListing {
  StationListing(this.station, this.options);
  final Station station;
  final List<StationOption> options;
  DateTime get updatedAt =>
      options.map((o) => o.updatedAt).reduce((a, b) => a.isBefore(b) ? a : b);
  int get available => options
      .where(
        (o) =>
            o.status == StationStatus.available &&
            o.connector.quality == DataQuality.observed,
      )
      .length;
  bool get stale =>
      options.any((o) => o.connector.quality != DataQuality.observed);
  String get connectors =>
      options.map((o) => o.connector.type).toSet().join(' / ');
  int get maxPowerW => options.fold(
    0,
    (power, o) => o.connector.powerW > power ? o.connector.powerW : power,
  );
}
