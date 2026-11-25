import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/application/auth_controller.dart';
import '../../profile/application/profile_controller.dart';
import '../../stations/application/connector_lookup_controller.dart';
import '../../stations/application/station_discovery_controller.dart';
import '../../stations/domain/connector_lookup.dart';
import '../domain/charge_session.dart';
import '../domain/charge_start.dart';
import '../domain/charging.dart';

final chargeStartRepositoryProvider = Provider<ChargeStartRepository>(
  (ref) => throw StateError('Configure charge start in ApiApp.'),
);

final chargeStartProvider =
    NotifierProvider<ChargeStartController, ChargeStartState?>(
      ChargeStartController.new,
    );

typedef ChargeStartDraft = ({ChargingMode mode, String input});
final chargeStartDraftProvider =
    NotifierProvider<ChargeStartDraftController, ChargeStartDraft>(
      ChargeStartDraftController.new,
    );

class ChargeStartDraftController extends Notifier<ChargeStartDraft> {
  @override
  ChargeStartDraft build() {
    ref.watch(discoverySessionProvider);
    ref.watch(connectorLookupProvider.select((value) => value.connector));
    return (mode: ChargingMode.energy, input: '');
  }

  void update(ChargingMode mode, String input) =>
      state = (mode: mode, input: input);
}

typedef ChargeStartAttempt = ({
  StartRequest request,
  ResolvedConnector connector,
  String vehicleLabel,
  String draftInput,
});

class ChargeStartState {
  const ChargeStartState(
    this.attempt, {
    this.snapshot,
    this.issue,
    this.busy = false,
    this.sessionEnded = false,
  });

  final ChargeStartAttempt attempt;
  final ChargeStartSnapshot? snapshot;
  final ChargeStartIssue? issue;
  final bool busy;
  final bool sessionEnded;

  ChargeSessionTarget? get sessionTarget => snapshot?.started == true
      ? (scope: attempt.request.scope, id: snapshot!.sessionId!)
      : null;

  bool get recoverable =>
      sessionTarget == null &&
      issue != ChargeStartIssue.keyConflict &&
      issue?.refused != true &&
      (snapshot == null || snapshot!.outcome.awaitingEffect);
  bool get canResend =>
      !busy &&
      recoverable &&
      (issue == ChargeStartIssue.uncertain ||
          issue == ChargeStartIssue.notFound);
  bool get canClear =>
      !busy &&
      ((snapshot != null &&
              !snapshot!.started &&
              !snapshot!.outcome.awaitingEffect) ||
          sessionEnded ||
          issue?.refused == true);

  bool get canEdit => canClear && !sessionEnded && sessionTarget == null;
}

class ChargeStartController extends Notifier<ChargeStartState?> {
  DateTime? _latestProgressAt;
  ChargeStartState? _pendingRead;
  ChargeStartState? _beforeRead;

  @override
  ChargeStartState? build() {
    ref.watch(authScopeProvider);
    _latestProgressAt = null;
    _pendingRead = null;
    _beforeRead = null;
    return null;
  }

  Future<void> start(
    DiscoverySession selection,
    ResolvedConnector connector,
    int? limit, {
    ChargingMode mode = ChargingMode.energy,
  }) async {
    if (state != null ||
        selection.scope == signedOutScope ||
        selection != ref.read(discoverySessionProvider) ||
        connector != ref.read(connectorLookupProvider).connector ||
        !connector.canRequestStart ||
        !validChargeLimit(mode, limit)) {
      return;
    }
    final vehicle = ref.read(profileControllerProvider).profile.selectedVehicle;
    if (vehicle == null || vehicle.id != selection.vehicleId) return;
    await _submit((
      request: StartRequest(
        scope: selection.scope,
        connectorId: connector.id,
        vehicleId: vehicle.id,
        mode: mode,
        limitValue: limit,
        key: newChargeStartKey(),
      ),
      connector: connector,
      draftInput: ref.read(chargeStartDraftProvider).input,
      vehicleLabel: [
        vehicle.label,
        if (vehicle.plateNumber != null) vehicle.plateNumber!,
      ].join(' · '),
    ));
  }

  Future<void> acceptLimit(StartRequest original) async {
    final current = state;
    if (current == null ||
        current.busy ||
        !identical(current.attempt.request, original) ||
        current.snapshot?.outcome != ChargeStartOutcome.requiresConfirmation) {
      return;
    }
    final maxLimit = current.snapshot!.maxLimitValue;
    final selection = ref.read(discoverySessionProvider);
    if (maxLimit == null ||
        !validChargeLimit(original.mode, maxLimit) ||
        selection.scope != original.scope ||
        selection.vehicleId != original.vehicleId) {
      return;
    }
    await _submit((
      request: StartRequest(
        scope: original.scope,
        connectorId: original.connectorId,
        vehicleId: original.vehicleId,
        mode: original.mode,
        limitValue: maxLimit,
        key: newChargeStartKey(),
      ),
      connector: current.attempt.connector,
      draftInput: chargeLimitInput(original.mode, maxLimit),
      vehicleLabel: current.attempt.vehicleLabel,
    ));
  }

  Future<void> resend() async {
    final current = state;
    if (current?.canResend != true) return;
    await _submit(current!.attempt, previous: current);
  }

  Future<void> check() async {
    final current = state;
    if (current == null || current.busy || !current.recoverable) return;
    await _request(current.attempt, previous: current, submit: false);
  }

  void pauseStatusReads() {
    if (!ref.mounted) return;
    ref.read(chargeStartRepositoryProvider).cancelStatusRead();
    if (_pendingRead != null && identical(state, _pendingRead)) {
      state = _beforeRead;
    }
    _pendingRead = null;
    _beforeRead = null;
  }

  bool recordProgress(ChargeSessionTarget target, ChargeProgress progress) {
    final current = state;
    if (current == null ||
        current.sessionTarget != target ||
        ref.read(authScopeProvider) != target.scope ||
        (progress.billingMode != null &&
            (progress.billingMode != current.attempt.request.mode ||
                progress.limitValue != current.attempt.request.limitValue)) ||
        _latestProgressAt?.isAfter(progress.updatedAt) == true ||
        (current.sessionEnded && !progress.confirmsEnd)) {
      return false;
    }
    _latestProgressAt = progress.updatedAt;
    if (progress.confirmsEnd && !current.sessionEnded) {
      state = ChargeStartState(
        current.attempt,
        snapshot: current.snapshot,
        sessionEnded: true,
      );
    }
    return true;
  }

  void releaseFinishedSession() {
    if (state?.sessionEnded == true) clear();
  }

  bool clear() {
    final current = state;
    if (current == null || !current.canClear) return false;
    ref.read(connectorLookupProvider.notifier).clear();
    _latestProgressAt = null;
    state = null;
    return true;
  }

  bool edit() {
    final current = state;
    if (current?.canEdit != true) return false;
    final request = current!.attempt.request;
    final selection = ref.read(discoverySessionProvider);
    if (selection.scope != request.scope ||
        selection.vehicleId != request.vehicleId ||
        ref.read(connectorLookupProvider).connector !=
            current.attempt.connector) {
      return false;
    }
    _latestProgressAt = null;
    ref
        .read(chargeStartDraftProvider.notifier)
        .update(request.mode, current.attempt.draftInput);
    state = null;
    return true;
  }

  Future<void> _submit(
    ChargeStartAttempt attempt, {
    ChargeStartState? previous,
  }) => _request(attempt, previous: previous, submit: true);

  Future<void> _request(
    ChargeStartAttempt attempt, {
    ChargeStartState? previous,
    required bool submit,
  }) async {
    final request = attempt.request;
    if (ref.read(authScopeProvider) != request.scope) return;
    final snapshot = previous?.snapshot;
    final pending = ChargeStartState(
      attempt,
      snapshot: snapshot,
      issue: previous?.issue,
      busy: true,
    );
    state = pending;
    if (!submit) {
      _pendingRead = pending;
      _beforeRead = previous;
    }
    bool isCurrent() =>
        ref.mounted &&
        ref.read(authScopeProvider) == request.scope &&
        identical(state, pending);
    try {
      final repository = ref.read(chargeStartRepositoryProvider);
      final next = await (submit
          ? repository.start(request)
          : repository.read(request));
      if (!isCurrent()) return;
      if (snapshot != null && next.intentId != snapshot.intentId) {
        throw const ChargeStartException(ChargeStartIssue.uncertain);
      }
      if (snapshot != null &&
          (next.version < snapshot.version ||
              (next.version == snapshot.version &&
                  !next.started &&
                  next.outcome != snapshot.outcome))) {
        state = previous;
        return;
      }
      state = ChargeStartState(attempt, snapshot: next);
    } on ChargeStartException catch (error) {
      if (!isCurrent()) return;
      state = ChargeStartState(
        attempt,
        snapshot: snapshot,
        issue: snapshot != null && error.issue.refused
            ? ChargeStartIssue.uncertain
            : error.issue,
      );
    } finally {
      if (identical(_pendingRead, pending)) {
        _pendingRead = null;
        _beforeRead = null;
      }
    }
  }
}
