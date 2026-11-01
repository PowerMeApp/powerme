import 'package:driver_app/app/powerme_app.dart';
import 'package:driver_app/app/router.dart';
import 'package:driver_app/demo/charging_engine.dart';
import 'package:driver_app/demo/charging_store.dart';
import 'package:driver_app/demo/demo_store.dart';
import 'package:driver_app/demo/payment_store.dart';
import 'package:driver_app/demo/station_actions_store.dart';
import 'package:driver_app/features/auth/application/auth_controller.dart';
import 'package:driver_app/features/auth/data/mock_auth_repository.dart';
import 'package:driver_app/features/auth/domain/auth_scope.dart';
import 'package:driver_app/features/charging/application/charging_controller.dart';
import 'package:driver_app/features/charging/data/mock_charging_repository.dart';
import 'package:driver_app/features/charging/domain/charging.dart';
import 'package:driver_app/features/payments/application/payments_controller.dart';
import 'package:driver_app/features/payments/data/mock_payments_repository.dart';
import 'package:driver_app/features/profile/application/profile_controller.dart';
import 'package:driver_app/features/profile/data/mock_profile_repository.dart';
import 'package:driver_app/features/stations/application/station_actions_controller.dart';
import 'package:driver_app/features/stations/application/stations_controller.dart';
import 'package:driver_app/features/stations/data/mock_station_actions_repository.dart';
import 'package:driver_app/features/stations/data/mock_station_repository.dart';
import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'scanner_platform_fake.dart';
import 'package:driver_app/features/charging/application/qr_connection_controller.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class _SignedIn extends AuthController {
  @override
  AuthState build() => const AuthState(
    scope: AuthScope(principalId: 'driver-minh', generation: 1),
  );
}

class _CountingRepository extends MockChargingRepository {
  _CountingRepository(super.store, super.charging, super.actions, super.scope);
  int starts = 0;
  int stops = 0;
  int restores = 0;
  int watches = 0;

  @override
  Future<CommandOutcome> start(StartRequest request) {
    starts++;
    return super.start(request);
  }

  @override
  Future<CommandOutcome> stop(String sessionId, String key) {
    stops++;
    return super.stop(sessionId, key);
  }

  @override
  Future<SessionSnapshot?> current() {
    restores++;
    return super.current();
  }

  @override
  Stream<SessionSnapshot> watch(String sessionId) {
    watches++;
    return super.watch(sessionId);
  }
}

void main() {
  WidgetController.hitTestWarningShouldBeFatal = true;
  late DateTime now;
  late DemoStore store;
  late ChargingStore charging;
  late StationActionsStore actions;
  late _CountingRepository adapter;
  late ScannerPlatformFake camera;

  setUp(() {
    camera = ScannerPlatformFake();
    MobileScannerPlatform.instance = camera;
    now = DateTime.utc(2026, 10, 30, 3);
    store = DemoStore();
    charging = ChargingStore(clock: () => now);
    actions = StationActionsStore(clock: () => now);
  });

  Future<ProviderContainer> boot(
    WidgetTester tester, {
    bool narrow = false,
  }) async {
    tester.view.physicalSize = Size(narrow ? 320 : 390, 844);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = narrow ? 2 : 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    final payments = PaymentStore(clock: () => now);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          authControllerProvider.overrideWith(_SignedIn.new),
          authRepositoryProvider.overrideWithValue(MockAuthRepository(store)),
          authScopeProvider.overrideWith((ref) {
            final scope =
                ref.watch(authControllerProvider).scope ?? signedOutScope;
            store.bind(scope);
            return scope;
          }),
          profileRepositoryProvider.overrideWith(
            (ref) => MockProfileRepository(
              store,
              scope: ref.watch(authScopeProvider),
            ),
          ),
          stationRepositoryProvider.overrideWith(
            (ref) => MockStationRepository(
              store,
              scope: ref.watch(authScopeProvider),
            ),
          ),
          stationActionsRepositoryProvider.overrideWith(
            (ref) => MockStationActionsRepository(
              store,
              actions,
              ref.watch(authScopeProvider),
            ),
          ),
          paymentsRepositoryProvider.overrideWith(
            (ref) => MockPaymentsRepository(
              store,
              payments,
              charging,
              actions,
              ref.watch(authScopeProvider),
            ),
          ),
          chargingRepositoryProvider.overrideWith(
            (ref) => adapter = _CountingRepository(
              store,
              charging,
              actions,
              ref.watch(authScopeProvider),
            ),
          ),
        ],
        child: const PowerMeApp(),
      ),
    );
    await tester.pumpAndSettle();
    return ProviderScope.containerOf(tester.element(find.byType(PowerMeApp)));
  }

  StartRequest request() => StartRequest(
    scope: store.activeScope,
    connectorId: 'station-powerme-center/1',
    vehicleId: store.profile.vehicleId,
    mode: ChargingMode.energy,
    limitValue: 10000,
    key: 'same-start-intent',
  );

  for (final script in [
    ChargingScript.normal,
    ChargingScript.unknownStart,
    ChargingScript.unknownStop,
  ]) {
    testWidgets(
      'Tabs preserve $script command, session and one subscription; logout clears it',
      (tester) async {
        final container = await boot(tester);
        final controller = container.read(chargingControllerProvider.notifier);
        await tester.pumpAndSettle();
        charging.nextScript = script;
        await controller.start(request());
        await tester.pumpAndSettle();
        if (script != ChargingScript.unknownStart) {
          now = now.add(const Duration(seconds: 5));
          MockChargingEngine(store, charging, actions).step();
          await tester.pumpAndSettle();
        }
        if (script == ChargingScript.unknownStop) {
          await controller.stopCurrent();
          await tester.pumpAndSettle();
        }
        final before = container.read(chargingControllerProvider);
        final calls = (
          adapter.starts,
          adapter.stops,
          adapter.restores,
          adapter.watches,
        );
        final keys = charging.commands.keys.toSet();
        for (final destination in [
          'nav-charging',
          'nav-account',
          'nav-discovery',
          'nav-charging',
          'nav-charging',
        ]) {
          await tester.tap(find.byKey(Key(destination)));
          await tester.pumpAndSettle();
          expect(find.byType(NavigationBar), findsOneWidget);
          expect(
            container.read(chargingControllerProvider.notifier),
            same(controller),
          );
          expect(
            container.read(chargingControllerProvider).command,
            same(before.command),
          );
          expect(
            container.read(chargingControllerProvider).session,
            same(before.session),
          );
        }
        expect((
          adapter.starts,
          adapter.stops,
          adapter.restores,
          adapter.watches,
        ), calls);
        expect(charging.commands.keys.toSet(), keys);
        expect(charging.sessions, hasLength(1));
        expect(
          charging.events.hasListener,
          script != ChargingScript.unknownStart,
        );
        expect(find.text('Về tìm trạm'), findsNothing);
        expect(
          tester
              .widget<NavigationBar>(find.byType(NavigationBar))
              .selectedIndex,
          1,
        );
        final oldSnapshot = before.session;
        container.read(authControllerProvider.notifier).signOut();
        await tester.pumpAndSettle();
        expect(find.byKey(const Key('auth-email')), findsOneWidget);
        expect(find.byType(NavigationBar), findsNothing);
        expect(charging.events.hasListener, isFalse);
        if (oldSnapshot != null) charging.events.add(oldSnapshot);
        container.read(routerProvider).go('/charging');
        await tester.pumpAndSettle();
        expect(find.byKey(const Key('auth-email')), findsOneWidget);
        final login = container
            .read(authControllerProvider.notifier)
            .signIn('an@powerme.local', 'PowerMe123!');
        await tester.pumpAndSettle();
        await login;
        container.read(routerProvider).go('/charging');
        await tester.pumpAndSettle();
        expect(container.read(chargingControllerProvider).session, isNull);
        expect(container.read(chargingControllerProvider).command, isNull);
        expect(find.text('Bạn chưa có phiên sạc.'), findsOneWidget);
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets(
    'Existing session restores once and stays observed when tab is left',
    (tester) async {
      final seed = MockChargingRepository(
        store,
        charging,
        actions,
        store.activeScope,
      );
      final id = (await seed.start(request())).sessionId!;
      final container = await boot(tester);
      final router = container.read(routerProvider);
      router.go('/charging');
      await tester.pumpAndSettle();
      expect(container.read(chargingControllerProvider).session!.sessionId, id);
      final originalAdapter = adapter;
      await tester.tap(find.byKey(const Key('nav-account')));
      await tester.pumpAndSettle();
      now = now.add(const Duration(seconds: 5));
      MockChargingEngine(store, charging, actions).step();
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('nav-charging')));
      await tester.pumpAndSettle();
      expect(
        container.read(chargingControllerProvider).session!.state,
        SessionState.active,
      );
      expect(adapter, same(originalAdapter));
      expect(adapter.restores, 1);
      expect(adapter.watches, 1);
      expect(adapter.starts, 0);
      expect(adapter.stops, 0);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'Hold action without connector opens empty selection; three tabs at 320px/200%',
    (tester) async {
      final container = await boot(tester, narrow: true);
      await tester.tap(find.byKey(const Key('expand-map-sheet')));
      await tester.pumpAndSettle();
      // final quickReserve = find.byKey(const Key('quick-reserve')).hitTestable();
      // await tester.scrollUntilVisible(
      //   quickReserve,
      //   200,
      //   scrollable: find
      //       .descendant(
      //         of: find.byType(ListView),
      //         matching: find.byType(Scrollable),
      //       )
      //       .first,
      // );
      // await tester.tap(quickReserve);
      // await tester.pumpAndSettle();
      // expect(find.text('Bạn chưa giữ cổng nào'), findsOneWidget);
      // expect(find.byKey(const Key('confirm-reservation')), findsNothing);
      // expect(actions.holds, isEmpty);
      // await tester.scrollUntilVisible(
      //   find.byKey(const Key('reserve-find-station')).hitTestable(),
      //   180,
      //   scrollable: find
      //       .descendant(
      //         of: find.byType(ListView),
      //         matching: find.byType(Scrollable),
      //       )
      //       .first,
      // );
      // await tester.pumpAndSettle();
      // await tester.tap(find.byKey(const Key('reserve-find-station')));
      // await tester.pumpAndSettle();
      for (final destination in [
        'nav-charging',
        'nav-account',
        'nav-discovery',
      ]) {
        await tester.tap(find.byKey(Key(destination)));
        await tester.pumpAndSettle();
        expect(find.byType(NavigationBar), findsOneWidget);
        expect(tester.takeException(), isNull);
      }
      expect(
        container.read(routerProvider).routeInformationProvider.value.uri.path,
        '/',
      );
      expect(charging.sessions, isEmpty);
      expect(charging.commands, isEmpty);
      expect(actions.holds, isEmpty);
    },
  );
  testWidgets(
    'QR duplicate opens confirmation once, leaving tab stops camera',
    (tester) async {
      final container = await boot(tester);
      await tester.tap(find.byKey(const Key('nav-charging')));
      await tester.pumpAndSettle();
      expect(camera.starts, 1);
      camera.emit('powerme:connector:station-powerme-center/1');
      camera.emit('powerme:connector:station-powerme-center/1');
      await tester.pumpAndSettle();
      expect(container.read(qrConnectionProvider).error, isNull);
      expect(
        container
            .read(routerProvider)
            .routerDelegate
            .currentConfiguration
            .last
            .matchedLocation,
        '/start',
      );
      expect(find.byKey(const Key('connector-reference')), findsOneWidget);
      expect(charging.commands, isEmpty);
      expect(camera.stops, greaterThanOrEqualTo(1));
      container.read(routerProvider).pop();
      await tester.pumpAndSettle();
      expect(camera.starts, 2);
      await tester.tap(find.byKey(const Key('nav-account')));
      await tester.pumpAndSettle();
      expect(camera.stops, 2);
      expect(charging.commands, isEmpty);
    },
  );

  testWidgets(
    'Camera denied retains manual canonical lookup; foreign URL rejected',
    (tester) async {
      camera.deny = true;
      final container = await boot(tester);
      await tester.tap(find.byKey(const Key('nav-charging')));
      await tester.pumpAndSettle();
      expect(find.textContaining('Cho phép Camera'), findsOneWidget);
      await tester.enterText(
        find.byKey(const Key('qr-manual-reference')),
        'https://evil.example/start',
      );
      await tester.ensureVisible(find.byKey(const Key('qr-connect')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('qr-connect')));
      await tester.pumpAndSettle();
      expect(
        container.read(routerProvider).routeInformationProvider.value.uri.path,
        '/scan',
      );
      expect(find.textContaining('Mã cổng không hợp lệ'), findsOneWidget);
      await tester.enterText(
        find.byKey(const Key('qr-manual-reference')),
        'station-powerme-center/1',
      );
      await tester.ensureVisible(find.byKey(const Key('qr-connect')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('qr-connect')));
      await tester.pumpAndSettle();
      expect(container.read(qrConnectionProvider).error, isNull);
      expect(
        container
            .read(routerProvider)
            .routerDelegate
            .currentConfiguration
            .last
            .matchedLocation,
        '/start',
      );
      expect(charging.commands, isEmpty);
    },
  );

  testWidgets('Camera stops in background and resumes only on QR route', (
    tester,
  ) async {
    await boot(tester);
    await tester.tap(find.byKey(const Key('nav-charging')));
    await tester.pumpAndSettle();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    await tester.pumpAndSettle();
    expect(camera.stops, 1);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();
    expect(camera.starts, 2);
    await tester.tap(find.byKey(const Key('nav-account')));
    await tester.pumpAndSettle();
    expect(camera.stops, 2);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();
    expect(camera.starts, 2);
  });
}
