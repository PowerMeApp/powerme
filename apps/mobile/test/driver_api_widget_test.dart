import 'dart:async';

import 'package:dio/dio.dart';
import 'package:driver_app/app/composition/api_app.dart';
import 'package:driver_app/core/api/api_config.dart';
import 'package:driver_app/features/profile/application/profile_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'driver_api_fixture.dart';
import 'driver_discovery_fixture.dart';
import 'scanner_platform_fake.dart';

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
        'stations' => reply(200, page([])),
        _ => throw StateError('Unexpected path'),
      },
    );
    await tester.pumpWidget(ApiApp(config: api, httpAdapter: fixture));
    await tester.pumpAndSettle();
    expect(find.text('Đăng ký hiện chưa khả dụng.'), findsOneWidget);
    await enterAccount(tester);
    final bar = find.byType(NavigationBar);
    final navigation = tester.widget<NavigationBar>(bar);
    expect(navigation.selectedIndex, 0);
    expect(
      navigation.destinations.cast<NavigationDestination>().map((d) => d.label),
      ['Khám phá', 'Quét QR', 'Tài khoản'],
    );
    final router = GoRouter.of(tester.element(bar));
    expect(router.routeInformationProvider.value.uri.path, '/discover');
    await tester.tap(find.byKey(const Key('nav-account')));
    await tester.pumpAndSettle();
    expect(find.text('Tài xế kiểm thử'), findsOneWidget);
    expect(find.text('VinFast VF 8'), findsOneWidget);
    expect(find.textContaining('51A-00001'), findsOneWidget);
    expect(find.text('Tín dụng sạc'), findsOneWidget);
    expect(find.byKey(const Key('edit-profile')), findsNothing);
    expect(find.byKey(const Key('add-vehicle')), findsOneWidget);
    expect(find.byKey(const Key('edit-9')), findsNothing);
    expect(tester.widget<NavigationBar>(bar).selectedIndex, 2);
    for (final route in [
      '/station/test',
      '/vehicles/9/edit',
      '/start?connector=21',
    ]) {
      router.go(route);
      await tester.pumpAndSettle();
      expect(router.routeInformationProvider.value.uri.path, '/discover');
    }
    expect(fixture.requests.where((r) => r.path == 'me'), hasLength(1));
    forbidden = true;
    await tester.tap(find.byKey(const Key('nav-account')));
    await tester.pumpAndSettle();
    final reload = find.byKey(const Key('refresh-profile'));
    await tester.ensureVisible(reload);
    await tester.pump();
    await tester.tap(reload);
    await tester.pumpAndSettle();
    expect(
      find.text('Tài khoản hiện không có quyền truy cập.'),
      findsOneWidget,
    );
    expect(find.text('Tài xế kiểm thử'), findsNothing);
    expect(fixture.requests.where((r) => r.path == 'me'), hasLength(2));
  });

  testWidgets(
    'QR resolves labels with the selected vehicle after camera denial',
    (tester) async {
      final camera = ScannerPlatformFake()..deny = true;
      final previous = MobileScannerPlatform.instance;
      MobileScannerPlatform.instance = camera;
      addTearDown(() => MobileScannerPlatform.instance = previous);
      var attempt = 0;
      final fixture = DriverApiFixture(
        (r) async => switch ((r.method, r.path)) {
          ('POST', 'auth/login') => reply(200, tokens(accessA)),
          ('GET', 'me') => reply(
            200,
            account(
              vehicles: [
                ownVehicle(isDefault: false),
                ownVehicle(id: '10'),
              ],
            ),
          ),
          ('GET', 'stations') => reply(200, page([])),
          ('GET', 'connectors/by-code/PM%20T96.1/2') => switch (++attempt) {
            1 => reply(503, {'error': 'auth_unavailable'}),
            2 => reply(404, {'error': 'not_found'}),
            _ => reply(200, _connector(code: 'PM T96.1')),
          },
          _ => throw StateError('Unexpected request ${r.method} ${r.path}'),
        },
      );
      await tester.binding.setSurfaceSize(const Size(390, 844));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(ApiApp(config: api, httpAdapter: fixture));
      await tester.pumpAndSettle();
      final router = GoRouter.of(
        tester.element(find.byKey(const Key('auth-submit'))),
      );
      router.go('/scan');
      await tester.pumpAndSettle();
      expect(router.routeInformationProvider.value.uri.path, '/login');
      expect(camera.starts, 0);
      await enterAccount(tester);
      expect(router.routeInformationProvider.value.uri.path, '/discover');
      await tester.tap(find.byKey(const Key('nav-charging')));
      await tester.pumpAndSettle();
      expect(router.routeInformationProvider.value.uri.path, '/scan');
      expect(
        tester.widget<NavigationBar>(find.byType(NavigationBar)).selectedIndex,
        1,
      );
      expect(camera.starts, 1);
      expect(find.textContaining('Cho phép Camera'), findsOneWidget);

      await _submitConnector(tester, 'https://foreign.invalid/PM-T96/2');
      expect(find.textContaining('Mã cổng chưa đúng'), findsOneWidget);
      await _submitConnector(tester, '../2');
      expect(find.textContaining('Mã cổng chưa đúng'), findsOneWidget);
      expect(attempt, 0);
      await _submitConnector(tester, ' PM T96.1/2 ');
      expect(
        find.textContaining('Chưa kiểm tra được cổng sạc'),
        findsOneWidget,
      );
      await _submitConnector(tester, ' PM T96.1/2 ');
      expect(
        find.textContaining('Không tìm thấy cổng phù hợp'),
        findsOneWidget,
      );
      await _submitConnector(tester, ' PM T96.1/2 ');
      expect(find.text('Trạm PowerMe T96'), findsOneWidget);
      expect(find.text('Trụ PM T96.1 · Cổng 2'), findsOneWidget);
      expect(find.text('Trống'), findsOneWidget);
      expect(find.text('Cổng đã được báo lỗi'), findsOneWidget);
      expect(router.routeInformationProvider.value.uri.path, '/scan');
      final lookups = fixture.requests.where(
        (r) => r.path.startsWith('connectors/'),
      );
      expect(lookups, hasLength(3));
      for (final lookup in lookups) {
        expect(lookup.method, 'GET');
        expect(lookup.headers['Authorization'], 'Bearer $accessA');
        expect(lookup.uri.queryParameters, {'vehicle_id': '10'});
      }
      expect(fixture.requests.map((r) => r.method).toSet(), {'POST', 'GET'});
      expect(
        fixture.requests.where((r) => r.method == 'POST').single.path,
        'auth/login',
      );
    },
  );

  testWidgets(
    'API camera ignores duplicate scans and drops a previous vehicle response',
    (tester) async {
      final camera = ScannerPlatformFake();
      final previous = MobileScannerPlatform.instance;
      MobileScannerPlatform.instance = camera;
      addTearDown(() => MobileScannerPlatform.instance = previous);
      final lateLookup = Completer<ResponseBody>();
      var vehicle = '9';
      final fixture = DriverApiFixture(
        (r) async => switch ((r.method, r.path)) {
          ('POST', 'auth/login') => reply(200, tokens(accessA)),
          ('GET', 'me') => reply(
            200,
            account(
              vehicles: [
                ownVehicle(isDefault: vehicle == '9'),
                ownVehicle(id: '10', isDefault: vehicle == '10'),
              ],
            ),
          ),
          ('PATCH', 'vehicles/10') => reply(
            200,
            ownVehicle(id: vehicle = '10'),
          ),
          ('GET', 'stations') => reply(200, page([])),
          ('GET', 'connectors/by-code/PM-T96/2')
              when r.uri.queryParameters['vehicle_id'] == '9' =>
            lateLookup.future,
          ('GET', 'connectors/by-code/PM-T96/2') => reply(200, _connector()),
          _ => throw StateError('Unexpected request ${r.method} ${r.path}'),
        },
      );
      await tester.pumpWidget(ApiApp(config: api, httpAdapter: fixture));
      await tester.pumpAndSettle();
      await enterAccount(tester);
      await tester.tap(find.byKey(const Key('nav-charging')));
      await tester.pumpAndSettle();
      expect(camera.starts, 1);
      final container = ProviderScope.containerOf(
        tester.element(find.byType(NavigationBar)),
      );
      camera.emit('powerme:connector:PM-T96/2');
      camera.emit('powerme:connector:PM-T96/2');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      final lookups = fixture.requests.where(
        (r) => r.path.startsWith('connectors/'),
      );
      expect(lookups, hasLength(1));
      unawaited(
        container.read(profileControllerProvider.notifier).selectVehicle('10'),
      );
      await tester.pumpAndSettle();
      lateLookup.complete(reply(200, _connector(name: 'Trạm của xe cũ')));
      await tester.pumpAndSettle();
      expect(find.text('Trạm của xe cũ'), findsNothing);
      camera.emit('powerme:connector:PM-T96/2');
      await tester.pumpAndSettle();
      expect(find.text('Trạm PowerMe T96'), findsOneWidget);
      expect(lookups.map((r) => r.uri.queryParameters['vehicle_id']), [
        '9',
        '10',
      ]);
    },
  );

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
    expect(find.text('Thêm xe để tìm trạm tương thích.'), findsOneWidget);
    expect(
      tester.widget<NavigationBar>(find.byType(NavigationBar)).selectedIndex,
      0,
    );
    await tester.tap(find.byKey(const Key('nav-account')));
    await tester.pumpAndSettle();
    expect(find.text('Tài xế kiểm thử'), findsOneWidget);
  });
}

Map<String, Object> _connector({
  String name = 'Trạm PowerMe T96',
  String code = 'PM-T96',
}) => {
  'connector_id': '31',
  'display_code': code,
  'connector_no': 2,
  'site_name': name,
  'is_online': true,
  'status': 'Available',
  'serial_number': 'fixture-serial',
  'lifecycle': 'in_service',
  'vinfast_only': false,
  'reported_issue': true,
};

Future<void> _submitConnector(WidgetTester tester, String code) async {
  final field = find.byKey(const Key('qr-manual-reference'));
  await tester.ensureVisible(field);
  await tester.enterText(field, code);
  final submit = find.byKey(const Key('qr-connect'));
  await tester.ensureVisible(submit);
  await tester.tap(submit);
  await tester.pumpAndSettle();
}
