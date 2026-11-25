import 'dart:async';

import 'package:dio/dio.dart';
import 'package:driver_app/app/composition/api_app.dart';
import 'package:driver_app/app/router.dart';
import 'package:driver_app/core/api/api_config.dart';
import 'package:driver_app/core/api/driver_api_session.dart';
import 'package:driver_app/features/auth/application/auth_controller.dart';
import 'package:driver_app/features/auth/domain/auth_scope.dart';
import 'package:driver_app/features/charging/application/charge_start_controller.dart';
import 'package:driver_app/features/charging/data/api_charge_start_repository.dart';
import 'package:driver_app/features/charging/data/api_charge_session_repository.dart';
import 'package:driver_app/features/charging/domain/charge_session.dart';
import 'package:driver_app/features/charging/domain/charge_start.dart';
import 'package:driver_app/features/charging/domain/charging.dart';
import 'package:driver_app/features/charging/presentation/charge_flow_visuals.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'driver_api_fixture.dart';
import 'driver_api_widget_test.dart' show enterAccount;
import 'scanner_platform_fake.dart';
import 'support/charge_modes_fixture.dart';

final _config = ApiConfig.parse('https://fixture.invalid/api/driver/v1');
const _scope = AuthScope(principalId: '7', generation: 1);
const _target = (scope: _scope, id: '78');
const _limits = [null, 30, 10000, 100000];
const _inputs = ['', '30', '10', '100000'];

void main() {
  testWidgets(
    'mode switches reset units/defaults and presets without reusing the energy draft',
    (tester) async {
      final fixture = ChargeModesFixture();
      await openChargeModes(tester, fixture);
      await selectChargeMode(tester, ChargingMode.energy, '12.345');
      await tapChargeKey(tester, 'charge-mode-timed');
      final field = find.byKey(const Key('qr-charge-limit'));
      expect(tester.widget<TextFormField>(field).controller!.text, '30');
      expect(
        tester
            .widget<TextField>(
              find.descendant(of: field, matching: find.byType(TextField)),
            )
            .decoration!
            .suffixText,
        'phút',
      );
      await tapChargeKey(tester, 'charge-preset-45');
      expect(tester.widget<TextFormField>(field).controller!.text, '45');
      await tapChargeKey(tester, 'charge-mode-cost');
      expect(tester.widget<TextFormField>(field).controller!.text, '100000');
      expect(
        tester
            .widget<TextField>(
              find.descendant(of: field, matching: find.byType(TextField)),
            )
            .decoration!
            .suffixText,
        'VND',
      );
      await tapChargeKey(tester, 'charge-preset-50000');
      expect(tester.widget<TextFormField>(field).controller!.text, '50000');
      await tapChargeKey(tester, 'charge-mode-autoFull');
      expect(find.byType(TextFormField), findsNothing);
      expect(
        fixture.adapter.requests.where((r) => r.path == 'charges'),
        isEmpty,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'money unknown uses no maximum as a ring value; legacy elapsed stays unknown',
    (tester) async {
      final fixture = ChargeModesFixture()
        ..confirmed = true
        ..progress = {
          ...chargeModeProgress(ChargingMode.cost, 100000),
          'metered_cost_vnd_estimate': null,
          'metered_cost_quality': 'unknown',
          'elapsed_seconds': null,
        };
      await openChargeModes(tester, fixture);
      await selectChargeMode(tester, ChargingMode.cost, '100000');
      await tapChargeKey(tester, 'qr-submit-start');
      final ring = tester.widget<ChargeRing>(find.byType(ChargeRing));
      expect(ring.energy, 'Chưa xác định');
      expect(ring.fraction, isNull);
      await tapChargeKey(tester, 'request-stop-charging');
      expect(find.text('51.000 đ'), findsWidgets);
      expect(find.text('—'), findsWidgets);
      await tapChargeKey(tester, 'continue-charging');
      expect(
        fixture.adapter.requests.where((r) => r.path.endsWith('/stop')),
        isEmpty,
      );
    },
  );

  for (final mode in ChargingMode.values) {
    final limit = _limits[mode.index];
    test(
      '$mode sends its exclusive wire shape and reads its bound cap',
      () async {
        final fixture = ChargeModesFixture();
        final session = DriverApiSession(_config, adapter: fixture.adapter);
        addTearDown(session.dispose);
        await session.signIn('test@example.invalid', 'fixture password');
        final repository = ApiChargeStartRepository(session);
        final request = _request(mode, limit);
        await repository.start(request);
        final body = fixture.adapter.requests.last.data;
        expect(body, {
          'connector_id': '31',
          'vehicle_id': '9',
          'mode': wireChargeMode(mode),
          if (limit case final int value) chargeLimitField(mode)!: value,
        });
        expect((await repository.read(request)).maxLimitValue, isNull);
        if (mode != ChargingMode.autoFull) {
          for (final cap in [0, 1, limit! - 1]) {
            fixture.cap = cap;
            expect((await repository.start(request)).maxLimitValue, cap);
          }
        }
        for (final bad in [
          0,
          -1,
          maxChargeLimit + 1,
          if (mode != ChargingMode.autoFull) null,
        ]) {
          await expectLater(
            repository.start(_request(mode, bad)),
            throwsA(isA<ChargeStartException>()),
          );
        }
      },
    );

    test(
      '$mode progress retains units, elapsed clock and distinct cost estimate',
      () async {
        final fixture = ChargeModesFixture()
          ..progress = chargeModeProgress(mode, limit);
        final session = DriverApiSession(_config, adapter: fixture.adapter);
        addTearDown(session.dispose);
        await session.signIn('test@example.invalid', 'fixture password');
        final repository = ApiChargeSessionRepository(session);
        final progress = await repository.progress(_target).result;
        expect(progress.billingMode, mode);
        expect(progress.limitValue, limit);
        expect(progress.elapsedSeconds, 1104);
        expect(progress.costEstimateVnd, 32000);
        expect(progress.estimatedCostVnd, 51000);
        expect(progress.costQuality, ChargeCostQuality.interpolated);
        expect(progress.costClock, ChargeCostClock.cpOffset);
        expect(progress.measuredEnergyWh, 10230);
      },
    );

    testWidgets(
      '$mode selection starts and automatically opens its truthful readout',
      (tester) async {
        final fixture = ChargeModesFixture()..confirmed = true;
        await openChargeModes(tester, fixture);
        await selectChargeMode(tester, mode, _inputs[mode.index]);
        await tapChargeKey(tester, 'qr-submit-start');
        expect(_path(tester), '/charge-session');
        expect(find.byKey(const Key('qr-follow-charge')), findsNothing);
        final ring = tester.widget<ChargeRing>(find.byType(ChargeRing));
        expect(ring.energy, switch (mode) {
          ChargingMode.timed => '00:18:24',
          ChargingMode.cost => '32.000 đ',
          _ => '10,23 kWh',
        });
        expect(ring.fraction, switch (mode) {
          ChargingMode.autoFull => null,
          ChargingMode.timed => closeTo(1104 / 1800, .0001),
          ChargingMode.energy => 1.0,
          ChargingMode.cost => .32,
        });
        final posts = fixture.adapter.requests
            .where((r) => r.method == 'POST')
            .length;
        await tester.pump(const Duration(minutes: 3));
        await tester.pumpAndSettle();
        expect(
          fixture.adapter.requests.where((r) => r.method == 'POST').length,
          posts,
        );
        await tapChargeKey(tester, 'request-stop-charging');
        expect(
          fixture.adapter.requests.where((r) => r.path.endsWith('/stop')),
          isEmpty,
        );
        await tapChargeKey(tester, 'continue-charging');
        expect(
          fixture.adapter.requests.where((r) => r.path.endsWith('/stop')),
          isEmpty,
        );
        expect(tester.takeException(), isNull);
      },
    );
  }

  test(
    'malformed caps, wrong bound mode and invalid full caps stay unknown',
    () async {
      Map<String, Object?> response = chargeModeSnapshot(ChargingMode.timed);
      final fixture = DriverApiFixture(
        (r) async => switch (r.path) {
          'auth/login' => reply(200, tokens(accessA)),
          'me' => reply(200, account(id: '7')),
          _ => reply(202, response),
        },
      );
      final session = DriverApiSession(_config, adapter: fixture);
      addTearDown(session.dispose);
      await session.signIn('test@example.invalid', 'fixture password');
      final repository = ApiChargeStartRepository(session);
      for (final mode in ChargingMode.values) {
        for (final cap in ['1', 1.5, -1, maxChargeLimit + 1, null]) {
          response = {
            ...chargeModeSnapshot(mode, outcome: 'requiresconfirmation'),
            if (chargeCapField(mode) != null) chargeCapField(mode)!: cap,
          };
          await expectLater(
            repository.start(_request(mode, _limits[mode.index])),
            throwsA(
              isA<ChargeStartException>().having(
                (e) => e.issue,
                'issue',
                ChargeStartIssue.uncertain,
              ),
            ),
          );
        }
        response = {...chargeModeSnapshot(mode), 'mode': 'unknown'};
        await expectLater(
          repository.start(_request(mode, _limits[mode.index])),
          throwsA(isA<ChargeStartException>()),
        );
        response = {...chargeModeSnapshot(mode), 'mode': null};
        await expectLater(
          repository.start(_request(mode, _limits[mode.index])),
          throwsA(isA<ChargeStartException>()),
        );
      }
      response = {
        ...chargeModeSnapshot(
          ChargingMode.timed,
          outcome: 'requiresconfirmation',
          cap: 15,
        ),
        'max_energy_wh': 1,
      };
      await expectLater(
        repository.start(_request(ChargingMode.timed, 30)),
        throwsA(isA<ChargeStartException>()),
      );
      response = chargeModeSnapshot(ChargingMode.energy);
      await expectLater(
        repository.start(_request(ChargingMode.timed, 30)),
        throwsA(isA<ChargeStartException>()),
      );
    },
  );

  test(
    'legacy energy remains readable; explicit invalid progress mode stays unknown',
    () async {
      final fixture = ChargeModesFixture();
      final session = DriverApiSession(_config, adapter: fixture.adapter);
      addTearDown(session.dispose);
      await session.signIn('test@example.invalid', 'fixture password');
      final repository = ApiChargeSessionRepository(session);
      fixture.progress = chargeModeProgress(ChargingMode.energy, 10000)
        ..remove('billing_mode')
        ..remove('elapsed_seconds');
      final legacy = await repository.progress(_target).result;
      expect(legacy.billingMode, isNull);
      expect(legacy.elapsedSeconds, isNull);
      expect(
        legacy
            .withStartContext(_request(ChargingMode.energy, 10000))
            .billingMode,
        ChargingMode.energy,
      );
      for (final invalid in [null, 'RFID', 1]) {
        fixture.progress = {...fixture.progress!, 'billing_mode': invalid};
        final unknown = await repository.progress(_target).result;
        expect(
          unknown
              .withStartContext(_request(ChargingMode.energy, 10000))
              .billingMode,
          isNull,
        );
      }
      fixture.progress = {
        ...fixture.progress!,
        'metered_cost_quality': 'unknown',
        'metered_cost_vnd_estimate': null,
      };
      expect(
        (await repository.progress(_target).result).costEstimateVnd,
        isNull,
      );
      for (final field in [
        'elapsed_seconds',
        'limit_value',
        'metered_cost_vnd_estimate',
      ]) {
        fixture.progress = {
          ...chargeModeProgress(ChargingMode.energy, 10000),
          field: '12',
        };
        await expectLater(
          repository.progress(_target).result,
          throwsA(isA<ChargeSessionException>()),
        );
      }
      for (final input in ['0', '-1', '1.5', '1e2', '9007199254740992']) {
        expect(parseChargeLimit(ChargingMode.timed, input), isNull);
        expect(parseChargeLimit(ChargingMode.cost, input), isNull);
      }
      expect(
        parseChargeLimit(ChargingMode.cost, '9007199254740991'),
        maxChargeLimit,
      );
    },
  );

  for (final mode in [
    ChargingMode.timed,
    ChargingMode.energy,
    ChargingMode.cost,
  ]) {
    testWidgets(
      '$mode cap edit preserves draft and apply sends a new key; zero cannot apply',
      (tester) async {
        final cap = mode == ChargingMode.timed
            ? 15
            : mode == ChargingMode.energy
            ? 5000
            : 50000;
        final fixture = ChargeModesFixture()..cap = cap;
        await openChargeModes(tester, fixture);
        await selectChargeMode(tester, mode, _inputs[mode.index]);
        await tapChargeKey(tester, 'qr-submit-start');
        final initial = fixture.adapter.requests.lastWhere(
          (r) => r.path == 'charges',
        );
        final lookups = fixture.adapter.requests
            .where((r) => r.path.startsWith('connectors/'))
            .length;
        await tapChargeKey(tester, 'qr-edit-charge');
        final field = mode == ChargingMode.energy
            ? 'qr-charge-energy'
            : 'qr-charge-limit';
        expect(
          tester.widget<TextFormField>(find.byKey(Key(field))).controller!.text,
          _inputs[mode.index],
        );
        expect(
          fixture.adapter.requests
              .where((r) => r.path.startsWith('connectors/'))
              .length,
          lookups,
        );
        await tapChargeKey(tester, 'qr-submit-start');
        final revised = fixture.adapter.requests.lastWhere(
          (r) => r.path == 'charges',
        );
        expect(
          revised.headers['Idempotency-Key'],
          isNot(initial.headers['Idempotency-Key']),
        );
        fixture.cap = 0;
        await tapChargeKey(tester, 'qr-accept-charge-limit');
        expect(
          fixture.adapter.requests
              .lastWhere((r) => r.method == 'POST' && r.path == 'charges')
              .data,
          {
            'connector_id': '31',
            'vehicle_id': '9',
            'mode': wireChargeMode(mode),
            chargeLimitField(mode)!: cap,
          },
        );
        expect(find.byKey(const Key('qr-accept-charge-limit')), findsNothing);
        expect(_container(tester).read(chargeStartProvider)!.canEdit, isTrue);
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets(
    'accepted stays M07; confirmation auto opens once and Back stays QR',
    (tester) async {
      final fixture = ChargeModesFixture();
      await openChargeModes(tester, fixture);
      await selectChargeMode(tester, ChargingMode.energy, '10');
      await tapChargeKey(tester, 'qr-submit-start');
      expect(_path(tester), '/scan');
      expect(find.text('Đã chấp nhận'), findsOneWidget);
      fixture.confirmed = true;
      await tester.pump(const Duration(milliseconds: 1500));
      await tester.pumpAndSettle();
      expect(_path(tester), '/charge-session');
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      await tester.pump(const Duration(seconds: 10));
      await tester.pumpAndSettle();
      expect(_path(tester), '/scan');
      expect(find.byKey(const Key('qr-follow-charge')), findsOneWidget);
      expect(
        fixture.adapter.requests.where((r) => r.path == 'charges'),
        hasLength(1),
      );
    },
  );

  testWidgets('confirmation in background queues navigation until resume', (
    tester,
  ) async {
    final pending = Completer<ResponseBody>();
    final fixture = ChargeModesFixture()..pendingPost = pending.future;
    await openChargeModes(tester, fixture);
    await selectChargeMode(tester, ChargingMode.timed, '30');
    await tapChargeKey(tester, 'qr-submit-start');
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    pending.complete(
      reply(202, chargeModeSnapshot(ChargingMode.timed, started: true)),
    );
    await tester.pumpAndSettle();
    expect(_path(tester), '/scan');
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();
    expect(_path(tester), '/charge-session');
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'background cancels status GET; accepted recovers to auto navigation on resume',
    (tester) async {
      final pending = Completer<ResponseBody>();
      final fixture = ChargeModesFixture()..pendingRead = pending.future;
      await openChargeModes(tester, fixture);
      await selectChargeMode(tester, ChargingMode.energy, '10');
      await tapChargeKey(tester, 'qr-submit-start');
      await tester.pump(const Duration(milliseconds: 1500));
      await tester.pump();
      final read = fixture.adapter.requests.lastWhere(
        (r) => r.method == 'GET' && r.path.startsWith('charges/'),
      );
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pumpAndSettle();
      expect(read.cancelToken!.isCancelled, isTrue);
      pending.complete(
        reply(200, chargeModeSnapshot(ChargingMode.energy, started: true)),
      );
      fixture.pendingRead = null;
      fixture.confirmed = true;
      await tester.pumpAndSettle();
      expect(_path(tester), '/scan');
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 1500));
      await tester.pumpAndSettle();
      expect(_path(tester), '/charge-session');
    },
  );

  testWidgets(
    'leave QR before late confirmation never pulls back; unsupported mode edits in place',
    (tester) async {
      final pending = Completer<ResponseBody>();
      final fixture = ChargeModesFixture()..pendingPost = pending.future;
      await openChargeModes(tester, fixture);
      await selectChargeMode(tester, ChargingMode.cost, '100000');
      await tapChargeKey(tester, 'qr-submit-start');
      await tapChargeKey(tester, 'nav-account');
      pending.complete(
        reply(202, chargeModeSnapshot(ChargingMode.cost, started: true)),
      );
      await tester.pumpAndSettle();
      expect(_path(tester), '/profile');
      _container(tester).read(authControllerProvider.notifier).signOut();
      await tester.pumpAndSettle();
      await enterAccount(tester);
      await tapChargeKey(tester, 'nav-charging');
      final container = _container(tester);
      expect(container.read(chargeStartDraftProvider).input, isEmpty);
      expect(
        container.read(chargeStartDraftProvider).mode,
        ChargingMode.energy,
      );
      final camera = MobileScannerPlatform.instance as ScannerPlatformFake;
      camera.emit('powerme:connector:PM-T96/2');
      await tester.pumpAndSettle();
      fixture.pendingPost = null;
      fixture.rejection = 'unsupported_mode';
      await selectChargeMode(tester, ChargingMode.autoFull, '');
      await tapChargeKey(tester, 'qr-submit-start');
      expect(find.textContaining('Chế độ này chưa khả dụng'), findsOneWidget);
      await tapChargeKey(tester, 'qr-edit-charge');
      expect(find.byKey(const Key('charge-mode-autoFull')), findsOneWidget);
      expect(find.byKey(const Key('qr-manual-reference')), findsNothing);
    },
  );
}

StartRequest _request(ChargingMode mode, int? limit) => StartRequest(
  scope: _scope,
  connectorId: '31',
  vehicleId: '9',
  mode: mode,
  limitValue: limit,
  key: newChargeStartKey(),
);

ProviderContainer _container(WidgetTester tester) =>
    ProviderScope.containerOf(tester.element(find.byType(Scaffold).first));
String _path(WidgetTester tester) => _container(
  tester,
).read(routerProvider).routeInformationProvider.value.uri.path;

Future<void> tapChargeKey(WidgetTester tester, String key) async {
  final target = find.byKey(Key(key));
  if (target.evaluate().isEmpty) {
    await tester.scrollUntilVisible(
      target,
      180,
      scrollable: find.byType(Scrollable).last,
    );
  }
  await Scrollable.ensureVisible(tester.element(target), alignment: .5);
  await tester.pumpAndSettle();
  await tester.tap(target);
  await tester.pumpAndSettle();
}

Future<void> selectChargeMode(
  WidgetTester tester,
  ChargingMode mode,
  String input,
) async {
  await tapChargeKey(tester, 'charge-mode-${mode.name}');
  if (mode == ChargingMode.autoFull) {
    expect(find.byType(TextFormField), findsNothing);
    return;
  }
  final field = find.byKey(
    Key(mode == ChargingMode.energy ? 'qr-charge-energy' : 'qr-charge-limit'),
  );
  await tester.ensureVisible(field);
  await tester.enterText(field, input);
  await tester.pumpAndSettle();
}

Future<ScannerPlatformFake> openChargeModes(
  WidgetTester tester,
  ChargeModesFixture fixture,
) async {
  final camera = ScannerPlatformFake();
  final previous = MobileScannerPlatform.instance;
  MobileScannerPlatform.instance = camera;
  addTearDown(() => MobileScannerPlatform.instance = previous);
  await tester.pumpWidget(
    ApiApp(config: _config, httpAdapter: fixture.adapter),
  );
  await tester.pumpAndSettle();
  await enterAccount(tester);
  await tapChargeKey(tester, 'nav-charging');
  camera.emit('powerme:connector:PM-T96/2');
  await tester.pumpAndSettle();
  return camera;
}
