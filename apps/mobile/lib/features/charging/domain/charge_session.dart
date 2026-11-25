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
    required this.limitValue,
    this.origin,
    this.paymentMode,
    this.serverCanStop,
    this.statementAvailable,
    this.billingMode,
    this.billingModeMissing = false,
    this.elapsedSeconds,
    this.costEstimateVnd,
    this.costQuality = ChargeCostQuality.unknown,
    this.costClock,
    required this.consumedWh,
    required this.meterStopWh,
    required this.energyWh,
    required this.estimatedCostVnd,
    required this.billingReviewRequired,
  });

  final SessionOrigin? origin;
  final PaymentMode? paymentMode;
  final bool? serverCanStop;
  final bool? statementAvailable;
  final SessionState status;
  final SettlementState settlement;
  final ConnectionState connection;
  final DataQuality quality;
  final DateTime updatedAt;
  final ChargingMode? billingMode;
  final bool billingModeMissing;
  final int? limitValue;
  final int? elapsedSeconds;
  final int? costEstimateVnd;
  final ChargeCostQuality costQuality;
  final ChargeCostClock? costClock;
  final int? consumedWh;
  final int? meterStopWh;
  final int? energyWh;
  final int? estimatedCostVnd;
  final bool billingReviewRequired;

  ChargeProgress withStartContext(StartRequest? request) {
    if (!billingModeMissing ||
        request == null ||
        (origin != null && origin != SessionOrigin.appQr)) {
      return this;
    }
    return ChargeProgress(
      origin: origin,
      paymentMode: paymentMode,
      serverCanStop: serverCanStop,
      statementAvailable: statementAvailable,
      status: status,
      settlement: settlement,
      connection: connection,
      quality: quality,
      updatedAt: updatedAt,
      billingMode: request.mode,
      limitValue: request.limitValue,
      elapsedSeconds: elapsedSeconds,
      costEstimateVnd: costEstimateVnd,
      costQuality: costQuality,
      costClock: costClock,
      consumedWh: consumedWh,
      meterStopWh: meterStopWh,
      energyWh: energyWh,
      estimatedCostVnd: estimatedCostVnd,
      billingReviewRequired: billingReviewRequired,
    );
  }

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

  /// Tạm tính hiện chỉ được hỗ trợ cho phiên khởi động từ app;
  /// khoản trừ thực tế lấy từ bảng kê posted, độc lập với origin.
  bool get supportsCostEstimate =>
      origin == null || origin == SessionOrigin.appQr;
  bool get canStop =>
      (origin == null || origin == SessionOrigin.appQr) &&
      serverCanStop != false &&
      !inReview &&
      meterStopWh == null &&
      isStoppableStatus(status);
  bool get statementEligible =>
      closed &&
      !inReview &&
      meterStopWh != null &&
      settlement == SettlementState.posted &&
      statementAvailable != false;
  bool get awaitingRfidSettlement =>
      origin == SessionOrigin.rfid &&
      paymentMode == PaymentMode.csmsBilled &&
      closed &&
      meterStopWh != null &&
      settlement == SettlementState.pending &&
      !inReview;
  bool get keepPolling =>
      (awaitingRfidSettlement ||
          !(origin != null &&
              origin != SessionOrigin.appQr &&
              meterStopWh != null)) &&
      !inReview &&
      status != SessionState.failed &&
      !(closed &&
          (settlement == SettlementState.posted ||
              settlement == SettlementState.notApplicable));
}

enum ChargeCostQuality { exact, interpolated, unknown }

enum ChargeCostClock { cp, cpOffset, csms }

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
