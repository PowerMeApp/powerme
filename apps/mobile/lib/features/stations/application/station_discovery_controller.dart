import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_scope.dart';
import '../../profile/application/profile_controller.dart';
import '../domain/map_location.dart';
import '../domain/station.dart';
import '../domain/station_discovery.dart';
import 'map_location_controller.dart';
import 'stations_controller.dart';

final stationDiscoveryRepositoryProvider = Provider<StationDiscoveryRepository>(
  (ref) => ref.watch(stationRepositoryProvider) as StationDiscoveryRepository,
);

final discoveryVehicleProvider = Provider<String>((ref) {
  if (ref.watch(authScopeProvider) == signedOutScope) return '';
  return ref.watch(
    profileControllerProvider.select((p) => p.profile.vehicleId),
  );
});

typedef DiscoverySession = ({AuthScope scope, String vehicleId});

final discoverySessionProvider = Provider<DiscoverySession>(
  (ref) => (
    scope: ref.watch(authScopeProvider),
    vehicleId: ref.watch(discoveryVehicleProvider),
  ),
);

final discoveryContextProvider =
    NotifierProvider<DiscoveryContext, DiscoveryContextState>(
      DiscoveryContext.new,
    );

final selectedDiscoveryStationProvider =
    NotifierProvider<SelectedDiscoveryStation, Station?>(
      SelectedDiscoveryStation.new,
    );

class SelectedDiscoveryStation extends Notifier<Station?> {
  @override
  Station? build() {
    ref.watch(authScopeProvider);
    ref.watch(discoveryVehicleProvider);
    return null;
  }

  void select(Station station) => state = station;
}

class DiscoveryContextState {
  const DiscoveryContextState({this.origin, this.includeVinFastOnly = false});
  final DiscoveryOrigin? origin;
  final bool includeVinFastOnly;
}

class DiscoveryContext extends Notifier<DiscoveryContextState> {
  int _originRequest = 0;
  Completer<void>? _originCancellation;

  void _cancelOriginUpdate() {
    ++_originRequest;
    _originCancellation?.complete();
    _originCancellation = null;
  }

  @override
  DiscoveryContextState build() {
    ref.watch(authScopeProvider);
    ref.watch(discoveryVehicleProvider);
    ref.onDispose(_cancelOriginUpdate);
    return const DiscoveryContextState();
  }

  void includeVinFastOnly(bool enabled) {
    state = DiscoveryContextState(
      origin: state.origin,
      includeVinFastOnly: enabled,
    );
  }

  void cancelOriginUpdate() => _cancelOriginUpdate();

  void clearOrigin() {
    _cancelOriginUpdate();
    state = DiscoveryContextState(includeVinFastOnly: state.includeVinFastOnly);
  }

  Future<bool> locate({required bool shareOriginWithPowerMe}) async {
    if (!shareOriginWithPowerMe) return false;
    return _updateOrigin((_, _) async {
      final location = await ref.read(mapLocationRepositoryProvider).current();
      if (!location.valid) {
        throw const LocationFailure(LocationIssue.unavailable);
      }
      return DiscoveryOrigin.device(location);
    });
  }

  Future<bool> selectAddress(
    AddressCandidate candidate, {
    required bool consentToVietmap,
    required bool shareOriginWithPowerMe,
  }) async {
    if (!consentToVietmap || !shareOriginWithPowerMe) return false;
    return _updateOrigin(
      (vehicle, cancelled) => ref
          .read(stationDiscoveryRepositoryProvider)
          .resolve(
            vehicle,
            candidate,
            consentToVietmap: consentToVietmap,
            cancelled: cancelled,
          ),
    );
  }

  Future<bool> _updateOrigin(
    Future<DiscoveryOrigin> Function(String vehicleId, Future<void> cancelled)
    action,
  ) async {
    _cancelOriginUpdate();
    final request = _originRequest;
    final scope = ref.read(authScopeProvider);
    final vehicle = ref.read(discoveryVehicleProvider);
    if (vehicle.isEmpty) return false;
    final cancel = _originCancellation = Completer<void>();
    bool current() =>
        ref.mounted &&
        request == _originRequest &&
        identical(scope, ref.read(authScopeProvider)) &&
        vehicle == ref.read(discoveryVehicleProvider);
    try {
      final origin = await action(vehicle, cancel.future);
      if (!current()) return false;
      state = DiscoveryContextState(
        origin: origin,
        includeVinFastOnly: state.includeVinFastOnly,
      );
      return true;
    } catch (_) {
      if (current()) rethrow;
      return false;
    } finally {
      if (identical(_originCancellation, cancel)) _originCancellation = null;
    }
  }
}

typedef DiscoverySearch = ({
  DiscoverySession session,
  StationSearchQuery query,
  DiscoveryOrigin? origin,
  bool consentToRoute,
  SmartSearchInput? smart,
});

final discoverySearchProvider = FutureProvider.autoDispose
    .family<StationSearchPage, DiscoverySearch>((ref, search) {
      final repository = _readRepository(ref, search.session);
      final cancel = Completer<void>();
      ref.onDispose(cancel.complete);
      final acceptedOrigin = ref.read(discoveryContextProvider).origin;
      final shareOrigin =
          search.origin != null && identical(search.origin, acceptedOrigin);
      return repository.search(
        search.session.vehicleId,
        search.query,
        origin: search.origin,
        shareOriginWithPowerMe: shareOrigin,
        smart: search.smart,
        consentToRoute: shareOrigin && search.consentToRoute,
        cancelled: shareOrigin ? cancel.future : null,
      );
    }, retry: (_, _) => null);

typedef AddressSearch = ({
  DiscoverySession session,
  String query,
  bool consentToVietmap,
});

final addressSearchProvider = FutureProvider.autoDispose
    .family<List<AddressCandidate>, AddressSearch>((ref, input) {
      ref.watch(discoverySessionProvider);
      final repository = _readRepository(ref, input.session);
      final cancel = Completer<void>();
      ref.onDispose(cancel.complete);
      return repository.autocomplete(
        input.session.vehicleId,
        input.query,
        consentToVietmap: input.consentToVietmap,
        cancelled: cancel.future,
      );
    }, retry: (_, _) => null);

typedef SelectedRoute = ({
  DiscoverySession session,
  String stationId,
  DiscoveryOrigin origin,
  bool includeVinFastOnly,
});

final discoveryRoadsProvider =
    NotifierProvider<DiscoveryRoads, DiscoveryRoadState>(DiscoveryRoads.new);

typedef DiscoveryRoadState = ({
  SelectedRoute? active,
  Map<SelectedRoute, ({StationRoadRoute route, DateTime expires})> routes,
  SelectedRoute? failed,
  Object? error,
});

class DiscoveryRoads extends Notifier<DiscoveryRoadState> {
  Completer<void>? _cancel;
  SelectedRoute? _activeInput;

  @override
  DiscoveryRoadState build() {
    ref.watch(discoverySessionProvider);
    ref.watch(discoveryContextProvider.select((state) => state.origin));
    ref.onDispose(stop);
    return (active: null, routes: const {}, failed: null, error: null);
  }

  void stop([SelectedRoute? input]) {
    if (input != null && _activeInput != input) return;
    final cancel = _cancel;
    if (cancel != null && !cancel.isCompleted) cancel.complete();
  }

  Future<void> request(
    SelectedRoute input, {
    required bool consentToVietmap,
  }) async {
    if (!consentToVietmap ||
        _cancel != null ||
        input.session != ref.read(discoverySessionProvider) ||
        input.origin != ref.read(discoveryContextProvider).origin ||
        !input.origin.location.valid) {
      return;
    }
    final cancel = _cancel = Completer<void>();
    _activeInput = input;
    var routes = state.routes;
    Object? error;
    state = (active: input, routes: routes, failed: null, error: null);
    try {
      final route = await _readRepository(ref, input.session).roadRoute(
        input.session.vehicleId,
        input.stationId,
        input.origin,
        includeVinFastOnly: input.includeVinFastOnly,
        consentToVietmap: consentToVietmap,
        cancelled: cancel.future,
      );
      final now = DateTime.now();
      routes = {
        for (final entry in routes.entries)
          if (entry.key != input && entry.value.expires.isAfter(now))
            entry.key: entry.value,
        input: (route: route, expires: now.add(const Duration(minutes: 5))),
      };
      if (routes.length > 20) routes.remove(routes.keys.first);
    } catch (failure) {
      error = failure;
    } finally {
      _cancel = null;
      _activeInput = null;
      if (ref.mounted &&
          input.session == ref.read(discoverySessionProvider) &&
          input.origin == ref.read(discoveryContextProvider).origin &&
          state.active == input) {
        state = (
          active: null,
          routes: cancel.isCompleted ? state.routes : Map.unmodifiable(routes),
          failed: error != null && !cancel.isCompleted ? input : null,
          error: cancel.isCompleted ? null : error,
        );
      }
    }
  }
}

SelectedRoute? selectedRoadInput(Ref ref, String stationId) {
  final discovery = ref.watch(discoveryContextProvider);
  final origin = discovery.origin;
  if (origin == null) return null;
  return (
    session: ref.watch(discoverySessionProvider),
    stationId: stationId,
    origin: origin,
    includeVinFastOnly: discovery.includeVinFastOnly,
  );
}

final selectedRoadInputProvider = Provider.autoDispose.family(
  selectedRoadInput,
);

StationRoadRoute? cachedRoad(DiscoveryRoadState state, SelectedRoute? input) {
  final cached = state.routes[input];
  return cached != null && cached.expires.isAfter(DateTime.now())
      ? cached.route
      : null;
}

StationDiscoveryRepository _readRepository(Ref ref, DiscoverySession session) {
  if (session.vehicleId.isEmpty ||
      session != ref.read(discoverySessionProvider)) {
    throw StateError('Discovery session changed.');
  }
  return ref.watch(stationDiscoveryRepositoryProvider);
}
