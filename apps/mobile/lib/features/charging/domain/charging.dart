import '../../auth/domain/auth_scope.dart';
import '../../stations/domain/station.dart';
export '../../stations/domain/station.dart' show DataQuality;

enum CommandState { requested, accepted, rejected, unknown }

enum ChargingMode { autoFull, timed, energy, cost }

enum SessionState {
  pending,
  active,
  paused,
  stopping,
  closed,
  reconciled,
  orphaned,
  review,
  failed,
  unknown,
}

enum SettlementState { pending, posted, review, notApplicable, unknown }

enum ConnectionState { online, offline, unknown }

enum PaymentMode { csmsBilled, stationWallet, free, unattributed, unknown }

class StartRequest {
  const StartRequest({
    required this.scope,
    required this.connectorId,
    required this.vehicleId,
    required this.mode,
    required this.limitValue,
    required this.key,
  });
  final AuthScope scope;
  final String connectorId;
  final String vehicleId;
  final ChargingMode mode;
  final int? limitValue;
  final String key;
  String get fingerprint => '$connectorId/$vehicleId/${mode.name}/$limitValue';
}

class CommandOutcome {
  const CommandOutcome({
    required this.scope,
    required this.requestKey,
    required this.status,
    required this.version,
    this.commandId,
    this.sessionId,
    this.reasonCode,
  });
  final AuthScope scope;
  final String? commandId;
  final String requestKey;
  final CommandState status;
  final String? sessionId;
  final String? reasonCode;
  final int version;
}

class StartPreview {
  const StartPreview({
    required this.connectorLabel,
    required this.creditVnd,
    required this.canStart,
    required this.tariffVndPerKwh,
    required this.effectiveLimit,
    this.reason,
    this.minimumVnd = 50000,
    this.cutoffVnd = 10000,
  });
  final String connectorLabel;
  final int creditVnd;
  final bool canStart;
  final int? tariffVndPerKwh;
  final int? effectiveLimit;
  final String? reason;
  final int minimumVnd;
  final int cutoffVnd;
}

class TariffSegment {
  const TariffSegment(
    this.label,
    this.energyWh,
    this.tariffVndPerKwh,
    this.debitVnd,
  );
  final String label;
  final int energyWh;
  final int tariffVndPerKwh;
  final int debitVnd;
}

class Statement {
  const Statement({
    required this.scope,
    required this.sessionId,
    required this.version,
    required this.debitVnd,
    required this.balanceVnd,
    required this.earnedPoints,
    this.segments = const [],
    this.stopReason = 'Tài xế yêu cầu dừng',
  });
  final AuthScope scope;
  final String sessionId;
  final int version;
  final int debitVnd;
  final int balanceVnd;
  final int earnedPoints;
  final List<TariffSegment> segments;
  final String stopReason;
}

class SessionSnapshot {
  const SessionSnapshot({
    required this.scope,
    required this.sessionId,
    required this.version,
    required this.observedAt,
    required this.state,
    required this.settlement,
    required this.connectionState,
    required this.paymentMode,
    required this.quality,
    this.energyWh,
    this.estimatedCostVnd,
    this.availableCreditVnd,
    this.socPercent,
    this.elapsedSeconds,
    this.statement,
    this.connectorLabel = '',
    this.stopReason,
    this.pauseCause,
  });
  final AuthScope scope;
  final String sessionId;
  final int version;
  final DateTime observedAt;
  final SessionState state;
  final SettlementState settlement;
  final int? energyWh;
  final int? estimatedCostVnd;
  final int? availableCreditVnd;
  final int? socPercent;
  final int? elapsedSeconds;
  final ConnectionState connectionState;
  final PaymentMode paymentMode;
  final DataQuality quality;
  final Statement? statement;
  final String connectorLabel;
  final String? stopReason;
  final String? pauseCause;
  bool get ended =>
      state == SessionState.closed ||
      state == SessionState.reconciled ||
      state == SessionState.failed;
  bool staleAt(DateTime now) => quality == DataQuality.stale;
}

abstract interface class ChargingRepository {
  Future<CommandOutcome> start(StartRequest request);
  Future<CommandOutcome> stop(String sessionId, String key);
  Future<CommandOutcome> outcome(String key);
  Future<SessionSnapshot> snapshot(String sessionId);
  Stream<SessionSnapshot> watch(String sessionId);
}

abstract interface class ChargingPreparation {
  Future<StartPreview> preview(
    String connectorId,
    String vehicleId,
    ChargingMode mode,
    int? limit,
  );
  Future<SessionSnapshot?> current();
}
