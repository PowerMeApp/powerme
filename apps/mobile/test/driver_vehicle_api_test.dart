import 'dart:async';

import 'package:dio/dio.dart';
import 'package:driver_app/core/api/driver_api_exception.dart';
import 'package:driver_app/features/profile/data/api_profile_repository.dart';
import 'package:driver_app/features/profile/domain/driver_profile.dart';
import 'package:driver_app/features/profile/domain/profile_repository.dart';
import 'package:flutter_test/flutter_test.dart';

import 'driver_api_fixture.dart';
import 'driver_api_session_test.dart' show problem, sessionWith;

const registration = VehicleRegistration(
  plateNumber: ' ５１ｋ－９０１．０１ ',
  modelId: '10',
  makeDefault: false,
);

void main() {
  test('catalog and mutations use the BE-34 contract and reload /me', () async {
    final first = ownVehicle(plate: '51K-901.01');
    final second = ownVehicle(
      id: '9007199254741001',
      plate: '30A-123.45',
      model: picturedLeaf,
      isDefault: false,
    );
    var vehicles = <Map<String, Object?>>[];
    final fixture = DriverApiFixture((request) async {
      expect(request.uri.path, '/api/driver/v1/${request.path}');
      expect(request.queryParameters, isEmpty);
      if (request.path == 'auth/login') return reply(200, tokens(accessA));
      expect(request.headers['Authorization'], 'Bearer $accessA');
      expect(request.headers['Idempotency-Key'], isNull);
      switch ((request.method, request.path)) {
        case ('GET', 'me'):
          return reply(200, account(vehicles: vehicles));
        case ('GET', 'vehicle-models'):
          return reply(200, {
            'items': [picturedLeaf, vf8],
          });
        case ('POST', 'vehicles'):
          expect(request.contentType, Headers.jsonContentType);
          expect(request.data, {
            'plate_number': registration.plateNumber,
            'vehicle_model_id': '10',
          });
          vehicles = [first, second];
          return reply(201, first);
        case ('PATCH', 'vehicles/9007199254741001'):
          expect(request.contentType, Headers.jsonContentType);
          expect(request.data, {'is_default': true});
          vehicles = [
            {...second, 'is_default': true},
            {...first, 'is_default': false},
          ];
          return reply(200, vehicles.first);
        case ('DELETE', 'vehicles/9007199254741001'):
          expect(request.data, isNull);
          vehicles = [first];
          return ResponseBody.fromString('', 204);
        default:
          throw StateError('Unexpected route');
      }
    });
    final session = sessionWith(fixture);
    final repo = ApiProfileRepository(session);
    await session.signIn('test@example.invalid', 'fixture password');
    expect(repo.read().vehicles, isEmpty);
    repo.selectLanguage(AppLanguage.english);
    final models = await repo.listModels();
    expect(models.map((m) => m.id), ['9007199254740997', '10']);
    expect(models.map((m) => m.label), [
      'Nissan Leaf · CHAdeMO',
      'VinFast VF 8 · GB/T',
    ]);
    expect(models.map((m) => (m.imageUrl, m.imageCredit)), [
      (leafPhotoUrl, leafPhotoCredit),
      (null, null),
    ]);
    expect(
      models.map((m) => (m.batteryCapacityKwh, m.ratedRangeKm, m.maxDcKw)),
      [(39.5, 270, 50), (null, null, null)],
    );
    expect(
      (await repo.addVehicle(registration)).selectedVehicle?.plateNumber,
      '51K-901.01',
    );
    expect(repo.read().vehicles, hasLength(2));
    expect(repo.read().language, AppLanguage.english);
    expect(repo.read().vehicles.last.imageUrl, leafPhotoUrl);
    final selected = await repo.selectVehicle('9007199254741001', 0);
    expect(selected.selectedVehicle?.isVinFast, isFalse);
    expect(selected.selectedVehicle?.imageCredit, leafPhotoCredit);
    expect(selected.vehicleId, '9007199254741001');
    expect(selected.language, AppLanguage.english);
    expect((await repo.removeVehicle(selected.vehicleId, 0)).vehicleId, '9');
    expect(repo.read().vehicles, hasLength(1));
    expect(repo.read().language, AppLanguage.english);
    expect(fixture.requests.map((request) => request.path), [
      'auth/login',
      'me',
      'vehicle-models',
      'vehicles',
      'me',
      'vehicles/9007199254741001',
      'me',
      'vehicles/9007199254741001',
      'me',
    ]);
  });

  test(
    'vehicle photo metadata accepts Wikimedia HTTPS and legacy nulls',
    () async {
      var model = <String, Object?>{};
      final fixture = DriverApiFixture(
        (request) async => switch (request.path) {
          'auth/login' => reply(200, tokens(accessA)),
          'me' => reply(200, account()),
          'vehicle-models' => reply(200, {
            'items': [
              {...leaf, ...model},
            ],
          }),
          _ => throw StateError('Unexpected route'),
        },
      );
      final session = sessionWith(fixture);
      final repo = ApiProfileRepository(session);
      await session.signIn('test@example.invalid', 'fixture password');
      expect(repo.read().selectedVehicle?.imageUrl, isNull);
      expect(repo.read().selectedVehicle?.imageCredit, isNull);
      for (final url in [
        leafPhotoUrl,
        'https://thumb.wikimedia.org/a.jpg',
        'https://upload.wikimedia.org/a.jpg',
      ]) {
        model = {'image_url': url, 'image_credit': leafPhotoCredit};
        expect((await repo.listModels()).single.imageUrl, url);
      }
      for (final rejected in [
        null,
        'http://commons.wikimedia.org/a.jpg',
        'https://commons.wikimedia.org.example.invalid/a.jpg',
        'https://user@commons.wikimedia.org/a.jpg',
        'https://commons.wikimedia.org:8443/a.jpg',
        'https://commons.wikimedia.org/an image.jpg',
      ]) {
        model = {'image_url': rejected, 'image_credit': null};
        final parsed = (await repo.listModels()).single;
        expect(parsed.imageUrl, isNull);
        expect(parsed.imageCredit, isNull);
      }
      for (final field in ['image_url', 'image_credit']) {
        model = {field: 123};
        await expectLater(
          repo.listModels(),
          throwsA(problem(DriverApiProblem.malformed)),
        );
      }
    },
  );

  test('catalog 401 refreshes once and rejects malformed items', () async {
    final fixture = DriverApiFixture(
      (request) async => switch (request.path) {
        'auth/login' => reply(200, tokens(accessA)),
        'me' => reply(200, account()),
        'auth/refresh' => reply(200, tokens(accessB, login: false)),
        'vehicle-models'
            when request.headers['Authorization'] == 'Bearer $accessA' =>
          reply(401, {'error': 'unauthorized'}),
        'vehicle-models' => reply(200, {
          'items': [vf8, vf8],
        }),
        _ => throw StateError('Unexpected route'),
      },
    );
    final session = sessionWith(fixture);
    await session.signIn('test@example.invalid', 'fixture password');
    await expectLater(
      session.listVehicleModels(),
      throwsA(problem(DriverApiProblem.malformed)),
    );
    expect(fixture.requests.map((r) => r.path), [
      'auth/login',
      'me',
      'vehicle-models',
      'auth/refresh',
      'vehicle-models',
    ]);
  });

  for (final (method, path, status) in [
    ('POST', 'vehicles', 201),
    ('PATCH', 'vehicles/9', 200),
    ('DELETE', 'vehicles/9', 204),
  ]) {
    test('$method replays once after an authenticated 401 refresh', () async {
      final fixture = DriverApiFixture((request) async {
        if (request.path == 'auth/login') return reply(200, tokens(accessA));
        if (request.path == 'auth/refresh') {
          return reply(200, tokens(accessB, login: false));
        }
        final bearer = request.headers['Authorization'];
        if (request.path == 'me') return reply(200, account());
        expect((request.method, request.path), (method, path));
        if (bearer == 'Bearer $accessA') {
          return reply(401, {'error': 'unauthorized'});
        }
        expect(bearer, 'Bearer $accessB');
        return status == 204
            ? ResponseBody.fromString('', 204)
            : reply(status, ownVehicle());
      });
      final session = sessionWith(fixture);
      final repo = ApiProfileRepository(session);
      await session.signIn('test@example.invalid', 'fixture password');
      await switch (method) {
        'POST' => repo.addVehicle(registration),
        'PATCH' => repo.selectVehicle('9', 0),
        _ => repo.removeVehicle('9', 0),
      };
      expect(fixture.requests.map((r) => r.path), [
        'auth/login',
        'me',
        path,
        'auth/refresh',
        path,
        'me',
      ]);
      final first = fixture.requests[2];
      final retry = fixture.requests[4];
      expect(retry.uri, first.uri);
      expect(retry.method, first.method);
      expect(retry.data, first.data);
    });
  }

  for (final (code, status, writes, refreshes) in [
    ('unauthorized', 401, 2, 1),
    ('unexpected', 401, 1, 0),
    ('forbidden', 403, 1, 0),
    ('internal_error', 500, 1, 0),
    ('', 0, 1, 0),
    ('', 200, 1, 0),
  ]) {
    test('write stops after $status/$code without further replay', () async {
      final fixture = DriverApiFixture(
        (request) async => switch (request.path) {
          'auth/login' => reply(200, tokens(accessA)),
          'me' => reply(200, account()),
          'auth/refresh' => reply(200, tokens(accessB, login: false)),
          'vehicles' when status == 0 => throw DioException(
            requestOptions: request,
            type: DioExceptionType.receiveTimeout,
          ),
          'vehicles' => reply(status, {'error': code}),
          _ => throw StateError('Unexpected route'),
        },
      );
      final session = sessionWith(fixture);
      await session.signIn('test@example.invalid', 'fixture password');
      await expectLater(
        ApiProfileRepository(session).addVehicle(registration),
        throwsA(isA<ProfileException>()),
      );
      expect(
        fixture.requests.where((r) => r.path == 'vehicles'),
        hasLength(writes),
      );
      expect(
        fixture.requests.where((r) => r.path == 'auth/refresh'),
        hasLength(refreshes),
      );
      expect(fixture.requests.where((r) => r.path == 'me'), hasLength(1));
      expect(session.account == null, status == 401 || status == 403);
    });
  }

  test('logout during a write token refresh prevents replay', () async {
    final started = Completer<void>();
    final response = Completer<ResponseBody>();
    final fixture = DriverApiFixture(
      (request) async => switch (request.path) {
        'auth/login' => reply(200, tokens(accessA)),
        'me' => reply(200, account()),
        'vehicles/9' => reply(401, {'error': 'unauthorized'}),
        'auth/refresh' => () {
          started.complete();
          return response.future;
        }(),
        _ => throw StateError('Unexpected route'),
      },
    );
    final session = sessionWith(fixture);
    await session.signIn('test@example.invalid', 'fixture password');
    final pending = expectLater(
      session.setDefaultVehicle('9'),
      throwsA(problem(DriverApiProblem.ended)),
    );
    await started.future;
    session.signOut();
    response.complete(reply(200, tokens(accessB, login: false)));
    await pending;
    expect(fixture.requests.map((r) => r.path), [
      'auth/login',
      'me',
      'vehicles/9',
      'auth/refresh',
    ]);
  });

  test(
    'only an owned-vehicle route maps not_found to vehicleMissing',
    () async {
      var code = 'not_found';
      final fixture = DriverApiFixture(
        (request) async => switch (request.path) {
          'auth/login' => reply(200, tokens(accessA)),
          'me' => reply(200, account()),
          'vehicles' || 'vehicles/9' => reply(404, {'error': code}),
          _ => throw StateError('Unexpected route'),
        },
      );
      final session = sessionWith(fixture);
      final repo = ApiProfileRepository(session);
      await session.signIn('test@example.invalid', 'fixture password');
      Matcher failsWith(ProfileFailure failure) => throwsA(
        isA<ProfileException>().having(
          (error) => error.failure,
          'failure',
          failure,
        ),
      );
      await expectLater(
        repo.addVehicle(registration),
        failsWith(ProfileFailure.unavailable),
      );
      await expectLater(
        repo.selectVehicle('9', 0),
        failsWith(ProfileFailure.vehicleMissing),
      );
      await expectLater(
        repo.removeVehicle('9', 0),
        failsWith(ProfileFailure.vehicleMissing),
      );
      code = 'unsupported_route';
      await expectLater(
        repo.removeVehicle('9', 0),
        failsWith(ProfileFailure.unavailable),
      );
    },
  );

  test('late mutation cannot reload a replacement account', () async {
    final started = Completer<void>();
    final response = Completer<ResponseBody>();
    var signedIn = false;
    final fixture = DriverApiFixture(
      (request) async => switch (request.path) {
        'auth/login' => reply(200, tokens(signedIn ? accessB : accessA)),
        'me' when request.headers['Authorization'] == 'Bearer $accessB' =>
          reply(
            200,
            account(name: 'Tài xế khác', id: '99', withVehicle: false),
          ),
        'me' => reply(200, account()),
        'vehicles' => () {
          started.complete();
          return response.future;
        }(),
        _ => throw StateError('Unexpected route'),
      },
    );
    final session = sessionWith(fixture);
    await session.signIn('test@example.invalid', 'fixture password');
    final pending = expectLater(
      session.addVehicle(
        plateNumber: '51K-901.01',
        modelId: '10',
        makeDefault: true,
      ),
      throwsA(problem(DriverApiProblem.ended)),
    );
    await started.future;
    expect(fixture.requests.last.data, {
      'plate_number': '51K-901.01',
      'vehicle_model_id': '10',
      'is_default': true,
    });
    session.signOut();
    signedIn = true;
    await session.signIn('other@example.invalid', 'fixture password');
    response.complete(reply(201, ownVehicle()));
    await pending;
    expect(session.account?.id, '99');
    expect(fixture.requests.map((r) => r.path), [
      'auth/login',
      'me',
      'vehicles',
      'auth/login',
      'me',
    ]);
  });
}
