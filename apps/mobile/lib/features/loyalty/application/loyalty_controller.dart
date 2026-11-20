import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_scope.dart';
import '../domain/loyalty.dart';

final loyaltyBalanceRepositoryProvider = Provider<LoyaltyBalanceRepository>(
  (ref) => throw StateError('Configure loyalty in ApiApp.'),
);

final loyaltyControllerProvider =
    NotifierProvider<LoyaltyController, LoyaltyView>(LoyaltyController.new);

typedef LoyaltyView = ({
  LoyaltyBalance? balance,
  bool loading,
  bool unavailable,
});

class LoyaltyController extends Notifier<LoyaltyView> {
  late AuthScope _scope;
  Object? _visibleRoute;
  LoyaltyRead? _request;
  LoyaltyBalance? _balance;
  bool _unavailable = false;

  @override
  LoyaltyView build() {
    _scope = ref.watch(authScopeProvider);
    ref.watch(loyaltyBalanceRepositoryProvider);
    ref.onDispose(() {
      _stop();
      _visibleRoute = null;
      _balance = null;
      _unavailable = false;
    });
    return _view;
  }

  LoyaltyView get _view =>
      (balance: _balance, loading: _request != null, unavailable: _unavailable);

  bool _owned(AuthScope scope) =>
      ref.mounted &&
      scope != signedOutScope &&
      ref.read(authScopeProvider) == scope;

  void setVisible(Object route, bool visible) {
    if (!ref.mounted) return;
    if (visible && _visibleRoute != route && _scope != signedOutScope) {
      _visibleRoute = route;
      refresh();
    } else if (!visible && _visibleRoute == route) {
      _visibleRoute = null;
      _stop();
      _balance = null;
      _unavailable = false;
      state = _view;
    }
  }

  void refresh() {
    if (!ref.mounted || _visibleRoute == null || !_owned(_scope)) return;
    _stop();
    _balance = null;
    _unavailable = false;
    unawaited(_load());
  }

  Future<void> _load() async {
    final scope = _scope;
    final request = ref.read(loyaltyBalanceRepositoryProvider).read(scope);
    _request = request;
    state = _view;
    try {
      final balance = await request.result;
      if (_owned(scope) && _request == request) {
        if (balance.scope != scope) throw StateError('Driver session changed.');
        _balance = balance;
      }
    } catch (_) {
      if (_owned(scope) && _request == request) _unavailable = true;
    } finally {
      if (_owned(scope) && _request == request) {
        _request = null;
        state = _view;
      }
    }
  }

  void _stop() {
    _request?.cancel();
    _request = null;
  }
}
