import '../../auth/domain/auth_scope.dart';
import 'charging.dart';

typedef ChargeSessionTarget = ({AuthScope scope, String id});
typedef ChargeSessionRead<T> = ({Future<T> result, void Function() cancel});

bool isStoppableStatus(SessionState status) => switch (status) {
  SessionState.active || SessionState.paused || SessionState.orphaned => true,
  _ => false,
};

enum ChargeStopOutcome {
  pending,
  sent,
  accepted,
  rejected,
  timeout,
  failed,
  effectReported,
  responseUnknown,
  pendingOrUnknown,
  notStoppable,
  unavailable,
  keyConflict,
  invalidRequest,
}

class ChargeProgress {
  const ChargeProgress({
    required this.status,
    required this.settlement,
    required this.connection,
    required this.quality,
    required this.updatedAt,
    required this.limitWh,
    required this.consumedWh,
    required this.meterStopWh,
    required this.energyWh,
    required this.estimatedCostVnd,
    required this.billingReviewRequired,
  });

  final SessionState status;
  final SettlementState settlement;
  final ConnectionState connection;
  final DataQuality quality;
  final DateTime updatedAt;
  final int? limitWh;
  final int? consumedWh;
  final int? meterStopWh;
  final int? energyWh;
  final int? estimatedCostVnd;
  final bool billingReviewRequired;

  int? get measuredEnergyWh => meterStopWh != null
      ? energyWh
      : quality == DataQuality.observed
      ? consumedWh
      : null;
  bool get closed =>
      status == SessionState.closed || status == SessionState.reconciled;
  bool get confirmsEnd =>
      meterStopWh != null &&
      (closed ||
          status == SessionState.review ||
          status == SessionState.failed);
  bool get inReview =>
      status == SessionState.review ||
      settlement == SettlementState.review ||
      billingReviewRequired;
  bool get canStop =>
      !inReview && meterStopWh == null && isStoppableStatus(status);
  bool get statementEligible =>
      closed &&
      !inReview &&
      meterStopWh != null &&
      settlement == SettlementState.posted;
  bool get keepPolling =>
      !inReview &&
      status != SessionState.failed &&
      !(closed &&
          (settlement == SettlementState.posted ||
              settlement == SettlementState.notApplicable));
}

class PostedChargeStatement {
  const PostedChargeStatement({
    required this.energyWh,
    required this.amountVnd,
    required this.earnedPoints,
    required this.createdAt,
  });

  final int energyWh;
  final int amountVnd;
  final int earnedPoints;
  final DateTime createdAt;
}

enum ChargeSessionIssue { unavailable, retry }

class ChargeSessionException implements Exception {
  const ChargeSessionException(this.issue);
  final ChargeSessionIssue issue;
}

abstract interface class ChargeSessionRepository {
  Future<ChargeStopOutcome> stop(
    ChargeSessionTarget target,
    String key, {
    required bool recovering,
  });
  ChargeSessionRead<ChargeProgress> progress(ChargeSessionTarget target);
  ChargeSessionRead<PostedChargeStatement> statement(
    ChargeSessionTarget target,
  );
}
