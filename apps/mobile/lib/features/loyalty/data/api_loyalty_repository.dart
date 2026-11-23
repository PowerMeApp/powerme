import 'package:dio/dio.dart';

import '../../../core/api/driver_api_session.dart';
import '../../../core/api/driver_top_up_quote.dart';
import '../../auth/domain/auth_scope.dart';
import '../domain/loyalty.dart';

class ApiLoyaltyRepository implements LoyaltyBalanceRepository {
  const ApiLoyaltyRepository(this._session, {required this.probeAmountVnd});

  final DriverApiSession _session;
  final int probeAmountVnd;

  @override
  LoyaltyRead read(AuthScope scope) {
    final cancel = CancelToken();
    final result = _session
        .quoteTopUp(scope.principalId, probeAmountVnd, cancel)
        .then(
          (json) => LoyaltyBalance(
            scope: scope,
            availablePoints: driverTopUpQuote(
              json,
              probeAmountVnd,
            ).pointsAvailable,
          ),
        );
    return (result: result, cancel: cancel.cancel);
  }
}
