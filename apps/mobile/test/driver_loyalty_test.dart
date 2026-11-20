import 'dart:async';

import 'package:dio/dio.dart';
import 'package:driver_app/app/composition/api_app.dart';
import 'package:driver_app/app/router.dart';
import 'package:driver_app/core/api/api_config.dart';
import 'package:driver_app/core/api/driver_api_exception.dart';
import 'package:driver_app/core/api/driver_api_session.dart';
import 'package:driver_app/features/auth/application/auth_controller.dart';
import 'package:driver_app/features/auth/domain/auth_scope.dart';
import 'package:driver_app/features/loyalty/application/loyalty_controller.dart';
import 'package:driver_app/features/loyalty/data/api_loyalty_repository.dart';
import 'package:driver_app/features/loyalty/domain/loyalty.dart';
import 'package:driver_app/features/loyalty/presentation/loyalty_screen.dart';
import 'package:driver_app/core/theme/powerme_theme.dart';
import 'package:driver_app/features/payments/data/api_credit_top_up_repository.dart';
import 'package:driver_app/features/payments/application/credit_top_up_controller.dart';
import 'package:driver_app/features/payments/domain/credit_top_up.dart';
import 'package:driver_app/features/profile/application/profile_controller.dart';
import 'package:driver_app/features/profile/domain/driver_profile.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'driver_api_fixture.dart';
import 'driver_api_widget_test.dart' show enterAccount;
import 'support/loyalty_api_fixture.dart';

final loyaltyApi = ApiConfig.parse('https://fixture.invalid/api/driver/v1');

void main() {
  test(
    'quote-backed balance accepts zero, below-minimum and dynamic policy',
    () async {
      Map<String, Object?> json = loyaltyQuote(
        available: 0,
        maximum: 0,
        discount: 0,
      );
      final fixture = loyaltyFixture(
        quote: (request) async {
          expect(request.method, 'GET');
          expect(request.queryParameters, {'amount_vnd': minTopUpVnd});
          expect(request.headers['Authorization'], 'Bearer $accessA');
          return reply(200, json);
        },
      );
      final session = DriverApiSession(loyaltyApi, adapter: fixture);
      addTearDown(session.dispose);
      final principal = await session.signIn(
        'test@example.invalid',
        'fixture password',
      );
      final scope = AuthScope(principalId: principal, generation: 1);
      final repo = ApiLoyaltyRepository(session, probeAmountVnd: minTopUpVnd);
      for (final points in [0, 499, 9007199254740991]) {
        json = loyaltyQuote(available: points, maximum: 0, discount: 0);
        final balance = await repo.read(scope).result;
        expect(balance.availablePoints, points);
        expect(balance.scope, scope);
      }
      json = loyaltyQuote(available: 6000, maximum: 2500, discount: 25000);
      expect((await repo.read(scope).result).availablePoints, 6000);
      json = loyaltyQuote(available: 30, maximum: 30, discount: 30001);
      expect(
        (await ApiCreditTopUpRepository(
          session,
        ).quote(scope, minTopUpVnd).result).maxPoints,
        30,
      );
      expect((await repo.read(scope).result).availablePoints, 30);
    },
  );

  test(
    'both adapters reject missing/null/negative/unsafe and inconsistent quote fields',
    () async {
      Map<String, Object?> json = loyaltyQuote();
      final session = DriverApiSession(
        loyaltyApi,
        adapter: loyaltyFixture(quote: (_) async => reply(200, json)),
      );
      addTearDown(session.dispose);
      final scope = AuthScope(
        principalId: await session.signIn(
          'test@example.invalid',
          'fixture password',
        ),
        generation: 1,
      );
      final repo = ApiLoyaltyRepository(session, probeAmountVnd: minTopUpVnd);
      final topUp = ApiCreditTopUpRepository(session);
      for (final field in [
        'points_available',
        'max_points',
        'max_discount_vnd',
      ]) {
        for (final value in [null, -1, 9007199254740992, '600', 1.5, true]) {
          json = {...loyaltyQuote(), field: value};
          await expectLater(
            repo.read(scope).result,
            throwsA(isA<DriverApiException>()),
          );
          await expectLater(
            topUp.quote(scope, minTopUpVnd).result,
            throwsA(isA<DriverApiException>()),
          );
        }
        json = loyaltyQuote()..remove(field);
        await expectLater(
          repo.read(scope).result,
          throwsA(isA<DriverApiException>()),
        );
      }
      for (final invalid in [
        loyaltyQuote(available: 20, maximum: 30, discount: 100),
        loyaltyQuote(maximum: 0),
        loyaltyQuote(discount: 0),
        loyaltyQuote(discount: minTopUpVnd),
      ]) {
        json = invalid;
        await expectLater(
          repo.read(scope).result,
          throwsA(isA<DriverApiException>()),
        );
      }
    },
  );

  test('loyalty and top-up GETs share one 401 session refresh', () async {
    var renewals = 0;
    final refresh = Completer<ResponseBody>();
    final fixture = DriverApiFixture(
      (request) async => switch (request.path) {
        'auth/login' => reply(200, tokens(accessA)),
        'me' => reply(200, account(withVehicle: false)),
        'auth/refresh' =>
          (++renewals == 1
              ? refresh.future
              : throw StateError('duplicate refresh')),
        loyaltyQuotePath
            when request.headers['Authorization'] == 'Bearer $accessA' =>
          reply(401, {'error': 'unauthorized'}),
        loyaltyQuotePath => reply(200, loyaltyQuote()),
        _ => throw StateError('Unexpected path'),
      },
    );
    final session = DriverApiSession(loyaltyApi, adapter: fixture);
    addTearDown(session.dispose);
    final scope = AuthScope(
      principalId: await session.signIn(
        'test@example.invalid',
        'fixture password',
      ),
      generation: 1,
    );
    final balance = ApiLoyaltyRepository(
      session,
      probeAmountVnd: minTopUpVnd,
    ).read(scope).result;
    final quote = ApiCreditTopUpRepository(session).quote(scope, 200000).result;
    while (renewals == 0) {
      await Future<void>.delayed(Duration.zero);
    }
    refresh.complete(reply(200, tokens(accessB, login: false)));
    expect((await balance).availablePoints, 600);
    expect((await quote).maxPoints, 600);
    expect(renewals, 1);
    expect(fixture.requests.where((r) => r.path == loyaltyQuotePath).length, 4);
  });

  test(
    'controller cancels refresh, route/background, auth and disposal and ignores late results',
    () async {
      const a = AuthScope(principalId: '42', generation: 1);
      const b = AuthScope(principalId: '43', generation: 2);
      final repo = _ControlledLoyalty();
      final container = ProviderContainer(
        overrides: [
          authScopeProvider.overrideWithValue(a),
          loyaltyBalanceRepositoryProvider.overrideWithValue(repo),
        ],
      );
      final subscription = container.listen(
        loyaltyControllerProvider,
        (_, _) {},
      );
      final controller = container.read(loyaltyControllerProvider.notifier);
      final route = Object();
      controller.setVisible(route, true);
      controller.refresh();
      expect(repo.cancelled, [0]);
      repo.complete(0, a, 999);
      repo.complete(1, a, 600);
      await Future<void>.delayed(Duration.zero);
      expect(
        container.read(loyaltyControllerProvider).balance!.availablePoints,
        600,
      );
      controller.refresh();
      controller.setVisible(route, false);
      expect(repo.cancelled, [0, 2]);
      repo.complete(2, a, 888);
      await Future<void>.delayed(Duration.zero);
      expect(container.read(loyaltyControllerProvider).balance, null);
      controller.setVisible(route, true);
      container.updateOverrides([
        authScopeProvider.overrideWithValue(b),
        loyaltyBalanceRepositoryProvider.overrideWithValue(repo),
      ]);
      container.read(loyaltyControllerProvider);
      repo.complete(3, a, 777);
      await Future<void>.delayed(Duration.zero);
      expect(repo.cancelled, contains(3));
      expect(container.read(loyaltyControllerProvider).balance, null);
      container
          .read(loyaltyControllerProvider.notifier)
          .setVisible(route, true);
      subscription.close();
      container.dispose();
      expect(repo.cancelled, contains(4));
      repo.complete(4, b, 123);
      await Future<void>.delayed(Duration.zero);
    },
  );

  test(
    'partial point amount has no locally inferred payable; exact maximum uses direct discount',
    () {
      const quote = (pointsAvailable: 40, maxPoints: 30, maxDiscountVnd: 30001);
      expect(topUpPayableEstimate(50000, 0, quote), 50000);
      expect(topUpPayableEstimate(50000, 29, quote), null);
      expect(topUpPayableEstimate(50000, 30, quote), 19999);
      expect(topUpPayableEstimate(50000, 31, quote), null);
      expect(topUpPayableEstimate(50000, -1, quote), null);
    },
  );

  test('cancelled quote read drops the delayed transport response', () async {
    final delayed = Completer<ResponseBody>();
    final started = Completer<void>();
    final session = DriverApiSession(
      loyaltyApi,
      adapter: loyaltyFixture(
        quote: (_) {
          started.complete();
          return delayed.future;
        },
      ),
    );
    addTearDown(session.dispose);
    final scope = AuthScope(
      principalId: await session.signIn(
        'test@example.invalid',
        'fixture password',
      ),
      generation: 1,
    );
    final read = ApiLoyaltyRepository(
      session,
      probeAmountVnd: minTopUpVnd,
    ).read(scope);
    final rejected = expectLater(
      read.result,
      throwsA(isA<DriverApiException>()),
    );
    await started.future;
    read.cancel();
    await rejected;
    delayed.complete(reply(200, loyaltyQuote()));
    await Future<void>.delayed(Duration.zero);
  });

  for (final outcome in [TopUpStatus.credited, TopUpStatus.refunded]) {
    test(
      '$outcome status does not instantiate an unconfigured loyalty provider',
      () async {
        const scope = AuthScope(principalId: '42', generation: 1);
        final container = ProviderContainer(
          overrides: [
            authScopeProvider.overrideWithValue(scope),
            creditTopUpRepositoryProvider.overrideWithValue(
              _SettledTopUp(outcome),
            ),
          ],
        );
        addTearDown(container.dispose);
        final controller = container.read(creditTopUpProvider.notifier);
        controller.setVisible(Object(), true);
        controller.changeAmount('50000');
        controller.retryQuote();
        await Future<void>.delayed(Duration.zero);
        expect(container.read(creditTopUpProvider).canCreate, true);
        expect(container.exists(loyaltyControllerProvider), false);
        await controller.create(
          shownPayableVnd: 50000,
          isSourceVisible: () => true,
        );
        expect(container.read(creditTopUpProvider).order!.status, outcome);
        expect(container.exists(loyaltyControllerProvider), false);
      },
    );
  }

  testWidgets(
    'account entry is read-only, zero and retry are real, CTA returns to refreshed points',
    (tester) async {
      var reads = 0;
      var fail = true;
      final fixture = loyaltyFixture(
        quote: (request) async {
          reads++;
          if (fail) {
            throw DioException(
              requestOptions: request,
              type: DioExceptionType.connectionError,
            );
          }
          return reply(
            200,
            loyaltyQuote(
              available: reads == 2 ? 0 : 499,
              maximum: 0,
              discount: 0,
            ),
          );
        },
      );
      await openLoyalty(tester, fixture);
      expect(find.text('Chưa tải được điểm. Hãy thử lại.'), findsOneWidget);
      expect(find.byKey(const Key('loyalty-available')), findsNothing);
      fail = false;
      await tapLoyalty(tester, 'loyalty-refresh');
      expect(find.text('0'), findsOneWidget);
      expect(find.text('Bạn chưa có điểm khả dụng.'), findsOneWidget);
      expect(find.text('Lịch sử điểm'), findsNothing);
      expect(find.text('Hết hạn trong 30 ngày'), findsNothing);
      expect(find.text('Điểm đang giữ cho lần nạp'), findsNothing);
      await tapLoyalty(tester, 'redeem-points');
      expect(find.byKey(const Key('top-up-amount')), findsOneWidget);
      await tester.tap(find.byTooltip('Quay lại'));
      await tester.pumpAndSettle();
      expect(find.text('499'), findsOneWidget);
      expect(reads, 3);
      expect(
        fixture.requests.where(
          (r) => r.method != 'GET' && r.path != 'auth/login',
        ),
        isEmpty,
      );
    },
  );

  testWidgets(
    'deep-link Back falls back to profile; background cancels and resumes a fresh read',
    (tester) async {
      final late = Completer<ResponseBody>();
      var reads = 0;
      final fixture = loyaltyFixture(
        quote: (_) async => ++reads == 1
            ? late.future
            : reply(200, loyaltyQuote(available: 125, maximum: 0, discount: 0)),
      );
      await openLoyalty(tester, fixture, direct: true, wait: false);
      expect(find.text('Đang tải điểm…'), findsOneWidget);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      late.complete(reply(200, loyaltyQuote(available: 999)));
      await tester.pump();
      expect(find.text('999'), findsNothing);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(find.text('125'), findsOneWidget);
      expect(reads, 2);
      await tester.tap(find.byTooltip('Quay lại'));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('open-loyalty')), findsOneWidget);
      expect(tester.takeException(), null);
    },
  );

  testWidgets('logout A to B drops an in-flight quote and displays only B', (
    tester,
  ) async {
    final late = Completer<ResponseBody>();
    var principal = '42';
    var reads = 0;
    final fixture = loyaltyFixture(
      principal: () => principal,
      quote: (_) async => ++reads == 1
          ? late.future
          : reply(200, loyaltyQuote(available: 125, maximum: 0, discount: 0)),
    );
    await openLoyalty(tester, fixture, wait: false);
    final container = loyaltyContainer(tester);
    container.read(authControllerProvider.notifier).signOut();
    await tester.pumpAndSettle();
    principal = '43';
    await enterAccount(tester);
    await tapLoyalty(tester, 'nav-account');
    await tapLoyalty(tester, 'open-loyalty');
    late.complete(reply(200, loyaltyQuote(available: 999)));
    await tester.pumpAndSettle();
    expect(find.text('125'), findsOneWidget);
    expect(find.text('999'), findsNothing);
    expect(tester.takeException(), null);
  });

  for (final outcome in ['credited', 'refunded']) {
    testWidgets(
      'ApiApp loyalty survives invalidation and $outcome top-up return',
      (tester) async {
        var available = 6000;
        final now = DateTime.now().toUtc();
        final fixture = loyaltyFixture(
          quote: (_) async => reply(
            200,
            loyaltyQuote(
              available: available,
              maximum: available >= 2500 ? 2500 : 0,
              discount: available >= 2500 ? 25000 : 0,
            ),
          ),
          other: (request) async {
            if (request.path == 'billing/top-ups') {
              expect(request.data, {
                'amount_vnd': 50000,
                'points_to_redeem': 0,
              });
              return reply(409, {
                'error': 'pending_top_up_confirming',
                'top_up_id': '31',
              });
            }
            if (request.path == 'billing/top-ups/31') {
              available = outcome == 'credited' ? 3500 : 6000;
              return reply(200, {
                'top_up_id': '31',
                'status': outcome,
                'amount_vnd': 50000,
                'points_redeemed': 0,
                'points_discount_vnd': 0,
                'amount_paid_vnd': 50000,
                'created_at': now.toIso8601String(),
                'expires_at': now
                    .add(const Duration(minutes: 15))
                    .toIso8601String(),
                'payment_url': null,
              });
            }
            throw StateError('Unexpected fixture path');
          },
        );
        await openLoyalty(tester, fixture);
        expect(find.text('6000'), findsOneWidget);
        final container = loyaltyContainer(tester);
        container.invalidate(loyaltyControllerProvider);
        await tester.pumpAndSettle();
        expect(find.text('6000'), findsOneWidget);
        await tapLoyalty(tester, 'loyalty-refresh');
        await tapLoyalty(tester, 'redeem-points');
        await tester.enterText(find.byKey(const Key('top-up-amount')), '50000');
        await tester.pump(const Duration(milliseconds: 400));
        await tester.pumpAndSettle();
        await tapLoyalty(tester, 'top-up-create');
        await tester.tap(find.byTooltip('Quay lại'));
        await tester.pumpAndSettle();
        expect(find.text('$available'), findsOneWidget);
        available = 1234;
        await tapLoyalty(tester, 'loyalty-refresh');
        expect(find.text('1234'), findsOneWidget);
        expect(tester.takeException(), null);
      },
    );
  }

  for (final language in AppLanguage.values) {
    testWidgets(
      'points help is accessible and scrolls at 200% in ${language.name}',
      (tester) async {
        tester.view.physicalSize = const Size(320, 844);
        tester.view.devicePixelRatio = 1;
        tester.platformDispatcher.textScaleFactorTestValue = 2;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
        final fixture = loyaltyFixture(
          quote: (_) async => reply(200, loyaltyQuote()),
        );
        await openLocalizedLoyalty(tester, fixture, language: language);
        final english = language == AppLanguage.english;
        final label = english
            ? 'How to use PowerMe points'
            : 'Cách sử dụng điểm PowerMe';
        await tapLoyalty(tester, 'points-help');
        expect(find.text(label), findsOneWidget);
        expect(find.byType(BottomSheet), findsOneWidget);
        final semantics = tester.ensureSemantics();
        expect(
          tester.getSemantics(find.text(label)),
          matchesSemantics(isHeader: true),
        );
        semantics.dispose();
        final close = find.byKey(const Key('points-help-close'));
        expect(close.hitTestable(), findsOneWidget);
        expect(tester.getSize(close).height, greaterThanOrEqualTo(48));
        final scroll = find.descendant(
          of: find.byKey(const Key('points-help-content')),
          matching: find.byType(Scrollable),
        );
        await tester.scrollUntilVisible(
          find.descendant(
            of: find.byType(BottomSheet),
            matching: find.textContaining(
              english ? 'Available points include' : 'Điểm khả dụng chỉ gồm',
            ),
          ),
          250,
          scrollable: scroll,
        );
        expect(tester.takeException(), null);
        await tester.tap(close);
        await tester.pumpAndSettle();
        expect(find.byType(BottomSheet), findsNothing);
        final help = find.byKey(const Key('points-help'));
        expect(tester.getSize(help).width, greaterThanOrEqualTo(48));
        expect(find.byTooltip(label), findsOneWidget);
        await tapLoyalty(tester, 'points-help');
        await tester.binding.handlePopRoute();
        await tester.pumpAndSettle();
        expect(find.byType(BottomSheet), findsNothing);
        expect(
          fixture.requests.where(
            (r) => r.method != 'GET' && r.path != 'auth/login',
          ),
          isEmpty,
        );
      },
    );

    testWidgets('loyalty reads and scrolls at 320px/200% in ${language.name}', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(320, 844);
      tester.view.devicePixelRatio = 1;
      tester.platformDispatcher.textScaleFactorTestValue = 2;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      await openLocalizedLoyalty(
        tester,
        loyaltyFixture(
          quote: (_) async =>
              reply(200, loyaltyQuote(available: 9007199254740991)),
        ),
        language: language,
      );
      await tapLoyalty(tester, 'loyalty-refresh');
      await tester.ensureVisible(find.byKey(const Key('redeem-points')));
      await tester.pumpAndSettle();
      expect(
        tester.getSize(find.byKey(const Key('redeem-points'))).height,
        greaterThanOrEqualTo(48),
      );
      expect(tester.takeException(), null);
    });
  }
}

ProviderContainer loyaltyContainer(WidgetTester tester) =>
    ProviderScope.containerOf(tester.element(find.byType(MaterialApp)));

Future<void> openLoyalty(
  WidgetTester tester,
  DriverApiFixture fixture, {
  bool direct = false,
  bool wait = true,
  AppLanguage language = AppLanguage.vietnamese,
  Widget Function(Widget)? wrap,
}) async {
  final app = ApiApp(config: loyaltyApi, httpAdapter: fixture);
  await tester.pumpWidget(wrap?.call(app) ?? app);
  await tester.pumpAndSettle();
  await enterAccount(tester);
  final container = loyaltyContainer(tester);
  await tester.pumpAndSettle();
  if (direct) {
    container.read(routerProvider).go('/loyalty');
  } else {
    await tapLoyalty(tester, 'nav-account');
    await tapLoyalty(tester, 'open-loyalty', settle: wait);
  }
  if (wait) {
    await tester.pumpAndSettle();
  } else {
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  }
}

Future<void> tapLoyalty(
  WidgetTester tester,
  String key, {
  bool settle = true,
}) async {
  final target = find.byKey(Key(key));
  if (target.evaluate().isEmpty) {
    await tester.scrollUntilVisible(
      target,
      180,
      scrollable: find.byType(Scrollable).first,
    );
  }
  await tester.ensureVisible(target);
  await tester.pumpAndSettle();
  await tester.tap(target);
  if (settle) {
    await tester.pumpAndSettle();
  } else {
    await tester.pump(const Duration(milliseconds: 400));
  }
}

class _ControlledLoyalty implements LoyaltyBalanceRepository {
  final pending = <Completer<LoyaltyBalance>>[];
  final cancelled = <int>[];
  @override
  LoyaltyRead read(AuthScope scope) {
    final index = pending.length;
    final completer = Completer<LoyaltyBalance>();
    pending.add(completer);
    return (result: completer.future, cancel: () => cancelled.add(index));
  }

  void complete(int index, AuthScope scope, int points) => pending[index]
      .complete(LoyaltyBalance(scope: scope, availablePoints: points));
}

Future<void> openLocalizedLoyalty(
  WidgetTester tester,
  DriverApiFixture fixture, {
  required AppLanguage language,
  bool wait = true,
  Widget Function(Widget)? wrap,
}) async {
  final session = DriverApiSession(loyaltyApi, adapter: fixture);
  addTearDown(session.dispose);
  final principal = (await tester.runAsync(
    () => session.signIn('test@example.invalid', 'fixture password'),
  ))!;
  final app = ProviderScope(
    overrides: [
      authScopeProvider.overrideWithValue(
        AuthScope(principalId: principal, generation: 1),
      ),
      loyaltyBalanceRepositoryProvider.overrideWithValue(
        ApiLoyaltyRepository(session, probeAmountVnd: minTopUpVnd),
      ),
      profileControllerProvider.overrideWith(() => _LocalizedProfile(language)),
    ],
    child: MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: powerMeTheme(),
      home: const LoyaltyScreen(),
    ),
  );
  await tester.pumpWidget(wrap?.call(app) ?? app);
  if (wait) {
    await tester.pumpAndSettle();
  } else {
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  }
}

class _LocalizedProfile extends ProfileController {
  _LocalizedProfile(this.language);
  final AppLanguage language;
  @override
  ProfileState build() =>
      ProfileState(DriverProfile(displayName: 'Tài xế', language: language));
}

class _SettledTopUp implements CreditTopUpRepository {
  _SettledTopUp(this.outcome);
  final TopUpStatus outcome;
  @override
  TopUpRead<TopUpQuote> quote(AuthScope scope, int amountVnd) => (
    result: Future.value((pointsAvailable: 0, maxPoints: 0, maxDiscountVnd: 0)),
    cancel: () {},
  );
  @override
  Future<TopUpCreate> create(AuthScope scope, TopUpRequest request) async =>
      (id: '31', confirming: false, freshCheckout: false);
  @override
  TopUpRead<CreditTopUp> status(AuthScope scope, String id) {
    final now = DateTime.now();
    return (
      result: Future.value((
        id: id,
        status: outcome,
        amountVnd: 50000,
        points: 0,
        discountVnd: 0,
        amountPaidVnd: 50000,
        createdAt: now,
        expiresAt: now.add(const Duration(minutes: 15)),
        paymentUrl: null,
      )),
      cancel: () {},
    );
  }
}
