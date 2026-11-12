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

class DriverVehicleResponse {
  DriverVehicleResponse._(Map<String, dynamic> json)
    : id = _id(json, 'vehicle_id'),
      plate = _text(json, 'plate_number'),
      brand = _text(json, 'brand'),
      model = _text(json, 'model_name'),
      connector = switch (json['connector_type']) {
        'ccs2' => 'CCS2',
        'chademo' => 'CHAdeMO',
        'gbt' => 'GB/T',
        'type2' => 'Type 2',
        _ => throw _malformed,
      },
      isDefault = _boolean(json, 'is_default') {
    _id(json, 'vehicle_model_id');
    _boolean(json, 'is_vinfast');
    _nullableNumber<num>(json, 'battery_capacity_kwh');
    _nullableNumber<int>(json, 'rated_range_km');
    _nullableNumber<num>(json, 'max_dc_kw');
  }

  final String id;
  final String plate;
  final String brand;
  final String model;
  final String connector;
  final bool isDefault;
}

List<DriverVehicleResponse> _vehicles(Object? value) {
  if (value is! List) throw _malformed;
  final ids = <String>{};
  return List.unmodifiable(
    value.map((item) {
      if (item is! Map<String, dynamic>) throw _malformed;
      final vehicle = DriverVehicleResponse._(item);
      if (!ids.add(vehicle.id)) throw _malformed;
      return vehicle;
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

void _nullableNumber<T extends num>(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (!json.containsKey(key) ||
      (value != null && (value is! T || !value.isFinite))) {
    throw _malformed;
  }
}

const _malformed = DriverApiException(DriverApiProblem.malformed);
