import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/idempotency_key.dart';
import '../../auth/application/auth_controller.dart';
import '../domain/charge_session.dart';
import '../domain/charging.dart';
import '../domain/owned_sessions.dart';
import 'charge_start_controller.dart';

final chargeSessionRepositoryProvider = Provider<ChargeSessionRepository>(
  (ref) => throw StateError('Configure charge sessions in ApiApp.'),
);

typedef OwnedSessionSelection = ({
  ChargeSessionTarget target,
  OwnedSessionSummary summary,
});
final selectedChargeSessionProvider =
    NotifierProvider<SelectedChargeSessionController, OwnedSessionSelection?>(
      SelectedChargeSessionController.new,
    );

class SelectedChargeSessionController extends Notifier<OwnedSessionSelection?> {
  final Set<String> _dismissed = {};
  @override
  OwnedSessionSelection? build() {
    ref.watch(authScopeProvider);
    _dismissed.clear();
    return null;
  }

  bool wasDismissed(String id) => _dismissed.contains(id);
  bool select(
    OwnedSessionSummary summary, {
    required ChargeSessionTarget target,
    bool automatic = false,
  }) {
    if (target.scope == signedOutScope ||
        ref.read(authScopeProvider) != target.scope ||
        summary.scope != target.scope ||
        summary.id != target.id ||
        !canSelectAnotherSession(target) ||
        (automatic &&
            (state != null ||
                ref.read(chargeStartProvider) != null ||
                wasDismissed(target.id)))) {
      return false;
    }
    state = (target: target, summary: summary);
    return true;
  }

  bool canSelectAnotherSession(ChargeSessionTarget target) {
    final own = ref.read(chargeStartProvider);
    if (own != null &&
        own.sessionTarget != target &&
        (own.busy || own.recoverable)) {
      return false;
    }
    final stop = ref.read(chargeStopProvider);
    return stop?.target == target || stop?.unresolved != true;
  }

  void clear() {
    if (state != null) _dismissed.add(state!.target.id);
    state = null;
  }
}

final confirmedChargeSessionProvider = Provider<ChargeSessionTarget?>((ref) {
  final scope = ref.watch(authScopeProvider);
  final selected = ref.watch(selectedChargeSessionProvider)?.target;
  final own = ref.watch(chargeStartProvider)?.sessionTarget;
  final target = selected ?? own;
  return scope != signedOutScope && target?.scope == scope ? target : null;
});

final matchingChargeStartProvider = Provider<ChargeStartState?>((ref) {
  final own = ref.watch(chargeStartProvider);
  return own?.sessionTarget != null &&
          own?.sessionTarget == ref.watch(confirmedChargeSessionProvider)
      ? own
      : null;
});

final postedChargeStatementProvider = FutureProvider.autoDispose
    .family<PostedChargeStatement, ChargeSessionTarget>((ref, target) async {
      if (ref.watch(authScopeProvider) != target.scope ||
          target.scope == signedOutScope) {
        throw const ChargeSessionException(ChargeSessionIssue.unavailable);
      }
      final request = ref
          .watch(chargeSessionRepositoryProvider)
          .statement(target);
      ref.onDispose(request.cancel);
      final statement = await request.result;
      if (!ref.mounted || ref.read(authScopeProvider) != target.scope) {
        throw const ChargeSessionException(ChargeSessionIssue.unavailable);
      }
      return statement;
    }, retry: (_, _) => null);

final chargeStopProvider =
    NotifierProvider<ChargeStopController, ChargeStopAttempt?>(
      ChargeStopController.new,
    );

final currentChargeStopProvider = Provider<ChargeStopAttempt?>((ref) {
  final attempt = ref.watch(chargeStopProvider);
  return attempt?.target == ref.watch(confirmedChargeSessionProvider)
      ? attempt
      : null;
});

class ChargeStopAttempt {
  const ChargeStopAttempt(
    this.target,
    this.key, [
    this.outcome,
    this.finished = false,
  ]);

  final ChargeSessionTarget target;

  final bool finished;
  bool get unresolved =>
      !finished &&
      (outcome == null ||
          !{
            ChargeStopOutcome.rejected,
            ChargeStopOutcome.notStoppable,
            ChargeStopOutcome.alreadyEnded,
            ChargeStopOutcome.unavailable,
            ChargeStopOutcome.keyConflict,
            ChargeStopOutcome.invalidRequest,
          }.contains(outcome));

  final String key;
  final ChargeStopOutcome? outcome;
}

class ChargeStopController extends Notifier<ChargeStopAttempt?> {
  @override
  ChargeStopAttempt? build() {
    ref.watch(authScopeProvider);
    return null;
  }

  void recordProgress(ChargeSessionTarget target, ChargeProgress progress) {
    if (ref.read(confirmedChargeSessionProvider) == target &&
        progress.confirmsEnd &&
        state?.target == target &&
        !state!.finished) {
      state = ChargeStopAttempt(target, state!.key, state!.outcome, true);
    }
  }

  Future<void> send(
    ChargeSessionTarget target, {
    required bool retry,
    required ChargeProgress progress,
  }) async {
    if (ref.read(confirmedChargeSessionProvider) != target) return;
    final ownProof = ref.read(chargeStartProvider)?.sessionTarget == target;
    if (!(progress.origin == SessionOrigin.appQr ||
            (progress.origin == null && ownProof)) ||
        progress.confirmsEnd ||
        progress.closed ||
        progress.inReview ||
        (!retry && !progress.canStop)) {
      return;
    }
    if (state?.unresolved == true && state?.target != target) return;
    final previous = state?.target == target ? state : null;
    if (retry
        ? previous?.outcome != ChargeStopOutcome.responseUnknown
        : previous != null && previous.outcome != ChargeStopOutcome.rejected) {
      return;
    }
    final attempt = ChargeStopAttempt(
      target,
      retry ? previous!.key : newIdempotencyKey(),
    );
    state = attempt;
    final outcome = await ref
        .read(chargeSessionRepositoryProvider)
        .stop(target, attempt.key, recovering: retry);
    if (!ref.mounted ||
        ref.read(confirmedChargeSessionProvider) != target ||
        !identical(state, attempt)) {
      return;
    }
    state = ChargeStopAttempt(target, attempt.key, outcome);
  }
}

class ChargeSessionController extends ChangeNotifier {
  ChargeSessionController(
    this._repository,
    this._target, {
    required this.recordProgress,
    this.completionOnly = false,
    this.startContext,
  });

  final ChargeSessionRepository _repository;
  final ChargeSessionTarget _target;
  final bool Function(ChargeSessionTarget, ChargeProgress) recordProgress;
  final bool completionOnly;
  final StartRequest? startContext;
  Timer? _poll;
  Timer? _settlementBudget;
  bool _settlementBudgetExpired = false;
  void Function()? _cancel;
  bool _visible = false;
  bool _refreshOnIdle = false;
  bool _progressRefreshOnIdle = false;
  int _visibilityGeneration = 0;

  ChargeProgress? _progress;
  ChargeSessionIssue? _progressIssue;
  PostedChargeStatement? _statement;
  ChargeSessionIssue? _statementIssue;
  ChargeProgress? get progress => _progress;
  ChargeSessionIssue? get progressIssue => _progressIssue;
  PostedChargeStatement? get statement => _statement;
  ChargeSessionIssue? get statementIssue => _statementIssue;
  bool get reading => _cancel != null && _visible && !_refreshOnIdle;

  bool get _canPoll => completionOnly
      ? _progress?.confirmsEnd != true
      : _progressIssue != ChargeSessionIssue.unavailable &&
            !(startContext == null &&
                _progress?.origin == null &&
                _progress?.confirmsEnd == true) &&
            !(_settlementBudgetExpired &&
                _progress?.awaitingRfidSettlement == true) &&
            (_progress?.keepPolling ?? true);

  void setVisible(bool visible) {
    if (_visible == visible) return;
    _visible = visible;
    _visibilityGeneration++;
    if (!visible) {
      _refreshOnIdle = false;
      _progressRefreshOnIdle = false;
      _poll?.cancel();
      _poll = null;
      _cancel?.call();
      return;
    }
    if (_cancel != null) {
      _refreshOnIdle = true;
    } else {
      _resumeReads();
    }
  }

  bool canRequestStop({required bool retry}) {
    final progress = _progress;
    if (progress == null ||
        _progressIssue == ChargeSessionIssue.unavailable ||
        progress.meterStopWh != null ||
        progress.closed ||
        !progress.keepPolling) {
      return false;
    }
    // Recovery reuses an existing app stop key even when a new stop is ineligible.
    if (!(progress.origin == SessionOrigin.appQr ||
        (progress.origin == null && startContext != null))) {
      return false;
    }
    if (retry) return true;
    return _progressIssue == null && progress.canStop;
  }

  void refreshProgress() {
    if (!_visible) return;
    if (_cancel != null) {
      _progressRefreshOnIdle = true;
      return;
    }
    _progressRefreshOnIdle = false;
    unawaited(_readProgress());
  }

  void retryStatement() {
    if (completionOnly ||
        (_progress?.origin == null && startContext == null) ||
        _progress?.statementEligible != true ||
        _statement != null) {
      return;
    }
    unawaited(
      _read(
        () => _repository.statement(_target),
        apply: (statement) {
          _statement = statement;
          _statementIssue = null;
        },
        fail: (issue) => _statementIssue = issue,
      ),
    );
  }

  void _resumeReads() {
    _syncPolling();
    if (completionOnly) return;
    if (_canPoll) {
      refreshProgress();
    } else {
      if (_statementIssue == null) retryStatement();
      // T148: resume must re-enable manual refresh even after automatic reads expire.
      notifyListeners();
    }
  }

  void _syncPolling() {
    if (_visible && _canPoll) {
      _poll ??= Timer.periodic(
        const Duration(seconds: 5),
        (_) => unawaited(_readProgress()),
      );
    } else {
      _poll?.cancel();
      _poll = null;
    }
  }

  Future<void> _readProgress() => _read(
    () => _repository.progress(_target),
    apply: (next) {
      // Meter samples can change without a session timestamp change.
      if (!recordProgress(_target, next)) {
        _progressIssue = ChargeSessionIssue.retry;
        return;
      }
      _progress = next.withStartContext(startContext);
      _progressIssue = null;
      if (_progress!.awaitingRfidSettlement) {
        // T148: this bounds foreground reads, never the server's financial settlement.
        _settlementBudget ??= Timer(const Duration(minutes: 2), () {
          _settlementBudgetExpired = true;
          _syncPolling();
          if (_visible) notifyListeners();
        });
      }
    },
    fail: (issue) {
      _progressIssue = issue;
      if (issue == ChargeSessionIssue.unavailable) {
        _progress = null;
        _statement = null;
        _statementIssue = null;
      }
    },
    afterSuccess: () {
      if (_progressIssue == null && _statementIssue == null) retryStatement();
    },
  );

  Future<void> _read<T>(
    ChargeSessionRead<T> Function() start, {
    required void Function(T) apply,
    required void Function(ChargeSessionIssue) fail,
    VoidCallback? afterSuccess,
  }) async {
    if (!_visible || _cancel != null) return;
    final generation = _visibilityGeneration;
    final request = start();
    _cancel = request.cancel;
    notifyListeners();
    var succeeded = false;
    try {
      final next = await request.result;
      if (generation != _visibilityGeneration) return;
      apply(next);
      succeeded = true;
    } on ChargeSessionException catch (error) {
      if (generation != _visibilityGeneration) return;
      fail(error.issue);
    } finally {
      _cancel = null;
      if (_refreshOnIdle) {
        _refreshOnIdle = false;
        _resumeReads();
      } else if (generation == _visibilityGeneration) {
        _syncPolling();
        notifyListeners();
        if (_progressRefreshOnIdle) {
          _progressRefreshOnIdle = false;
          refreshProgress();
        } else if (succeeded) {
          afterSuccess?.call();
        }
      }
    }
  }

  @override
  void dispose() {
    _settlementBudget?.cancel();
    setVisible(false);
    super.dispose();
  }
}
