import 'package:dio/dio.dart';

import '../../../core/api/driver_api_exception.dart';
import '../../../core/api/driver_api_session.dart';
import '../../../core/api/driver_api_values.dart';
import '../../../core/api/vnpay_checkout_url.dart';
import '../../auth/domain/auth_scope.dart';
import '../domain/credit_top_up.dart';

class ApiCreditTopUpRepository implements CreditTopUpRepository {
  const ApiCreditTopUpRepository(this._session);

  final DriverApiSession _session;

  @override
  TopUpRead<TopUpQuote> quote(AuthScope scope, int amountVnd) {
    final cancel = CancelToken();
    final result = _session
        .quoteTopUp(scope.principalId, amountVnd, cancel)
        .then((json) {
          final available = _integer(json['points_available']);
          final max = _integer(json['max_points']);
          final discount = _integer(json['max_discount_vnd']);
          if (max > available ||
              (max != 0 && max < minRedeemPoints) ||
              discount > amountVnd ~/ 2 ||
              (max == 0) != (discount == 0)) {
            throw _malformed;
          }
          return (
            pointsAvailable: available,
            maxPoints: max,
            maxDiscountVnd: discount,
          );
        });
    return (result: result, cancel: cancel.cancel);
  }

  @override
  Future<TopUpCreate> create(AuthScope scope, TopUpRequest request) async {
    try {
      final response = await _session.createTopUp(
        scope.principalId,
        request.key,
        request.amountVnd,
        request.points,
      );
      final order = _order(response.json);
      if (order.amountVnd != request.amountVnd ||
          order.points != request.points) {
        throw _malformed;
      }
      return (
        id: order.id,
        confirming: false,
        freshCheckout:
            response.created &&
            order.status == TopUpStatus.pending &&
            order.paymentUrl != null &&
            order.expiresAt.isAfter(DateTime.now()),
      );
    } on DriverApiException catch (error) {
      final conflict = error.topUpConflict;
      if (conflict != null) {
        // Fetch the owned order for the current link and its expiration.
        return (
          id: conflict.id,
          confirming: conflict.confirming,
          freshCheckout: false,
        );
      }
      rethrow;
    }
  }

  @override
  TopUpRead<CreditTopUp> status(AuthScope scope, String id) {
    final cancel = CancelToken();
    final result = _session.readTopUp(scope.principalId, id, cancel).then((
      json,
    ) {
      final order = _order(json);
      if (order.id != id) throw _malformed;
      return order;
    });
    return (result: result, cancel: cancel.cancel);
  }
}

const _malformed = DriverApiException(DriverApiProblem.malformed);

int _integer(Object? value) {
  if (value is! int || value < 0 || value > 9007199254740991) throw _malformed;
  return value;
}

CreditTopUp _order(Map<String, dynamic> json) {
  final id = json['top_up_id'];
  final status = switch (json['status']) {
    'pending' => TopUpStatus.pending,
    'credited' => TopUpStatus.credited,
    'failed' => TopUpStatus.failed,
    'expired' => TopUpStatus.expired,
    'refunded' => TopUpStatus.refunded,
    _ => throw _malformed,
  };
  final amount = _integer(json['amount_vnd']);
  final points = _integer(json['points_redeemed']);
  final discount = _integer(json['points_discount_vnd']);
  final paid = _integer(json['amount_paid_vnd']);
  final created = driverApiTimestamp(json['created_at']);
  final expires = driverApiTimestamp(json['expires_at']);
  final url = json['payment_url'];
  final paymentUrl = validatedVnpayCheckoutUrl(url);
  if (!isDriverApiId(id) ||
      amount == 0 ||
      paid == 0 ||
      discount != amount - paid ||
      (points == 0) != (discount == 0) ||
      created == null ||
      expires == null ||
      !expires.isAfter(created) ||
      !json.containsKey('payment_url') ||
      (url != null && (paymentUrl == null || status != TopUpStatus.pending))) {
    throw _malformed;
  }
  return (
    id: id as String,
    status: status,
    amountVnd: amount,
    points: points,
    discountVnd: discount,
    amountPaidVnd: paid,
    createdAt: created,
    expiresAt: expires,
    paymentUrl: paymentUrl,
  );
}
