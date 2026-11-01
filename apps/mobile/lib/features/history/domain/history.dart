import '../../auth/domain/auth_scope.dart';
import '../../charging/domain/charging.dart';
import '../../payments/domain/payments.dart';

class HistorySnapshot {
  const HistorySnapshot(
    this.scope,
    this.version,
    this.sessions,
    this.orders,
    this.entries,
  );
  final AuthScope scope;
  final int version;
  final List<SessionSnapshot> sessions;
  final List<TopUpOrder> orders;
  final List<CreditEntry> entries;
}

abstract interface class HistoryRepository {
  Future<HistorySnapshot> history();
  Future<TopUpOrder> invoice(String orderId);
}
