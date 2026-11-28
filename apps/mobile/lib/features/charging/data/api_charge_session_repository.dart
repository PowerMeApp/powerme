import 'package:dio/dio.dart';

import '../../../core/api/driver_api_exception.dart';
import '../../../core/api/driver_api_session.dart';
import '../domain/charge_session.dart';
import '../domain/charging.dart';
import 'session_metadata.dart';

class ApiChargeSessionRepository implements ChargeSessionRepository {
  const ApiChargeSessionRepository(this._session);

  final DriverApiSession _session;

  @override
  Future<ChargeStopOutcome> stop(
    ChargeSessionTarget target,
    String key, {
    required bool recovering,
  }) async {
    try {
      final json = await _session.stopCharge(
        target.scope.principalId,
        target.id,
        key,
      );
      final commandId = json['command_id'];
      final sessionStatus = _state(
        SessionState.values,
        json['session_status'],
        SessionState.unknown,
      );
      final effect = json['effect_confirmed'];
      if (commandId is! String ||
          !_id.hasMatch(commandId) ||
          sessionStatus == SessionState.unknown ||
          effect is! bool) {
        return ChargeStopOutcome.responseUnknown;
      }
      final status = switch (json['command_status']) {
        'pending' => ChargeStopOutcome.pending,
        'sent' => ChargeStopOutcome.sent,
        'accepted' => ChargeStopOutcome.accepted,
        // A replay can report a rejected operator command with the intent still open.
        'rejected' when recovering => ChargeStopOutcome.pendingOrUnknown,
        'rejected' when isStoppableStatus(sessionStatus) =>
          ChargeStopOutcome.rejected,
        'rejected' => ChargeStopOutcome.notStoppable,
        'timeout' => ChargeStopOutcome.timeout,
        'failed' => ChargeStopOutcome.failed,
        _ => ChargeStopOutcome.responseUnknown,
      };
      return effect ? ChargeStopOutcome.effectReported : status;
    } on DriverApiException catch (error) {
      return switch ((error.status, error.code)) {
        (404, _) => ChargeStopOutcome.unavailable,
        (409, 'session_not_stoppable') => ChargeStopOutcome.alreadyEnded,
        (409, 'stop_pending_or_unknown') => ChargeStopOutcome.pendingOrUnknown,
        (409, 'idempotency_conflict') => ChargeStopOutcome.keyConflict,
        (400, 'invalid_idempotency_key' || 'reserved_idempotency_key') =>
          ChargeStopOutcome.invalidRequest,
        _ => ChargeStopOutcome.responseUnknown,
      };
    }
  }

  @override
  ChargeSessionRead<ChargeProgress> progress(
    ChargeSessionTarget target,
  ) => _read((cancel) async {
    final json = await _session.readChargeProgress(
      target.scope.principalId,
      target.id,
      cancel,
    );
    if (json['session_id'] != target.id) throw _unavailable;
    final quality = json['telemetry_quality'] == 'observed'
        ? DataQuality.observed
        : DataQuality.unknown;
    final point = json['charge_point'];
    final online = point is Map<String, dynamic> ? point['is_online'] : null;
    final mode = switch (json['billing_mode']) {
      'full' => ChargingMode.autoFull,
      'timed' => ChargingMode.timed,
      'energy_kwh' => ChargingMode.energy,
      'amount_vnd' => ChargingMode.cost,
      _ => null,
    };
    final limit = _integerOrNull(json['limit_value']);
    if (mode == ChargingMode.autoFull
        ? limit != null
        : mode != null && (limit == null || limit == 0)) {
      throw _retry;
    }
    final costQuality = _state(
      ChargeCostQuality.values,
      json['metered_cost_quality'],
      ChargeCostQuality.unknown,
    );
    final cost = _integerOrNull(json['metered_cost_vnd_estimate']);
    final hasMetadata = [
      'origin',
      'payment_mode',
      'can_stop',
      'statement_available',
    ].any(json.containsKey);
    if (hasMetadata &&
        (json['origin'] is! String ||
            json['payment_mode'] is! String ||
            json['can_stop'] is! bool ||
            json['statement_available'] is! bool ||
            (json['can_stop'] == true &&
                (sessionOrigin(json['origin']) != SessionOrigin.appQr ||
                    json['meter_stop_wh'] != null ||
                    !isStoppableStatus(
                      _state(
                        SessionState.values,
                        json['status'],
                        SessionState.unknown,
                      ),
                    ))) ||
            (json['statement_available'] == true &&
                sessionPaymentMode(json['payment_mode']) !=
                    PaymentMode.csmsBilled))) {
      throw _retry;
    }
    return ChargeProgress(
      origin: hasMetadata ? sessionOrigin(json['origin']) : null,
      paymentMode: hasMetadata
          ? sessionPaymentMode(json['payment_mode'])
          : null,
      serverCanStop: hasMetadata ? json['can_stop'] as bool : null,
      statementAvailable: hasMetadata
          ? json['statement_available'] as bool
          : null,
      status: _state(SessionState.values, json['status'], SessionState.unknown),
      settlement: switch (json['settlement_state']) {
        'pending' => SettlementState.pending,
        'posted' => SettlementState.posted,
        'review' => SettlementState.review,
        'ineligible' => SettlementState.notApplicable,
        _ => SettlementState.unknown,
      },
      connection: switch (online) {
        true => ConnectionState.online,
        false => ConnectionState.offline,
        _ => ConnectionState.unknown,
      },
      quality: quality,
      updatedAt: _timestamp(json['updated_at']),
      billingMode: mode,
      billingModeMissing: !json.containsKey('billing_mode'),
      limitValue: limit,
      elapsedSeconds: _integerOrNull(json['elapsed_seconds']),
      costEstimateVnd: costQuality == ChargeCostQuality.unknown ? null : cost,
      costQuality: cost == null ? ChargeCostQuality.unknown : costQuality,
      costClock: switch (json['metered_cost_clock']) {
        'cp' => ChargeCostClock.cp,
        'cp_offset' => ChargeCostClock.cpOffset,
        'csms' => ChargeCostClock.csms,
        _ => null,
      },
      consumedWh: _integerOrNull(json['consumed_wh']),
      meterStopWh: _integerOrNull(json['meter_stop_wh']),
      energyWh: _integerOrNull(json['energy_wh']),
      estimatedCostVnd: _integerOrNull(json['estimated_cost_vnd']),
      billingReviewRequired: json['billing_review_required'] == true,
    );
  });

  @override
  ChargeSessionRead<PostedChargeStatement> statement(
    ChargeSessionTarget target,
  ) => _read((cancel) async {
    final json = await _session.readChargeStatement(
      target.scope.principalId,
      target.id,
      cancel,
    );
    if (json['session_id'] != target.id ||
        json['driver_id'] != target.scope.principalId) {
      throw _unavailable;
    }
    return PostedChargeStatement(
      energyWh: _integerOrNull(json['energy_wh']) ?? (throw _retry),
      amountVnd: _integerOrNull(json['amount_vnd']) ?? (throw _retry),
      earnedPoints: _integerOrNull(json['earned_points']) ?? (throw _retry),
      createdAt: _timestamp(json['created_at']),
    );
  });

  ChargeSessionRead<T> _read<T>(Future<T> Function(CancelToken) run) {
    final token = CancelToken();
    return (result: _mapError(run(token)), cancel: token.cancel);
  }

  Future<T> _mapError<T>(Future<T> response) async {
    try {
      return await response;
    } on DriverApiException catch (error) {
      throw error.status == 404 ? _unavailable : _retry;
    }
  }
}

const _unavailable = ChargeSessionException(ChargeSessionIssue.unavailable);
const _retry = ChargeSessionException(ChargeSessionIssue.retry);
const _maxSafeInteger = 9007199254740991;
final _id = RegExp(r'^[1-9][0-9]{0,18}$');

T _state<T extends Enum>(List<T> values, Object? raw, T fallback) =>
    values.firstWhere((state) => state.name == raw, orElse: () => fallback);

int? _integerOrNull(Object? raw) {
  if (raw == null) return null;
  if (raw is int && raw >= 0 && raw <= _maxSafeInteger) return raw;
  throw _retry;
}

DateTime _timestamp(Object? raw) {
  final date = raw is String ? DateTime.tryParse(raw) : null;
  if (date == null || !date.isUtc) throw _retry;
  return date;
}
