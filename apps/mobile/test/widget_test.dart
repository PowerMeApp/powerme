import 'support/driver_app_test_harness.dart';
import 'package:driver_app/app/powerme_app.dart';
import 'package:driver_app/app/router.dart';
import 'package:driver_app/demo/demo_store.dart';
import 'package:driver_app/features/auth/domain/auth_scope.dart';
import 'package:driver_app/features/auth/application/auth_controller.dart';
import 'test_helpers.dart';
import 'package:driver_app/demo/charging_store.dart';
import 'package:driver_app/demo/payment_store.dart';
import 'package:driver_app/demo/station_actions_store.dart';
import 'package:driver_app/features/payments/application/payments_controller.dart';
import 'package:driver_app/features/payments/data/mock_payments_repository.dart';
import 'package:driver_app/features/profile/application/profile_controller.dart';
import 'package:driver_app/features/profile/data/mock_profile_repository.dart';
import 'package:driver_app/features/profile/domain/driver_profile.dart';
import 'package:driver_app/features/stations/application/stations_controller.dart';
import 'package:driver_app/features/stations/data/mock_station_repository.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  WidgetController.hitTestWarningShouldBeFatal = true;
  void viewport(WidgetTester tester, {double width = 390, double scale = 1}) {
    tester.view.physicalSize = Size(width, 1000);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = scale;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  }

  void cleanCopy(WidgetTester tester) {
    final visible = tester
        .widgetList<Text>(find.byType(Text))
        .map((w) => w.data ?? '')
        .join(' ')
        .toLowerCase();
    for (final banned in [
      'demo',
      'mock',
      'sample',
      'dữ liệu mẫu',
      'mô phỏng',
    ]) {
      expect(visible, isNot(contains(banned)));
    }
  }

  testWidgets(
    'Discovery search/filter/empty reset/detail and account language navigation',
    (tester) async {
      viewport(tester);
      await tester.pumpWidget(const DriverAppTestHarness());
      await tester.pumpAndSettle();
      await signIn(tester);
      expect(find.bySemanticsLabel('PowerMe'), findsOneWidget);
      cleanCopy(tester);
      await tester.enterText(
        find.byKey(const Key('station-search')),
        'nguyen hue',
      );
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.byKey(const Key('station-powerme-center')).hitTestable(),
        200,
        scrollable: find
            .descendant(
              of: find.byType(ListView),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      expect(
        find.descendant(
          of: find.byKey(const Key('station-powerme-center')),
          matching: find.text('PowerMe Nguyễn Huệ'),
        ),
        findsOneWidget,
      );
      expect(find.text('PowerMe Landmark 81'), findsNothing);
      await tester.drag(
        find.byKey(const Key('expand-map-sheet')),
        const Offset(0, 500),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('station-filters')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('filter-available')));
      await tester.tap(find.text('Xong'));
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.byKey(const Key('station-powerme-center')).hitTestable(),
        200,
        scrollable: find
            .descendant(
              of: find.byType(ListView),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.tap(find.byKey(const Key('station-powerme-center')));
      await tester.pumpAndSettle();
      expect(find.text('Cổng 01 · CCS2'), findsOneWidget);
      expect(find.text('Đang sử dụng'), findsOneWidget);
      cleanCopy(tester);
      await tester.tap(find.byTooltip('Quay lại'));
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.byKey(const Key('station-search')).hitTestable(),
        -300,
        scrollable: find
            .descendant(
              of: find.byType(ListView),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.enterText(find.byKey(const Key('station-search')), 'zzz');
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.text('Không có trạm phù hợp').hitTestable(),
        200,
        scrollable: find
            .descendant(
              of: find.byType(ListView),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      expect(find.text('Không có trạm phù hợp'), findsOneWidget);
      await tester.ensureVisible(find.text('Xóa bộ lọc'));
      await tester.tap(find.text('Xóa bộ lọc'));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('pin-station-powerme-center')),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const Key('nav-account')));
      await tester.pumpAndSettle();
      expect(find.text('Minh Nguyễn'), findsOneWidget);
      cleanCopy(tester);
      await tester.scrollUntilVisible(
        find.byKey(const Key('language-english')).hitTestable(),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.byKey(const Key('language-english')));
      await tester.pumpAndSettle();
      expect(find.text('Language'), findsOneWidget);
      await tester.tap(find.byKey(const Key('nav-discovery')));
      await tester.pumpAndSettle();
      expect(find.text('Find your next charge'), findsOneWidget);
      cleanCopy(tester);
      expect(tester.takeException(), isNull);
    },
  );
  for (final language in AppLanguage.values) {
    testWidgets(
      'Injected profile, detail recovery and 320px/200% ${language.name}',
      (tester) async {
        viewport(tester, width: 320, scale: 2);
        final store = DemoStore(
          profile: DriverProfile(
            displayName: 'An Trần',
            vehicles: [
              Vehicle(
                id: 'vehicle-ioniq5',
                brand: 'Hyundai',
                model: 'IONIQ 5',
                connectors: ['CCS2', 'Type 2'],
              ),
            ],
            selectedVehicleId: 'vehicle-ioniq5',
            language: language,
          ),
        );
        final container = ProviderContainer.test(
          overrides: [
            paymentsRepositoryProvider.overrideWithValue(
              MockPaymentsRepository(
                store,
                PaymentStore(),
                ChargingStore(),
                StationActionsStore(),
                store.activeScope,
              ),
            ),
            authControllerProvider.overrideWith(TestSignedIn.new),
            localScopeProvider.overrideWithValue(
              const AuthScope(principalId: 'test-driver', generation: 1),
            ),
            profileRepositoryProvider.overrideWithValue(
              MockProfileRepository(store),
            ),
            stationRepositoryProvider.overrideWithValue(
              MockStationRepository(store),
            ),
          ],
        );
        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: container,
            child: const PowerMeApp(),
          ),
        );
        await tester.pumpAndSettle();
        final station = find.byKey(const Key('station-powerme-center'));
        await tester.scrollUntilVisible(
          station.hitTestable(),
          250,
          scrollable: find
              .descendant(
                of: find.byType(ListView),
                matching: find.byType(Scrollable),
              )
              .first,
        );
        await tester.tap(station);
        await tester.pumpAndSettle();
        await tester.drag(find.byType(ListView), const Offset(0, -500));
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        cleanCopy(tester);
        container.read(routerProvider).go('/profile');
        await tester.pumpAndSettle();
        expect(find.text('An Trần'), findsOneWidget);
        final english = find.byKey(const Key('language-english'));
        await tester.scrollUntilVisible(
          english.hitTestable(),
          200,
          scrollable: find
              .descendant(
                of: find.byType(ListView),
                matching: find.byType(Scrollable),
              )
              .first,
        );
        await tester.tap(english);
        await tester.pumpAndSettle();
        expect(store.profile.language, AppLanguage.english);
        expect(tester.takeException(), isNull);
        container.read(routerProvider).go('/station/missing');
        await tester.pumpAndSettle();
        expect(find.text('Station not found'), findsOneWidget);
        await tester.tap(find.text('Discover'));
        await tester.pumpAndSettle();
        await tester.drag(find.byType(ListView), const Offset(0, 10000));
        await tester.pumpAndSettle();
        await tester.scrollUntilVisible(
          find.byKey(const Key('station-search')).hitTestable(),
          200,
          scrollable: find
              .descendant(
                of: find.byType(ListView),
                matching: find.byType(Scrollable),
              )
              .first,
        );
        expect(find.byKey(const Key('station-search')), findsOneWidget);
        expect(tester.takeException(), isNull);
      },
    );
  }
}
