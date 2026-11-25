import 'package:driver_app/features/auth/domain/auth_scope.dart';
import 'package:driver_app/features/charging/domain/charge_session.dart';
import 'package:driver_app/features/charging/domain/charging.dart';
import 'package:driver_app/features/charging/domain/owned_sessions.dart';
import 'package:driver_app/features/charging/data/api_owned_session_repository.dart';

Map<String, dynamic> ownedSessionJson({
  String id = '78',
  String origin = 'rfid',
  String status = 'active',
  bool statement = false,
  int? amount,
  bool stopped = false,
}) => {
  'session_id': id,
  'status': status,
  'origin': origin,
  'payment_mode': 'csms_billed',
  'can_stop': origin == 'app_qr' && status == 'active' && !stopped,
  'statement_available': statement,
  'started_at': '2026-11-24T01:00:00Z',
  'stopped_at': stopped ? '2026-11-24T02:00:00Z' : null,
  'updated_at': '2026-11-24T02:00:00Z',
  'energy_wh': stopped ? 1200 : null,
  'amount_vnd': amount,
  'settlement_state': statement ? 'posted' : null,
  'connector_id': '31',
  'connector_no': 2,
  'charge_point_display_code': 'PM-T146',
  'site_id': '4',
  'site_name': 'Trạm PowerMe',
  'vehicle_id': null,
  'vehicle_label': null,
};
Map<String, dynamic> ownedPageJson(
  List<Map<String, dynamic>> items, {
  int? total,
  int page = 1,
  int pageSize = 20,
}) => {
  'items': items,
  'total': total ?? items.length,
  'page': page,
  'page_size': pageSize,
};
OwnedSessionSummary summary(
  AuthScope scope, {
  String id = '78',
  String origin = 'rfid',
}) => decodeOwnedSessionPage(
  ownedPageJson([ownedSessionJson(id: id, origin: origin)]),
  scope: scope,
  page: 1,
  pageSize: 20,
).items.single;

Map<String, dynamic> externalProgress({
  String status = 'active',
  bool closed = false,
  bool statement = false,
  int energy = 1200,
  String origin = 'rfid',
  int? costEstimate,
}) => {
  'session_id': '78',
  'status': status,
  'origin': origin,
  'payment_mode': 'csms_billed',
  'can_stop': origin == 'app_qr' && status == 'active' && !closed,
  'statement_available': statement,
  'updated_at': '2026-11-24T02:00:00Z',
  'telemetry_quality': 'observed',
  'charge_point': {'is_online': true},
  'billing_mode': null,
  'limit_value': null,
  'consumed_wh': energy,
  'meter_stop_wh': closed ? 1400 : null,
  'energy_wh': closed ? energy : null,
  'settlement_state': statement
      ? 'posted'
      : closed
      ? 'ineligible'
      : null,
  'billing_review_required': false,
  'estimated_cost_vnd': null,
  if (costEstimate != null) ...{
    'metered_cost_vnd_estimate': costEstimate,
    'metered_cost_quality': 'exact',
  },
};
ChargeProgress progress({
  SessionOrigin? origin = SessionOrigin.rfid,
  SessionState status = SessionState.active,
  bool canStop = false,
  bool? statement = false,
  int? meterStop,
  SettlementState settlement = SettlementState.pending,
  bool review = false,
}) => ChargeProgress(
  origin: origin,
  paymentMode: PaymentMode.csmsBilled,
  serverCanStop: canStop,
  statementAvailable: statement,
  status: status,
  settlement: settlement,
  connection: ConnectionState.online,
  quality: DataQuality.observed,
  updatedAt: DateTime.utc(2026, 11, 24),
  limitValue: null,
  consumedWh: 1200,
  meterStopWh: meterStop,
  energyWh: meterStop == null ? null : 1200,
  estimatedCostVnd: null,
  billingReviewRequired: review,
);
