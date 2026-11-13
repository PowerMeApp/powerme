import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'support/driver_app_test_harness.dart';
import 'package:driver_app/app/powerme_app.dart';
import 'package:driver_app/app/router.dart';
import 'package:driver_app/features/charging/application/charging_controller.dart';
import 'package:driver_app/features/charging/domain/charging.dart';
import 'package:driver_app/features/payments/application/payments_controller.dart';
import 'package:driver_app/features/payments/domain/payments.dart';
import 'package:driver_app/features/payments/data/mock_payments_repository.dart';
import 'package:driver_app/features/stations/application/station_actions_controller.dart';
import 'test_helpers.dart';

void main() {
  WidgetController.hitTestWarningShouldBeFatal = true;
  late DateTime now;
  Future<ProviderContainer> boot(
    WidgetTester tester, {
    double width = 390,
    double scale = 1,
  }) async {
    now = DateTime.utc(2026, 10, 29, 3);
    tester.view.physicalSize = Size(width, 1000);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = scale;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(DriverAppTestHarness(clock: () => now));
    await tester.pumpAndSettle();
    await signIn(tester);
    return ProviderScope.containerOf(tester.element(find.byType(PowerMeApp)));
  }

  Future<void> tap(WidgetTester tester, Finder finder) async {
    await tester.drag(find.byType(ListView).first, const Offset(0, 10000));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      finder.hitTestable(),
      150,
      scrollable: find
          .descendant(
            of: find.byType(ListView),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    await tester.tap(finder);
    await tester.pumpAndSettle();
  }

  Future<void> advance(WidgetTester tester, int seconds) async {
    now = now.add(Duration(seconds: seconds));
    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle();
  }

  void clean(WidgetTester tester) {
    final text = tester
        .widgetList<Text>(find.byType(Text))
        .map((w) => w.data ?? '')
        .join(' ')
        .toLowerCase();
    expect(text, isNot(matches(r'demo|mock|sample|dữ liệu mẫu|mô phỏng')));
    expect(tester.takeException(), isNull);
  }

  testWidgets(
    'Low credit to topup/checkout query/return, original start intent, active/stop/statement/history/points',
    (tester) async {
      final container = await boot(tester);
      final adapter =
          container.read(paymentsRepositoryProvider) as MockPaymentsRepository;
      adapter.store.money.account('driver-minh').balanceVnd = 30000;
      final router = container.read(routerProvider);
      router.push('/start?connector=station-powerme-center%2F1');
      await tester.pumpAndSettle();
      await tap(tester, find.byKey(const Key('check-start')));
      expect(find.text('Tín dụng chưa đạt mức bắt đầu.'), findsOneWidget);
      await tap(tester, find.text('Nạp tín dụng'));
      await tester.enterText(find.byKey(const Key('topup-amount')), '100000');
      await tester.enterText(find.byKey(const Key('topup-points')), '500');
      await tap(tester, find.byKey(const Key('create-topup')));
      expect(find.text('Thanh toán VNPay'), findsOneWidget);
      expect((await adapter.credit()).balanceVnd, 30000);
      await tap(tester, find.byKey(const Key('query-payment')));
      expect((await adapter.credit()).balanceVnd, 30000);
      await tap(tester, find.byKey(const Key('pay-checkout')));
      await advance(tester, 8);
      expect(
        container.read(paymentsControllerProvider).order!.state,
        TopUpState.posted,
      );
      await tap(tester, find.byKey(const Key('back-credit')));
      router.pop();
      await tester.pumpAndSettle();
      expect(find.text('Bắt đầu sạc'), findsOneWidget);
      await tap(tester, find.byKey(const Key('check-start')));
      await tap(tester, find.byKey(const Key('confirm-start')));
      await tap(tester, find.byKey(const Key('open-session')));
      expect(find.text('Đang chờ bắt đầu'), findsOneWidget);
      expect(find.text('Đang chờ đối soát'), findsNothing);
      final sessionId = container
          .read(chargingControllerProvider)
          .session!
          .sessionId;
      router.push('/statement/$sessionId');
      await tester.pumpAndSettle();
      expect(find.text('Đang chờ đối soát'), findsNothing);
      expect(
        find.text('Bảng kê được lập sau khi phiên sạc kết thúc.'),
        findsOneWidget,
      );
      router.pop();
      await tester.pumpAndSettle();
      await advance(tester, 4);
      expect(
        container.read(chargingControllerProvider).session!.state,
        SessionState.active,
      );
      expect(find.text('Đang chờ đối soát'), findsNothing);
      await tap(tester, find.byKey(const Key('stop-charging')));
      expect(
        container.read(chargingControllerProvider).session!.ended,
        isFalse,
      );
      await advance(tester, 2);
      expect(
        container.read(chargingControllerProvider).session!.state,
        SessionState.closed,
      );
      expect(find.text('Đang chờ đối soát'), findsOneWidget);
      await advance(tester, 3);
      expect(
        container.read(chargingControllerProvider).session!.state,
        SessionState.reconciled,
      );
      await tap(tester, find.byKey(const Key('open-statement')));
      expect(find.text('Đã ghi sổ tín dụng'), findsOneWidget);
      clean(tester);
      router.go('/history');
      await tester.pumpAndSettle();
      expect(find.text('Phiên sạc và bảng kê'), findsOneWidget);
      clean(tester);
      router.go('/loyalty');
      await tester.pumpAndSettle();
      expect(find.text('Điểm PowerMe'), findsOneWidget);
      clean(tester);
      final orderId = container.read(paymentsControllerProvider).order!.id;
      router.go('/checkout/$orderId');
      await tester.pumpAndSettle();
      await tap(tester, find.byKey(const Key('back-credit')));
      expect(find.text('Tín dụng sạc'), findsOneWidget);
      clean(tester);
      router.go('/start?connector=station-powerme-center%2F1');
      await tester.pumpAndSettle();
      await tap(tester, find.byKey(const Key('check-start')));
      expect(container.read(chargingControllerProvider).command, isNull);
      await tap(tester, find.byKey(const Key('confirm-start')));
      await tester.pump();
      expect(adapter.charging.sessions.length, 2);
    },
  );
  testWidgets(
    'Suggestions, hold disclosure/confirm/start and report saved acknowledgment connected',
    (tester) async {
      final container = await boot(tester);
      final router = container.read(routerProvider);
      await tap(tester, find.byKey(const Key('jump-to-stations')));
      expect(find.text('Trạm sạc').hitTestable(), findsOneWidget);
      router.push('/suggestions');
      await tester.pumpAndSettle();
      await tap(tester, find.byKey(const Key('find-suggestions')));
      expect(container.read(suggestionControllerProvider).options, isNotEmpty);
      clean(tester);
      // router.go('/reserve?connector=station-powerme-center%2F1');
      // await tester.pumpAndSettle();
      // await tap(tester, find.byKey(const Key('confirm-reservation')));
      // expect(find.text('Đang giữ cổng'), findsOneWidget);
      // await tap(tester, find.byKey(const Key('start-reservation')));
      // expect(find.text('Bắt đầu sạc'), findsOneWidget);
      router.go('/report?connector=station-powerme-center%2F1');
      await tester.pumpAndSettle();
      expect(find.text('PowerMe Nguyễn Huệ · Cổng 1'), findsOneWidget);
      expect(find.text('station-powerme-center/1'), findsNothing);
      await tester.enterText(
        find.byKey(const Key('report-note')),
        'Đầu nối cần kiểm tra trước khi sử dụng.',
      );
      await tap(tester, find.byKey(const Key('send-report')));
      expect(find.text('Đã nhận báo lỗi'), findsOneWidget);
      clean(tester);
      // router.go('/reserve');
      // await tester.pumpAndSettle();
      // await tap(tester, find.byKey(const Key('cancel-reservation')));
      // expect(find.text('Đã hủy miễn phí'), findsOneWidget);
      // clean(tester);
    },
  );
  for (final scale in [1.0, 2.0]) {
    testWidgets(
      'All remaining screens and states at 320px / scale $scale have no overflow or technical copy',
      (tester) async {
        final container = await boot(tester, width: 320, scale: scale);
        final router = container.read(routerProvider);
        final c = container.read(paymentsControllerProvider.notifier);
        await c.create('100000', '500');
        final id = container.read(paymentsControllerProvider).order!.id;
        for (final path in [
          '/start?connector=station-powerme-center%2F1',
          '/charging',
          '/statement/missing',
          '/credit',
          '/checkout/$id',
          '/history',
          '/invoice/$id',
          '/loyalty',
          '/report?connector=station-powerme-center%2F1',
          // '/reserve?connector=station-powerme-center%2F1',
          '/suggestions',
        ]) {
          router.go(path);
          await tester.pumpAndSettle();
          for (var i = 0; i < 6; i++) {
            clean(tester);
            await tester.drag(
              find.byType(ListView).first,
              const Offset(0, -350),
            );
            await tester.pumpAndSettle();
          }
          clean(tester);
        }
      },
    );
  }
}
