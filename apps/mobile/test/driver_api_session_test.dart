import 'dart:async';

import 'package:dio/dio.dart';
import 'package:driver_app/core/api/api_config.dart';
import 'package:driver_app/core/api/driver_api_exception.dart';
import 'package:driver_app/core/api/driver_api_session.dart';
import 'package:driver_app/features/auth/data/api_auth_repository.dart';
import 'package:driver_app/features/auth/domain/auth_repository.dart';
import 'package:driver_app/features/profile/data/api_profile_repository.dart';
import 'package:flutter_test/flutter_test.dart';

import 'driver_api_fixture.dart';

final config = ApiConfig.parse('https://fixture.invalid/api/driver/v1');

Matcher problem(DriverApiProblem kind) =>
    isA<DriverApiException>().having((error) => error.problem, 'problem', kind);

Matcher authFailure(AuthFailure failure) =>
    isA<AuthException>().having((error) => error.failure, 'failure', failure);

DriverApiSession sessionWith(DriverApiFixture fixture) {
  final session = DriverApiSession(config, adapter: fixture);
  addTearDown(session.dispose);
  return session;
}

void main() {
  test('API base validates prefix, transport, userinfo and tunnel hosts', () {
    for (final url in [
      '',
      'https://fixture.invalid',
      'https://user@fixture.invalid/api/driver/v1',
      'https://fixture.invalid/api/driver/v1?',
      'https://fixture.invalid/api/driver/v1#',
      'http://fixture.invalid/api/driver/v1',
      'http://127.0.0.2:3000/api/driver/v1',
    ]) {
      expect(
        () => ApiConfig.parse(url, allowTunnelHttp: true),
        throwsFormatException,
        reason: url,
      );
    }
    const tunnel = 'http://10.0.2.2:3000/api/driver/v1';
    expect(() => ApiConfig.parse(tunnel), throwsFormatException);
    expect(
      ApiConfig.parse(tunnel, allowTunnelHttp: true).baseUrl.path,
      '/api/driver/v1/',
    );
    expect(
      ApiConfig.parse(tunnel, allowTunnelHttp: true).consentVersion,
      isNull,
    );
  });

  test(
    'login and register use the exact contract and server principal',
    () async {
      final fixture = DriverApiFixture((request) async {
        expect(request.uri.path, '/api/driver/v1/${request.path}');
        expect(request.followRedirects, isFalse);
        if (request.path == 'me') {
          expect(request.method, 'GET');
          expect(request.headers['Authorization'], 'Bearer $accessA');
          expect(request.queryParameters, isEmpty);
          return reply(200, account());
        }
        expect(request.method, 'POST');
        expect(request.headers['Authorization'], isNull);
        expect(request.contentType, Headers.jsonContentType);
        if (request.path == 'auth/register') {
          expect(request.data, {
            'email': 'test@example.invalid',
            'password': 'fixture password',
            'full_name': 'Tên đăng ký',
            'consent': true,
            'consent_version': 'fixture-v1',
          });
          return reply(201, tokens(accessA));
        }
        expect(request.data, {
          'email': 'test@example.invalid',
          'password': 'fixture password',
        });
        return reply(200, tokens(accessA));
      });
      final session = sessionWith(fixture);
      final auth = ApiAuthRepository(session, consentVersion: 'fixture-v1');
      final profile = ApiProfileRepository(session);
      expect(await auth.restore(), isNull);
      const registration = Registration(
        displayName: ' Tên đăng ký ',
        email: 'test@example.invalid',
        password: 'fixture password',
        consent: true,
      );
      expect(
        ApiAuthRepository(session, consentVersion: null).register(registration),
        throwsA(
          isA<AuthException>().having(
            (error) => error.failure,
            'failure',
            AuthFailure.registrationUnavailable,
          ),
        ),
      );
      expect(fixture.requests, isEmpty);
      expect(await auth.register(registration), '9007199254740993');
      expect(profile.read().email, isEmpty);
      expect(profile.read().selectedVehicle?.plateNumber, '51A-00001');
      expect(profile.read().selectedVehicle?.connectors, ['GB/T']);
      auth.signOut();
      expect(profile.read().displayName, isEmpty);
      expect(
        await auth.signIn('test@example.invalid', 'fixture password'),
        '9007199254740993',
      );
      expect(fixture.requests.map((request) => request.path), [
        'auth/register',
        'me',
        'auth/login',
        'me',
      ]);
    },
  );

  for (final (status, code, failure) in [
    (409, 'email_taken', AuthFailure.emailInUse),
    (400, 'invalid_input', AuthFailure.invalidRegistration),
    (429, 'too_many_attempts', AuthFailure.rateLimited),
  ]) {
    test('registration maps HTTP $status without retrying POST', () async {
      final fixture = DriverApiFixture(
        (_) async => reply(status, {'error': code}),
      );
      final session = sessionWith(fixture);
      final auth = ApiAuthRepository(session, consentVersion: 'fixture-v1');
      await expectLater(
        auth.register(_registration),
        throwsA(authFailure(failure)),
      );
      expect(fixture.requests.single.path, 'auth/register');
      expect(await auth.restore(), isNull);
    });
  }

  test(
    'register timeout leaves outcome unconfirmed and does not retry',
    () async {
      final fixture = DriverApiFixture((request) async {
        throw DioException(
          requestOptions: request,
          type: DioExceptionType.receiveTimeout,
        );
      });
      final session = sessionWith(fixture);
      final auth = ApiAuthRepository(session, consentVersion: 'fixture-v1');
      await expectLater(
        auth.register(_registration),
        throwsA(authFailure(AuthFailure.registrationUnconfirmed)),
      );
      expect(fixture.requests.single.path, 'auth/register');
      expect(await auth.restore(), isNull);
    },
  );

  test(
    'failure loading profile after 201 cannot be reported as rejection',
    () async {
      final fixture = DriverApiFixture(
        (request) async => switch (request.path) {
          'auth/register' => reply(201, tokens(accessA)),
          'me' => reply(429, {'error': 'too_many_attempts'}),
          _ => throw StateError('Unexpected path'),
        },
      );
      final session = sessionWith(fixture);
      final auth = ApiAuthRepository(session, consentVersion: 'fixture-v1');
      await expectLater(
        auth.register(_registration),
        throwsA(authFailure(AuthFailure.registrationUnconfirmed)),
      );
      expect(fixture.requests.map((request) => request.path), [
        'auth/register',
        'me',
      ]);
      expect(await auth.restore(), isNull);
    },
  );

  test(
    'parallel 401 responses share one refresh and each retry once',
    () async {
      final allRejected = Completer<void>();
      final refreshStarted = Completer<void>();
      final releaseRefresh = Completer<void>();
      var oldReads = 0;
      var newReads = 0;
      var refreshes = 0;
      var bootstrap = true;
      final fixture = DriverApiFixture((request) async {
        if (request.path == 'auth/login') return reply(200, tokens(accessA));
        if (request.path == 'auth/refresh') {
          refreshes++;
          expect(request.headers['Authorization'], isNull);
          expect(request.data, {'refresh_token': refreshA});
          refreshStarted.complete();
          await releaseRefresh.future;
          return reply(200, tokens(accessB, login: false));
        }
        if (bootstrap) return reply(200, account());
        if (request.headers['Authorization'] == 'Bearer $accessA') {
          if (++oldReads == 3) allRejected.complete();
          await allRejected.future;
          return reply(401, {'error': 'unauthorized'});
        }
        expect(request.headers['Authorization'], 'Bearer $accessB');
        newReads++;
        return reply(200, account(name: 'Hồ sơ mới'));
      });
      final session = sessionWith(fixture);
      await session.signIn('test@example.invalid', 'fixture password');
      bootstrap = false;
      final reads = List.generate(3, (_) => session.refreshAccount());
      await refreshStarted.future;
      releaseRefresh.complete();
      final results = await Future.wait(reads);
      expect(
        results.map((result) => result.fullName),
        everyElement('Hồ sơ mới'),
      );
      expect((oldReads, refreshes, newReads), (3, 1, 3));
    },
  );

  test('a second 401 clears the session without another refresh', () async {
    var reads = 0;
    final fixture = DriverApiFixture(
      (request) async => switch (request.path) {
        'auth/login' => reply(200, tokens(accessA)),
        'auth/refresh' => reply(200, tokens(accessB, login: false)),
        _ when ++reads == 1 => reply(200, account()),
        _ => reply(401, {'error': 'unauthorized'}),
      },
    );
    final session = sessionWith(fixture);
    await session.signIn('test@example.invalid', 'fixture password');
    final ended = expectLater(session.ended, emits(DriverSessionEnd.expired));
    await expectLater(
      session.refreshAccount(),
      throwsA(isA<DriverApiException>()),
    );
    await ended;
    expect(session.account, isNull);
    expect(fixture.requests.map((request) => request.path), [
      'auth/login',
      'me',
      'me',
      'auth/refresh',
      'me',
    ]);
  });

  test(
    'network failure during refresh keeps scope and the original refresh token',
    () async {
      var reads = 0;
      var refreshes = 0;
      final fixture = DriverApiFixture((request) async {
        if (request.path == 'auth/login') return reply(200, tokens(accessA));
        if (request.path == 'auth/refresh') {
          expect(request.data, {'refresh_token': refreshA});
          if (++refreshes == 1) {
            throw DioException(
              requestOptions: request,
              type: DioExceptionType.connectionError,
            );
          }
          return reply(200, tokens(accessB, login: false));
        }
        if (++reads == 1 ||
            request.headers['Authorization'] == 'Bearer $accessB') {
          return reply(200, account());
        }
        return reply(401, {'error': 'unauthorized'});
      });
      final session = sessionWith(fixture);
      final id = await session.signIn(
        'test@example.invalid',
        'fixture password',
      );
      await expectLater(
        session.refreshAccount(),
        throwsA(problem(DriverApiProblem.connection)),
      );
      expect(session.account?.id, id);
      expect((await session.refreshAccount()).id, id);
      expect(refreshes, 2);
    },
  );

  test('403 ends a live account with no refresh', () async {
    var blocked = false;
    final fixture = DriverApiFixture((request) async {
      if (request.path == 'auth/login') return reply(200, tokens(accessA));
      expect(request.path, 'me');
      return blocked
          ? reply(403, {'error': 'forbidden'})
          : reply(200, account());
    });
    final session = sessionWith(fixture);
    await session.signIn('test@example.invalid', 'fixture password');
    blocked = true;
    final ended = expectLater(session.ended, emits(DriverSessionEnd.forbidden));
    await expectLater(
      session.refreshAccount(),
      throwsA(isA<DriverApiException>()),
    );
    await ended;
    expect(session.account, isNull);
    expect(fixture.requests, hasLength(3));
  });

  test('malformed me blocks login and cannot publish private state', () async {
    final fixture = DriverApiFixture(
      (request) async => request.path == 'me'
          ? reply(200, {...account(), 'vehicles': 'unexpected'})
          : reply(200, tokens(accessA)),
    );
    final session = sessionWith(fixture);
    await expectLater(
      session.signIn('test@example.invalid', 'fixture password'),
      throwsA(problem(DriverApiProblem.malformed)),
    );
    expect(session.account, isNull);
  });

  for (final duringRefresh in [false, true]) {
    test(
      'sign-out drops a late ${duringRefresh ? 'refresh' : 'login'} response',
      () async {
        final requestStarted = Completer<void>();
        final release = Completer<void>();
        final lateResponse = Completer<void>();
        var bootstrapped = false;
        final fixture = DriverApiFixture((request) async {
          if (request.path == 'me') {
            return bootstrapped
                ? reply(401, {'error': 'unauthorized'})
                : reply(200, account());
          }
          if (duringRefresh && request.path == 'auth/login') {
            return reply(200, tokens(accessA));
          }
          requestStarted.complete();
          await release.future;
          lateResponse.complete();
          return reply(200, tokens(accessB, login: !duringRefresh));
        });
        final session = sessionWith(fixture);
        if (duringRefresh) {
          await session.signIn('test@example.invalid', 'fixture password');
          bootstrapped = true;
        }
        final pending = duringRefresh
            ? session.refreshAccount()
            : session.signIn('test@example.invalid', 'fixture password');
        final assertion = expectLater(
          pending,
          throwsA(problem(DriverApiProblem.ended)),
        );
        await requestStarted.future;
        session.signOut();
        release.complete();
        await lateResponse.future;
        await assertion;
        expect(session.account, isNull);
        expect(fixture.requests, hasLength(duringRefresh ? 4 : 1));
      },
    );
  }
}

const _registration = Registration(
  displayName: 'Tài xế kiểm thử',
  email: 'test@example.invalid',
  password: 'fixture password',
  consent: true,
);
