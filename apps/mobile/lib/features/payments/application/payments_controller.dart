import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/format.dart';
import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_scope.dart';
import '../domain/payments.dart';

final paymentsRepositoryProvider = Provider<PaymentsRepository>(
  (ref) => throw StateError('Select payments adapter.'),
);
final paymentsControllerProvider =
    NotifierProvider<PaymentsController, PaymentsState>(PaymentsController.new);

class PaymentsState {
  const PaymentsState({
    this.credit,
    this.order,
    this.busy = false,
    this.error,
    this.closure,
  });
  final CreditSnapshot? credit;
  final TopUpOrder? order;
  final bool busy;
  final String? error;
  final String? closure;
}

class PaymentsController extends Notifier<PaymentsState> {
  int _request = 0;
  int _serial = 0;
  String? _key;
  String? _payload;
  Timer? _poll;
  int _polls = 0;
  AuthScope get scope => ref.read(authScopeProvider);
  PaymentsRepository get repository => ref.read(paymentsRepositoryProvider);
  @override
  PaymentsState build() {
    ref.watch(authScopeProvider);
    ref.watch(paymentsRepositoryProvider);
    ++_request;
    _key = null;
    _payload = null;
    _poll?.cancel();
    _polls = 0;
    ref.onDispose(() {
      ++_request;
      _poll?.cancel();
    });
    final n = _request;
    Future.microtask(() {
      if (ref.mounted && n == _request) refresh();
    });
    return const PaymentsState();
  }

  bool current(AuthScope s, int n) =>
      ref.mounted &&
      n == _request &&
      s.principalId == scope.principalId &&
      s.generation == scope.generation;
  bool owned(TopUpOrder o, AuthScope s) =>
      o.scope.principalId == s.principalId &&
      o.scope.generation == s.generation;
  Future<void> refresh({String? orderId}) => run(() async {
    final credit = await repository.credit();
    TopUpOrder? order = state.order;
    final id = orderId ?? order?.id;
    if (id != null) order = await repository.order(id);
    return PaymentsState(credit: credit, order: order, closure: state.closure);
  }, expectedId: orderId ?? state.order?.id);
  Future<void> create(String amount, String points) async {
    if (state.busy) return;
    final a = int.tryParse(amount);
    final p = points.isEmpty ? 0 : int.tryParse(points);
    if (a == null || p == null) {
      state = PaymentsState(
        credit: state.credit,
        order: state.order,
        error: 'Nhập số tiền và điểm bằng số nguyên.',
      );
      return;
    }
    final payload = '$a/$p';
    if (_key != null && _payload != payload && state.order?.open != false) {
      state = PaymentsState(
        credit: state.credit,
        order: state.order,
        error: 'Kiểm tra yêu cầu nạp hiện tại trước khi đổi số tiền.',
      );
      return;
    }
    if (_key == null || _payload != payload || state.order?.open == false) {
      _payload = payload;
      _key =
          'topup/${scope.principalId}/${scope.generation}/${DateTime.now().microsecondsSinceEpoch}/${++_serial}';
    }
    await run(() async {
      final order = await repository.create(a, p, _key!);
      return PaymentsState(credit: await repository.credit(), order: order);
    }, creating: true);
  }

  Future<void> checkout(String id, String attempt) => run(() async {
    final order = await repository.openCheckout(id, attempt);
    return PaymentsState(credit: await repository.credit(), order: order);
  }, expectedId: id);
  Future<void> closeAccount() => run(() async {
    final reference = await repository.requestClosure(
      'closure/${scope.principalId}',
    );
    return PaymentsState(
      credit: await repository.credit(),
      order: state.order,
      closure: reference,
    );
  });
  Future<void> run(
    Future<PaymentsState> Function() action, {
    String? expectedId,
    bool creating = false,
  }) async {
    if (state.busy) return;
    final captured = scope;
    final n = ++_request;
    final old = state;
    state = PaymentsState(
      credit: old.credit,
      order: old.order,
      busy: true,
      closure: old.closure,
    );
    try {
      final next = await action();
      if (!current(captured, n)) return;
      if (next.credit != null &&
              (next.credit!.scope.principalId != captured.principalId ||
                  next.credit!.scope.generation != captured.generation) ||
          next.order != null &&
              (!owned(next.order!, captured) ||
                  expectedId != null && next.order!.id != expectedId)) {
        throw StateError('Kết quả không thuộc yêu cầu hiện tại.');
      }
      if (next.order != null &&
              old.order?.id == next.order!.id &&
              old.order!.version > next.order!.version ||
          next.credit != null &&
              old.credit != null &&
              next.credit!.version < old.credit!.version) {
        state = old;
        return;
      }
      state = next;
      poll();
    } catch (e) {
      if (current(captured, n)) {
        if (creating && e is StateError) {
          _key = null;
          _payload = null;
        }
        state = PaymentsState(
          credit: old.credit,
          order: old.order,
          closure: old.closure,
          error: failureText(e),
        );
      }
    }
  }

  void poll() {
    _poll?.cancel();
    final order = state.order;
    if (order != null &&
        (order.state == TopUpState.failed ||
            order.state == TopUpState.expired ||
            order.state == TopUpState.refundPending ||
            order.state == TopUpState.refunded)) {
      return;
    }
    if (order == null ||
        !order.open && order.invoice != InvoiceState.pending ||
        _polls >= 20) {
      return;
    }
    _poll = Timer(const Duration(seconds: 2), () {
      if (!ref.mounted) return;
      ++_polls;
      refresh(orderId: order.id);
    });
  }
}
