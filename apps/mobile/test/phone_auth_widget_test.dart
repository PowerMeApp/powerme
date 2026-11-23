import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:dio/dio.dart';
import 'package:driver_app/core/api/api_config.dart';
import 'package:driver_app/core/api/driver_api_session.dart';
import 'package:driver_app/core/l10n/app_copy.dart';
import 'package:driver_app/core/theme/powerme_theme.dart';
import 'package:driver_app/core/widgets/flow_page.dart';
import 'package:driver_app/features/auth/application/auth_controller.dart';
import 'package:driver_app/features/auth/data/api_auth_repository.dart';
import 'package:driver_app/features/auth/domain/auth_repository.dart';
import 'package:driver_app/features/auth/presentation/auth_screen.dart';
import 'package:driver_app/features/auth/presentation/onboarding_screen.dart';
import 'package:driver_app/features/profile/domain/driver_profile.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'driver_api_fixture.dart';

final _config = ApiConfig.parse('https://fixture.invalid/api/driver/v1');
const _password = ' fixture password ';
const _phone = '+84 901 234 567';

Future<void> _show(WidgetTester tester, Finder target) async {
  await Scrollable.ensureVisible(tester.element(target), alignment: 0.5);
  await tester.pumpAndSettle();
}

Future<void> _tap(WidgetTester tester, String key) async {
  final target = find.byKey(Key(key));
  await _show(tester, target);
  await tester.tap(target);
  await tester.pumpAndSettle();
}

Future<void> _enter(WidgetTester tester, String key, String value) async {
  final target = find.byKey(Key(key));
  await _show(tester, target);
  await tester.enterText(target, value);
  await tester.pumpAndSettle();
}

TextFormField _field(WidgetTester tester, String key) =>
    tester.widget<TextFormField>(find.byKey(Key(key)));

TextField _input(WidgetTester tester, String key) => tester.widget<TextField>(
  find.descendant(of: find.byKey(Key(key)), matching: find.byType(TextField)),
);

void main() {
  WidgetController.hitTestWarningShouldBeFatal = true;
  for (final (width, scale) in [(390.0, 1.0), (320.0, 2.0)]) {
    for (final language in AppLanguage.values) {
      final copy = AppCopy(language);
      final scenario = '${width.toInt()}-${scale.toInt()}x-${language.name}';
      testWidgets(
        'phone login keyboard, busy, failure and semantics $scenario',
        (tester) async {
          await _setup(tester, width, scale);
          final first = Completer<ResponseBody>();
          var attempt = 0;
          final fixture = DriverApiFixture((r) async {
            expect(r.path, 'auth/login');
            expect(r.data, {'phone_number': _phone, 'password': _password});
            return switch (++attempt) {
              1 => first.future,
              2 => reply(403, {'error': 'account_locked'}),
              _ => reply(429, {'error': 'too_many_attempts'}),
            };
          });
          final boundary = GlobalKey();
          await _mount(tester, fixture, AuthScreen(copy: copy), boundary);
          final semantics = tester.ensureSemantics();
          await tester.pump();
          await _capture(tester, boundary, '$scenario/login-top');
          await _show(tester, find.byKey(const Key('auth-email')));
          expect(
            find.bySemanticsLabel(
              RegExp(
                RegExp.escape(
                  copy.text(
                    'Email hoặc số điện thoại',
                    'Email or phone number',
                  ),
                ),
              ),
            ),
            findsWidgets,
          );
          expect(_input(tester, 'auth-email').autofillHints, [
            AutofillHints.username,
          ]);
          expect(_input(tester, 'auth-email').keyboardType, TextInputType.text);
          expect(_input(tester, 'auth-password').autofillHints, [
            AutofillHints.password,
          ]);
          expect(
            _input(tester, 'auth-password').textInputAction,
            TextInputAction.done,
          );
          tester.view.viewInsets = const FakeViewPadding(bottom: 220);
          await tester.pumpAndSettle();
          await _enter(tester, 'auth-email', '${' ' * 23}0901234567');
          await _enter(tester, 'auth-password', _password);
          await _tap(tester, 'auth-submit');
          expect(fixture.requests, isEmpty);
          expect(
            find.text(
              copy.text(
                'Nhập email hoặc số điện thoại hợp lệ.',
                'Enter a valid email or phone number.',
              ),
            ),
            findsOneWidget,
          );
          await _enter(tester, 'auth-email', _phone);
          expect(
            find.text(
              copy.text(
                'Nhập email hoặc số điện thoại hợp lệ.',
                'Enter a valid email or phone number.',
              ),
            ),
            findsNothing,
          );
          await _show(tester, find.byKey(const Key('auth-submit')));
          expect(
            tester.getSize(find.byKey(const Key('auth-submit'))).height,
            greaterThanOrEqualTo(48),
          );
          await tester.tap(find.byKey(const Key('auth-submit')));
          await tester.pump();
          expect(_field(tester, 'auth-email').enabled, isFalse);
          expect(_field(tester, 'auth-password').enabled, isFalse);
          expect(
            tester
                .widget<FilledButton>(find.byKey(const Key('auth-submit')))
                .onPressed,
            isNull,
          );
          _input(tester, 'auth-password').onSubmitted!(_password);
          await tester.pump(const Duration(milliseconds: 30));
          expect(fixture.requests, hasLength(1));
          first.complete(reply(401, {'error': 'invalid_credentials'}));
          await tester.pumpAndSettle();
          expect(
            find.text(authFailureText(AuthFailure.invalidCredentials, copy)),
            findsOneWidget,
          );
          expect(_field(tester, 'auth-email').controller!.text, _phone);
          expect(_field(tester, 'auth-password').controller!.text, _password);
          await _show(tester, find.byType(FailureNotice));
          await _capture(tester, boundary, '$scenario/login-error-keyboard');
          await _tap(tester, 'auth-submit');
          expect(
            find.text(authFailureText(AuthFailure.accountLocked, copy)),
            findsOneWidget,
          );
          await _tap(tester, 'auth-submit');
          expect(
            find.text(authFailureText(AuthFailure.rateLimited, copy)),
            findsOneWidget,
          );
          expect(fixture.requests, hasLength(3));
          semantics.dispose();
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox.shrink());
          await tester.pumpAndSettle();
        },
      );

      testWidgets(
        'optional phone registration stays reachable and retains errors $scenario',
        (tester) async {
          await _setup(tester, width, scale);
          var attempt = 0;
          final fixture = DriverApiFixture((r) async {
            expect(r.path, 'auth/register');
            expect(r.data, {
              'email': 'test@example.invalid',
              'full_name': 'Tài xế kiểm thử',
              'phone_number': _phone,
              'password': _password,
              'consent': true,
              'consent_version': 'fixture-v1',
            });
            return ++attempt == 1
                ? reply(409, {'error': 'phone_taken'})
                : reply(400, {'error': 'invalid_input'});
          });
          final boundary = GlobalKey();
          await _mount(tester, fixture, OnboardingScreen(copy: copy), boundary);
          await _tap(tester, 'consent');
          await _tap(tester, 'onboarding-next');
          await _capture(tester, boundary, '$scenario/register-top');
          tester.view.viewInsets = const FakeViewPadding(bottom: 220);
          await tester.pumpAndSettle();
          for (final (key, value) in [
            ('register-name', 'Tài xế kiểm thử'),
            ('register-email', 'test@example.invalid'),
            ('register-password', _password),
            ('register-confirm-password', _password),
          ]) {
            await _enter(tester, key, value);
          }
          expect(_input(tester, 'register-phone').autofillHints, [
            AutofillHints.telephoneNumber,
          ]);
          expect(
            _input(tester, 'register-phone').keyboardType,
            TextInputType.phone,
          );
          expect(_field(tester, 'register-phone').validator!('   '), isNull);
          expect(
            _field(tester, 'register-phone').validator!('+1 (415) 555-0123'),
            isNull,
          );
          await _enter(tester, 'register-phone', '${' ' * 23}0901234567');
          await _tap(tester, 'onboarding-next');
          expect(fixture.requests, isEmpty);
          expect(
            find.text(
              copy.text(
                'Nhập số điện thoại hợp lệ (tối đa 32 ký tự).',
                'Enter a valid phone number (up to 32 characters).',
              ),
            ),
            findsOneWidget,
          );
          await _enter(tester, 'register-phone', _phone);
          expect(
            find.text(
              copy.text(
                'Nhập số điện thoại hợp lệ (tối đa 32 ký tự).',
                'Enter a valid phone number (up to 32 characters).',
              ),
            ),
            findsNothing,
          );
          await _show(tester, find.byKey(const Key('register-phone')));
          await _capture(tester, boundary, '$scenario/register-phone-keyboard');
          await _tap(tester, 'onboarding-next');
          expect(
            find.text(authFailureText(AuthFailure.phoneInUse, copy)),
            findsOneWidget,
          );
          await _show(tester, find.byType(FailureNotice));
          await _capture(
            tester,
            boundary,
            '$scenario/register-phone-taken-keyboard',
          );
          expect(
            _field(tester, 'register-email').controller!.text,
            'test@example.invalid',
          );
          expect(_field(tester, 'register-phone').controller!.text, _phone);
          expect(
            _field(tester, 'register-password').controller!.text,
            _password,
          );
          await _show(tester, find.byKey(const Key('onboarding-next')));
          final buttonRect = tester.getRect(
            find.byKey(const Key('onboarding-next')),
          );
          expect(buttonRect.bottom, lessThanOrEqualTo(844 - 220));
          expect(buttonRect.height, greaterThanOrEqualTo(48));
          await _capture(
            tester,
            boundary,
            '$scenario/register-submit-keyboard',
          );
          await tester.tap(find.byKey(const Key('onboarding-next')));
          await tester.pumpAndSettle();
          expect(
            find.text(
              copy.text(
                'Vui lòng kiểm tra thông tin tài khoản và số điện thoại (nếu có).',
                'Please check your account details and optional phone number.',
              ),
            ),
            findsOneWidget,
          );
          expect(fixture.requests, hasLength(2));
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox.shrink());
          await tester.pumpAndSettle();
        },
      );
    }
  }
}

Future<void> _mount(
  WidgetTester tester,
  DriverApiFixture fixture,
  Widget screen,
  GlobalKey boundary,
) async {
  final session = DriverApiSession(_config, adapter: fixture);
  addTearDown(session.dispose);
  await tester.pumpWidget(
    RepaintBoundary(
      key: boundary,
      child: ProviderScope(
        overrides: [
          authRepositoryProvider.overrideWithValue(
            ApiAuthRepository(session, consentVersion: 'fixture-v1'),
          ),
          registrationOptionsProvider.overrideWithValue((
            enabled: true,
            needsVehicle: false,
          )),
        ],
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: powerMeTheme(),
          home: screen,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _setup(WidgetTester tester, double width, double scale) async {
  tester.view.physicalSize = Size(width, 844);
  tester.view.devicePixelRatio = 1;
  tester.platformDispatcher.textScaleFactorTestValue = scale;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetViewInsets);
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  const fonts = String.fromEnvironment('POWERME_PREVIEW_FONTS');
  if (fonts.isEmpty) return;
  await tester.runAsync(() async {
    for (final family in ['Roboto', 'Ahem']) {
      final loader = FontLoader(family);
      for (final weight in ['regular', 'medium', 'bold']) {
        loader.addFont(
          File(
            '$fonts/roboto-$weight.ttf',
          ).readAsBytes().then(ByteData.sublistView),
        );
      }
      await loader.load();
    }
    await (FontLoader('MaterialIcons')..addFont(
          File(
            '$fonts/materialicons-regular.otf',
          ).readAsBytes().then(ByteData.sublistView),
        ))
        .load();
  });
}

Future<void> _capture(
  WidgetTester tester,
  GlobalKey boundary,
  String name,
) async {
  const output = String.fromEnvironment('POWERME_AUTH_CAPTURE');
  if (output.isEmpty) return;
  FocusManager.instance.primaryFocus?.unfocus();
  await tester.pumpAndSettle();
  final render =
      boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  void repaint(RenderObject object) {
    object.markNeedsPaint();
    object.visitChildren(repaint);
  }

  repaint(render);
  await tester.pump();
  await tester.runAsync(() async {
    final image = await render.toImage();
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    final file = File('$output/$name.png');
    await file.parent.create(recursive: true);
    await file.writeAsBytes(data!.buffer.asUint8List());
    image.dispose();
  });
  expect(tester.takeException(), isNull);
}
