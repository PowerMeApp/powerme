import 'dart:async';

import 'package:dio/dio.dart';
import 'package:driver_app/app/composition/api_app.dart';
import 'package:driver_app/core/api/api_config.dart';
import 'package:driver_app/features/auth/application/auth_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'driver_api_fixture.dart';
import 'driver_api_widget_test.dart' show enterAccount;
import 'driver_discovery_fixture.dart' show page;

void main() {
  testWidgets(
    'account credit uses server amounts and retries the selected page',
    (tester) async {
      var summaries = 0;
      var secondPages = 0;
      final queries = <Map<String, dynamic>>[];
      final fixture = DriverApiFixture((request) async {
        switch (request.path) {
          case 'auth/login':
            return reply(200, tokens(accessA));
          case 'me':
            return reply(200, account());
          case 'stations':
            return reply(200, page([]));
          case 'credit':
            expect(request.queryParameters, isEmpty);
            return ++summaries == 1
                ? reply(503, {'error': 'unavailable'})
                : reply(
                    200,
                    _credit(
                      balance: -5000,
                      held: 1000,
                      available: -6000,
                      status: 'in_shortfall',
                    ),
                  );
          case 'credit/transactions':
            queries.add(request.queryParameters);
            final current = request.queryParameters['page'] as int;
            if (current == 1) {
              return reply(
                200,
                _ledger(
                  1,
                  21,
                  List.generate(20, (i) => _entry(21 - i, -123456)),
                ),
              );
            }
            return ++secondPages == 1
                ? reply(503, {'error': 'unavailable'})
                : reply(200, _ledger(2, 21, [_entry(1, 200000)]));
          default:
            throw StateError('Unexpected path');
        }
      });

      await _signIn(tester, fixture);
      await _openCredit(tester);
      expect(find.text('Chưa tải được số dư tín dụng.'), findsOneWidget);
      await _tap(tester, find.text('Thử tải lại số dư'));
      expect(find.text('Thiếu hụt tín dụng'), findsOneWidget);
      expect(find.text('−5.000 đ'), findsOneWidget);
      expect(find.text('1.000 đ'), findsOneWidget);
      expect(find.text('−6.000 đ'), findsOneWidget);
      await _scrollTo(tester, find.text('−123.456 đ').first);
      expect(find.text('−123.456 đ'), findsWidgets);
      await _tap(tester, find.text('Trang sau'));
      await _scrollTo(tester, find.text('Chưa tải được giao dịch tín dụng.'));
      expect(find.text('Chưa có giao dịch.'), findsNothing);
      await _tap(tester, find.text('Thử tải lại giao dịch'));
      await _scrollTo(tester, find.text('+200.000 đ'));
      expect(find.text('+200.000 đ'), findsOneWidget);
      await _scrollTo(tester, find.text('Trang 2'));
      final next = tester.widget<TextButton>(
        find.widgetWithText(TextButton, 'Trang sau'),
      );
      expect(next.onPressed, isNull);
      expect(queries, [
        {'page': 1, 'page_size': 20},
        {'page': 2, 'page_size': 20},
        {'page': 2, 'page_size': 20},
      ]);
      expect(
        fixture.requests.where((r) => r.path.startsWith('billing/')),
        isEmpty,
      );
    },
  );

  testWidgets(
    'settled history pages through top-ups and reads owned statements',
    (tester) async {
      var reads = 0;
      final fixture = DriverApiFixture(
        (r) async => switch (r.path) {
          'auth/login' => reply(200, tokens(accessA)),
          'me' => reply(200, account(id: '7')),
          'stations' => reply(200, page([])),
          'credit' => reply(200, _credit(balance: 5000, available: 5000)),
          'credit/transactions' when r.queryParameters['page'] == 1 => reply(
            200,
            _ledger(1, 23, List.generate(20, (i) => _entry(23 - i, 20000))),
          ),
          'credit/transactions' => reply(
            200,
            _ledger(2, 23, [
              _entry(3, -45000)..['session_id'] = '9223372036854775807',
              _entry(2, -1000)..remove('session_id'),
              _entry(1, 10000),
            ]),
          ),
          'sessions/9223372036854775807/statement' => reply(200, {
            'session_id': '9223372036854775807',
            'driver_id': ++reads == 1 ? '8' : '7',
            'energy_wh': 10000,
            'amount_vnd': 45000,
            'earned_points': 45,
            'created_at': '2026-11-17T00:00:00Z',
          }),
          _ => throw StateError('Unexpected ${r.method} ${r.path}'),
        },
      );

      await _signIn(tester, fixture);
      await _tap(tester, find.byKey(const Key('nav-history')));
      expect(find.text('Phiên đã quyết toán'), findsOneWidget);
      expect(
        find.text('Trang này không có phiên đã quyết toán.'),
        findsOneWidget,
      );
      expect(find.text('Nạp tín dụng'), findsNothing);
      expect(fixture.requests.where((r) => r.path == 'credit'), isEmpty);
      await _tap(tester, find.text('Trang sau'));
      expect(find.text('Thanh toán phiên sạc'), findsNWidgets(2));
      expect(find.text('Nạp tín dụng'), findsNothing);
      expect(find.text('Xem bảng kê'), findsOneWidget);
      await _tap(tester, find.text('Xem bảng kê'));
      expect(
        find.text('Bảng kê chưa có. Bạn có thể thử tải lại.'),
        findsOneWidget,
      );
      expect(find.text('Điểm nhận được'), findsNothing);
      await _tap(tester, find.text('Tải lại bảng kê'));
      expect(reads, 2);
      expect(find.text('Điểm nhận được'), findsOneWidget);
      expect(find.text('45'), findsOneWidget);
      expect(
        fixture.requests.where((r) => r.path.endsWith('/progress')),
        isEmpty,
      );
      expect(
        fixture.requests.where((r) => r.method == 'POST').map((r) => r.path),
        ['auth/login'],
      );

      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      await _tap(tester, find.byKey(const Key('nav-credit')));
      expect(find.text('Giao dịch tín dụng'), findsOneWidget);
      expect(find.text('Nạp tín dụng'), findsWidgets);
      expect(find.text('Xem bảng kê'), findsNothing);
    },
  );

  testWidgets('refresh and logout discard previous credit and ledger results', (
    tester,
  ) async {
    final lateBalance = Completer<ResponseBody>();
    final lateLedger = Completer<ResponseBody>();
    var signIns = 0;
    var firstSummaryReads = 0;
    final fixture = DriverApiFixture((request) async {
      final bearer = request.headers['Authorization'];
      switch (request.path) {
        case 'auth/login':
          return reply(200, tokens(++signIns == 1 ? accessA : accessB));
        case 'auth/refresh':
          return reply(200, tokens(accessA, login: false));
        case 'me':
          return reply(
            200,
            account(id: bearer == 'Bearer $accessA' ? '7' : '8'),
          );
        case 'stations':
          return reply(200, page([]));
        case 'credit' when bearer == 'Bearer $accessA':
          return switch (++firstSummaryReads) {
            1 => reply(200, _credit(balance: 999999, available: 999999)),
            2 => reply(401, {'error': 'token_expired'}),
            _ => lateBalance.future,
          };
        case 'credit':
          return reply(200, _credit(status: 'none'));
        case 'credit/transactions' when bearer == 'Bearer $accessA':
          return lateLedger.future;
        case 'credit/transactions':
          return reply(200, _ledger(1, 0, []));
        default:
          throw StateError('Unexpected path');
      }
    });

    await _signIn(tester, fixture);
    await _openCredit(tester, settle: false);
    expect(find.text('999.999 đ'), findsNWidgets(2));
    await _tap(tester, find.text('Cập nhật số dư'), settle: false);
    expect(firstSummaryReads, 3);
    expect(find.text('999.999 đ'), findsNothing);

    final ref = ProviderScope.containerOf(
      tester.element(find.byType(Scaffold).last),
    );
    ref.read(authControllerProvider.notifier).signOut();
    await tester.pumpAndSettle();
    await enterAccount(tester);
    await _openCredit(tester);
    expect(find.text('Chưa có tài khoản tín dụng'), findsOneWidget);
    expect(find.text('Chưa có giao dịch.'), findsOneWidget);
    lateBalance.complete(
      reply(200, _credit(balance: 888888, available: 888888)),
    );
    lateLedger.complete(reply(200, _ledger(1, 1, [_entry(1, -777777)])));
    await tester.pumpAndSettle();
    expect(find.text('888.888 đ'), findsNothing);
    expect(find.text('−777.777 đ'), findsNothing);
    expect(find.text('Chưa có giao dịch.'), findsOneWidget);
    expect(
      fixture.requests.where((r) => r.path == 'auth/refresh'),
      hasLength(1),
    );
  });
}

Map<String, Object?> _credit({
  int balance = 0,
  int held = 0,
  int available = 0,
  String status = 'active',
}) => {
  'balance_vnd': balance,
  'held_vnd': held,
  'available_vnd': available,
  'status': status,
  'updated_at': status == 'none' ? null : '2026-11-17T00:00:00Z',
};

Map<String, Object?> _entry(int number, int amount) => {
  'transaction_id': '$number',
  'entry_no': number,
  'transaction_type': amount < 0 ? 'session_debit' : 'top_up',
  'amount_vnd': amount,
  'balance_after_vnd': 0,
  'session_id': amount < 0 ? '78' : null,
  'top_up_id': amount > 0 ? '79' : null,
  'reservation_id': null,
  'created_at': '2026-11-17T00:00:00Z',
};

Map<String, Object> _ledger(
  int page,
  int total,
  List<Map<String, Object?>> items,
) => {'items': items, 'total': total, 'page': page, 'page_size': 20};

Future<void> _signIn(WidgetTester tester, DriverApiFixture fixture) async {
  await tester.pumpWidget(
    ApiApp(
      config: ApiConfig.parse('https://fixture.invalid/api/driver/v1'),
      httpAdapter: fixture,
    ),
  );
  await tester.pumpAndSettle();
  await enterAccount(tester);
}

Future<void> _openCredit(WidgetTester tester, {bool settle = true}) async {
  await _tap(tester, find.byKey(const Key('nav-account')));
  await _tap(tester, find.text('Tín dụng sạc'), settle: settle);
}

Future<void> _scrollTo(WidgetTester tester, Finder finder) async {
  if (finder.evaluate().isEmpty) {
    await tester.scrollUntilVisible(
      finder,
      350,
      scrollable: find.byType(Scrollable).last,
    );
  }
  await tester.ensureVisible(finder);
  await tester.pump();
}

Future<void> _tap(
  WidgetTester tester,
  Finder finder, {
  bool settle = true,
}) async {
  await _scrollTo(tester, finder);
  await tester.tap(finder);
  if (settle) {
    await tester.pumpAndSettle();
  } else {
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  }
}
