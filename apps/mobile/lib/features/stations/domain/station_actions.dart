import 'station.dart';

enum SuggestionMode { fastest, cheapest, nearest }

enum HoldState {
  active,
  fulfilled,
  cancelledFree,
  cancelledLate,
  expired,
  voided,
}

class HoldQuote {
  const HoldQuote({
    required this.connectorId,
    required this.version,
    required this.expiresAt,
    required this.freeCancelUntil,
    this.id = '',
    this.validUntil,
    this.connectorLabel,
    this.feeVnd = 20000,
    this.lateCancelFeeVnd = 10000,
  });
  final String connectorId;
  final String id;
  final String? connectorLabel;
  final DateTime? validUntil;
  final int version;
  final DateTime expiresAt;
  final DateTime freeCancelUntil;
  final int feeVnd;
  final int lateCancelFeeVnd;
}

class Reservation {
  const Reservation({
    required this.id,
    required this.quote,
    required this.state,
    required this.version,
    this.chargedFeeVnd = 0,
    this.remainingSeconds,
  });
  final String id;
  final HoldQuote quote;
  final HoldState state;
  final int version;
  final int chargedFeeVnd;
  final int? remainingSeconds;
}

abstract interface class StationActionsRepository {
  Future<StationOption> resolve(String reference);
  Future<List<StationOption>> suggestions(
    String vehicleId,
    SuggestionMode mode,
    int? batteryPercent,
    int? targetPercent,
  );
  Future<HoldQuote> quote(String connectorId);
  Future<Reservation> reserve(HoldQuote quote, String key);
  Future<Reservation?> reservation();
  Future<Reservation> cancel(String id, String key);
}
