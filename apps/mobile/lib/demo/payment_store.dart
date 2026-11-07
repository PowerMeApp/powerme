import '../features/payments/domain/payments.dart';

enum PaymentScript {
  normal,
  lateSuccess,
  rejected,
  timeout,
  invoiceFailed,
  expiredLate,
}

class LocalTopUp {
  LocalTopUp(this.owner, this.key, this.order, this.script);
  final String owner;
  final String key;
  final PaymentScript script;
  TopUpOrder order;
  DateTime? openedAt;
  bool pointsFinalized = false;
}

class PaymentStore {
  PaymentStore({DateTime Function()? clock}) : clock = clock ?? DateTime.now;
  final DateTime Function() clock;
  final orders = <String, LocalTopUp>{};
  final keys = <String, String>{};
  final closures = <String, String>{};
  PaymentScript nextScript = PaymentScript.normal;
  int serial = 0;
}
