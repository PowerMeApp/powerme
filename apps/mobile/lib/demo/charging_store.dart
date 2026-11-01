import 'dart:async';
import '../features/charging/domain/charging.dart';

enum ChargingScript {
  normal,
  unknownStart,
  unknownStop,
  rejected,
  paused,
  orphaned,
  offlineCutoff,
  stationWallet,
  unattributed,
  failed,
  review,
}

class LocalSession {
  LocalSession(
    this.owner,
    this.request,
    this.preview,
    this.script,
    this.snapshot,
    this.startedAt,
  );
  final String owner;
  final StartRequest request;
  final StartPreview preview;
  final ChargingScript script;
  SessionSnapshot snapshot;
  final DateTime startedAt;
  DateTime? stopAt;
  String? stopReason;
  bool effectConfirmed = false;
  bool get stopRequested => stopAt != null;
}

class ChargingStore {
  ChargingStore({DateTime Function()? clock}) : clock = clock ?? DateTime.now;
  final DateTime Function() clock;
  ChargingScript nextScript = ChargingScript.normal;
  final sessions = <String, LocalSession>{};
  final commands = <String, CommandOutcome>{};
  final payloads = <String, String>{};
  final events = StreamController<SessionSnapshot>.broadcast(sync: true);
  int serial = 0;
}
