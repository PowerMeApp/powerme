import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../auth/application/auth_controller.dart';
import '../../profile/application/profile_controller.dart';
import '../../../core/format.dart';
import '../domain/station.dart';
import '../domain/station_actions.dart';
import '../domain/station_repository.dart';
import 'stations_controller.dart';

final showRestrictedProvider = NotifierProvider<RestrictedChoice, bool>(
  RestrictedChoice.new,
);

class RestrictedChoice extends Notifier<bool> {
  @override
  bool build() {
    ref.watch(authScopeProvider);
    return false;
  }

  void select(bool value) => state = value;
}

final stationActionsRepositoryProvider = Provider<StationActionsRepository>(
  (ref) => throw StateError('Select station actions adapter.'),
);
final suggestionControllerProvider =
    NotifierProvider<SuggestionController, SuggestionState>(
      SuggestionController.new,
    );

class SuggestionState {
  const SuggestionState({
    this.options = const [],
    this.busy = false,
    this.error,
    this.loaded = false,
    this.batteryPercent,
  });
  final List<StationOption> options;
  final int? batteryPercent;
  final bool busy;
  final bool loaded;
  final String? error;
}

class SuggestionController extends Notifier<SuggestionState> {
  int _request = 0;
  @override
  SuggestionState build() {
    ref.watch(authScopeProvider);
    ref.watch(
      profileControllerProvider.select((p) => p.profile.selectedVehicle),
    );
    ++_request;
    return const SuggestionState();
  }

  Future<void> search(SuggestionMode mode, int? battery, int? target) async {
    final n = ++_request;
    final scope = ref.read(authScopeProvider);
    final vehicle = ref.read(profileControllerProvider).profile.vehicleId;
    state = const SuggestionState(busy: true);
    try {
      final repository = ref.read(stationRepositoryProvider);
      if (repository is StationSuggestionPreferences) {
        (repository as StationSuggestionPreferences).configureSuggestions(
          mode,
          battery,
          target,
        );
      }
      final controller = ref.read(stationsControllerProvider.notifier);
      await controller.suggest(vehicle);
      final options = controller.suggestions;
      if (ref.mounted &&
          n == _request &&
          identical(scope, ref.read(authScopeProvider))) {
        state = SuggestionState(
          options: options,
          loaded: true,
          batteryPercent: battery,
        );
      }
    } catch (e) {
      if (ref.mounted &&
          n == _request &&
          identical(scope, ref.read(authScopeProvider))) {
        state = SuggestionState(error: failureText(e));
      }
    }
  }
}

/*
final reservationControllerProvider =
    NotifierProvider.autoDispose<ReservationController, ReservationState>(
      ReservationController.new,
    );

class ReservationState {
  const ReservationState({
    this.quote,
    this.hold,
    this.busy = false,
    this.error,
  });
  final HoldQuote? quote;
  final Reservation? hold;
  final bool busy;
  final String? error;
}

class ReservationController extends Notifier<ReservationState> {
  int _request = 0;
  Timer? _refreshTimer;
  String _connector = '';
  @override
  ReservationState build() {
    ref.watch(authScopeProvider);
    ++_request;
    _refreshTimer?.cancel();
    ref.onDispose(() {
      ++_request;
      _refreshTimer?.cancel();
    });
    return const ReservationState();
  }

  Future<void> load(String connector) {
    if (connector.isNotEmpty && connector != _connector) {
      _connector = connector;
      ++_request;
      state = const ReservationState();
    }
    return _run(() async {
      final repo = ref.read(stationActionsRepositoryProvider);
      final hold = await repo.reservation();
      if (hold?.state == HoldState.active || connector.isEmpty) {
        return ReservationState(hold: hold);
      }
      final quote = await repo.quote(connector);
      return ReservationState(hold: hold, quote: quote);
    });
  }

  Future<void> confirm() async {
    final quote = state.quote;
    if (quote == null) return;
    await _run(
      () async => ReservationState(
        hold: await ref
            .read(stationActionsRepositoryProvider)
            .reserve(quote, 'hold/${quote.id}'),
      ),
    );
  }

  Future<void> cancel() async {
    final hold = state.hold;
    if (hold == null) return;
    await _run(
      () async => ReservationState(
        hold: await ref
            .read(stationActionsRepositoryProvider)
            .cancel(hold.id, 'cancel/${hold.id}'),
      ),
    );
  }

  Future<void> _run(Future<ReservationState> Function() action) async {
    if (state.busy) return;
    final n = ++_request;
    final scope = ref.read(authScopeProvider);
    final old = state;
    state = ReservationState(quote: old.quote, hold: old.hold, busy: true);
    try {
      final next = await action();
      if (ref.mounted &&
          n == _request &&
          identical(scope, ref.read(authScopeProvider))) {
        state = next;
        _refreshTimer?.cancel();
        if (next.hold?.state == HoldState.active) {
          _refreshTimer = Timer(const Duration(seconds: 30), () {
            if (ref.mounted) load('');
          });
        }
      }
    } catch (e) {
      if (ref.mounted &&
          n == _request &&
          identical(scope, ref.read(authScopeProvider))) {
        state = ReservationState(
          quote: old.quote,
          hold: old.hold,
          error: failureText(e),
        );
      }
    }
  }
}
*/
