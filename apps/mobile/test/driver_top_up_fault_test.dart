import 'dart:async';

import 'package:dio/dio.dart';
import 'package:driver_app/app/composition/api_app.dart';
import 'package:driver_app/core/api/api_config.dart';
import 'package:driver_app/core/api/driver_api_exception.dart';
import 'package:driver_app/core/api/driver_api_session.dart';
import 'package:driver_app/core/api/vnpay_checkout_url.dart';
import 'package:driver_app/features/auth/application/auth_controller.dart';
import 'package:driver_app/features/auth/domain/auth_scope.dart';
import 'package:driver_app/features/payments/application/credit_top_up_controller.dart';
import 'package:driver_app/features/payments/data/api_credit_top_up_repository.dart';
import 'package:driver_app/features/payments/domain/credit_top_up.dart';
import 'package:driver_app/features/support/domain/connector_fault_report.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'driver_api_fixture.dart';
import 'driver_api_widget_test.dart' show enterAccount;
import 'driver_discovery_fixture.dart';
import 'scanner_platform_fake.dart';

const _id = '9007199254740994';
const _statusPath = 'billing/top-ups/$_id';
const _faultPath = 'connectors/$firstConnector/fault-reports';
const _checkout =
    'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html?vnp_OrderInfo=A+%2fB&vnp_SecureHash=fixture';
const _channel = MethodChannel('powerme/vnpay_checkout');
final _api = ApiConfig.parse('https://fixture.invalid/api/driver/v1');
const _quote = {
  'points_available': 1700,
  'max_points': 1700,
  'max_discount_vnd': 17000,
};

void main() {
  test('VNPay permits the signed checkout URL unchanged', () {
    expect(validatedVnpayCheckoutUrl(_checkout), _checkout);
    for (final url in [
      _checkout.replaceFirst('https:', 'http:'),
      _checkout.replaceFirst(
        'sandbox.vnpayment.vn',
        'sandbox.vnpayment.vn.invalid',
      ),
      _checkout.replaceFirst(
        'sandbox.vnpayment.vn',
        'user@sandbox.vnpayment.vn',
      ),
      _checkout.replaceFirst(
        'sandbox.vnpayment.vn',
        'sandbox.vnpayment.vn:444',
      ),
      _checkout.replaceFirst('/paymentv2/', '/elsewhere/'),
      _checkout.replaceFirst('%2f', '%zz'),
      '$_checkout#fragment',
    ]) {
      expect(validatedVnpayCheckoutUrl(url), null, reason: url);
    }
  });

  test(
    'typed conflicts distinguish existing checkout and confirmation',
    () async {
      var response = reply(409, {
        'error': 'top_up_pending',
        'top_up_id': _id,
        'payment_url': _checkout,
      });
      final session = DriverApiSession(
        _api,
        adapter: _fixture((_) async => response),
      );
      addTearDown(session.dispose);
      final principal = await session.signIn(
        'test@example.invalid',
        'fixture password',
      );
      final scope = AuthScope(principalId: principal, generation: 1);
      final repo = ApiCreditTopUpRepository(session);
      const request = (
        key: '01f74cc1-f6d5-40d1-8f27-42df86d119dd',
        amountVnd: 200000,
        points: 600,
      );
      expect(await repo.create(scope, request), (
        id: _id,
        confirming: false,
        freshCheckout: false,
      ));
      response = reply(409, {
        'error': 'pending_top_up_confirming',
        'top_up_id': _id,
      });
      expect(await repo.create(scope, request), (
        id: _id,
        confirming: true,
        freshCheckout: false,
      ));
      response = reply(409, {
        'error': 'top_up_pending',
        'top_up_id': _id,
        'payment_url': 'https://other.invalid/pay',
      });
      await expectLater(
        repo.create(scope, request),
        throwsA(
          isA<DriverApiException>().having(
            (e) => e.topUpConflict,
            'trusted conflict',
            isNull,
          ),
        ),
      );
      response = reply(201, _order('pending'));
      expect(await repo.create(scope, request), (
        id: _id,
        confirming: false,
        freshCheckout: true,
      ));
      response = reply(200, _order('pending'));
      expect(await repo.create(scope, request), (
        id: _id,
        confirming: false,
        freshCheckout: false,
      ));
      response = reply(200, _order('refunded'));
      expect(
        (await repo.status(scope, _id).result).status,
        TopUpStatus.refunded,
      );
      response = reply(200, {
        ..._order('pending'),
        'top_up_id': '9223372036854775808',
      });
      await expectLater(
        repo.status(scope, _id).result,
        throwsA(isA<DriverApiException>()),
      );
    },
  );

  for (final points in [0, 600]) {
    testWidgets('fresh checkout with $points points opens once after GET', (
      tester,
    ) async {
      final launches = _recordLaunches(failFirst: points > 0);
      final verified = Completer<ResponseBody>();
      var reads = 0;
      var writes = 0;
      final order = _order('pending', points: points);
      await _openQuotedTopUp(
        tester,
        _topUpFixture(
          create: (request) async {
            writes++;
            expect(request.data, {
              'amount_vnd': 200000,
              'points_to_redeem': points,
            });
            expect(request.headers['Idempotency-Key'], isNotEmpty);
            return reply(201, order);
          },
          status: () async =>
              ++reads == 1 ? verified.future : reply(200, order),
        ),
        points: points,
      );
      await _visible(tester, _key('top-up-create'));
      expect(find.text('Thanh toán qua VNPay'), findsOneWidget);
      expect(find.text('Tổng thanh toán dự kiến'), findsOneWidget);
      expect(
        find.text(points == 0 ? '200.000 đ' : '194.000 đ'),
        findsOneWidget,
      );
      await tester.tap(_key('top-up-create'));
      await tester.pump(const Duration(milliseconds: 100));
      expect(writes, 1);
      expect(reads, 1);
      expect(launches, isEmpty);

      verified.complete(reply(200, order));
      await tester.pumpAndSettle();
      expect(launches, [_checkout]);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(reads, 2);
      await tester.pump(const Duration(seconds: 5));
      await tester.pumpAndSettle();
      expect(reads, 3);
      expect(writes, 1);
      expect(launches, [_checkout]);
      if (points > 0) {
        expect(find.textContaining('Không mở được VNPay'), findsOneWidget);
        expect(find.text('Mở lại VNPay'), findsOneWidget);
        await _tap(tester, _key('top-up-pay'));
        expect(launches, [_checkout, _checkout]);
      }
    });
  }

  for (final scenario in [
    'conflict',
    'replay',
    'amount changed',
    'inexact quote',
  ]) {
    testWidgets('$scenario keeps checkout behind the continue button', (
      tester,
    ) async {
      final launches = _recordLaunches();
      final order = _order('pending');
      await _openQuotedTopUp(
        tester,
        _topUpFixture(
          create: (_) async => switch (scenario) {
            'conflict' => reply(409, {
              'error': 'top_up_pending',
              'top_up_id': _id,
              'payment_url': _checkout,
            }),
            'replay' => reply(200, order),
            _ => reply(201, order),
          },
          status: () async => reply(
            200,
            scenario == 'amount changed'
                ? {
                    ...order,
                    'points_discount_vnd': 6600,
                    'amount_paid_vnd': 193400,
                  }
                : order,
          ),
          quote: scenario == 'inexact quote'
              ? {..._quote, 'max_discount_vnd': 17001}
              : _quote,
        ),
        points: 600,
      );
      await _tap(tester, _key('top-up-create'));
      expect(launches, isEmpty);
      expect(find.text('Số tiền cần thanh toán'), findsOneWidget);
      expect(
        find.text(scenario == 'amount changed' ? '193.400 đ' : '194.000 đ'),
        findsOneWidget,
      );
      await _tap(tester, _key('top-up-pay'));
      expect(launches, [_checkout]);
    });
  }

  testWidgets('backgrounding during verification consumes the original tap', (
    tester,
  ) async {
    final launches = _recordLaunches();
    final firstRead = Completer<ResponseBody>();
    final order = _order('pending');
    var reads = 0;
    await _openQuotedTopUp(
      tester,
      _topUpFixture(
        create: (_) async => reply(201, order),
        status: () async => ++reads == 1 ? firstRead.future : reply(200, order),
      ),
      points: 600,
    );
    await _visible(tester, _key('top-up-create'));
    await tester.tap(_key('top-up-create'));
    await tester.pump(const Duration(milliseconds: 100));
    expect(reads, 1);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    firstRead.complete(reply(200, order));
    await tester.pump();
    expect(launches, isEmpty);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();
    expect(reads, 2);
    expect(launches, isEmpty);
    await _tap(tester, _key('top-up-pay'));
    expect(launches, [_checkout]);
  });

  testWidgets(
    'replays the same top-up across routes and refreshes credit only on credited GET',
    (tester) async {
      final launches = <Object?>[];
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(_channel, (call) async {
        expect(call.method, 'openCheckout');
        launches.add(call.arguments);
        return true;
      });
      addTearDown(() => messenger.setMockMethodCallHandler(_channel, null));
      var writes = 0;
      var checks = 0;
      var balances = 0;
      var ledgers = 0;
      var status = 'pending';
      final sent = <RequestOptions>[];
      final fixture = _fixture((request) async {
        switch (request.path) {
          case 'credit':
            balances++;
            return reply(200, _credit(status == 'credited' ? 200000 : 0));
          case 'credit/transactions':
            ledgers++;
            return reply(200, _emptyLedger);
          case 'billing/top-ups/quote':
            expect(request.queryParameters, {'amount_vnd': 200000});
            return reply(200, _quote);
          case 'billing/top-ups':
            sent.add(request);
            return ++writes == 1
                ? reply(502, {})
                : reply(200, _order('pending'));
          case _statusPath:
            checks++;
            return reply(200, _order(status));
        }
        throw StateError('Unexpected path');
      });

      await _signIn(tester, fixture);
      await _tap(tester, _key('nav-credit'));
      final initialBalances = balances;
      final initialLedgers = ledgers;
      await _tap(tester, _key('open-credit-top-up'));
      await _tap(tester, find.text('200K'));
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextField>(_key('top-up-amount')).controller!.text,
        '200000',
      );
      expect(writes, 0);
      await tester.enterText(_key('top-up-points'), '600');
      await _tap(tester, _key('top-up-create'));
      expect(find.text('Thử lại giao dịch này'), findsOneWidget);
      await _back(tester);
      await _tap(tester, _key('open-credit-top-up'));
      await _tap(tester, _key('top-up-create'));
      expect(checks, 1);
      expect(find.text(_id), findsOneWidget);
      expect(find.text('194.000 đ'), findsOneWidget);
      expect(launches, isEmpty);
      expect(sent, hasLength(2));
      final key = sent.first.headers['Idempotency-Key'] as String;
      expect(
        key,
        matches(
          r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
        ),
      );
      expect(sent.last.headers['Idempotency-Key'], key);
      expect(sent.last.data, sent.first.data);
      expect(sent.first.data, {'amount_vnd': 200000, 'points_to_redeem': 600});
      expect(balances, initialBalances);
      expect(ledgers, initialLedgers);
      await _tap(tester, _key('top-up-pay'));
      expect(launches, [_checkout]);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pump(const Duration(seconds: 6));
      expect(checks, 1);
      status = 'credited';
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(find.text('Tín dụng đã được cộng.'), findsOneWidget);
      expect(find.text('+200.000 đ'), findsOneWidget);
      await _back(tester);
      expect(balances, initialBalances + 1);
      expect(ledgers, initialLedgers + 1);
      expect(find.text('200.000 đ'), findsWidgets);
    },
  );

  testWidgets(
    'quote reselection, expired order, 404 recovery and signed-out scope at 320px',
    (tester) async {
      var writes = 0;
      var quotes = 0;
      var checks = 0;
      var missing = false;
      final fixture = _fixture((request) async {
        switch (request.path) {
          case 'credit':
            return reply(200, _credit(0));
          case 'credit/transactions':
            return reply(200, _emptyLedger);
          case 'billing/top-ups/quote':
            quotes++;
            return reply(200, _quote);
          case 'billing/top-ups':
            switch (++writes) {
              case 1:
                return reply(422, {'error': 'points_unavailable'});
              case 2:
                return reply(409, {
                  'error': 'pending_top_up_confirming',
                  'top_up_id': _id,
                });
              default:
                return reply(409, {
                  'error': 'top_up_pending',
                  'top_up_id': _id,
                  'payment_url': _checkout,
                });
            }
          case _statusPath:
            checks++;
            return missing
                ? reply(404, {'error': 'not_found'})
                : reply(200, _order('expired'));
        }
        throw StateError('Unexpected path');
      });
      await _signIn(tester, fixture);
      await _tap(tester, _key('nav-credit'));
      await _tap(tester, _key('open-credit-top-up'));
      _applyNarrowLayout(tester);
      await tester.pumpAndSettle();
      await tester.enterText(_key('top-up-amount'), '200000');
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pumpAndSettle();
      await _visible(tester, _key('top-up-points'));
      await tester.enterText(_key('top-up-points'), '600');
      await _tap(tester, _key('top-up-create'));
      await _visible(tester, _key('top-up-points'));
      expect(
        tester.widget<TextField>(_key('top-up-points')).controller!.text,
        isEmpty,
      );
      expect(quotes, 2);
      await _tap(tester, _key('top-up-create'));
      expect(find.text('Giao dịch nạp đã hết hạn.'), findsOneWidget);
      expect(_key('top-up-pay'), findsNothing);
      expect(tester.takeException(), isNull);
      await _tap(tester, _key('top-up-new'));
      await tester.enterText(_key('top-up-amount'), '200000');
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pumpAndSettle();
      missing = true;
      await _tap(tester, _key('top-up-create'));
      expect(checks, 2);
      await _visible(tester, _key('top-up-create'));
      expect(
        find.textContaining('Không tìm thấy giao dịch trước'),
        findsOneWidget,
      );

      final container = ProviderScope.containerOf(
        tester.element(find.byType(MaterialApp)),
      );
      container.read(authControllerProvider.notifier).signOut();
      await tester.pumpAndSettle();
      final reset = container.read(creditTopUpProvider);
      expect(reset.amountText, isEmpty);
      expect(reset.tracking, false);
      expect(reset.issue, null);
    },
  );

  test(
    'fault description matches JavaScript trim, control rule and rune length',
    () {
      expect(faultDescription('  A😀\tB\nC  '), 'A😀\tB\nC');
      expect(faultDescription('abc\u0000de'), null);
      expect(faultDescription('😀😀😀😀'), null);
      expect(faultDescription('😀' * 500), isNotNull);
      expect(faultDescription('😀' * 501), null);
    },
  );

  testWidgets(
    'ignores stale quote and late create after auth generation changes',
    (tester) async {
      final oldQuote = Completer<ResponseBody>();
      final oldWrite = Completer<ResponseBody>();
      var statusReads = 0;
      final fixture = _fixture(
        (request) async => switch (request.path) {
          'credit' => reply(200, _credit(0)),
          'credit/transactions' => reply(200, _emptyLedger),
          'billing/top-ups/quote'
              when request.queryParameters['amount_vnd'] == 100000 =>
            oldQuote.future,
          'billing/top-ups/quote' => reply(200, _quote),
          'billing/top-ups' => oldWrite.future,
          _statusPath => reply(
            ++statusReads == 1 ? 200 : 404,
            _order('pending'),
          ),
          _ => throw StateError('Unexpected path'),
        },
      );
      await _signIn(tester, fixture);
      await _tap(tester, _key('nav-credit'));
      await _tap(tester, _key('open-credit-top-up'));
      await tester.enterText(_key('top-up-amount'), '100000');
      await tester.pump(const Duration(milliseconds: 400));
      await tester.enterText(_key('top-up-amount'), '200000');
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pumpAndSettle();
      oldQuote.complete(
        reply(200, {
          'points_available': 0,
          'max_points': 0,
          'max_discount_vnd': 0,
        }),
      );
      await tester.pumpAndSettle();
      expect(_key('top-up-points'), findsOneWidget);
      await tester.enterText(_key('top-up-points'), '600');
      await _tap(tester, _key('top-up-create'));
      expect(find.text('Đang gửi'), findsOneWidget);
      final container = ProviderScope.containerOf(
        tester.element(find.byType(MaterialApp)),
      );
      container.read(authControllerProvider.notifier).signOut();
      await tester.pumpAndSettle();
      await enterAccount(tester);
      await _tap(tester, _key('nav-credit'));
      await _tap(tester, _key('open-credit-top-up'));
      oldWrite.complete(reply(201, _order('pending')));
      await tester.pumpAndSettle();
      expect(statusReads, 0);
      expect(
        tester.widget<TextField>(_key('top-up-amount')).controller!.text,
        isEmpty,
      );
      expect(_key('top-up-pay'), findsNothing);
    },
  );

  testWidgets(
    'blocked QR report uses the canonical connector for duplicate, saved and unavailable',
    (tester) async {
      final oldCamera = MobileScannerPlatform.instance;
      MobileScannerPlatform.instance = ScannerPlatformFake();
      addTearDown(() => MobileScannerPlatform.instance = oldCamera);
      var submitted = 0;
      final fixture = _fixture((request) async {
        switch (request.path) {
          case 'connectors/by-code/TRU-12/1':
            return reply(200, {
              'connector_id': firstConnector,
              'site_name': 'Trạm QR',
              'display_code': 'TRU-12',
              'connector_no': 1,
              'is_online': true,
              'status': 'Unavailable',
              'reported_issue': true,
              'blocked': true,
            });
          case _faultPath:
            expect(request.method, 'POST');
            expect(request.headers['Idempotency-Key'], isNull);
            expect(request.data, {
              'description': 'Cổng không mở\nKiểm tra giúp',
            });
            return switch (++submitted) {
              1 => reply(400, {'error': 'invalid_description'}),
              2 => reply(409, {'error': 'duplicate_report'}),
              3 => reply(201, _report(firstConnector, reported: true)),
              4 => reply(502, {}),
              _ => reply(404, {'error': 'not_found'}),
            };
        }
        throw StateError('Unexpected path');
      });
      await _signIn(tester, fixture);
      await _tap(tester, _key('nav-charging'));
      await tester.enterText(_key('qr-manual-reference'), 'TRU-12/1');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(find.text('Cổng đã được báo lỗi'), findsOneWidget);
      await _tap(tester, _key('qr-report-connector'));
      _applyNarrowLayout(tester);
      await tester.pumpAndSettle();
      final description = _key('connector-fault-description');
      await tester.enterText(description, 'abcd');
      await _tap(tester, _key('send-connector-fault'));
      expect(submitted, 0);
      expect(find.textContaining('5 đến 500'), findsOneWidget);
      await _visible(tester, description);
      await tester.enterText(description, ' Cổng không mở\nKiểm tra giúp ');
      await _tap(tester, _key('send-connector-fault'));
      expect(submitted, 1);
      expect(find.textContaining('5 đến 500'), findsOneWidget);
      await _tap(tester, _key('send-connector-fault'));
      expect(find.textContaining('Bạn vừa gửi báo lỗi'), findsOneWidget);
      await _tap(tester, _key('send-connector-fault'));
      expect(find.text('Đã nhận báo lỗi'), findsOneWidget);
      expect(
        find.textContaining('Đơn vị vận hành đã được thông báo'),
        findsOneWidget,
      );
      expect(submitted, 3);
      expect(find.text('27'), findsOneWidget);
      await _tap(tester, find.text('Hoàn tất và quay lại'));
      await _tap(tester, _key('qr-report-connector'));
      await _visible(tester, description);
      await tester.enterText(description, 'Cổng không mở\nKiểm tra giúp');
      await _tap(tester, _key('send-connector-fault'));
      expect(find.textContaining('Chưa xác nhận được báo lỗi'), findsOneWidget);
      await _tap(tester, _key('send-connector-fault'));
      expect(find.text('Cổng sạc không khả dụng'), findsOneWidget);
      expect(find.text('Khám phá trạm sạc'), findsOneWidget);
      expect(_key('send-connector-fault'), findsNothing);
      expect(submitted, 5);
      expect(tester.takeException(), isNull);
    },
  );
}

DriverApiFixture _fixture(
  Future<ResponseBody> Function(RequestOptions) handler,
) => DriverApiFixture(
  (request) async => switch (request.path) {
    'auth/login' => reply(200, tokens(accessA)),
    'me' => reply(200, account()),
    'stations' => reply(200, page([])),
    _ => handler(request),
  },
);

Map<String, Object?> _credit(int amount) => {
  'balance_vnd': amount,
  'held_vnd': 0,
  'available_vnd': amount,
  'status': 'active',
  'updated_at': '2026-11-17T00:00:00Z',
};

const _emptyLedger = {'items': [], 'total': 0, 'page': 1, 'page_size': 20};

Map<String, Object?> _order(String status, {int points = 600}) {
  final now = DateTime.now().toUtc();
  return {
    'top_up_id': _id,
    'status': status,
    'amount_vnd': 200000,
    'points_redeemed': points,
    'points_discount_vnd': points * 10,
    'amount_paid_vnd': 200000 - points * 10,
    'created_at': now.subtract(const Duration(minutes: 5)).toIso8601String(),
    'expires_at': now.add(const Duration(minutes: 10)).toIso8601String(),
    'payment_url': status == 'pending' ? _checkout : null,
  };
}

Map<String, Object?> _report(String connector, {required bool reported}) => {
  'report_id': '9007199254740995',
  'report_no': '27',
  'connector_id': connector,
  'reported_at': '2026-11-17T00:00:00Z',
  'fault_event_id': reported ? '17' : null,
  'reported_issue': reported,
};

Future<void> _signIn(WidgetTester tester, DriverApiFixture fixture) async {
  await tester.pumpWidget(ApiApp(config: _api, httpAdapter: fixture));
  await tester.pumpAndSettle();
  await enterAccount(tester);
}

List<Object?> _recordLaunches({bool failFirst = false}) {
  final launches = <Object?>[];
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  messenger.setMockMethodCallHandler(_channel, (call) async {
    expect(call.method, 'openCheckout');
    launches.add(call.arguments);
    return !failFirst || launches.length > 1;
  });
  addTearDown(() => messenger.setMockMethodCallHandler(_channel, null));
  return launches;
}

DriverApiFixture _topUpFixture({
  required Future<ResponseBody> Function(RequestOptions) create,
  required Future<ResponseBody> Function() status,
  Map<String, int> quote = _quote,
}) => _fixture(
  (request) async => switch (request.path) {
    'credit' => reply(200, _credit(0)),
    'credit/transactions' => reply(200, _emptyLedger),
    'billing/top-ups/quote' => reply(200, quote),
    'billing/top-ups' => create(request),
    _statusPath => status(),
    _ => throw StateError('Unexpected path'),
  },
);

Future<void> _openQuotedTopUp(
  WidgetTester tester,
  DriverApiFixture fixture, {
  required int points,
}) async {
  await _signIn(tester, fixture);
  await _tap(tester, _key('nav-credit'));
  await _tap(tester, _key('open-credit-top-up'));
  await _tap(tester, find.text('200K'));
  await tester.pump(const Duration(milliseconds: 400));
  await tester.pumpAndSettle();
  if (points > 0) {
    await _visible(tester, _key('top-up-points'));
    await tester.enterText(_key('top-up-points'), '$points');
  }
}

void _applyNarrowLayout(WidgetTester tester) {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(320, 680);
  tester.platformDispatcher.textScaleFactorTestValue = 2;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
}

Finder _key(String key) => find.byKey(Key(key));

Future<void> _visible(WidgetTester tester, Finder finder) async {
  await tester.pumpAndSettle();
  if (finder.evaluate().isEmpty) {
    await tester.scrollUntilVisible(
      finder,
      180,
      scrollable: find.byType(Scrollable).first,
    );
  }
  await tester.ensureVisible(finder);
  await tester.pump();
}

Future<void> _tap(WidgetTester tester, Finder finder) async {
  await _visible(tester, finder);
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

Future<void> _back(WidgetTester tester) async {
  await tester.tap(find.byTooltip('Quay lại'));
  await tester.pumpAndSettle();
}
