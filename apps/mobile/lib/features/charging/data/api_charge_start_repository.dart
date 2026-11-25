import 'package:dio/dio.dart';

import '../../../core/api/driver_api_exception.dart';
import '../../../core/api/driver_api_session.dart';
import '../domain/charge_start.dart';
import '../domain/charging.dart';

class ApiChargeStartRepository implements ChargeStartRepository {
  ApiChargeStartRepository(this._session);

  final DriverApiSession _session;
  CancelToken? _statusRead;

  @override
  void cancelStatusRead() => _statusRead?.cancel();

  @override
  Future<ChargeStartSnapshot> start(StartRequest request) async {
    final limit = request.limitValue;
    if (!validChargeLimit(request.mode, limit)) {
      throw const ChargeStartException(ChargeStartIssue.invalidRequest);
    }
    try {
      return _decode(
        await _session.startCharge(
          principalId: request.scope.principalId,
          key: request.key,
          connectorId: request.connectorId,
          vehicleId: request.vehicleId,
          mode: _wireMode(request.mode),
          limit: switch (request.mode) {
            ChargingMode.autoFull => const {},
            ChargingMode.timed => {'duration_minutes': limit!},
            ChargingMode.energy => {'energy_limit_wh': limit!},
            ChargingMode.cost => {'amount_limit_vnd': limit!},
          },
        ),
        request,
      );
    } on DriverApiException catch (error) {
      throw ChargeStartException(switch ((error.status, error.code)) {
        (409, 'idempotency_conflict') => ChargeStartIssue.keyConflict,
        (409, 'credit_unavailable') => ChargeStartIssue.creditUnavailable,
        (409, 'connector_unavailable') => ChargeStartIssue.connectorUnavailable,
        (409, 'connector_busy_or_unknown') => ChargeStartIssue.connectorBusy,
        (409, 'tariff_unavailable') => ChargeStartIssue.tariffUnavailable,
        (409, 'power_unavailable') => ChargeStartIssue.powerUnavailable,
        (400, 'vehicle_not_owned_or_incompatible') =>
          ChargeStartIssue.vehicleIncompatible,
        (400, 'unsupported_mode') => ChargeStartIssue.modeUnavailable,
        (400, 'invalid_input') => ChargeStartIssue.invalidRequest,
        _ => ChargeStartIssue.uncertain,
      });
    }
  }

  @override
  Future<ChargeStartSnapshot> read(StartRequest request) async {
    final cancel = CancelToken();
    _statusRead = cancel;
    try {
      final json = await _session.readCharge(
        request.scope.principalId,
        request.key,
        cancel,
      );
      return _decode(json, request);
    } on DriverApiException catch (error) {
      throw ChargeStartException(
        error.status == 404
            ? ChargeStartIssue.notFound
            : ChargeStartIssue.uncertain,
      );
    } finally {
      if (identical(_statusRead, cancel)) _statusRead = null;
    }
  }
}

final _id = RegExp(r'^[1-9][0-9]{0,18}$');
bool _validId(Object? value) => value is String && _id.hasMatch(value);
bool _nullableId(Map<String, dynamic> json, String key) =>
    json.containsKey(key) && (json[key] == null || _validId(json[key]));

String _wireMode(ChargingMode mode) => switch (mode) {
  ChargingMode.autoFull => 'full',
  ChargingMode.timed => 'timed',
  ChargingMode.energy => 'energy_kwh',
  ChargingMode.cost => 'amount_vnd',
};

ChargeStartSnapshot _decode(Map<String, dynamic> json, StartRequest request) {
  final intentId = json['intent_id'];
  final sessionId = json['session_id'];
  final effect = json['effect_confirmed'];
  final version = json['version'];
  final capField = switch (request.mode) {
    ChargingMode.autoFull => null,
    ChargingMode.timed => 'max_duration_minutes',
    ChargingMode.energy => 'max_energy_wh',
    ChargingMode.cost => 'max_amount_vnd',
  };
  final cap = json[capField];
  final legacy =
      !json.containsKey('mode') && request.mode == ChargingMode.energy;
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
      (!legacy && json['mode'] != _wireMode(request.mode)) ||
      effect != (sessionId != null) ||
      effect != outcome.sessionOutcome ||
      !json.containsKey('max_energy_wh') ||
      (!legacy &&
          (!json.containsKey('max_duration_minutes') ||
              !json.containsKey('max_amount_vnd'))) ||
      [
        'max_energy_wh',
        'max_duration_minutes',
        'max_amount_vnd',
      ].any((field) => field != capField && json[field] != null) ||
      (outcome == ChargeStartOutcome.requiresConfirmation
          ? capField == null ||
                cap is! int ||
                cap < 0 ||
                cap > maxChargeLimit ||
                request.limitValue == null ||
                cap >= request.limitValue!
          : cap != null)) {
    throw const ChargeStartException(ChargeStartIssue.uncertain);
  }
  return ChargeStartSnapshot(
    intentId: intentId as String,
    sessionId: sessionId as String?,
    outcome: outcome,
    effectConfirmed: effect,
    version: version,
    maxLimitValue: cap as int?,
  );
}
