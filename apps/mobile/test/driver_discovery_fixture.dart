import 'driver_api_fixture.dart';

const firstConnector = '9007199254740998';
const bestConnector = '9007199254740999';

Map<String, Object?> station(
  String id,
  String name, {
  bool coordinates = true,
  bool smart = false,
}) => {
  'site_id': id,
  'site_code': 'S$id',
  'site_name': name,
  'operator_id': '41',
  'operator_name': 'PowerMe',
  'address': null,
  'vinfast_only': false,
  'latitude': coordinates ? 10.8 : null,
  'longitude': coordinates ? 106.7 : null,
  'distance_m': smart ? 1800 : null,
  'best_connector_id': smart ? bestConnector : null,
  'reach': smart ? 'risky' : null,
  'est_drive_min': smart ? 8.5 : null,
  'est_wait_min': smart ? 0 : null,
  'est_charge_min': smart ? 16.0 : null,
  'est_total_min': smart ? 24.5 : null,
  'est_cost_vnd_max': smart ? 0 : null,
  'connectors': [
    {
      'connector_id': firstConnector,
      'charge_point_id': '11',
      'display_code': 'TRU-11',
      'connector_no': 1,
      'connector_type': 'chademo',
      'driver_status': 'unknown',
      'status_quality': 'stale',
      'available_now': false,
    },
    {
      'connector_id': bestConnector,
      'charge_point_id': '12',
      'display_code': 'TRU-12',
      'connector_no': 1,
      'connector_type': 'chademo',
      'driver_status': 'available',
      'status_quality': 'fresh',
      'available_now': true,
      'rated_power_kw': 30.5,
      'status_updated_at': '2026-11-13T01:30:00Z',
    },
  ],
};

Map<String, Object?> page(
  List<Map<String, Object?>> items, {
  int page = 1,
  int pageSize = 20,
  int? total,
  String? reason,
  double? rangeKm,
  String? rankingSource,
}) => {
  'items': items,
  'total': total ?? items.length,
  'page': page,
  'page_size': pageSize,
  'estimate': rangeKm == null ? null : {'est_range_km': rangeKm},
  'smart_unavailable_reason': ?reason,
  'ranking_source': ?rankingSource,
};

const place = {
  'ref_id': 'auto:fixture',
  'display': '12 Võ Văn Tần',
  'name': 'Võ Văn Tần',
  'address': '12 Võ Văn Tần',
};

Map<String, Object?> road({
  Object coordinates = const [
    [106.66, 10.77],
    [106.68, 10.78],
    [106.7, 10.8],
  ],
}) => {
  'site_id': '31',
  'distance_m': 2400.5,
  'duration_s': 422,
  'computed_at': '2026-11-13T01:30:00Z',
  'quality': 'provider_estimate',
  'traffic_quality': 'unknown',
  'cached': false,
  'geometry': {'type': 'LineString', 'coordinates': coordinates},
};

Map<String, Object?> roadWithTraffic() => {
  ...road(
    coordinates: const [
      [106.66, 10.77],
      [106.67, 10.77],
      [106.68, 10.78],
      [106.7, 10.8],
    ],
  ),
  'instructions': [
    {'start_index': 0, 'end_index': 1, 'sign': 0, 'distance_m': 300},
    {
      'start_index': 1,
      'end_index': 1,
      'sign': -2,
      'text': 'Đi về phía trạm sạc',
      'street_name': 'Võ Văn Tần',
      'distance_m': 108,
    },
    {'start_index': 2, 'end_index': 2, 'sign': 4, 'distance_m': 0},
  ],
  'traffic_segments': [
    {'start_index': 2, 'end_index': 3, 'level': 'low'},
    {'start_index': 0, 'end_index': 1, 'level': 'heavy'},
  ],
  'congested_distance_m': 300,
};

Map<String, Object?> leafVehicle({String id = '9', bool isDefault = true}) =>
    ownVehicle(id: id, model: leaf, isDefault: isDefault);
