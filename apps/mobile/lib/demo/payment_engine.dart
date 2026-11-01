import '../features/payments/domain/payments.dart';
import 'demo_store.dart';
import 'payment_store.dart';

class MockPaymentEngine {
  MockPaymentEngine(this.store, this.payments);
  final DemoStore store;
  final PaymentStore payments;
  void step() {
    final now = payments.clock().toUtc();
    for (final owner in store.money.accounts.keys.toList()) {
      store.money.expire(owner, now);
    }
    for (final r in payments.orders.values) {
      final old = r.order;
      if (old.state == TopUpState.failed ||
          old.state == TopUpState.expired &&
              r.script != PaymentScript.expiredLate) {
        continue;
      }
      final age = r.openedAt == null
          ? -1
          : now.difference(r.openedAt!).inSeconds;
      var state = old.state;
      var invoice = old.invoice;
      var posted = old.creditPosted;
      if (old.state == TopUpState.refunded ||
          old.state == TopUpState.refundPending) {
        continue;
      }
      if (r.script == PaymentScript.expiredLate && age >= 10) {
        state = TopUpState.refundPending;
      } else if (r.script == PaymentScript.rejected && age >= 3) {
        state = TopUpState.failed;
      } else if (age < 0 && now.difference(old.createdAt).inMinutes >= 10 ||
          r.script == PaymentScript.expiredLate && age >= 3) {
        state = TopUpState.expired;
      } else if (r.script == PaymentScript.timeout && age >= 3) {
        state = TopUpState.unknown;
      } else if (age >= (r.script == PaymentScript.lateSuccess ? 12 : 5)) {
        state = TopUpState.posted;
        posted = true;
        store.money.post(
          r.owner,
          'topup/${old.id}',
          'Nạp tín dụng',
          old.amountVnd,
          now,
        );
        if (!r.pointsFinalized) {
          store.money.finishPoints(r.owner, old.id, now, commit: true);
          r.pointsFinalized = true;
        }
        if (age >= (r.script == PaymentScript.lateSuccess ? 15 : 7)) {
          invoice = r.script == PaymentScript.invoiceFailed
              ? InvoiceState.failed
              : InvoiceState.issued;
        }
      } else if (age >= (r.script == PaymentScript.lateSuccess ? 10 : 3)) {
        state = TopUpState.verified;
      } else if (r.script == PaymentScript.lateSuccess && age >= 3) {
        state = TopUpState.unknown;
      }
      if ((state == TopUpState.failed ||
              state == TopUpState.expired ||
              state == TopUpState.refundPending) &&
          !r.pointsFinalized) {
        store.money.finishPoints(r.owner, old.id, now, commit: false);
        r.pointsFinalized = true;
      }
      if (state != old.state ||
          invoice != old.invoice ||
          posted != old.creditPosted) {
        r.order = copyOrder(
          old,
          state: state,
          invoice: invoice,
          creditPosted: posted,
        );
        store.money.account(r.owner).version++;
      }
    }
  }
}

TopUpOrder copyOrder(
  TopUpOrder o, {
  TopUpState? state,
  InvoiceState? invoice,
  bool? creditPosted,
  bool? checkoutOpened,
}) {
  final nextInvoice = invoice ?? o.invoice;
  final number = nextInvoice == InvoiceState.issued
      ? 'PM-${o.id.toUpperCase()}'
      : null;
  return TopUpOrder(
    scope: o.scope,
    id: o.id,
    attemptId: o.attemptId,
    version: o.version + 1,
    amountVnd: o.amountVnd,
    cashVnd: o.cashVnd,
    points: o.points,
    createdAt: o.createdAt,
    state: state ?? o.state,
    invoice: nextInvoice,
    creditPosted: creditPosted ?? o.creditPosted,
    checkoutOpened: checkoutOpened ?? o.checkoutOpened,
    invoiceNumber: number,
    invoiceText: number == null
        ? null
        : 'POWERME\nHóa đơn: $number\nNạp tín dụng: ${o.amountVnd} VND\nSố tiền thu: ${o.cashVnd} VND\nĐiểm sử dụng: ${o.points}\nHóa đơn gắn với lần nạp tín dụng.',
  );
}
