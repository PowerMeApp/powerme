import 'dart:async';

import 'package:dio/dio.dart';
import 'package:driver_app/app/composition/api_app.dart';
import 'package:driver_app/core/api/api_config.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'driver_api_fixture.dart';

final api = ApiConfig.parse('https://fixture.invalid/api/driver/v1');

Future<void> enterAccount(WidgetTester tester) async {
  for (final field in {
    'auth-email': 'test@example.invalid',
    'auth-password': 'fixture password',
  }.entries) {
    await tester.enterText(find.byKey(Key(field.key)), field.value);
  }
  final submit = find.byKey(const Key('auth-submit'));
  await tester.ensureVisible(submit);
  await tester.tap(submit);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('API login prevents duplicate submissions and shows failures', (
    tester,
  ) async {
    final firstLogin = Completer<ResponseBody>();
    var attempt = 0;
    final fixture = DriverApiFixture((request) async {
      switch (++attempt) {
        case 1:
          return firstLogin.future;
        case 2:
          return reply(429, {'error': 'too_many_attempts'});
        default:
          throw DioException(
            requestOptions: request,
            type: DioExceptionType.connectionError,
          );
      }
    });
    final config = ApiConfig.parse(
      api.baseUrl.toString(),
      consentVersion: 'fixture-v1',
    );
    await tester.binding.setSurfaceSize(const Size(800, 600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(ApiApp(config: config, httpAdapter: fixture));
    await tester.pumpAndSettle();
    final submit = find.byKey(const Key('auth-submit'));
    final register = find.byKey(const Key('auth-register'));
    await tester.enterText(
      find.byKey(const Key('auth-email')),
      ' test@example.invalid ',
    );
    await tester.enterText(
      find.byKey(const Key('auth-password')),
      'fixture password ',
    );
    await tester.ensureVisible(submit);
    expect(tester.getSize(submit).width, 440);
    await tester.tap(submit);
    await tester.tap(submit);
    await tester.pump();
    expect(find.text('Đang đăng nhập…'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(tester.widget<FilledButton>(submit).onPressed, isNull);
    expect(tester.widget<TextButton>(register).onPressed, isNull);
    await tester.pump(const Duration(milliseconds: 50));
    expect(fixture.requests.single.path, 'auth/login');
    expect(fixture.requests.single.data, {
      'email': 'test@example.invalid',
      'password': 'fixture password ',
    });

    firstLogin.complete(reply(401, {'error': 'invalid_credentials'}));
    await tester.pumpAndSettle();
    expect(find.text('Email hoặc mật khẩu chưa đúng.'), findsOneWidget);

    await tester.ensureVisible(submit);
    await tester.tap(submit);
    await tester.pumpAndSettle();
    expect(
      find.text('Bạn đã thử quá nhiều lần. Vui lòng thử lại sau.'),
      findsOneWidget,
    );

    await tester.ensureVisible(submit);
    await tester.tap(submit);
    await tester.pumpAndSettle();
    expect(
      find.text('Không kết nối được PowerMe. Vui lòng thử lại.'),
      findsOneWidget,
    );
    expect(
      fixture.requests.map((request) => request.path),
      List.filled(3, 'auth/login'),
    );
  });

  testWidgets('API account exposes vehicles and blocks unrelated routes', (
    tester,
  ) async {
    var forbidden = false;
    final fixture = DriverApiFixture(
      (request) async => switch (request.path) {
        'auth/login' => reply(200, tokens(accessA)),
        'me' when forbidden => reply(403, {'error': 'forbidden'}),
        'me' => reply(200, account()),
        _ => throw StateError('Unexpected path'),
      },
    );
    await tester.pumpWidget(ApiApp(config: api, httpAdapter: fixture));
    await tester.pumpAndSettle();
    expect(find.text('Đăng ký hiện chưa khả dụng.'), findsOneWidget);
    await enterAccount(tester);
    expect(find.text('Tài xế kiểm thử'), findsOneWidget);
    expect(find.text('VinFast VF 8'), findsOneWidget);
    expect(find.textContaining('51A-00001'), findsOneWidget);
    expect(find.text('Tín dụng sạc'), findsNothing);
    expect(find.byKey(const Key('edit-profile')), findsNothing);
    expect(find.byKey(const Key('add-vehicle')), findsOneWidget);
    expect(find.byKey(const Key('edit-9')), findsNothing);
    expect(find.byType(NavigationBar), findsNothing);
    final router = GoRouter.of(tester.element(find.text('Tài xế kiểm thử')));
    for (final route in [
      '/credit',
      '/station/test',
      '/vehicles/9/edit',
      '/scan',
    ]) {
      router.go(route);
      await tester.pumpAndSettle();
      expect(router.routeInformationProvider.value.uri.path, '/profile');
      expect(find.text('Tài xế kiểm thử'), findsOneWidget);
    }
    expect(fixture.requests, hasLength(2));
    forbidden = true;
    final reload = find.byKey(const Key('refresh-profile'));
    await tester.ensureVisible(reload);
    await tester.tap(reload);
    await tester.pumpAndSettle();
    expect(
      find.text('Tài khoản hiện không có quyền truy cập.'),
      findsOneWidget,
    );
    expect(find.text('Tài xế kiểm thử'), findsNothing);
    expect(fixture.requests, hasLength(3));
  });

  testWidgets('API onboarding validates consent and password confirmation', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(800, 950));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final fixture = DriverApiFixture(
      (request) async => switch (request.path) {
        'auth/register' => reply(201, tokens(accessA)),
        'me' => reply(200, account(withVehicle: false)),
        _ => throw StateError('Unexpected path'),
      },
    );
    final config = ApiConfig.parse(
      api.baseUrl.toString(),
      consentVersion: 'fixture-v1',
    );
    await tester.pumpWidget(ApiApp(config: config, httpAdapter: fixture));
    await tester.pumpAndSettle();
    final register = find.byKey(const Key('auth-register'));
    await tester.ensureVisible(register);
    await tester.tap(register);
    await tester.pumpAndSettle();
    expect(find.text('Bước 1 / 2'), findsOneWidget);
    final next = find.byKey(const Key('onboarding-next'));
    await tester.ensureVisible(next);
    await tester.tap(next);
    await tester.pumpAndSettle();
    expect(
      find.text('Cần sự đồng ý của bạn để tạo tài khoản.'),
      findsOneWidget,
    );
    expect(fixture.requests, isEmpty);
    final consent = find.byKey(const Key('consent'));
    await tester.ensureVisible(consent);
    await tester.tap(consent);
    await tester.pumpAndSettle();
    await tester.ensureVisible(next);
    await tester.tap(next);
    await tester.pumpAndSettle();
    expect(find.text('Bước 2 / 2'), findsOneWidget);
    final email = find.byKey(const Key('register-email'));
    final password = find.byKey(const Key('register-password'));
    final confirmation = find.byKey(const Key('register-confirm-password'));
    await tester.ensureVisible(email);
    await tester.enterText(email, 'test@example.invalid.');
    await tester.ensureVisible(password);
    await tester.enterText(password, List.filled(129, 'a').join());
    await tester.ensureVisible(next);
    await tester.tap(next);
    await tester.pumpAndSettle();
    expect(find.text('Nhập họ và tên.'), findsOneWidget);
    expect(find.text('Nhập email hợp lệ.'), findsOneWidget);
    expect(find.text('Mật khẩu tối đa 128 ký tự.'), findsOneWidget);
    expect(fixture.requests, isEmpty);
    for (final field in {
      'register-name': 'Tài xế kiểm thử',
      'register-email': 'test@example.invalid',
      'register-password': 'fixture password',
    }.entries) {
      final input = find.byKey(Key(field.key));
      await tester.ensureVisible(input);
      await tester.enterText(input, field.value);
    }
    await tester.ensureVisible(next);
    await tester.tap(next);
    await tester.pumpAndSettle();
    expect(find.text('Vui lòng nhập lại mật khẩu.'), findsOneWidget);
    expect(fixture.requests, isEmpty);

    await tester.ensureVisible(confirmation);
    await tester.enterText(confirmation, 'fixture password');
    await tester.ensureVisible(password);
    await tester.enterText(password, 'fixture password ');
    await tester.ensureVisible(next);
    await tester.tap(next);
    await tester.pumpAndSettle();
    expect(find.text('Mật khẩu nhập lại không khớp.'), findsOneWidget);
    expect(fixture.requests, isEmpty);

    await tester.ensureVisible(confirmation);
    await tester.enterText(confirmation, 'fixture password ');
    await tester.ensureVisible(next);
    await tester.tap(next);
    await tester.tap(next);
    await tester.pumpAndSettle();
    expect(fixture.requests.map((request) => request.path), [
      'auth/register',
      'me',
    ]);
    expect(fixture.requests.first.data, {
      'email': 'test@example.invalid',
      'password': 'fixture password ',
      'full_name': 'Tài xế kiểm thử',
      'consent': true,
      'consent_version': 'fixture-v1',
    });
    expect(find.text('Chưa có xe trong hồ sơ.'), findsOneWidget);
    expect(find.text('Tài xế kiểm thử'), findsOneWidget);
  });
}
