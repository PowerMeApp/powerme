import '../../../demo/demo_store.dart';
import '../../../demo/charging_store.dart';
import '../../../demo/payment_store.dart';
import '../../../demo/payment_engine.dart';
import '../../auth/domain/auth_scope.dart';
import '../../charging/domain/charging.dart';
import '../../charging/data/mock_charging_repository.dart';
import '../../../demo/station_actions_store.dart';
import '../../history/domain/history.dart';
import '../../loyalty/domain/loyalty.dart';
import '../domain/payments.dart';

class MockPaymentsRepository
    implements PaymentsRepository, HistoryRepository, LoyaltyRepository {
  MockPaymentsRepository(
    this.store,
    this.payments,
    this.charging,
    this.actions,
    this.scope,
  );
  final DemoStore store;
  final PaymentStore payments;
  final ChargingStore charging;
  final StationActionsStore actions;
  final AuthScope scope;
  void guard() => store.requireScope(scope);
  LocalTopUp owned(String id) {
    guard();
    final r = payments.orders[id];
    if (r == null || r.owner != scope.principalId) {
      throw StateError('Không tìm thấy lần nạp thuộc tài khoản.');
    }
    return r;
  }

  TopUpOrder bind(TopUpOrder o) => TopUpOrder(
    scope: scope,
    id: o.id,
    attemptId: o.attemptId,
    version: o.version,
    amountVnd: o.amountVnd,
    cashVnd: o.cashVnd,
    points: o.points,
    createdAt: o.createdAt,
    state: o.state,
    invoice: o.invoice,
    creditPosted: o.creditPosted,
    checkoutOpened: o.checkoutOpened,
    invoiceNumber: o.invoiceNumber,
    invoiceText: o.invoiceText,
  );
  List<TopUpOrder> get orders => payments.orders.values
      .where((r) => r.owner == scope.principalId)
      .map((r) => bind(r.order))
      .toList()
      .reversed
      .toList();
  @override
  Future<CreditSnapshot> credit() async {
    guard();
    final a = store.money.account(scope.principalId);
    final running = charging.sessions.values
        .where(
          (r) =>
              r.owner == scope.principalId &&
              r.snapshot.settlement != SettlementState.posted &&
              r.snapshot.paymentMode == PaymentMode.csmsBilled,
        )
        .fold<int>(0, (sum, r) => sum + (r.snapshot.estimatedCostVnd ?? 0));
    return CreditSnapshot(
      scope: scope,
      version: a.version,
      balanceVnd: a.balanceVnd,
      availableVnd: a.balanceVnd - running,
      availablePoints: a.points,
      orders: List.unmodifiable(orders),
      entries: List.unmodifiable(a.entries),
      closureReference: payments.closures[scope.principalId],
    );
  }

  @override
  Future<TopUpOrder> create(int amountVnd, int points, String key) async {
    guard();
    if (key.isEmpty) throw StateError('Thiếu mã yêu cầu.');
    final identity = '${scope.principalId}/$key';
    final existing = payments.keys[identity];
    if (existing != null) {
      final order = owned(existing).order;
      if (order.amountVnd != amountVnd || order.points != points) {
        throw StateError('Mã yêu cầu đã dùng cho nội dung khác.');
      }
      return bind(order);
    }
    final a = store.money.account(scope.principalId);
    if (orders.any((o) => o.open)) {
      throw StateError(
        'Bạn đang có lần nạp chưa rõ kết quả. Kiểm tra lần nạp hiện tại.',
      );
    }
    if (amountVnd < 50000 ||
        amountVnd > 2000000 ||
        a.balanceVnd + amountVnd > 5000000) {
      throw StateError('Số tiền ngoài giới hạn hoặc vượt mức tín dụng.');
    }
    if (points != 0 &&
        (points < 500 || points % 100 != 0 || points * 10 > amountVnd ~/ 2)) {
      throw StateError(
        'Đổi từ 500 điểm, theo bội 100 và không quá 50% lần nạp.',
      );
    }
    final id = 'topup-${++payments.serial}';
    store.money.reservePoints(scope.principalId, id, points, payments.clock());
    final o = TopUpOrder(
      scope: scope,
      id: id,
      attemptId: 'attempt-$id-1',
      version: 1,
      amountVnd: amountVnd,
      cashVnd: amountVnd - points * 10,
      points: points,
      createdAt: payments.clock().toUtc(),
      state: TopUpState.pending,
      invoice: InvoiceState.pending,
      creditPosted: false,
      checkoutOpened: false,
    );
    payments.orders[id] = LocalTopUp(
      scope.principalId,
      key,
      o,
      payments.nextScript,
    );
    payments.keys[identity] = id;
    payments.nextScript = PaymentScript.normal;
    return o;
  }

  @override
  Future<TopUpOrder> openCheckout(String orderId, String attemptId) async {
    final r = owned(orderId);
    if (attemptId != r.order.attemptId) {
      throw StateError('Tham chiếu thanh toán không hợp lệ.');
    }
    if (r.openedAt == null && r.order.open) {
      r.openedAt = payments.clock().toUtc();
      r.order = copyOrder(r.order, checkoutOpened: true);
    }
    return bind(r.order);
  }

  @override
  Future<TopUpOrder> order(String orderId) async => bind(owned(orderId).order);
  @override
  Future<String> requestClosure(String key) async {
    guard();
    final a = store.money.account(scope.principalId);
    if (key.isEmpty ||
        a.balanceVnd < 0 ||
        orders.any((o) => o.open) ||
        charging.sessions.values.any(
          (r) =>
              r.owner == scope.principalId &&
              r.snapshot.state != SessionState.reconciled &&
              r.snapshot.state != SessionState.failed,
        )) {
      throw StateError(
        'Chưa thể đóng tài khoản khi số dư âm hoặc còn phiên sạc/lần nạp đang mở.',
      );
    }
    return payments.closures.putIfAbsent(
      scope.principalId,
      () => 'closure-${++payments.serial}',
    );
  }

  @override
  Future<HistorySnapshot> history() async {
    guard();
    final repo = MockChargingRepository(store, charging, actions, scope);
    final sessions = charging.sessions.values
        .where((r) => r.owner == scope.principalId)
        .map((r) => repo.rebind(r.snapshot))
        .toList()
        .reversed
        .toList();
    final a = store.money.account(scope.principalId);
    final version = sessions.fold<int>(a.version, (v, s) => v + s.version);
    return HistorySnapshot(
      scope,
      version,
      List.unmodifiable(sessions),
      List.unmodifiable(orders),
      List.unmodifiable(a.entries),
    );
  }

  @override
  Future<TopUpOrder> invoice(String orderId) => order(orderId);
  @override
  Future<LoyaltySnapshot> loyalty() async {
    guard();
    final a = store.money.account(scope.principalId);
    final cutoff = payments.clock().toUtc().add(const Duration(days: 30));
    final expiring = a.lots
        .where((l) => !l.expiresAt.isAfter(cutoff))
        .fold<int>(0, (sum, l) => sum + l.points);
    return LoyaltySnapshot(
      scope,
      a.version,
      a.points,
      a.reservedPoints,
      expiring,
      List.unmodifiable(a.lots),
      List.unmodifiable(a.pointEntries),
    );
  }
}
