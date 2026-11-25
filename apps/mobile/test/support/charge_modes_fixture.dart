import 'package:dio/dio.dart';
import 'package:driver_app/features/charging/domain/charging.dart';

import '../driver_api_fixture.dart';
import '../driver_discovery_fixture.dart' show page;

String wireChargeMode(ChargingMode mode) => switch (mode) {
  ChargingMode.autoFull => 'full',
  ChargingMode.timed => 'timed',
  ChargingMode.energy => 'energy_kwh',
  ChargingMode.cost => 'amount_vnd',
};

String? chargeLimitField(ChargingMode mode) => switch (mode) {
  ChargingMode.autoFull => null,
  ChargingMode.timed => 'duration_minutes',
  ChargingMode.energy => 'energy_limit_wh',
  ChargingMode.cost => 'amount_limit_vnd',
};

String? chargeCapField(ChargingMode mode) => switch (mode) {
  ChargingMode.autoFull => null,
  ChargingMode.timed => 'max_duration_minutes',
  ChargingMode.energy => 'max_energy_wh',
  ChargingMode.cost => 'max_amount_vnd',
};

Map<String, Object?> chargeModeSnapshot(
  ChargingMode mode, {
  String outcome = 'accepted',
  bool started = false,
  int? cap,
}) => {
  'intent_id': '41',
  'command_id': cap == null ? '52' : null,
  'session_id': started ? '78' : null,
  'outcome': started ? 'active' : outcome,
  'effect_confirmed': started,
  'version': started ? 2 : 1,
  'mode': wireChargeMode(mode),
  'max_energy_wh': null,
  'max_duration_minutes': null,
  'max_amount_vnd': null,
  if (cap != null && chargeCapField(mode) != null) chargeCapField(mode)!: cap,
};

Map<String, Object?> chargeModeProgress(
  ChargingMode mode,
  int? limit, {
  String status = 'active',
  String settlement = 'pending',
}) => {
  'session_id': '78',
  'status': status,
  'settlement_state': settlement,
  'updated_at': '2026-11-19T01:02:00Z',
  'billing_mode': wireChargeMode(mode),
  'limit_value': limit,
  'elapsed_seconds': 1104,
  'meter_start_wh': 400,
  'meter_stop_wh': status == 'closed' ? 10630 : null,
  'energy_wh': status == 'closed' ? 10230 : null,
  'consumed_wh': 10230,
  'estimated_cost_vnd': 51000,
  'metered_cost_vnd_estimate': 32000,
  'metered_cost_quality': 'interpolated',
  'metered_cost_clock': 'cp_offset',
  'telemetry_quality': 'observed',
  'billing_review_required': false,
  'charge_point': {'is_online': true},
};

class ChargeModesFixture {
  ChargeModesFixture() {
    adapter = DriverApiFixture(_handle);
  }
  late final DriverApiFixture adapter;
  ChargingMode mode = ChargingMode.energy;
  int? limit = 10000;
  bool confirmed = false;
  int? cap;
  String? rejection;
  Future<ResponseBody>? pendingPost;
  Future<ResponseBody>? pendingRead;
  Map<String, Object?>? progress;

  Future<ResponseBody> _handle(RequestOptions request) async {
    switch ((request.method, request.path)) {
      case ('POST', 'auth/login'):
        return reply(200, tokens(accessA));
      case ('GET', 'me'):
        return reply(
          200,
          account(
            id: '7',
            vehicles: [ownVehicle(model: _ioniq5)],
          ),
        );
      case ('GET', 'stations'):
        return reply(200, page([]));
      case ('GET', 'connectors/by-code/PM-T96/2'):
        return reply(200, {
          'connector_id': '31',
          'display_code': 'PM-T96',
          'connector_no': 2,
          'site_name': 'Trạm PowerMe T96',
          'status': 'Preparing',
          'is_online': true,
          'reported_issue': false,
        });
      case ('POST', 'charges'):
        final body = request.data as Map;
        mode = ChargingMode.values.singleWhere(
          (m) => wireChargeMode(m) == body['mode'],
        );
        limit = body[chargeLimitField(mode)] as int?;
        if (rejection != null) return reply(400, {'error': rejection});
        if (pendingPost != null) return pendingPost!;
        return reply(
          202,
          chargeModeSnapshot(
            mode,
            started: confirmed,
            cap: cap,
            outcome: cap == null ? 'accepted' : 'requiresconfirmation',
          ),
        );
      case ('GET', final path) when path.startsWith('charges/'):
        if (pendingRead != null) return pendingRead!;
        return reply(200, chargeModeSnapshot(mode, started: confirmed));
      case ('GET', 'sessions'):
        return emptyActiveSessions(request);
      case ('GET', 'sessions/78/progress'):
        return reply(200, progress ?? chargeModeProgress(mode, limit));
      case ('POST', 'sessions/78/stop'):
        return reply(202, {
          'command_id': '53',
          'command_status': 'accepted',
          'session_status': 'stopping',
          'effect_confirmed': false,
        });
      case ('GET', 'sessions/78/statement'):
        return reply(200, {
          'session_id': '78',
          'driver_id': '7',
          'energy_wh': 10230,
          'amount_vnd': 32000,
          'earned_points': 32,
          'created_at': '2026-11-19T01:03:00Z',
        });
      default:
        throw StateError('Unexpected ${request.method} ${request.path}');
    }
  }
}

const _ioniq5 = {
  'vehicle_model_id': '30',
  'brand': 'Hyundai',
  'model_name': 'IONIQ 5',
  'connector_type': 'ccs2',
  'is_vinfast': false,
  'battery_capacity_kwh': null,
  'rated_range_km': null,
  'max_dc_kw': null,
};
