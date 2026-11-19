import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/idempotency_key.dart';
import '../../auth/application/auth_controller.dart';
import '../domain/charge_session.dart';
import '../domain/charging.dart';
import 'charge_start_controller.dart';

final chargeSessionRepositoryProvider = Provider<ChargeSessionRepository>(
  (ref) => throw StateError('Configure charge sessions in ApiApp.'),
);

final confirmedChargeSessionProvider = Provider<ChargeSessionTarget?>((ref) {
  final scope = ref.watch(authScopeProvider);
  final start = ref.watch(chargeStartProvider);
  final target = start?.sessionTarget;
  return scope != signedOutScope && target?.scope == scope ? target : null;
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

class ChargeStopAttempt {
  const ChargeStopAttempt(this.key, [this.outcome]);

  final String key;
  final ChargeStopOutcome? outcome;
}

class ChargeStopController extends Notifier<ChargeStopAttempt?> {
  @override
  ChargeStopAttempt? build() {
    ref.watch(confirmedChargeSessionProvider);
    return null;
  }

  Future<void> send(ChargeSessionTarget target, {required bool retry}) async {
    if (ref.read(confirmedChargeSessionProvider) != target) return;
    final previous = state;
    if (retry
        ? previous?.outcome != ChargeStopOutcome.responseUnknown
        : previous != null && previous.outcome != ChargeStopOutcome.rejected) {
      return;
    }
    final attempt = ChargeStopAttempt(
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
    state = ChargeStopAttempt(attempt.key, outcome);
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
  void Function()? _cancel;
  bool _visible = false;
  bool _refreshOnIdle = false;
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
            (_progress?.keepPolling ?? true);

  void setVisible(bool visible) {
    if (_visible == visible) return;
    _visible = visible;
    _visibilityGeneration++;
    if (!visible) {
      _refreshOnIdle = false;
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
    if (retry) return true;
    return _progressIssue == null && progress.canStop;
  }

  void refreshProgress() => unawaited(_readProgress());

  void retryStatement() {
    if (completionOnly ||
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
    } else if (_statementIssue == null) {
      retryStatement();
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
        if (succeeded) afterSuccess?.call();
      }
    }
  }

  @override
  void dispose() {
    setVisible(false);
    super.dispose();
  }
}
