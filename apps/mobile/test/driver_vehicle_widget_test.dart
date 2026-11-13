import 'dart:async';

import 'package:dio/dio.dart';
import 'package:driver_app/app/composition/api_app.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'driver_api_fixture.dart';
import 'driver_api_widget_test.dart' show api, enterAccount;

const _add = 'add-vehicle';
const _save = 'vehicle-save';
const _reload = 'refresh-profile';

Future<void> _open(
  WidgetTester tester,
  DriverApiFixture fixture, {
  Size size = const Size(430, 940),
}) async {
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(ApiApp(config: api, httpAdapter: fixture));
  await tester.pumpAndSettle();
  await enterAccount(tester);
}

Future<void> _tap(WidgetTester tester, String key, {bool settle = true}) async {
  final target = find.byKey(Key(key));
  await tester.ensureVisible(target);
  await tester.tap(target);
  if (settle) await tester.pumpAndSettle();
}

Future<void> _enterPlate(WidgetTester tester, String plate) async {
  final field = find.byKey(const Key('vehicle-plate'));
  await tester.ensureVisible(field);
  await tester.enterText(field, plate);
  await tester.pumpAndSettle();
}

Future<void> _chooseModel(WidgetTester tester) async {
  await _tap(tester, 'vehicle-model-${leaf['vehicle_model_id']}');
}

bool _canSave(WidgetTester tester) =>
    tester.widget<FilledButton>(find.byKey(const Key(_save))).onPressed != null;

void main() {
  testWidgets('empty account adds, sets default and removes using /me', (
    tester,
  ) async {
    var vehicles = <Map<String, Object?>>[];
    final fixture = DriverApiFixture((request) async {
      switch ((request.method, request.path)) {
        case ('POST', 'auth/login'):
          return reply(200, tokens(accessA));
        case ('GET', 'me'):
          return reply(200, account(vehicles: vehicles));
        case ('GET', 'vehicle-models'):
          return reply(200, {
            'items': [leaf, vf8],
          });
        case ('POST', 'vehicles'):
          final body = request.data as Map<String, Object?>;
          expect(body['vehicle_model_id'], leaf['vehicle_model_id']);
          final first = vehicles.isEmpty;
          final added = ownVehicle(
            id: first ? '9' : '10',
            plate: (body['plate_number'] as String).trim().toUpperCase(),
            model: leaf,
            isDefault: first,
          );
          vehicles = [...vehicles, added];
          return reply(201, added);
        case ('PATCH', 'vehicles/10'):
          vehicles = [
            {...vehicles.last, 'is_default': true},
            {...vehicles.first, 'is_default': false},
          ];
          return reply(200, vehicles.first);
        case ('DELETE', 'vehicles/10'):
          vehicles = [
            {...vehicles.last, 'is_default': true},
          ];
          return ResponseBody.fromString('', 204);
        case ('DELETE', 'vehicles/9'):
          vehicles = [];
          return ResponseBody.fromString('', 204);
        default:
          throw StateError('Unexpected route');
      }
    });
    await _open(tester, fixture);
    expect(find.text('Xe của tôi'), findsOneWidget);
    expect(find.text('Chưa có xe trong hồ sơ.'), findsOneWidget);
    await _tap(tester, _add);
    await _enterPlate(tester, '51K-1');
    await _tap(tester, _save);
    expect(find.text('Chọn mẫu xe.'), findsOneWidget);
    expect(find.textContaining('Biển số không hợp lệ'), findsOneWidget);
    await _enterPlate(tester, ' 51k-901.01 ');
    await _tap(tester, _save);
    expect(find.text('Chọn mẫu xe.'), findsOneWidget);
    expect(fixture.requests.where((r) => r.path == 'vehicles'), isEmpty);
    await _chooseModel(tester);
    await _tap(tester, _save, settle: false);
    await tester.tap(find.byKey(const Key(_save)));
    await tester.pumpAndSettle();
    expect(find.text('51K-901.01 · CHAdeMO · Xe mặc định'), findsOneWidget);
    expect(fixture.requests.where((r) => r.path == 'vehicles'), hasLength(1));

    await _tap(tester, _add);
    await _enterPlate(tester, '30A-123.45');
    await _chooseModel(tester);
    await _tap(tester, _save);
    await _tap(tester, 'select-10');
    expect(find.text('30A-123.45 · CHAdeMO · Xe mặc định'), findsOneWidget);
    expect(find.text('51K-901.01 · CHAdeMO'), findsOneWidget);
    await _tap(tester, 'remove-10');
    expect(find.text('Nissan Leaf · 30A-123.45'), findsOneWidget);
    await _tap(tester, 'confirm-remove-vehicle');
    expect(find.textContaining('30A-123.45'), findsNothing);
    expect(find.text('51K-901.01 · CHAdeMO · Xe mặc định'), findsOneWidget);
    await _tap(tester, 'remove-9');
    await _tap(tester, 'confirm-remove-vehicle');
    expect(find.text('Chưa có xe trong hồ sơ.'), findsOneWidget);
    expect(fixture.requests.where((r) => r.path == 'me'), hasLength(6));
  });

  testWidgets('catalog loading, error and empty block submission until retry', (
    tester,
  ) async {
    var catalogs = 0;
    final first = Completer<ResponseBody>();
    final fixture = DriverApiFixture(
      (request) async => switch (request.path) {
        'auth/login' => reply(200, tokens(accessA)),
        'me' => reply(200, account(withVehicle: false)),
        'vehicle-models' when ++catalogs == 1 => first.future,
        'vehicle-models' when catalogs == 2 => reply(200, {'items': []}),
        'vehicle-models' => reply(200, {
          'items': [leaf],
        }),
        _ => throw StateError('Unexpected route'),
      },
    );
    await _open(tester, fixture);
    await _tap(tester, _add, settle: false);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(_canSave(tester), isFalse);
    first.complete(reply(503, {'error': 'auth_unavailable'}));
    await tester.pumpAndSettle();
    expect(find.text('Chưa tải được danh mục mẫu xe.'), findsOneWidget);
    expect(_canSave(tester), isFalse);
    await _tap(tester, 'reload-vehicle-models');
    expect(find.text('Danh mục chưa có mẫu xe.'), findsOneWidget);
    expect(_canSave(tester), isFalse);
    await _tap(tester, 'reload-vehicle-models');
    expect(find.byKey(const Key('vehicle-model-catalog')), findsOneWidget);
    expect(_canSave(tester), isTrue);
  });

  testWidgets('catalog filters preserve the selected API model and payload', (
    tester,
  ) async {
    final added = ownVehicle(plate: '30A-123.45', model: leaf);
    final fixture = DriverApiFixture((request) async {
      if (request.path == 'vehicles') {
        expect(request.data, {
          'vehicle_model_id': leaf['vehicle_model_id'],
          'plate_number': '30A-123.45',
          'is_default': true,
        });
        return reply(201, added);
      }
      return switch (request.path) {
        'auth/login' => reply(200, tokens(accessA)),
        'me' => reply(200, account()),
        'vehicle-models' => reply(200, {
          'items': [leaf, vf8],
        }),
        _ => throw StateError('Unexpected route'),
      };
    });
    await _open(tester, fixture, size: const Size(320, 640));
    await _tap(tester, _add);
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpAndSettle();

    final search = find.byKey(const Key('vehicle-model-search'));
    final leafCard = find.byKey(
      Key('vehicle-model-${leaf['vehicle_model_id']}'),
    );
    final vf8Card = find.byKey(Key('vehicle-model-${vf8['vehicle_model_id']}'));
    Finder chip(String label) => find.widgetWithText(ChoiceChip, label);
    Future<void> chooseBrand(String label) async {
      await tester.ensureVisible(search);
      await tester.ensureVisible(chip(label));
      await tester.pumpAndSettle();
      await tester.tap(chip(label).hitTestable());
      await tester.pumpAndSettle();
    }

    expect(tester.widget<ChoiceChip>(chip('Tất cả')).selected, isTrue);
    expect(
      tester.getTopLeft(leafCard).dy,
      lessThan(tester.getTopLeft(vf8Card).dy),
    );
    await tester.ensureVisible(search);
    await tester.enterText(search, '  vInFaSt  ');
    await tester.pumpAndSettle();
    expect(leafCard, findsNothing);
    await _tap(tester, 'vehicle-model-${vf8['vehicle_model_id']}');
    expect(find.text('GB/T'), findsOneWidget);
    expect(find.text('Chưa có dữ liệu'), findsNWidgets(3));

    await tester.ensureVisible(search);
    await tester.enterText(search, 'lEaF');
    await tester.pumpAndSettle();
    expect(vf8Card, findsNothing);
    await _chooseModel(tester);
    expect(find.text('39.5 kWh'), findsOneWidget);
    expect(find.text('270 km'), findsOneWidget);
    expect(find.text('50 kW'), findsOneWidget);
    expect(find.text('CHAdeMO'), findsOneWidget);
    await chooseBrand('VinFast');
    expect(find.text('Không tìm thấy mẫu xe phù hợp.'), findsOneWidget);
    expect(leafCard, findsNothing);
    expect(find.text('39.5 kWh'), findsOneWidget);

    final plate = find.byKey(const Key('vehicle-plate'));
    await tester.ensureVisible(plate);
    await tester.showKeyboard(plate);
    tester.view.viewInsets = const FakeViewPadding(bottom: 300);
    addTearDown(tester.view.resetViewInsets);
    await tester.pumpAndSettle();
    await _enterPlate(tester, '30A-123.45');
    await _tap(tester, 'vehicle-make-default');
    await _tap(tester, _save);
    expect(tester.takeException(), isNull);
    expect(fixture.requests.map((r) => r.path), [
      'auth/login',
      'me',
      'vehicle-models',
      'vehicles',
      'me',
    ]);
  });

  testWidgets('reload blocks a model removed from the catalog', (tester) async {
    var loads = 0;
    final fixture = DriverApiFixture(
      (request) async => switch (request.path) {
        'auth/login' => reply(200, tokens(accessA)),
        'me' => reply(200, account(withVehicle: false)),
        'vehicle-models' => reply(200, {
          'items': [if (++loads == 1) leaf else vf8],
        }),
        'vehicles' => reply(400, {'error': 'unknown_vehicle_model'}),
        _ => throw StateError('Unexpected route'),
      },
    );
    await _open(tester, fixture);
    await _tap(tester, _add);
    await _chooseModel(tester);
    await _enterPlate(tester, '30A-123.45');
    await _tap(tester, _save);
    await _tap(tester, 'reload-vehicle-models');
    expect(find.text('39.5 kWh'), findsNothing);
    await _tap(tester, _save);
    expect(find.text('Chọn mẫu xe.'), findsOneWidget);
    expect(fixture.requests.where((r) => r.path == 'vehicles'), hasLength(1));
  });

  testWidgets('plate_taken keeps the form and vehicle_in_use keeps the car', (
    tester,
  ) async {
    var missing = false;
    final fixture = DriverApiFixture(
      (request) async => switch (request.path) {
        'auth/login' => reply(200, tokens(accessA)),
        'me' => reply(200, account(withVehicle: !missing)),
        'vehicle-models' => reply(200, {
          'items': [leaf],
        }),
        'vehicles' => reply(409, {'error': 'plate_taken'}),
        'vehicles/9' when missing => reply(404, {'error': 'not_found'}),
        'vehicles/9' => reply(409, {'error': 'vehicle_in_use'}),
        _ => throw StateError('Unexpected route'),
      },
    );
    await _open(tester, fixture);
    await _tap(tester, _add);
    await _enterPlate(tester, '51A-00001');
    await _chooseModel(tester);
    await _tap(tester, _save);
    expect(find.text('Biển số này đã được đăng ký.'), findsOneWidget);
    expect(find.text('51A-00001'), findsOneWidget);
    await tester.tap(find.byTooltip('Quay lại'));
    await tester.pumpAndSettle();
    await _tap(tester, 'remove-9');
    await _tap(tester, 'confirm-remove-vehicle');
    expect(
      find.textContaining('phiên hoặc yêu cầu sạc chưa hoàn tất'),
      findsOneWidget,
    );
    expect(find.text('VinFast VF 8'), findsOneWidget);
    missing = true;
    await _tap(tester, 'remove-9');
    await _tap(tester, 'confirm-remove-vehicle');
    expect(find.textContaining('Xe không còn trong hồ sơ.'), findsOneWidget);
    expect(
      tester.widget<TextButton>(find.byKey(const Key('remove-9'))).onPressed,
      isNull,
    );
    await _tap(tester, _reload);
    expect(find.text('Chưa có xe trong hồ sơ.'), findsOneWidget);
  });

  for (final received in [false, true]) {
    final outcome = received ? 'accepted' : 'timed out';
    testWidgets('add $outcome requires /me recovery', (tester) async {
      var submitted = false;
      var blocked = true;
      final added = ownVehicle(plate: '30A-123.45', model: leaf);
      final fixture = DriverApiFixture(
        (request) async => switch (request.path) {
          'auth/login' => reply(200, tokens(accessA)),
          'me' when !submitted => reply(200, account(withVehicle: false)),
          'me' when blocked => reply(503, {'error': 'auth_unavailable'}),
          'me' => reply(200, account(vehicles: [added])),
          'vehicle-models' => reply(200, {
            'items': [leaf],
          }),
          'vehicles' => () {
            submitted = true;
            if (received) return reply(201, added);
            throw DioException(
              requestOptions: request,
              type: DioExceptionType.receiveTimeout,
            );
          }(),
          _ => throw StateError('Unexpected route'),
        },
      );
      await _open(tester, fixture);
      await _tap(tester, _add);
      await _enterPlate(tester, '30A-123.45');
      await _chooseModel(tester);
      await _tap(tester, _save);
      final notice = find.textContaining(
        received ? 'Đã ghi nhận thay đổi.' : 'Chưa xác nhận được thay đổi.',
      );
      expect(notice, findsOneWidget);
      expect(find.byKey(const Key(_save)), findsNothing);
      await _tap(tester, _reload);
      expect(notice, findsOneWidget);
      expect(find.byKey(const Key(_save)), findsNothing);
      blocked = false;
      await _tap(tester, _reload);
      expect(find.text('30A-123.45 · CHAdeMO · Xe mặc định'), findsOneWidget);
      expect(fixture.requests.where((r) => r.path == 'vehicles'), hasLength(1));
    });
  }
}
