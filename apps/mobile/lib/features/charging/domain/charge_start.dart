import '../../../core/api/idempotency_key.dart';
import 'charging.dart';

const maxChargeEnergyWh = 9007199254740991;
final _kwh = RegExp(r'^([0-9]*)(?:[.,]([0-9]{1,3}))?$');

int? parseChargeEnergyWh(String input) {
  final value = input.trim();
  final match = _kwh.firstMatch(value);
  if (match == null) return null;
  final digits = match[1]!;
  final whole = digits.isEmpty ? 0 : int.tryParse(digits);
  if (whole == null || whole > maxChargeEnergyWh ~/ 1000) return null;
  final fraction = int.parse((match[2] ?? '').padRight(3, '0'));
  final wh = whole * 1000 + fraction;
  return wh > 0 && wh <= maxChargeEnergyWh ? wh : null;
}

String newChargeStartKey() => newIdempotencyKey();

enum ChargeStartOutcome {
  sent,
  accepted,
  unknown,
  topUpRequired,
  requiresConfirmation,
  rejected,
  released,
  startTimeout,
  active,
  paused,
  stopping,
  closed,
  reconciled,
  review,
  orphaned,
  failed;

  bool get awaitingEffect => switch (this) {
    sent || accepted || unknown => true,
    _ => false,
  };

  bool get sessionOutcome => switch (this) {
    active ||
    paused ||
    stopping ||
    closed ||
    reconciled ||
    review ||
    orphaned ||
    failed => true,
    _ => false,
  };
}

class ChargeStartSnapshot {
  const ChargeStartSnapshot({
    required this.intentId,
    required this.sessionId,
    required this.outcome,
    required this.effectConfirmed,
    required this.version,
    required this.maxEnergyWh,
  });

  final String intentId;
  final String? sessionId;
  final ChargeStartOutcome outcome;
  final bool effectConfirmed;
  final int version;
  final int? maxEnergyWh;

  bool get started => sessionId != null && effectConfirmed;
}

enum ChargeStartIssue {
  uncertain,
  notFound,
  keyConflict,
  creditUnavailable,
  connectorUnavailable,
  connectorBusy,
  tariffUnavailable,
  vehicleIncompatible,
  invalidRequest;

  bool get refused => switch (this) {
    creditUnavailable ||
    connectorUnavailable ||
    connectorBusy ||
    tariffUnavailable ||
    vehicleIncompatible ||
    invalidRequest => true,
    _ => false,
  };
}

class ChargeStartException implements Exception {
  const ChargeStartException(this.issue);
  final ChargeStartIssue issue;
}

abstract interface class ChargeStartRepository {
  Future<ChargeStartSnapshot> start(StartRequest request);
  Future<ChargeStartSnapshot> read(StartRequest request);
}
