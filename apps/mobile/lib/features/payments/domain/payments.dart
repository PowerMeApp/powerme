import '../../auth/domain/auth_scope.dart';

enum TopUpState {
  pending,
  unknown,
  verified,
  posted,
  failed,
  expired,
  refundPending,
  refunded,
}

enum InvoiceState { pending, issued, failed }

class CreditEntry {
  const CreditEntry(this.reference, this.label, this.amountVnd, this.at);
  final String reference;
  final String label;
  final int amountVnd;
  final DateTime at;
}

class TopUpOrder {
  const TopUpOrder({
    required this.scope,
    required this.id,
    required this.attemptId,
    required this.version,
    required this.amountVnd,
    required this.cashVnd,
    required this.points,
    required this.createdAt,
    required this.state,
    required this.invoice,
    required this.creditPosted,
    required this.checkoutOpened,
    this.invoiceNumber,
    this.invoiceText,
  });
  final AuthScope scope;
  final String id;
  final String attemptId;
  final int version;
  final int amountVnd;
  final int cashVnd;
  final int points;
  final DateTime createdAt;
  final TopUpState state;
  final InvoiceState invoice;
  final bool creditPosted;
  final bool checkoutOpened;
  final String? invoiceNumber;
  final String? invoiceText;
  bool get open =>
      state == TopUpState.pending ||
      state == TopUpState.unknown ||
      state == TopUpState.verified;
}

class CreditSnapshot {
  const CreditSnapshot({
    required this.scope,
    required this.version,
    required this.balanceVnd,
    required this.availableVnd,
    required this.availablePoints,
    required this.orders,
    required this.entries,
    this.closureReference,
    this.minimumTopUpVnd = 50000,
    this.maximumTopUpVnd = 2000000,
    this.balanceCapVnd = 5000000,
  });
  final AuthScope scope;
  final int version;
  final int balanceVnd;
  final int availableVnd;
  final int availablePoints;
  final List<TopUpOrder> orders;
  final List<CreditEntry> entries;
  final int minimumTopUpVnd;
  final int maximumTopUpVnd;
  final int balanceCapVnd;
  final String? closureReference;
}

abstract interface class PaymentsRepository {
  Future<CreditSnapshot> credit();
  Future<TopUpOrder> create(int amountVnd, int points, String key);
  Future<TopUpOrder> openCheckout(String orderId, String attemptId);
  Future<TopUpOrder> order(String orderId);
  Future<String> requestClosure(String key);
}
