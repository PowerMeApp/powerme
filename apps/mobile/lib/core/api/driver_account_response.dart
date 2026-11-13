import 'driver_api_exception.dart';

class DriverAccountResponse {
  DriverAccountResponse.fromJson(Map<String, dynamic> json)
    : id = _id(json, 'user_id'),
      fullName = _text(json, 'full_name'),
      vehicles = _vehicles(json['vehicles']) {
    if (json['role'] != 'driver' || json['account_status'] != 'active') {
      throw _malformed;
    }
  }

  final String id;
  final String fullName;
  final List<DriverVehicleResponse> vehicles;
}

class DriverVehicleModelResponse {
  DriverVehicleModelResponse._(Map<String, dynamic> json)
    : modelId = _id(json, 'vehicle_model_id'),
      brand = _text(json, 'brand'),
      model = _text(json, 'model_name'),
      connector = switch (json['connector_type']) {
        'ccs2' => 'CCS2',
        'chademo' => 'CHAdeMO',
        'gbt' => 'GB/T',
        'type2' => 'Type 2',
        _ => throw _malformed,
      },
      isVinFast = _boolean(json, 'is_vinfast'),
      batteryCapacityKwh = _nullableNumber<num>(json, 'battery_capacity_kwh'),
      ratedRangeKm = _nullableNumber<int>(json, 'rated_range_km'),
      maxDcKw = _nullableNumber<num>(json, 'max_dc_kw');

  final String modelId;
  final String brand;
  final String model;
  final String connector;
  final bool isVinFast;
  final num? batteryCapacityKwh;
  final int? ratedRangeKm;
  final num? maxDcKw;

  static List<DriverVehicleModelResponse> catalog(Map<String, dynamic> json) =>
      _uniqueList(
        json['items'],
        DriverVehicleModelResponse._,
        (v) => v.modelId,
      );
}

class DriverVehicleResponse extends DriverVehicleModelResponse {
  DriverVehicleResponse._(super.json)
    : id = _id(json, 'vehicle_id'),
      plate = _text(json, 'plate_number'),
      isDefault = _boolean(json, 'is_default'),
      super._();

  final String id;
  final String plate;
  final bool isDefault;
}

List<DriverVehicleResponse> _vehicles(Object? value) =>
    _uniqueList(value, DriverVehicleResponse._, (v) => v.id);

List<T> _uniqueList<T>(
  Object? value,
  T Function(Map<String, dynamic>) parse,
  String Function(T) id,
) {
  if (value is! List) throw _malformed;
  final ids = <String>{};
  return List.unmodifiable(
    value.map((item) {
      if (item is! Map<String, dynamic>) throw _malformed;
      final entry = parse(item);
      if (!ids.add(id(entry))) throw _malformed;
      return entry;
    }),
  );
}

String _text(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is! String) throw _malformed;
  return value;
}

String _id(Map<String, dynamic> json, String key) {
  final value = _text(json, key);
  if (!RegExp(r'^[1-9][0-9]{0,18}$').hasMatch(value) ||
      (value.length == 19 && value.compareTo('9223372036854775807') > 0)) {
    throw _malformed;
  }
  return value;
}

bool _boolean(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is! bool) throw _malformed;
  return value;
}

T? _nullableNumber<T extends num>(Map<String, dynamic> json, String key) {
  if (!json.containsKey(key)) throw _malformed;
  final value = json[key];
  if (value == null) return null;
  if (value is! T || !value.isFinite) throw _malformed;
  return value;
}

const _malformed = DriverApiException(DriverApiProblem.malformed);
