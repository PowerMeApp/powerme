import 'driver_api_exception.dart';

({int pointsAvailable, int maxPoints, int maxDiscountVnd}) driverTopUpQuote(
  Map<String, dynamic> json,
  int amountVnd,
) {
  final available = _integer(json['points_available']);
  final maximum = _integer(json['max_points']);
  final discount = _integer(json['max_discount_vnd']);
  if (maximum > available ||
      discount >= amountVnd ||
      (maximum == 0) != (discount == 0)) {
    throw _malformed;
  }
  return (
    pointsAvailable: available,
    maxPoints: maximum,
    maxDiscountVnd: discount,
  );
}

const _malformed = DriverApiException(DriverApiProblem.malformed);

int _integer(Object? value) {
  if (value is! int || value < 0 || value > 9007199254740991) throw _malformed;
  return value;
}
