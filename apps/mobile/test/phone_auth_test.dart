import 'dart:async';

import 'package:driver_app/core/api/api_config.dart';
import 'package:driver_app/core/api/driver_api_session.dart';
import 'package:driver_app/features/auth/application/auth_controller.dart';
import 'package:driver_app/features/auth/data/api_auth_repository.dart';
import 'package:driver_app/features/auth/domain/auth_input.dart';
import 'package:driver_app/features/auth/domain/auth_repository.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'driver_api_fixture.dart';

final _config = ApiConfig.parse('https://fixture.invalid/api/driver/v1');

ApiAuthRepository _repository(DriverApiFixture fixture) {
  final session = DriverApiSession(_config, adapter: fixture);
  addTearDown(session.dispose);
  return ApiAuthRepository(session, consentVersion: 'fixture-v1');
}

Matcher _failure(AuthFailure failure) =>
    isA<AuthException>().having((error) => error.failure, 'failure', failure);

Registration _registration(String? phone) => Registration(
  displayName: ' Tài xế kiểm thử ',
  email: ' test@example.invalid ',
  phoneNumber: phone,
  password: ' fixture password ',
  consent: true,
);

void main() {
  test('BE-30 input validation preserves supported formats and raw length', () {
    for (final phone in [
      '0901234567',
      '090.123.4567',
      '0(901) 234-567',
      '84901234567',
      '+84 901 234 567',
      '+84 (0) 901-234-567',
      '02412345678',
      '+14155550123',
      '+1234567',
      '+123456789012345',
      ' 0901234567 ',
      '${' ' * 22}0901234567',
    ]) {
      expect(isPhoneNumberInput(phone), isTrue, reason: phone);
    }
    for (final phone in [
      '',
      ' ',
      '901234567',
      '+8490123456',
      '+8400901234567',
      '+0123456789',
      '840901234567',
      '+123456',
      '+1234567890123456',
      '0901/234/567',
      '0901x234567',
      '０９０１２３４５６７',
      '${' ' * 23}0901234567',
      '+84'.padRight(33, ' '),
    ]) {
      expect(isPhoneNumberInput(phone), isFalse, reason: phone);
    }
    expect(isEmailInput(' test@example.invalid '), isTrue);
    expect(isEmailInput('test@example.invalid@extra'), isFalse);
  });

  for (final identifier in [
    ' test@example.invalid ',
    '0901234567',
    '090.123.4567',
    '+84 901 234 567',
    '+84 (0) 901-234-567',
    '84901234567',
    '02412345678',
    '+1 (415) 555-0123',
  ]) {
    test('login sends one identifier and bootstraps me: $identifier', () async {
      final fixture = DriverApiFixture((request) async {
        if (request.path == 'auth/login') {
          expect(request.headers['Authorization'], isNull);
          expect(request.data, {
            if (identifier.contains('@'))
              'email': identifier.trim()
            else
              'phone_number': identifier,
            'password': ' fixture password ',
          });
          return reply(200, tokens(accessA));
        }
        expect(request.path, 'me');
        expect(request.headers['Authorization'], 'Bearer $accessA');
        return reply(200, account());
      });
      final auth = _repository(fixture);
      final container = ProviderContainer.test(
        overrides: [authRepositoryProvider.overrideWithValue(auth)],
      );
      addTearDown(container.dispose);
      container.read(authControllerProvider);
      await Future<void>.delayed(Duration.zero);
      await container
          .read(authControllerProvider.notifier)
          .signIn(identifier, ' fixture password ');
      expect(
        container.read(authControllerProvider).scope?.principalId,
        '9007199254740993',
      );
      expect(fixture.requests.map((r) => r.path), ['auth/login', 'me']);
    });
  }

  for (final phone in <String?>[
    null,
    '',
    '   ',
    '090.123.4567',
    '+84 901 234 567',
    ' +14155550123 ',
  ]) {
    test(
      'registration optional raw phone ${phone == null ? 'null' : 'length ${phone.length}'}',
      () async {
        final fixture = DriverApiFixture((request) async {
          if (request.path == 'me') return reply(200, account());
          expect(request.path, 'auth/register');
          expect(request.data, {
            'email': 'test@example.invalid',
            'password': ' fixture password ',
            'full_name': 'Tài xế kiểm thử',
            'consent': true,
            'consent_version': 'fixture-v1',
            if (phone?.trim().isNotEmpty ?? false) 'phone_number': phone,
          });
          return reply(201, tokens(accessA));
        });
        expect(
          await _repository(fixture).register(_registration(phone)),
          '9007199254740993',
        );
        expect(fixture.requests, hasLength(2));
      },
    );
  }

  for (final (status, code, expected) in [
    (400, 'phone_taken', AuthFailure.phoneInUse),
    (409, 'phone_taken', AuthFailure.phoneInUse),
    (400, 'invalid_input', AuthFailure.invalidRegistration),
    (409, 'email_taken', AuthFailure.emailInUse),
  ]) {
    test('register maps $status $code without retry or account', () async {
      final fixture = DriverApiFixture(
        (_) async => reply(status, {'error': code}),
      );
      final auth = _repository(fixture);
      await expectLater(
        auth.register(_registration('+84 901 234 567')),
        throwsA(_failure(expected)),
      );
      expect(fixture.requests.single.path, 'auth/register');
      expect(await auth.restore(), isNull);
    });
  }

  for (final (status, code, expected) in [
    (401, 'invalid_credentials', AuthFailure.invalidCredentials),
    (403, 'account_locked', AuthFailure.accountLocked),
    (429, 'too_many_attempts', AuthFailure.rateLimited),
  ]) {
    test('phone login maps $status $code without refresh or me', () async {
      final fixture = DriverApiFixture(
        (_) async => reply(status, {'error': code}),
      );
      final auth = _repository(fixture);
      await expectLater(
        auth.signIn('0901234567', 'wrong password'),
        throwsA(_failure(expected)),
      );
      expect(fixture.requests.single.path, 'auth/login');
      expect(await auth.restore(), isNull);
    });
  }

  test('phone bootstrap failure never publishes a principal', () async {
    final fixture = DriverApiFixture(
      (r) async => r.path == 'me'
          ? reply(200, {...account(), 'vehicles': 'malformed'})
          : reply(200, tokens(accessA)),
    );
    final auth = _repository(fixture);
    await expectLater(
      auth.signIn('0901234567', 'fixture password'),
      throwsA(_failure(AuthFailure.profileUnavailable)),
    );
    expect(await auth.restore(), isNull);
  });

  test(
    'phone session keeps shared 401 refresh and the original refresh token',
    () async {
      var bootstrap = true;
      final rejected = Completer<void>();
      var oldReads = 0;
      final fixture = DriverApiFixture((r) async {
        if (r.path == 'auth/login') return reply(200, tokens(accessA));
        if (r.path == 'auth/refresh') {
          await rejected.future;
          expect(r.data, {'refresh_token': refreshA});
          return reply(200, tokens(accessB, login: false));
        }
        expect(r.path, 'me');
        if (bootstrap) return reply(200, account());
        if (r.headers['Authorization'] == 'Bearer $accessA') {
          if (++oldReads == 2) rejected.complete();
          return reply(401, {'error': 'unauthorized'});
        }
        expect(r.headers['Authorization'], 'Bearer $accessB');
        return reply(200, account());
      });
      final session = DriverApiSession(_config, adapter: fixture);
      addTearDown(session.dispose);
      await session.signIn('0901234567', 'fixture password');
      bootstrap = false;
      final accounts = await Future.wait([
        session.refreshAccount(),
        session.refreshAccount(),
      ]);
      expect(accounts.map((a) => a.id), everyElement('9007199254740993'));
      expect(
        fixture.requests.where((r) => r.path == 'auth/refresh'),
        hasLength(1),
      );
      expect(oldReads, 2);
    },
  );

  for (final duringBootstrap in [false, true]) {
    test(
      'cancel phone ${duringBootstrap ? 'bootstrap' : 'login'} then email login ignores late account',
      () async {
        final started = Completer<void>();
        final release = Completer<void>();
        final delivered = Completer<void>();
        var old = true;
        final fixture = DriverApiFixture((r) async {
          if (old &&
              (duringBootstrap ? r.path == 'me' : r.path == 'auth/login')) {
            started.complete();
            await release.future;
            delivered.complete();
            return duringBootstrap
                ? reply(200, account())
                : reply(200, tokens(accessA));
          }
          if (r.path == 'auth/login') return reply(200, tokens(accessB));
          return reply(200, account(id: '42'));
        });
        final auth = _repository(fixture);
        final container = ProviderContainer.test(
          overrides: [authRepositoryProvider.overrideWithValue(auth)],
        );
        addTearDown(container.dispose);
        container.read(authControllerProvider);
        await Future<void>.delayed(Duration.zero);
        final controller = container.read(authControllerProvider.notifier);
        final pending = controller.signIn('0901234567', 'fixture password');
        await started.future;
        await controller.signIn('0901234567', 'duplicate');
        expect(
          fixture.requests.where((r) => r.path == 'auth/login'),
          hasLength(1),
        );
        controller.signOut();
        old = false;
        await controller.signIn('test@example.invalid', 'fixture password');
        final scope = container.read(authControllerProvider).scope;
        expect(scope?.principalId, '42');
        release.complete();
        await delivered.future;
        await pending;
        expect(container.read(authControllerProvider).scope, scope);
        expect(await auth.restore(), '42');
      },
    );
  }
}
