import 'dart:async';

import 'package:dio/dio.dart';
import 'package:driver_app/app/composition/api_app.dart';
import 'package:driver_app/core/api/api_config.dart';
import 'package:driver_app/core/api/driver_api_session.dart';
import 'package:driver_app/core/theme/powerme_theme.dart';
import 'package:driver_app/features/auth/domain/auth_scope.dart';
import 'package:driver_app/features/charging/data/api_charge_start_repository.dart';
import 'package:driver_app/features/charging/domain/charge_start.dart';
import 'package:driver_app/features/charging/domain/charging.dart';
import 'package:driver_app/features/charging/presentation/charge_flow_visuals.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'driver_api_fixture.dart';
import 'driver_api_widget_test.dart' show enterAccount;
import 'driver_discovery_fixture.dart' show page;
import 'scanner_platform_fake.dart';

void main() {
  test(
    'converts kWh to Wh exactly within the Driver API safe integer range',
    () {
      for (final (input, expected) in [
        (' 0,001 ', 1),
        (',5', 500),
        ('12.045', 12045),
        ('0002', 2000),
        ('9007199254740,991', maxChargeEnergyWh),
        ('9007199254740.992', null),
        ('9007199254741', null),
        ('99999999999999999999999999', null),
        ('0', null),
        ('-1', null),
        ('1e2', null),
        ('1,000.1', null),
        ('1.0000', null),
      ]) {
        expect(parseChargeEnergyWh(input), expected, reason: input);
      }
    },
  );

  test(
    'distinguishes charge conflicts and treats invalid replies as uncertain',
    () async {
      var response = reply(503, {'error': 'connector_unavailable'});
      final fixture = _fixture((_) async => response);
      final session = DriverApiSession(
        ApiConfig.parse('https://fixture.invalid/api/driver/v1'),
        adapter: fixture,
      );
      addTearDown(session.dispose);
      final principal = await session.signIn(
        'test@example.invalid',
        'fixture password',
      );
      final repository = ApiChargeStartRepository(session);
      final request = StartRequest(
        scope: AuthScope(principalId: principal, generation: 1),
        connectorId: '31',
        vehicleId: '9',
        mode: ChargingMode.energy,
        limitValue: 3000,
        key: newChargeStartKey(),
      );
      for (final (status, body, issue) in [
        (409, {'error': 'idempotency_conflict'}, ChargeStartIssue.keyConflict),
        (
          409,
          {'error': 'credit_unavailable'},
          ChargeStartIssue.creditUnavailable,
        ),
        (
          409,
          {'error': 'connector_unavailable'},
          ChargeStartIssue.connectorUnavailable,
        ),
        (
          409,
          {'error': 'connector_busy_or_unknown'},
          ChargeStartIssue.connectorBusy,
        ),
        (
          409,
          {'error': 'tariff_unavailable'},
          ChargeStartIssue.tariffUnavailable,
        ),
        (503, {'error': 'connector_unavailable'}, ChargeStartIssue.uncertain),
        (202, _snapshot('new_server_outcome'), ChargeStartIssue.uncertain),
        (202, _snapshot('active'), ChargeStartIssue.uncertain),
        (202, _snapshot('failed'), ChargeStartIssue.uncertain),
        (202, {'outcome': 'active'}, ChargeStartIssue.uncertain),
      ]) {
        response = reply(status, body);
        await expectLater(
          repository.start(request),
          throwsA(
            isA<ChargeStartException>().having(
              (error) => error.issue,
              'issue',
              issue,
            ),
          ),
        );
      }
    },
  );

  testWidgets('QR start retries auth once and recovers the original request', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(320, 700));
    tester.platformDispatcher.textScaleFactorTestValue = 1.5;
    addTearDown(() async {
      tester.platformDispatcher.clearTextScaleFactorTestValue();
      await tester.binding.setSurfaceSize(null);
    });
    final notFound = Completer<ResponseBody>();
    final older = Completer<ResponseBody>();
    final confirmed = Completer<ResponseBody>();
    final unchanged = Completer<ResponseBody>();
    var connectorStatus = 'Charging';
    var chargePosts = 0;
    var chargeReads = 0;
    final fixture = _fixture((r) async {
      if (r.path.startsWith('connectors/')) {
        return reply(200, _connector(connectorStatus));
      }
      if (r.path == 'auth/refresh') {
        return reply(200, tokens(accessB, login: false));
      }
      if (r.method == 'POST' && r.path == 'charges') {
        switch (++chargePosts) {
          case 1:
            return reply(401, {'error': 'unauthorized'});
          case 2:
            throw DioException(
              requestOptions: r,
              type: DioExceptionType.receiveTimeout,
            );
          default:
            return reply(202, _snapshot('accepted', version: 2));
        }
      }
      if (r.method == 'GET' && r.path.startsWith('charges/')) {
        return switch (++chargeReads) {
          1 => notFound.future,
          2 => older.future,
          3 => unchanged.future,
          4 => confirmed.future,
          _ => throw StateError('Unexpected start-status read'),
        };
      }
      throw StateError('Unexpected ${r.method} ${r.path}');
    });
    final camera = await _openQr(tester, fixture);
    await _scan(tester, camera);
    expect(find.text('Trạm PowerMe T96'), findsOneWidget);
    expect(_key('qr-charge-energy'), findsNothing);
    expect(chargePosts, 0);
    connectorStatus = 'Preparing';
    final rescan = find.text('Quét lại');
    await tester.ensureVisible(rescan);
    await tester.pumpAndSettle();
    expect(rescan.hitTestable(), findsOneWidget);
    await tester.tap(rescan);
    await tester.pumpAndSettle();
    await _scan(tester, camera);
    expect(find.text('Đang chuẩn bị sạc'), findsOneWidget);
    expect(find.text('Trụ PM-T96 · Cổng 2'), findsOneWidget);
    expect(find.text('VinFast VF 8 · 51A-00001'), findsOneWidget);
    expect(find.text('Chuẩn sạc của xe · GB/T'), findsOneWidget);
    expect(chargePosts, 0);
    await _enterLimit(tester, '0,0001');
    await _tap(tester, 'qr-submit-start');
    expect(chargePosts, 0);
    expect(find.textContaining('tối đa 3 chữ số'), findsOneWidget);

    await _enterLimit(tester, '12,345');
    await _tap(tester, 'qr-submit-start', twice: true);
    expect(chargePosts, 2);
    final requests = fixture.requests.where((r) => r.path == 'charges');
    final first = requests.first;
    final key = first.headers['Idempotency-Key'];
    expect(
      key,
      matches(
        r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
      ),
    );
    expect(first.data, {
      'connector_id': '31',
      'vehicle_id': '9',
      'mode': 'energy_kwh',
      'energy_limit_wh': 12345,
    });
    expect(requests.map((r) => r.headers['Authorization']), [
      'Bearer $accessA',
      'Bearer $accessB',
    ]);
    expect(requests.last.headers['Idempotency-Key'], key);
    expect(requests.last.data, first.data);
    expect(fixture.requests.singleWhere((r) => r.path == 'auth/refresh').data, {
      'refresh_token': refreshA,
    });
    expect(find.textContaining('Chưa xác nhận được kết quả'), findsOneWidget);

    await _tap(tester, 'nav-account');
    await tester.pump(const Duration(seconds: 4));
    expect(chargeReads, 0);
    await _tap(tester, 'nav-charging');
    expect(find.textContaining('Chưa xác nhận được kết quả'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 1500));
    await tester.pump(const Duration(seconds: 3));
    expect(chargeReads, 1);
    notFound.complete(reply(404, {'error': 'not_found'}));
    await tester.pumpAndSettle();
    expect(find.textContaining('Chưa tìm thấy yêu cầu'), findsOneWidget);
    await _tap(tester, 'qr-resend-charge');
    expect(chargePosts, 3);
    expect(requests.last.data, first.data);
    expect(requests.last.headers['Idempotency-Key'], key);
    expect(requests.last.headers['Authorization'], 'Bearer $accessB');
    expect(find.textContaining('Đang chờ trụ'), findsOneWidget);
    expect(find.text('Trụ đã bắt đầu phiên sạc.'), findsNothing);
    expect(find.text('Đã chấp nhận'), findsOneWidget);
    expect(find.text('Đã xác nhận'), findsNothing);
    expect(find.text('Phiên bắt đầu'), findsOneWidget);
    expect(find.text('Chưa xác nhận'), findsOneWidget);
    expect(find.text('Đã bắt đầu'), findsNothing);

    expect(_key('qr-check-charge'), findsNothing);
    expect(_key('qr-follow-charge'), findsNothing);
    await tester.pump(const Duration(milliseconds: 1500));
    expect(chargeReads, 2);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    await tester.pump(const Duration(seconds: 10));
    older.complete(reply(200, _snapshot('sent', version: 1)));
    await tester.pumpAndSettle();
    expect(find.text('Đã chấp nhận'), findsOneWidget);
    expect(chargeReads, 2);

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 1500));
    expect(chargeReads, 3);
    await tester.pump(const Duration(seconds: 3));
    expect(chargeReads, 3);
    expect(find.text('Đã chấp nhận'), findsOneWidget);
    unchanged.complete(reply(200, _snapshot('accepted', version: 2)));
    await tester.pumpAndSettle();
    expect(find.text('Đã chấp nhận'), findsOneWidget);

    await tester.pump(const Duration(milliseconds: 1500));
    expect(chargeReads, 4);
    confirmed.complete(
      reply(200, _snapshot('active', session: '78', version: 3)),
    );
    await tester.pumpAndSettle();
    expect(find.text('Trụ đã bắt đầu phiên sạc.'), findsOneWidget);
    expect(find.text('Đã xác nhận'), findsOneWidget);
    expect(find.text('Đã chấp nhận'), findsNothing);
    expect(find.text('Chưa xác nhận'), findsNothing);
    expect(find.text('Đã bắt đầu'), findsOneWidget);
    final milestones = tester.widget<ChargeMilestones>(
      find.byType(ChargeMilestones),
    );
    final acknowledgement = milestones.steps.singleWhere(
      (step) => step.label == 'Trụ phản hồi',
    );
    expect(acknowledgement.icon, Icons.check_rounded);
    expect(acknowledgement.color, PowerMeColors.teal);
    expect(find.text('78'), findsOneWidget);
    expect(_key('qr-submit-start'), findsNothing);
    expect(_key('qr-resend-charge'), findsNothing);

    expect(_key('qr-follow-charge'), findsOneWidget);
    expect(_key('qr-clear-charge'), findsNothing);
    expect(chargePosts, 3);

    final reads = fixture.requests.where((r) => r.path.startsWith('charges/'));
    expect(reads.map((r) => r.path).toSet(), {'charges/$key'});
    expect(
      reads.every((r) => r.headers['Authorization'] == 'Bearer $accessB'),
      isTrue,
    );
    expect(tester.takeException(), isNull);
  });
}

Finder _key(String key) => find.byKey(Key(key));

Future<void> _tap(WidgetTester tester, String key, {bool twice = false}) async {
  await Scrollable.ensureVisible(tester.element(_key(key)), alignment: 0.5);
  await tester.pump();
  await tester.tap(_key(key));
  if (twice) await tester.tap(_key(key));
  await tester.pumpAndSettle();
}

Future<void> _enterLimit(WidgetTester tester, String energy) async {
  await tester.ensureVisible(_key('qr-charge-energy'));
  await tester.pump();
  await tester.enterText(_key('qr-charge-energy'), energy);
  await tester.pumpAndSettle();
}

Future<void> _scan(WidgetTester tester, ScannerPlatformFake camera) async {
  camera.emit('powerme:connector:PM-T96/2');
  await tester.pumpAndSettle();
}

Future<ScannerPlatformFake> _openQr(
  WidgetTester tester,
  DriverApiFixture fixture,
) async {
  final camera = ScannerPlatformFake();
  final previous = MobileScannerPlatform.instance;
  MobileScannerPlatform.instance = camera;
  addTearDown(() => MobileScannerPlatform.instance = previous);
  await tester.pumpWidget(
    ApiApp(
      config: ApiConfig.parse('https://fixture.invalid/api/driver/v1'),
      httpAdapter: fixture,
    ),
  );
  await tester.pumpAndSettle();
  await enterAccount(tester);
  await _tap(tester, 'nav-charging');
  return camera;
}

DriverApiFixture _fixture(
  Future<ResponseBody> Function(RequestOptions) charges, {
  String Function()? selected,
}) => DriverApiFixture((r) async {
  final active = selected?.call() ?? '9';
  return switch ((r.method, r.path)) {
    ('POST', 'auth/login') => reply(200, tokens(accessA)),
    ('GET', 'me') => reply(
      200,
      account(
        vehicles: [
          ownVehicle(isDefault: active == '9'),
          ownVehicle(id: '10', plate: '51A-00002', isDefault: active == '10'),
        ],
      ),
    ),
    ('GET', 'stations') => reply(200, page([])),
    _ => charges(r),
  };
});

Map<String, Object> _connector([String status = 'Available']) => {
  'connector_id': '31',
  'display_code': 'PM-T96',
  'connector_no': 2,
  'site_name': 'Trạm PowerMe T96',
  'is_online': true,
  'status': status,
  'reported_issue': true,
};

Map<String, Object?> _snapshot(
  String outcome, {
  int version = 1,
  String? session,
  int? limit,
}) => {
  'intent_id': '41',
  'command_id': '52',
  'session_id': session,
  'outcome': outcome,
  'effect_confirmed': session != null,
  'version': version,
  'max_energy_wh': limit,
};
