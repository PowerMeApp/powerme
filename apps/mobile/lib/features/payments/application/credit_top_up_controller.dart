import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/driver_api_exception.dart';
import '../../../core/api/idempotency_key.dart';
import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_scope.dart';
import '../../loyalty/application/loyalty_controller.dart';
import '../domain/credit_top_up.dart';
import 'charging_credit_controller.dart';

final creditTopUpRepositoryProvider = Provider<CreditTopUpRepository>(
  (ref) => throw StateError('Configure top-ups in ApiApp.'),
);

final openVnpayCheckoutProvider = Provider<Future<bool> Function(String)>(
  (ref) =>
      (_) async => false,
);

final creditTopUpProvider = NotifierProvider<CreditTopUpController, TopUpView>(
  CreditTopUpController.new,
);

typedef TopUpView = ({
  String amountText,
  String pointsText,
  TopUpQuote? quote,
  bool quoting,
  bool quoteUnavailable,
  int? expectedPayableVnd,
  bool canCreate,
  bool creating,
  bool retryCreate,
  bool tracking,
  bool checking,
  bool confirming,
  bool canPay,
  bool opening,
  CreditTopUp? order,
  TopUpIssue? issue,
});

class CreditTopUpController extends Notifier<TopUpView> {
  late AuthScope _scope;
  Object? _visibleRoute;
  int _visibilityGeneration = 0;
  String _amountText = '';
  String _pointsText = '';
  TopUpQuote? _quote;
  bool _quoteUnavailable = false;
  Timer? _quoteTimer;
  TopUpRead<TopUpQuote>? _quoteRead;
  TopUpRequest? _submitted;
  bool _creating = false;
  String? _id;
  CreditTopUp? _order;
  bool _confirming = false;
  bool _opening = false;
  TopUpIssue? _issue;
  Timer? _poll;
  Timer? _checkoutExpiry;
  int _checksLeft = 0;
  TopUpRead<CreditTopUp>? _statusRead;
  bool _readCancelled = false;
  bool _checkoutVerified = false;

  @override
  TopUpView build() {
    _scope = ref.watch(authScopeProvider);
    ref.onDispose(() {
      _stopQuote();
      _stopChecks();
      _visibleRoute = null;
      _amountText = '';
      _pointsText = '';
      _quote = null;
      _quoteUnavailable = false;
      _submitted = null;
      _creating = false;
      _id = null;
      _order = null;
      _confirming = false;
      _opening = false;
      _issue = null;
      _statusRead = null;
    });
    return _view;
  }

  int? get _amount => parseTopUpInteger(_amountText);
  int? get _points =>
      _pointsText.trim().isEmpty ? 0 : parseTopUpInteger(_pointsText);

  int? get _expectedPayableVnd {
    final amount = _amount;
    final points = _points;
    final quote = _quote;
    if (amount == null || points == null || quote == null) return null;
    return topUpPayableEstimate(amount, points, quote);
  }

  bool get _canCreate {
    final points = _points;
    final quote = _quote;
    return _scope != signedOutScope &&
        _id == null &&
        !_creating &&
        _submitted == null &&
        quote != null &&
        points != null &&
        (points >= 0 && points <= quote.maxPoints);
  }

  bool get _hasLiveLink =>
      _order?.status == TopUpStatus.pending &&
      _order!.paymentUrl != null &&
      _order!.expiresAt.isAfter(DateTime.now());

  String? get _checkoutUrl =>
      _checkoutVerified && _hasLiveLink ? _order?.paymentUrl : null;

  bool get _needsStatus =>
      _id != null && (_order == null || _order?.status == TopUpStatus.pending);

  TopUpView get _view => (
    amountText: _amountText,
    pointsText: _pointsText,
    quote: _quote,
    quoting: _quoteRead != null || _quoteTimer != null,
    quoteUnavailable: _quoteUnavailable,
    expectedPayableVnd: _expectedPayableVnd,
    canCreate: _canCreate,
    creating: _creating,
    retryCreate: !_creating && _submitted != null,
    tracking: _id != null,
    checking: _statusRead != null && !_readCancelled,
    confirming:
        _confirming || (_order?.status == TopUpStatus.pending && !_hasLiveLink),
    canPay: _checkoutUrl != null && !_opening,
    opening: _opening,
    order: _order,
    issue: _issue,
  );

  bool _owned(AuthScope scope) =>
      ref.mounted &&
      scope != signedOutScope &&
      ref.read(authScopeProvider) == scope;

  void _publish() => state = _view;

  void setVisible(Object route, bool visible) {
    if (!ref.mounted || _scope == signedOutScope) return;
    if (visible && _visibleRoute != route) {
      _visibilityGeneration++;
      _visibleRoute = route;
      if (_needsStatus) {
        checkStatus();
      } else if (_id == null && _quote == null && _submitted == null) {
        _scheduleQuote();
      }
    } else if (!visible && _visibleRoute == route) {
      _visibilityGeneration++;
      _visibleRoute = null;
      _stopQuote();
      _stopChecks();
    }
  }

  void changeAmount(String input) {
    if (_id != null || _submitted != null) return;
    _amountText = input;
    _pointsText = '';
    _quote = null;
    _issue = null;
    _quoteUnavailable = false;
    _scheduleQuote();
  }

  void changePoints(String input) {
    if (_id != null || _submitted != null || _quote == null) return;
    _pointsText = input;
    _publish();
  }

  void retryQuote() => _scheduleQuote(immediate: true);

  void _scheduleQuote({bool immediate = false}) {
    _stopQuote();
    final amount = _amount;
    if (_visibleRoute != null && validTopUpAmount(amount)) {
      _quoteUnavailable = false;
      _quoteTimer = Timer(
        immediate ? Duration.zero : const Duration(milliseconds: 350),
        () {
          _quoteTimer = null;
          unawaited(_loadQuote(amount!));
        },
      );
    }
    _publish();
  }

  Future<void> _loadQuote(int amount) async {
    final scope = _scope;
    final request = ref
        .read(creditTopUpRepositoryProvider)
        .quote(scope, amount);
    _quoteRead = request;
    _publish();
    try {
      final quote = await request.result;
      if (_owned(scope) && _quoteRead == request) _quote = quote;
    } on DriverApiException catch (error) {
      if (_owned(scope) && _quoteRead == request) {
        _quoteUnavailable = true;
        if (error.code == 'payment_unconfigured') {
          _issue = TopUpIssue.paymentUnavailable;
        }
      }
    } finally {
      if (_owned(scope) && _quoteRead == request) {
        _quoteRead = null;
        _publish();
      }
    }
  }

  void _stopQuote() {
    _quoteTimer?.cancel();
    _quoteTimer = null;
    _quoteRead?.cancel();
    _quoteRead = null;
  }

  Future<void> create({
    required int? shownPayableVnd,
    required bool Function() isSourceVisible,
  }) async {
    final scope = _scope;
    if (!_owned(scope) ||
        _visibleRoute == null ||
        !isSourceVisible() ||
        _creating) {
      return;
    }
    if (_submitted == null && !_canCreate) return;
    final visibility = _visibilityGeneration;
    final allowAutoOpen =
        _submitted == null &&
        shownPayableVnd != null &&
        shownPayableVnd == _expectedPayableVnd;
    final request = _submitted ??= (
      key: newIdempotencyKey(),
      amountVnd: _amount!,
      points: _points!,
    );
    _creating = true;
    _issue = null;
    _publish();
    var freshCheckout = false;
    try {
      final result = await ref
          .read(creditTopUpRepositoryProvider)
          .create(scope, request);
      if (!_owned(scope)) return;
      _id = result.id;
      _confirming = result.confirming;
      freshCheckout = result.freshCheckout;
      _submitted = null;
    } on DriverApiException catch (error) {
      if (!_owned(scope)) return;
      final issue = _createIssue(error);
      _issue = issue;
      if (issue != TopUpIssue.uncertain && issue != TopUpIssue.malformed) {
        _submitted = null;
      }
      if (error.status == 422) {
        _quote = null;
        _pointsText = '';
        _scheduleQuote(immediate: true);
      }
    } finally {
      if (_owned(scope)) {
        _creating = false;
        _publish();
      }
    }
    if (!_owned(scope)) return;
    // The original tap applies only to this immediate GET.
    final order = await _checkStatus();
    if (allowAutoOpen &&
        freshCheckout &&
        _owned(scope) &&
        visibility == _visibilityGeneration &&
        isSourceVisible() &&
        order != null &&
        order == _order &&
        _checkoutUrl != null &&
        order.amountVnd == request.amountVnd &&
        order.points == request.points &&
        order.amountPaidVnd == shownPayableVnd) {
      await openPayment();
    }
  }

  void checkStatus() {
    unawaited(_checkStatus());
  }

  Future<CreditTopUp?>? _checkStatus() {
    if (_visibleRoute == null || !_needsStatus) return null;
    _poll?.cancel();
    _poll = null;
    _checksLeft = 12;
    return _statusRead == null ? _loadStatus() : null;
  }

  Future<CreditTopUp?> _loadStatus() async {
    final scope = _scope;
    final id = _id;
    if (_visibleRoute == null ||
        id == null ||
        !_needsStatus ||
        !_owned(scope)) {
      return null;
    }
    _checksLeft--;
    final request = ref.read(creditTopUpRepositoryProvider).status(scope, id);
    _statusRead = request;
    _readCancelled = false;
    _publish();
    try {
      final order = await request.result;
      if (!_owned(scope) || _readCancelled) return null;
      _order = order;
      _confirming = false;
      _checkoutVerified = true;
      if (_issue != TopUpIssue.launchUnavailable || !_hasLiveLink) {
        _issue = null;
      }
      _checkoutExpiry?.cancel();
      final remaining = order.expiresAt.difference(DateTime.now());
      if (order.paymentUrl != null && remaining > Duration.zero) {
        _checkoutExpiry = Timer(remaining, _publish);
      }
      if (order.status == TopUpStatus.credited ||
          order.status == TopUpStatus.refunded) {
        if (ref.exists(loyaltyControllerProvider)) {
          ref.read(loyaltyControllerProvider.notifier).refresh();
        }
        ref.invalidate(chargingCreditProvider);
        ref.invalidate(creditLedgerProvider);
      }
      return order;
    } on DriverApiException catch (error) {
      if (!_owned(scope) || _readCancelled) return null;
      _checkoutVerified = false;
      _issue = switch ((error.problem, error.status, error.code)) {
        (_, 404, 'not_found') => TopUpIssue.notFound,
        (_, 503, 'payment_unconfigured') => TopUpIssue.paymentUnavailable,
        (DriverApiProblem.malformed, _, _) => TopUpIssue.malformed,
        _ => TopUpIssue.statusUnavailable,
      };
      _checksLeft = 0;
      if (_issue == TopUpIssue.notFound) {
        _id = null;
        _order = null;
        _confirming = false;
        _amountText = '';
        _pointsText = '';
        _quote = null;
        _quoteUnavailable = false;
      }
      return null;
    } finally {
      if (_owned(scope) && _statusRead == request) {
        final cancelled = _readCancelled;
        _statusRead = null;
        _readCancelled = false;
        _publish();
        if (_visibleRoute != null && _needsStatus && _checksLeft > 0) {
          _poll = Timer(
            cancelled ? Duration.zero : const Duration(seconds: 5),
            () {
              _poll = null;
              unawaited(_loadStatus());
            },
          );
        }
      }
    }
  }

  void _stopChecks() {
    _poll?.cancel();
    _poll = null;
    _checksLeft = 0;
    _checkoutExpiry?.cancel();
    _checkoutExpiry = null;
    _checkoutVerified = false;
    final request = _statusRead;
    if (request != null) {
      _readCancelled = true;
      request.cancel();
    }
  }

  Future<void> openPayment() async {
    final scope = _scope;
    if (_visibleRoute == null || !_owned(scope) || _opening) return;
    final url = _checkoutUrl;
    if (url == null) {
      checkStatus();
      _publish();
      return;
    }
    _opening = true;
    _issue = null;
    _publish();
    var opened = false;
    try {
      opened = await ref.read(openVnpayCheckoutProvider)(url);
    } catch (_) {
      // A launcher failure leaves the verified order available for retry.
    }
    if (!_owned(scope)) return;
    _opening = false;
    if (!opened && _order?.paymentUrl == url && _hasLiveLink) {
      _issue = TopUpIssue.launchUnavailable;
    }
    _publish();
  }

  void startAnother() {
    if (_id == null || _order == null || _needsStatus) return;
    _id = null;
    _order = null;
    _amountText = '';
    _pointsText = '';
    _quote = null;
    _quoteUnavailable = false;
    _issue = null;
    _publish();
  }
}

TopUpIssue _createIssue(DriverApiException error) =>
    switch ((error.problem, error.status, error.code)) {
      (_, 503, 'payment_unconfigured') => TopUpIssue.paymentUnavailable,
      (_, 422, 'balance_limit_exceeded') => TopUpIssue.balanceLimit,
      (_, 422, _) => TopUpIssue.quoteChanged,
      (_, 409, 'idempotency_conflict') => TopUpIssue.keyConflict,
      (_, 409, 'account_closed') => TopUpIssue.accountClosed,
      (_, 409, _) => TopUpIssue.malformed,
      (DriverApiProblem.malformed, _, _) => TopUpIssue.malformed,
      (DriverApiProblem.connection, _, _) => TopUpIssue.uncertain,
      (_, final int status, _) when status >= 500 => TopUpIssue.uncertain,
      _ => TopUpIssue.rejected,
    };
