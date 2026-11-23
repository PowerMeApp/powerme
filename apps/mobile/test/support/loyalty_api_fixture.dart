import 'package:dio/dio.dart';
import '../driver_api_fixture.dart';

const loyaltyQuotePath = 'billing/top-ups/quote';
Map<String, Object?> loyaltyQuote({
  int available = 600,
  int maximum = 600,
  int discount = 6000,
}) => {
  'points_available': available,
  'max_points': maximum,
  'max_discount_vnd': discount,
};

DriverApiFixture loyaltyFixture({
  required Future<ResponseBody> Function(RequestOptions) quote,
  String Function()? principal,
  Future<ResponseBody> Function(RequestOptions)? other,
}) => DriverApiFixture(
  (request) async => switch (request.path) {
    'auth/login' => reply(200, tokens(accessA)),
    'auth/logout' => reply(200, {'success': true}),
    'me' => reply(
      200,
      account(id: principal?.call() ?? '42', withVehicle: false),
    ),
    'credit' => reply(200, {
      'balance_vnd': 0,
      'held_vnd': 0,
      'available_vnd': 0,
      'status': 'active',
      'updated_at': '2026-11-19T00:00:00Z',
    }),
    loyaltyQuotePath => quote(request),
    _ =>
      other != null
          ? other(request)
          : throw StateError(
              'Unexpected fixture request: ${request.method} ${request.path}',
            ),
  },
);
