import '../../../core/api/driver_api_exception.dart';
import '../../../core/api/driver_api_session.dart';
import '../domain/charge_start.dart';
import '../domain/charging.dart';

class ApiChargeStartRepository implements ChargeStartRepository {
  const ApiChargeStartRepository(this._session);

  final DriverApiSession _session;

  @override
  Future<ChargeStartSnapshot> start(StartRequest request) async {
    final limit = request.limitValue;
    if (request.mode != ChargingMode.energy ||
        limit == null ||
        limit < 1 ||
        limit > maxChargeEnergyWh) {
      throw const ChargeStartException(ChargeStartIssue.invalidRequest);
    }
    try {
      return _decode(
        await _session.startCharge(
          principalId: request.scope.principalId,
          key: request.key,
          connectorId: request.connectorId,
          vehicleId: request.vehicleId,
          energyLimitWh: limit,
        ),
        limit,
      );
    } on DriverApiException catch (error) {
      throw ChargeStartException(switch ((error.status, error.code)) {
        (409, 'idempotency_conflict') => ChargeStartIssue.keyConflict,
        (409, 'credit_unavailable') => ChargeStartIssue.creditUnavailable,
        (409, 'connector_unavailable') => ChargeStartIssue.connectorUnavailable,
        (409, 'connector_busy_or_unknown') => ChargeStartIssue.connectorBusy,
        (409, 'tariff_unavailable') => ChargeStartIssue.tariffUnavailable,
        (400, 'vehicle_not_owned_or_incompatible') =>
          ChargeStartIssue.vehicleIncompatible,
        (400, 'invalid_input' || 'unsupported_mode') =>
          ChargeStartIssue.invalidRequest,
        _ => ChargeStartIssue.uncertain,
      });
    }
  }

  @override
  Future<ChargeStartSnapshot> read(StartRequest request) async {
    try {
      final json = await _session.readCharge(
        request.scope.principalId,
        request.key,
      );
      return _decode(json, request.limitValue!);
    } on DriverApiException catch (error) {
      throw ChargeStartException(
        error.status == 404
            ? ChargeStartIssue.notFound
            : ChargeStartIssue.uncertain,
      );
    }
  }
}

final _id = RegExp(r'^[1-9][0-9]{0,18}$');
bool _validId(Object? value) => value is String && _id.hasMatch(value);
bool _nullableId(Map<String, dynamic> json, String key) =>
    json.containsKey(key) && (json[key] == null || _validId(json[key]));

ChargeStartSnapshot _decode(Map<String, dynamic> json, int requestedWh) {
  final intentId = json['intent_id'];
  final sessionId = json['session_id'];
  final effect = json['effect_confirmed'];
  final version = json['version'];
  final maxWh = json['max_energy_wh'];
  final raw = json['outcome'];
  final outcome = switch (raw) {
    'topuprequired' => ChargeStartOutcome.topUpRequired,
    'requiresconfirmation' => ChargeStartOutcome.requiresConfirmation,
    'start_timeout' => ChargeStartOutcome.startTimeout,
    'sent' ||
    'accepted' ||
    'unknown' ||
    'rejected' ||
    'released' ||
    'active' ||
    'paused' ||
    'stopping' ||
    'closed' ||
    'reconciled' ||
    'review' ||
    'orphaned' ||
    'failed' => ChargeStartOutcome.values.byName(raw as String),
    _ => null,
  };
  if (!_validId(intentId) ||
      !_nullableId(json, 'command_id') ||
      !_nullableId(json, 'session_id') ||
      effect is! bool ||
      version is! int ||
      version < 1 ||
      version > maxChargeEnergyWh ||
      outcome == null ||
      effect != (sessionId != null) ||
      effect != outcome.sessionOutcome ||
      !json.containsKey('max_energy_wh') ||
      (outcome == ChargeStartOutcome.requiresConfirmation
          ? maxWh is! int || maxWh < 0 || maxWh >= requestedWh
          : maxWh != null)) {
    throw const ChargeStartException(ChargeStartIssue.uncertain);
  }
  return ChargeStartSnapshot(
    intentId: intentId as String,
    sessionId: sessionId as String?,
    outcome: outcome,
    effectConfirmed: effect,
    version: version,
    maxEnergyWh: maxWh as int?,
  );
}
