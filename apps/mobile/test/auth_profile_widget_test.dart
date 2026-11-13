import 'support/driver_app_test_harness.dart';
import 'package:driver_app/app/powerme_app.dart';
import 'package:driver_app/app/router.dart';
import 'package:driver_app/features/auth/application/auth_controller.dart';
import 'package:driver_app/features/profile/application/profile_controller.dart';
import 'package:driver_app/features/profile/domain/driver_profile.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'test_helpers.dart';

Future<void> tap(WidgetTester tester, Finder target) async {
  if (target.evaluate().isEmpty) {
    await tester.scrollUntilVisible(
      target,
      250,
      scrollable: find.byType(Scrollable).first,
    );
  }
  await Scrollable.ensureVisible(tester.element(target), alignment: 0.5);
  await tester.pumpAndSettle();
  await tester.tap(target);
  await tester.pumpAndSettle();
}

ProviderContainer appContainer(WidgetTester tester) =>
    ProviderScope.containerOf(tester.element(find.byType(PowerMeApp)));
void cleanCopy(WidgetTester tester) {
  final copy = tester
      .widgetList<Text>(find.byType(Text))
      .map((w) => w.data ?? '')
      .join(' ')
      .toLowerCase();
  expect(
    RegExp(r'\b(demo|mock|sample)\b|dữ liệu mẫu|mô phỏng').hasMatch(copy),
    isFalse,
  );
}

void size(WidgetTester tester, {double width = 390, double scale = 1}) {
  tester.view.physicalSize = Size(width, 1000);
  tester.view.devicePixelRatio = 1;
  tester.platformDispatcher.textScaleFactorTestValue = scale;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
}

void main() {
  WidgetController.hitTestWarningShouldBeFatal = true;
  testWidgets(
    'Login validation, private route guard, allowlisted station continuation and logout/back',
    (tester) async {
      size(tester);
      await tester.pumpWidget(const DriverAppTestHarness());
      await tester.pumpAndSettle();
      final container = appContainer(tester);
      final router = container.read(routerProvider);
      router.go(
        '/station/station-powerme-center?return=https://untrusted.example',
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('auth-email')), findsOneWidget);
      expect(find.text('Minh Nguyễn'), findsNothing);
      await tap(tester, find.byKey(const Key('auth-submit')));
      expect(find.text('Nhập email hợp lệ.'), findsOneWidget);
      await tester.enterText(
        find.byKey(const Key('auth-email')),
        'minh@powerme.local',
      );
      await tester.enterText(find.byKey(const Key('auth-password')), 'wrong');
      await tap(tester, find.byKey(const Key('auth-submit')));
      expect(find.text('Email hoặc mật khẩu chưa đúng.'), findsOneWidget);
      await signIn(tester);
      expect(
        router.routeInformationProvider.value.uri.path,
        '/station/station-powerme-center',
      );
      expect(router.routeInformationProvider.value.uri.query, isEmpty);
      expect(find.text('Cổng 01 · CCS2'), findsOneWidget);
      router.go('/profile');
      await tester.pumpAndSettle();
      await tap(tester, find.byKey(const Key('logout')));
      await tap(tester, find.byKey(const Key('confirm-logout')));
      expect(find.byKey(const Key('auth-email')), findsOneWidget);
      expect(find.text('Minh Nguyễn'), findsNothing);
      router.go('/vehicles/vehicle-ioniq5/edit');
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('vehicle-brand')), findsNothing);
      await signIn(tester, email: 'an@powerme.local');
      router.go('/profile');
      await tester.pumpAndSettle();
      expect(find.text('An Trần'), findsOneWidget);
      expect(find.text('Hyundai IONIQ 5'), findsNothing);
      cleanCopy(tester);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'Three-step onboarding consent validation, account, vehicle and register/login round trip',
    (tester) async {
      size(tester);
      await tester.pumpWidget(const DriverAppTestHarness());
      await tester.pumpAndSettle();
      await tap(tester, find.byKey(const Key('auth-register')));
      await tap(tester, find.byKey(const Key('onboarding-next')));
      expect(
        find.text('Cần sự đồng ý của bạn để tạo tài khoản.'),
        findsOneWidget,
      );
      expect(find.text('Bước 1 / 3'), findsOneWidget);
      await tap(tester, find.byKey(const Key('consent')));
      await tap(tester, find.byKey(const Key('onboarding-next')));
      expect(find.text('Bước 2 / 3'), findsOneWidget);
      await tester.enterText(
        find.byKey(const Key('register-name')),
        'Lan Nguyễn',
      );
      await tester.enterText(
        find.byKey(const Key('register-email')),
        'lan@example.test',
      );
      await tester.enterText(
        find.byKey(const Key('register-password')),
        'PowerMe123!',
      );
      final confirmation = find.byKey(const Key('register-confirm-password'));
      await tester.ensureVisible(confirmation);
      await tester.enterText(confirmation, 'PowerMe123!');
      await tap(tester, find.byKey(const Key('onboarding-next')));
      expect(find.text('Bước 3 / 3'), findsOneWidget);
      await tap(tester, find.byKey(const Key('onboarding-next')));
      expect(find.text('Chọn ít nhất một chuẩn cổng.'), findsOneWidget);
      await tester.enterText(find.byKey(const Key('vehicle-brand')), 'BYD');
      await tester.enterText(find.byKey(const Key('vehicle-model')), 'Atto 3');
      await tap(tester, find.byKey(const Key('connector-CCS2')));
      await tap(tester, find.byKey(const Key('onboarding-next')));
      expect(find.text('BYD Atto 3'), findsOneWidget);
      final container = appContainer(tester);
      expect(
        container.read(profileControllerProvider).profile.displayName,
        'Lan Nguyễn',
      );
      container.read(authControllerProvider.notifier).signOut();
      await tester.pumpAndSettle();
      await signIn(tester, email: 'lan@example.test');
      expect(find.text('BYD Atto 3'), findsOneWidget);
      cleanCopy(tester);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'Profile edit and vehicle add/edit/select/remove with empty recovery',
    (tester) async {
      size(tester);
      await tester.pumpWidget(const DriverAppTestHarness());
      await tester.pumpAndSettle();
      await signIn(tester);
      await tap(tester, find.byKey(const Key('nav-account')));
      await tap(tester, find.byKey(const Key('edit-profile')));
      await tester.enterText(
        find.byKey(const Key('profile-name')),
        'Minh Trần',
      );
      await tap(tester, find.byKey(const Key('profile-save')));
      expect(find.text('Minh Trần'), findsOneWidget);
      await tap(tester, find.byKey(const Key('add-vehicle')));
      await tester.enterText(find.byKey(const Key('vehicle-brand')), 'Nissan');
      await tester.enterText(find.byKey(const Key('vehicle-model')), 'Leaf');
      await tap(tester, find.byKey(const Key('connector-CHAdeMO')));
      await tap(tester, find.byKey(const Key('vehicle-save')));
      final container = appContainer(tester);
      final id = container
          .read(profileControllerProvider)
          .profile
          .vehicles
          .last
          .id;
      await tap(tester, find.byKey(Key('select-$id')));
      await tap(tester, find.byKey(const Key('nav-discovery')));
      expect(find.text('Nissan Leaf'), findsOneWidget);
      expect(find.text('PowerMe Nguyễn Huệ'), findsNothing);
      await tap(tester, find.byKey(const Key('nav-account')));
      await tap(tester, find.byKey(Key('edit-$id')));
      await tester.enterText(find.byKey(const Key('vehicle-model')), 'Leaf e+');
      await tap(tester, find.byKey(const Key('vehicle-save')));
      expect(find.text('Nissan Leaf e+'), findsOneWidget);
      for (final vehicleId in [id, 'vehicle-ioniq5']) {
        await tap(tester, find.byKey(Key('remove-$vehicleId')));
        await tap(tester, find.text('Xóa'));
      }
      expect(find.text('Bạn chưa thêm xe nào.'), findsOneWidget);
      await tap(tester, find.byKey(const Key('nav-discovery')));
      expect(find.text('Thêm xe của bạn'), findsOneWidget);
      await tap(tester, find.text('Thêm xe'));
      expect(find.byKey(const Key('vehicle-brand')), findsOneWidget);
      cleanCopy(tester);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('Auth/onboarding/vehicle forms remain usable at 320px and 200%', (
    tester,
  ) async {
    size(tester, width: 320, scale: 2);
    await tester.pumpWidget(const DriverAppTestHarness());
    await tester.pumpAndSettle();
    cleanCopy(tester);
    final semantics = tester.ensureSemantics();
    try {
      expect(find.bySemanticsLabel(RegExp(r'^Email\b')), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp(r'^Mật khẩu')), findsOneWidget);
    } finally {
      semantics.dispose();
    }
    final password = find.byKey(const Key('auth-password'));
    final passwordInput = find.descendant(
      of: password,
      matching: find.byType(TextField),
    );
    final submit = find.byKey(const Key('auth-submit'));
    await tester.showKeyboard(password);
    tester.view.viewInsets = const FakeViewPadding(bottom: 480);
    addTearDown(tester.view.resetViewInsets);
    await tester.pumpAndSettle();
    expect(tester.widget<TextField>(passwordInput).obscureText, isTrue);
    await tap(tester, find.byTooltip('Hiện mật khẩu'));
    expect(find.byTooltip('Ẩn mật khẩu'), findsOneWidget);
    expect(tester.widget<TextField>(passwordInput).obscureText, isFalse);
    await tap(tester, find.byTooltip('Ẩn mật khẩu'));
    expect(tester.widget<TextField>(passwordInput).obscureText, isTrue);
    await tap(tester, submit);
    expect(find.text('Nhập mật khẩu.'), findsOneWidget);
    tester.view.resetViewInsets();
    await tester.pumpAndSettle();
    await tap(tester, find.byKey(const Key('auth-register')));
    await tap(tester, find.byKey(const Key('consent')));
    await tap(tester, find.byKey(const Key('onboarding-next')));
    await tester.ensureVisible(find.byKey(const Key('register-name')));
    await tester.enterText(find.byKey(const Key('register-name')), 'Mai');
    await tester.ensureVisible(find.byKey(const Key('register-email')));
    await tester.enterText(
      find.byKey(const Key('register-email')),
      'mai@example.test',
    );
    await tester.ensureVisible(find.byKey(const Key('register-password')));
    await tester.enterText(
      find.byKey(const Key('register-password')),
      'PowerMe123!',
    );
    final confirmation = find.byKey(const Key('register-confirm-password'));
    await tester.ensureVisible(confirmation);
    await tester.enterText(confirmation, 'PowerMe123!');
    tester.view.viewInsets = const FakeViewPadding(bottom: 480);
    await tester.pumpAndSettle();
    await tap(tester, find.byKey(const Key('onboarding-next')));
    tester.view.resetViewInsets();
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byKey(const Key('vehicle-brand')));
    await tester.enterText(find.byKey(const Key('vehicle-brand')), 'BYD');
    await tester.ensureVisible(find.byKey(const Key('vehicle-model')));
    await tester.enterText(find.byKey(const Key('vehicle-model')), 'Atto 3');
    await tap(tester, find.byKey(const Key('connector-CCS2')));
    await tap(tester, find.byKey(const Key('onboarding-next')));
    final container = appContainer(tester);
    for (final language in AppLanguage.values) {
      container
          .read(profileControllerProvider.notifier)
          .selectLanguage(language);
      container.read(routerProvider).go('/vehicles/new');
      await tester.pumpAndSettle();
      await tap(tester, find.byKey(const Key('vehicle-save')));
      expect(tester.takeException(), isNull);
      cleanCopy(tester);
    }
  });
}
