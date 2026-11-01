import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:driver_app/demo/demo_store.dart';
import 'package:driver_app/demo/charging_store.dart';
import 'package:driver_app/demo/charging_engine.dart';
import 'package:driver_app/demo/payment_store.dart';
import 'package:driver_app/demo/payment_engine.dart';
import 'package:driver_app/demo/station_actions_store.dart';
import 'package:driver_app/features/auth/domain/auth_scope.dart';
import 'package:driver_app/features/auth/application/auth_controller.dart';
import 'package:driver_app/features/charging/domain/charging.dart';
import 'package:driver_app/features/charging/data/mock_charging_repository.dart';
import 'package:driver_app/features/loyalty/domain/loyalty.dart';
import 'package:driver_app/features/payments/domain/payments.dart';
import 'package:driver_app/features/payments/data/mock_payments_repository.dart';
import 'package:driver_app/features/payments/application/payments_controller.dart';

void main() {
  late DateTime now;
  late DemoStore store;
  late PaymentStore payments;
  late ChargingStore charging;
  late StationActionsStore actions;
  late MockPaymentsRepository repo;
  void step(int seconds) {
    now = now.add(Duration(seconds: seconds));
    MockPaymentEngine(store, payments).step();
  }

  setUp(() {
    now = DateTime.utc(2026, 10, 29, 3);
    store = DemoStore();
    payments = PaymentStore(clock: () => now);
    charging = ChargingStore(clock: () => now);
    actions = StationActionsStore(clock: () => now);
    repo = MockPaymentsRepository(
      store,
      payments,
      charging,
      actions,
      store.activeScope,
    );
  });
  test(
    'Concurrent same key returns one order; different key rejects; amount/points validation',
    () async {
      final orders = await Future.wait([
        repo.create(100000, 500, 'key'),
        repo.create(100000, 500, 'key'),
      ]);
      expect(orders.first.id, orders.last.id);
      expect(payments.orders.length, 1);
      expect((await repo.loyalty()).reserved, 500);
      await expectLater(repo.create(200000, 500, 'key'), throwsStateError);
      await expectLater(repo.create(100000, 0, 'other'), throwsStateError);
      expect((await repo.credit()).balanceVnd, 320000);
    },
  );
  test(
    'Reject invalid amount, cap, point increment/minimum/discount and insufficient points atomically',
    () async {
      for (final input in [
        (49999, 0),
        (2000001, 0),
        (100000, 499),
        (100000, 550),
        (50000, 3000),
        (100000, 1900),
        (100000, -1),
      ]) {
        await expectLater(
          repo.create(input.$1, input.$2, 'bad'),
          throwsStateError,
        );
      }
      store.money.account('driver-minh').balanceVnd = 4990000;
      await expectLater(repo.create(50000, 0, 'cap'), throwsStateError);
      expect(payments.orders, isEmpty);
      expect((await repo.loyalty()).reserved, 0);
    },
  );
  test(
    'Checkout and return queries never credit; verified before posted; duplicate settlement once; invoice independent',
    () async {
      final order = await repo.create(100000, 500, 'key');
      expect(order.cashVnd, 95000);
      await repo.order(order.id);
      await repo.credit();
      expect((await repo.credit()).balanceVnd, 320000);
      await expectLater(
        repo.openCheckout(order.id, 'forged-attempt'),
        throwsStateError,
      );
      await repo.openCheckout(order.id, order.attemptId);
      for (var i = 0; i < 8; i++) {
        await repo.order(order.id);
      }
      expect((await repo.credit()).balanceVnd, 320000);
      step(3);
      expect((await repo.order(order.id)).state, TopUpState.verified);
      expect((await repo.credit()).balanceVnd, 320000);
      step(2);
      expect((await repo.order(order.id)).creditPosted, isTrue);
      expect((await repo.order(order.id)).invoice, InvoiceState.pending);
      expect((await repo.credit()).balanceVnd, 420000);
      expect((await repo.loyalty()).available, 1300);
      expect((await repo.loyalty()).reserved, 0);
      step(2);
      final issued = await repo.invoice(order.id);
      expect(issued.invoice, InvoiceState.issued);
      expect(issued.invoiceText, contains('95000'));
      step(200);
      await repo.openCheckout(order.id, order.attemptId);
      expect((await repo.invoice(order.id)).invoiceText, issued.invoiceText);
      expect((await repo.credit()).entries.length, 1);
      expect((await repo.loyalty()).entries.length, 1);
    },
  );
  test(
    'Closed/unknown checkout recovers late authoritative credit on original order without double points',
    () async {
      payments.nextScript = PaymentScript.lateSuccess;
      final o = await repo.create(200000, 1000, 'late');
      await repo.openCheckout(o.id, o.attemptId);
      step(4);
      expect((await repo.order(o.id)).state, TopUpState.unknown);
      expect((await repo.credit()).balanceVnd, 320000);
      await expectLater(repo.create(100000, 0, 'new'), throwsStateError);
      step(8);
      expect((await repo.order(o.id)).state, TopUpState.posted);
      step(10);
      expect((await repo.credit()).balanceVnd, 520000);
      expect((await repo.loyalty()).available, 800);
      expect((await repo.credit()).entries.length, 1);
    },
  );
  test(
    'Failed and expired orders cannot reopen or credit on later ticks',
    () async {
      for (final script in [PaymentScript.rejected, PaymentScript.normal]) {
        payments.nextScript = script;
        final o = await repo.create(50000, 500, script.name);
        if (script == PaymentScript.rejected) {
          await repo.openCheckout(o.id, o.attemptId);
        }
        step(601);
        final terminal = await repo.order(o.id);
        expect(
          terminal.state,
          script == PaymentScript.rejected
              ? TopUpState.failed
              : TopUpState.expired,
        );
        await repo.openCheckout(o.id, o.attemptId);
        step(86400);
        expect((await repo.order(o.id)).state, terminal.state);
        expect((await repo.credit()).balanceVnd, 320000);
        expect((await repo.loyalty()).reserved, 0);
        expect(
          payments.orders[o.id]!.openedAt == null,
          script == PaymentScript.normal,
        );
      }
      expect((await repo.credit()).entries, isEmpty);
    },
  );
  test(
    'Explicit expired late verification goes to refund review with no credit or point commit',
    () async {
      payments.nextScript = PaymentScript.expiredLate;
      final o = await repo.create(100000, 500, 'expired-late');
      await repo.openCheckout(o.id, o.attemptId);
      step(3);
      expect((await repo.order(o.id)).state, TopUpState.expired);
      final opened = payments.orders[o.id]!.openedAt;
      await repo.openCheckout(o.id, o.attemptId);
      expect(payments.orders[o.id]!.openedAt, opened);
      step(8);
      expect((await repo.order(o.id)).state, TopUpState.refundPending);
      step(1000);
      expect((await repo.credit()).entries, isEmpty);
      expect((await repo.loyalty()).available, 1800);
    },
  );
  test(
    'Invoice failure never rolls back verified credit; owned history and invoice separated from statement',
    () async {
      payments.nextScript = PaymentScript.invoiceFailed;
      final o = await repo.create(100000, 0, 'invoice-fail');
      await repo.openCheckout(o.id, o.attemptId);
      step(10);
      expect((await repo.invoice(o.id)).invoice, InvoiceState.failed);
      expect((await repo.credit()).balanceVnd, 420000);
      final history = await repo.history();
      expect(history.orders.single.id, o.id);
      expect(history.sessions, isEmpty);
      expect(history.entries.single.amountVnd, 100000);
      store.bind(const AuthScope(principalId: 'driver-an', generation: 2));
      final other = MockPaymentsRepository(
        store,
        payments,
        charging,
        actions,
        store.activeScope,
      );
      expect((await other.history()).orders, isEmpty);
      await expectLater(other.invoice(o.id), throwsStateError);
      await expectLater(
        other.openCheckout(o.id, o.attemptId),
        throwsStateError,
      );
      await expectLater(repo.credit(), throwsStateError);
    },
  );
  test(
    'Oldest points reserved first; expiry/release preserves original expiry; compensation idempotent',
    () async {
      final a = store.money.account('driver-minh');
      a.lots.clear();
      a.lots.addAll([
        PointLot('later', 500, now.add(const Duration(days: 40))),
        PointLot('soon', 600, now.add(const Duration(seconds: 5))),
      ]);
      payments.nextScript = PaymentScript.rejected;
      final o = await repo.create(100000, 500, 'reserve');
      expect(a.reservations[o.id]!.first.id, 'soon');
      expect((await repo.loyalty()).expiringSoon, 100);
      await repo.openCheckout(o.id, o.attemptId);
      step(6);
      expect((await repo.loyalty()).available, 500);
      expect((await repo.loyalty()).reserved, 0);
      store.money.adjustPoints(
        'driver-minh',
        'correction/one',
        'Điều chỉnh điểm phiên sạc',
        -100,
        now,
      );
      store.money.adjustPoints(
        'driver-minh',
        'correction/one',
        'Điều chỉnh điểm phiên sạc',
        -100,
        now,
      );
      expect((await repo.loyalty()).available, 400);
      expect((await repo.credit()).balanceVnd, 320000);
    },
  );
  test(
    'Shared session debit, point earn, topup, history and negative shortfall recovery agree',
    () async {
      final chargingRepo = MockChargingRepository(
        store,
        charging,
        actions,
        store.activeScope,
      );
      final started = await chargingRepo.start(
        StartRequest(
          scope: store.activeScope,
          connectorId: 'station-powerme-center/1',
          vehicleId: store.profile.vehicleId,
          mode: ChargingMode.energy,
          limitValue: 1000,
          key: 'start',
        ),
      );
      step(105);
      MockChargingEngine(store, charging, actions).step();
      final statement = (await chargingRepo.snapshot(
        started.sessionId!,
      )).statement!;
      expect((await repo.credit()).balanceVnd, statement.balanceVnd);
      expect((await repo.loyalty()).available, 1800 + statement.earnedPoints);
      expect(
        (await repo.history()).sessions.single.statement!.debitVnd,
        statement.debitVnd,
      );
      store.money.account('driver-minh').balanceVnd = -20000;
      final o = await repo.create(50000, 0, 'shortfall');
      await repo.openCheckout(o.id, o.attemptId);
      step(7);
      expect((await repo.credit()).balanceVnd, 30000);
      expect(
        (await chargingRepo.preview(
          'station-powerme-center/1',
          store.profile.vehicleId,
          ChargingMode.autoFull,
          null,
        )).canStart,
        isFalse,
      );
    },
  );
  test(
    'Account closure rejects negative, open topup and session; acknowledged request idempotent',
    () async {
      store.money.account('driver-minh').balanceVnd = -1;
      await expectLater(repo.requestClosure('close'), throwsStateError);
      store.money.account('driver-minh').balanceVnd = 320000;
      final o = await repo.create(50000, 0, 'open');
      await expectLater(repo.requestClosure('close'), throwsStateError);
      step(601);
      expect((await repo.order(o.id)).state, TopUpState.expired);
      final reference = await repo.requestClosure('close');
      expect(await repo.requestClosure('close'), reference);
      expect((await repo.credit()).balanceVnd, 320000);
      final chargingRepo = MockChargingRepository(
        store,
        charging,
        actions,
        store.activeScope,
      );
      await chargingRepo.start(
        StartRequest(
          scope: store.activeScope,
          connectorId: 'station-powerme-center/1',
          vehicleId: store.profile.vehicleId,
          mode: ChargingMode.autoFull,
          limitValue: null,
          key: 'start',
        ),
      );
      await expectLater(repo.requestClosure('close'), throwsStateError);
    },
  );
  test(
    'Controller guards stale versions, wrong order/owner and late dispose; transport retry keeps key',
    () async {
      final fake = DelayedPayments(repo);
      final container = ProviderContainer.test(
        overrides: [
          authScopeProvider.overrideWithValue(store.activeScope),
          paymentsRepositoryProvider.overrideWithValue(fake),
        ],
      );
      final c = container.read(paymentsControllerProvider.notifier);
      await Future<void>.delayed(Duration.zero);
      fake.failCreate = true;
      await c.create('100000', '500');
      final firstKey = fake.lastKey;
      expect(container.read(paymentsControllerProvider).order, isNull);
      await c.create('200000', '0');
      expect(fake.lastKey, firstKey);
      fake.failCreate = false;
      await c.create('100000', '500');
      final o = container.read(paymentsControllerProvider).order!;
      expect(fake.lastKey, firstKey);
      await repo.openCheckout(o.id, o.attemptId);
      step(7);
      await c.refresh(orderId: o.id);
      fake.orderOverride = o;
      await c.refresh(orderId: o.id);
      expect(
        container.read(paymentsControllerProvider).order!.state,
        TopUpState.posted,
      );
      fake.orderOverride = TopUpOrder(
        scope: const AuthScope(principalId: 'driver-an', generation: 2),
        id: o.id,
        attemptId: o.attemptId,
        version: 99,
        amountVnd: o.amountVnd,
        cashVnd: o.cashVnd,
        points: o.points,
        createdAt: o.createdAt,
        state: TopUpState.posted,
        invoice: InvoiceState.issued,
        creditPosted: true,
        checkoutOpened: true,
      );
      await c.refresh(orderId: o.id);
      expect(
        container.read(paymentsControllerProvider).order!.scope.principalId,
        'driver-minh',
      );
      fake.orderOverride = null;
      fake.creditPending = Completer<CreditSnapshot>();
      final pending = c.refresh();
      container.dispose();
      fake.creditPending!.complete(await repo.credit());
      await pending;
    },
  );
}

class DelayedPayments implements PaymentsRepository {
  DelayedPayments(this.delegate);
  final PaymentsRepository delegate;
  bool failCreate = false;
  String? lastKey;
  TopUpOrder? orderOverride;
  Completer<CreditSnapshot>? creditPending;
  @override
  Future<CreditSnapshot> credit() => creditPending?.future ?? delegate.credit();
  @override
  Future<TopUpOrder> create(int amountVnd, int points, String key) async {
    lastKey = key;
    if (failCreate) throw TimeoutException('unknown');
    return delegate.create(amountVnd, points, key);
  }

  @override
  Future<TopUpOrder> order(String id) async =>
      orderOverride ?? await delegate.order(id);
  @override
  Future<TopUpOrder> openCheckout(String id, String attempt) =>
      delegate.openCheckout(id, attempt);
  @override
  Future<String> requestClosure(String key) => delegate.requestClosure(key);
}
