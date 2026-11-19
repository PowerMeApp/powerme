import '../../auth/domain/auth_scope.dart';

const minTopUpVnd = 50000;
const maxTopUpVnd = 2000000;
const minRedeemPoints = 500;

int? parseTopUpInteger(String input) {
  final text = input.trim();
  return RegExp(r'^[0-9]{1,15}$').hasMatch(text) ? int.tryParse(text) : null;
}

bool validTopUpAmount(int? amount) =>
    amount != null && amount >= minTopUpVnd && amount <= maxTopUpVnd;

typedef TopUpQuote = ({int pointsAvailable, int maxPoints, int maxDiscountVnd});

int? topUpPayableEstimate(int amount, int points, TopUpQuote quote) {
  if (points == 0) return amount;
  final maxPoints = quote.maxPoints;
  final maxDiscount = quote.maxDiscountVnd;
  if (points < minRedeemPoints ||
      points > maxPoints ||
      maxDiscount <= 0 ||
      maxDiscount > amount ~/ 2 ||
      maxDiscount % maxPoints != 0) {
    return null;
  }
  return amount - points * (maxDiscount ~/ maxPoints);
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
