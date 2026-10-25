import '../../stations/domain/station_models.dart';

enum CommandStatus { idle, sending, accepted, rejected, unknown }

enum SessionState {
  none,
  preparing,
  charging,
  suspendedEv,
  suspendedEvse,
  finishing,
  ended,
  faulted,
}

enum ConnectionStatus { online, stale, offline }

enum DataQuality { live, stale, unavailable }

class ChargingSession {
  const ChargingSession({
    required this.id,
    required this.energyWh,
    required this.estimatedCostVnd,
    required this.startedAt,
    required this.lastUpdated,
    required this.soc,
  });

  final String id;
  final int energyWh;
  final int estimatedCostVnd;
  final DateTime startedAt;
  final DateTime lastUpdated;
  final int? soc;
}

class ChargeSummary {
  const ChargeSummary({
    required this.sessionId,
    required this.energyWh,
    required this.amountVnd,
    required this.reason,
    required this.endedAt,
  });

  final String sessionId;
  final int energyWh;
  final int amountVnd;
  final String reason;
  final DateTime endedAt;
}

class ChargingFlowState {
  const ChargingFlowState({
    this.station,
    this.connector,
    this.commandStatus = CommandStatus.idle,
    this.sessionState = SessionState.none,
    this.connectionStatus = ConnectionStatus.online,
    this.dataQuality = DataQuality.unavailable,
    this.session,
    this.summary,
    this.stopRequested = false,
    this.message,
  });

  final Station? station;
  final Connector? connector;
  final CommandStatus commandStatus;
  final SessionState sessionState;
  final ConnectionStatus connectionStatus;
  final DataQuality dataQuality;
  final ChargingSession? session;
  final ChargeSummary? summary;
  final bool stopRequested;
  final String? message;

  bool get hasSelection => station != null && connector != null;
  bool get hasActiveSession =>
      session != null && sessionState != SessionState.ended;

  ChargingFlowState copyWith({
    Station? station,
    Connector? connector,
    CommandStatus? commandStatus,
    SessionState? sessionState,
    ConnectionStatus? connectionStatus,
    DataQuality? dataQuality,
    ChargingSession? session,
    ChargeSummary? summary,
    bool? stopRequested,
    String? message,
    bool clearMessage = false,
    bool clearSession = false,
    bool clearSummary = false,
  }) {
    return ChargingFlowState(
      station: station ?? this.station,
      connector: connector ?? this.connector,
      commandStatus: commandStatus ?? this.commandStatus,
      sessionState: sessionState ?? this.sessionState,
      connectionStatus: connectionStatus ?? this.connectionStatus,
      dataQuality: dataQuality ?? this.dataQuality,
      session: clearSession ? null : session ?? this.session,
      summary: clearSummary ? null : summary ?? this.summary,
      stopRequested: stopRequested ?? this.stopRequested,
      message: clearMessage ? null : message ?? this.message,
    );
  }
}
