import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';

const accessA = 'fixture.access.a';
const accessB = 'fixture.access.b';
const refreshA = 'fixture.refresh.a';

Map<String, Object> tokens(String access, {bool login = true}) => {
  'access_token': access,
  'token_type': 'Bearer',
  'expires_in': 900,
  if (login) ...{'refresh_token': refreshA, 'refresh_expires_in': 2592000},
};

Map<String, Object> account({
  String name = 'Tài xế kiểm thử',
  String id = '9007199254740993',
  bool withVehicle = true,
  List<Map<String, Object?>>? vehicles,
}) => {
  'user_id': id,
  'full_name': name,
  'role': 'driver',
  'account_status': 'active',
  'vehicles': vehicles ?? [if (withVehicle) ownVehicle()],
};

const vf8 = {
  'vehicle_model_id': '10',
  'brand': 'VinFast',
  'model_name': 'VF 8',
  'connector_type': 'gbt',
  'is_vinfast': true,
  'battery_capacity_kwh': null,
  'rated_range_km': null,
  'max_dc_kw': null,
};

const leaf = {
  'vehicle_model_id': '9007199254740997',
  'brand': 'Nissan',
  'model_name': 'Leaf',
  'connector_type': 'chademo',
  'is_vinfast': false,
  'battery_capacity_kwh': 39.5,
  'rated_range_km': 270,
  'max_dc_kw': 50,
};

Map<String, Object?> ownVehicle({
  String id = '9',
  String plate = '51A-00001',
  bool isDefault = true,
  Map<String, Object?> model = vf8,
}) => {
  ...model,
  'vehicle_id': id,
  'plate_number': plate,
  'is_default': isDefault,
};

ResponseBody reply(int status, Object json) => ResponseBody.fromString(
  jsonEncode(json),
  status,
  headers: {
    Headers.contentTypeHeader: [Headers.jsonContentType],
  },
);

class DriverApiFixture implements HttpClientAdapter {
  DriverApiFixture(this.handler);

  final Future<ResponseBody> Function(RequestOptions options) handler;
  final requests = <RequestOptions>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) {
    requests.add(options);
    return handler(options);
  }

  @override
  void close({bool force = false}) {}
}
