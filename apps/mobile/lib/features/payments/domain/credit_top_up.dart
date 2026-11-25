import '../../auth/domain/auth_scope.dart';
import '../../loyalty/domain/loyalty.dart';

export '../../loyalty/domain/loyalty.dart' show minRedemptionPoints;

const minTopUpVnd = 50000;
const maxTopUpVnd = 2000000;

int? parseTopUpInteger(String input) {
  final text = input.trim();
  return RegExp(r'^[0-9]{1,15}$').hasMatch(text) ? int.tryParse(text) : null;
}

bool validTopUpAmount(int? amount) =>
    amount != null && amount >= minTopUpVnd && amount <= maxTopUpVnd;

bool validTopUpPoints(int? points, int maxPoints) =>
    points != null &&
    (points == 0 || (points >= minRedemptionPoints && points <= maxPoints));

typedef TopUpQuote = ({int pointsAvailable, int maxPoints, int maxDiscountVnd});

int? topUpPayableEstimate(int amount, int points, TopUpQuote quote) {
  if (points == 0) return amount;
  // The quote prices only its maximum selection, not arbitrary point amounts.
  if (points <= 0 ||
      points != quote.maxPoints ||
      quote.maxDiscountVnd <= 0 ||
      quote.maxDiscountVnd >= amount) {
    return null;
  }
  return amount - quote.maxDiscountVnd;
}

typedef TopUpRequest = ({String key, int amountVnd, int points});

enum TopUpStatus { pending, credited, failed, expired, refunded }

typedef CreditTopUp = ({
  String id,
  TopUpStatus status,
  int amountVnd,
  int points,
  int discountVnd,
  int amountPaidVnd,
  DateTime createdAt,
  DateTime expiresAt,
  String? paymentUrl,
});

enum TopUpIssue {
  uncertain,
  rejected,
  balanceLimit,
  quoteChanged,
  pointsBelowMinimum,
  accountClosed,
  keyConflict,
  paymentUnavailable,
  statusUnavailable,
  notFound,
  malformed,
  launchUnavailable,
}

typedef TopUpRead<T> = ({Future<T> result, void Function() cancel});

typedef TopUpCreate = ({String id, bool confirming, bool freshCheckout});

abstract interface class CreditTopUpRepository {
  TopUpRead<TopUpQuote> quote(AuthScope scope, int amountVnd);
  Future<TopUpCreate> create(AuthScope scope, TopUpRequest request);
  TopUpRead<CreditTopUp> status(AuthScope scope, String id);
}
