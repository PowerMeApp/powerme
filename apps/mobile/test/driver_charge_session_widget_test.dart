import 'dart:async';

import 'package:dio/dio.dart';
import 'package:driver_app/app/composition/api_app.dart';
import 'package:driver_app/app/router.dart';
import 'package:driver_app/core/api/api_config.dart';
import 'package:driver_app/core/widgets/flow_page.dart' show ValueLine;
import 'package:driver_app/features/charging/presentation/charge_flow_visuals.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'driver_api_fixture.dart';
import 'driver_api_widget_test.dart' show enterAccount;
import 'driver_discovery_fixture.dart' show page;
import 'scanner_platform_fake.dart';

const _connectorPath = 'connectors/by-code/PM-T96/2';
const _progressPath = 'sessions/78/progress';
const _statementPath = 'sessions/78/statement';
const _driver = '7';
const _timestamp = '2026-11-16T01:02:00.000Z';

void main() {
  testWidgets(
    'QR → 5s progress → limit stop → posted statement at 320px/200%',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(320, 700));
      tester.platformDispatcher.textScaleFactorTestValue = 2;
      addTearDown(() async {
        tester.platformDispatcher.clearTextScaleFactorTestValue();
        await tester.binding.setSurfaceSize(null);
      });

      var snapshot = _progress(online: false, health: 'unknown');
      final fixture = _fixture(
        (r) async => switch (r.path) {
          _progressPath => reply(200, snapshot),
          _statementPath => reply(200, _statement()),
          _ => throw StateError('Unexpected ${r.method} ${r.path}'),
        },
      );
      final camera = await _signIn(tester, fixture);
      final router = _container(tester).read(routerProvider);
      router.go('/charge-session');
      await tester.pumpAndSettle();
      expect(router.routeInformationProvider.value.uri.path, '/scan');
      expect(_count(fixture, _progressPath), 0);
      await _start(tester, camera);
      router.go('/charge-session?session_id=79');
      await tester.pumpAndSettle();
      expect(_count(fixture, _progressPath), 0);
      await _tap(tester, _byKey('nav-account'));
      await _tap(tester, _byKey('nav-charging'));
      expect(router.routeInformationProvider.value.uri.path, '/charge-session');
      expect(_byKey('qr-follow-charge'), findsNothing);
      expect(_count(fixture, _progressPath), 1);
      expect(find.text('Đang sạc'), findsOneWidget);
      expect(find.text('Đang chờ trụ báo cáo'), findsNothing);
      await _findText(tester, 'Số liệu sạc có thể chưa được cập nhật.');
      await _findText(tester, 'Chưa có số đo');
      expect(
        tester.widget<ChargeRing>(find.byType(ChargeRing)).fraction,
        isNull,
      );

      snapshot = _progress(consumed: 2500, estimate: 12500);
      await tester.pump(const Duration(seconds: 4));
      expect(_count(fixture, _progressPath), 1);
      await _tick(tester, const Duration(seconds: 1));
      expect(_count(fixture, _progressPath), 2);
      await _findText(tester, '2,5 kWh');
      expect(tester.widget<ChargeRing>(find.byType(ChargeRing)).fraction, .25);
      await _findText(tester, 'Chi phí (tạm tính, tối đa)');
      await _findText(tester, '12.500 đ');
      expect(find.text('Tín dụng đã trừ'), findsNothing);

      snapshot = _progress(
        status: 'closed',
        settlement: 'pending',
        meterStop: 10400,
        energy: 10000,
        health: 'unknown',
        estimate: 50000,
      );
      await _tick(tester);
      await _findText(tester, 'Điện năng khi dừng');
      final finalEnergy = tester.widget<ValueLine>(
        find.ancestor(
          of: find.text('Điện năng khi dừng'),
          matching: find.byType(ValueLine),
        ),
      );
      expect(finalEnergy.value, '10 kWh');
      await _findText(tester, 'Đang chờ quyết toán.');
      expect(_count(fixture, _statementPath), 0);

      snapshot = {...snapshot, 'settlement_state': 'posted'};
      await _tick(tester);
      await _findText(tester, 'Bảng kê phiên sạc');
      await _findText(tester, 'Tín dụng đã trừ');
      await _findText(tester, '45.000 đ');
      await _findText(tester, '45');
      expect(_count(fixture, _statementPath), 1);
      await _tick(tester, const Duration(seconds: 20));
      expect(_count(fixture, _progressPath), 4);
      expect(_count(fixture, _statementPath), 1);
      expect(
        fixture.requests.where((r) => r.method == 'POST').map((r) => r.path),
        ['auth/login', 'charges'],
      );
      expect(tester.takeException(), isNull);
      await _reveal(tester, _byKey('charge-session-return-to-scan'));
      expect(_byKey('charge-session-return-to-scan'), findsOneWidget);
      await _tap(tester, find.byTooltip('Quay lại'));
      await _tick(tester, const Duration(seconds: 10));
      await _reveal(tester, _byKey('qr-manual-reference'));
      expect(_byKey('qr-manual-reference'), findsOneWidget);
      expect(_byKey('qr-follow-charge'), findsNothing);
      expect(_byKey('qr-charge-energy'), findsNothing);
      expect(_count(fixture, _progressPath), 4);
      expect(
        fixture.requests.where((r) => r.path.startsWith('charges/')),
        isEmpty,
      );
      expect(_count(fixture, _connectorPath), 1);

      camera.emit('powerme:connector:PM-T96/2');
      await tester.pumpAndSettle();
      expect(_byKey('qr-charge-energy'), findsOneWidget);
      expect(_count(fixture, _connectorPath), 2);
      expect(_count(fixture, 'charges'), 1);
    },
  );

  testWidgets('one in-flight read, lifecycle cancellation and stale recovery', (
    tester,
  ) async {
    final blocked = Completer<ResponseBody>();
    final abandoned = Completer<ResponseBody>();
    var reads = 0;
    final fixture = _fixture((r) async {
      expect(r.path, _progressPath);
      return switch (++reads) {
        1 => reply(401, {'error': 'unauthorized'}),
        2 => reply(200, _progress(consumed: 1200)),
        3 => blocked.future,
        4 => reply(503, {'error': 'unavailable'}),
        5 => reply(200, _progress(consumed: 9400, at: '2026-11-16T01:01:00Z')),
        6 => reply(200, _progress(status: 'orphaned', online: false)),
        7 => reply(200, _progress(status: 'new_status')),
        8 => abandoned.future,
        _ => reply(200, _progress()),
      };
    });
    await _openProgress(tester, fixture);
    expect(reads, 2);
    expect(_count(fixture, 'auth/refresh'), 1);
    expect(fixture.requests.last.headers['Authorization'], 'Bearer $accessB');
    await _findText(tester, '1,2 kWh');
    await _tick(tester);
    await _tick(tester, const Duration(seconds: 12));
    expect(reads, 3);
    final cancelled = fixture.requests.last.cancelToken!;
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await _tick(tester, const Duration(seconds: 20));
    expect(cancelled.isCancelled, isTrue);
    expect(reads, 3);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await _tick(tester, Duration.zero);
    expect(reads, 4);
    blocked.complete(reply(200, _progress(consumed: 9900)));
    await tester.pumpAndSettle();
    await _findText(
      tester,
      'Chưa cập nhật được. Đang hiển thị số liệu gần nhất.',
    );
    await _findText(tester, '1,2 kWh');
    expect(find.text('9,9 kWh'), findsNothing);
    await _tap(tester, find.text('Thử cập nhật'));
    expect(reads, 5);
    expect(find.text('9,4 kWh'), findsNothing);
    await _tap(tester, find.text('Thử cập nhật'));
    await _findText(tester, 'Đang chờ trụ báo cáo');
    await _tick(tester);
    await _findText(tester, 'Chưa xác định');
    await _findText(tester, 'Chưa có số đo');
    await _tick(tester);
    expect(reads, 8);
    final leaving = fixture.requests.last.cancelToken!;
    await _tap(tester, find.byTooltip('Quay lại'));
    expect(leaving.isCancelled, isTrue);
    expect(_byKey('qr-follow-charge'), findsOneWidget);
    expect(_byKey('qr-clear-charge'), findsNothing);
    expect(_byKey('qr-manual-reference'), findsNothing);
    abandoned.complete(
      reply(200, _progress(status: 'closed', meterStop: 9999)),
    );
    await _tick(tester);
    expect(reads, 9);
    await tester.pumpAndSettle();
    expect(_byKey('qr-follow-charge'), findsOneWidget);
    expect(_byKey('qr-clear-charge'), findsNothing);
    expect(_count(fixture, 'charges'), 1);
  });
}

final _config = ApiConfig.parse('https://fixture.invalid/api/driver/v1');

DriverApiFixture _fixture(
  Future<ResponseBody> Function(RequestOptions) charge,
) => DriverApiFixture(
  (r) async => switch ((r.method, r.path)) {
    ('POST', 'auth/login') => reply(200, tokens(accessA)),
    ('POST', 'auth/refresh') => reply(200, tokens(accessB, login: false)),
    ('GET', 'me') => reply(200, account(id: _driver)),
    ('GET', 'stations') => reply(200, page([])),
    ('GET', _connectorPath) => reply(200, {
      'connector_id': '31',
      'display_code': 'PM-T96',
      'connector_no': 2,
      'site_name': 'Trạm PowerMe T96',
      'is_online': true,
      'status': 'Preparing',
      'reported_issue': true,
    }),
    ('POST', 'charges') => reply(202, _startedCharge()),
    _ when r.method == 'GET' && r.path.startsWith('charges/') => reply(
      200,
      _startedCharge(),
    ),
    _ => charge(r),
  },
);

Map<String, Object?> _startedCharge() => {
  'intent_id': '41',
  'command_id': '52',
  'session_id': '78',
  'outcome': 'active',
  'effect_confirmed': true,
  'version': 1,
  'max_energy_wh': null,
};

Map<String, Object?> _progress({
  String status = 'active',
  String health = 'observed',
  String at = _timestamp,
  String? settlement,
  int? consumed,
  int? meterStop,
  int? energy,
  int? estimate,
  bool online = true,
  bool review = false,
}) => {
  'session_id': '78',
  'status': status,
  'updated_at': at,
  'meter_start_wh': 400,
  'meter_stop_wh': meterStop,
  'energy_wh': energy,
  'consumed_wh': consumed,
  'telemetry_quality': health,
  'limit_value': 10000,
  'estimated_cost_vnd': estimate,
  'settlement_state': settlement,
  'billing_review_required': review,
  'time_left': null,
  'charge_point': {'lifecycle': 'active', 'is_online': online},
};

Map<String, Object> _statement() => {
  'session_id': '78',
  'driver_id': _driver,
  'energy_wh': 10000,
  'amount_vnd': 45000,
  'earned_points': 45,
  'debit_id': '25',
  'loyalty_entry_id': '26',
  'created_at': '2026-11-16T01:03:00Z',
};

int _count(DriverApiFixture fixture, String path) =>
    fixture.requests.where((r) => r.path == path).length;

ProviderContainer _container(WidgetTester tester) =>
    ProviderScope.containerOf(tester.element(find.byType(Scaffold).first));

Finder _byKey(String key) => find.byKey(Key(key));

Future<void> _tick(
  WidgetTester tester, [
  Duration elapsed = const Duration(seconds: 5),
]) async {
  await tester.pump(elapsed);
  await tester.pumpAndSettle();
}

Future<void> _findText(WidgetTester tester, String text) async {
  await _reveal(tester, find.text(text));
  expect(find.text(text), findsWidgets);
}

Future<void> _reveal(WidgetTester tester, Finder finder) async {
  if (finder.evaluate().isEmpty &&
      find.byType(Scrollable).evaluate().isNotEmpty) {
    final scrollable = find.byType(Scrollable).first;
    tester.state<ScrollableState>(scrollable).position.jumpTo(0);
    await tester.pump();
    if (finder.evaluate().isEmpty) {
      await tester.scrollUntilVisible(finder, 170, scrollable: scrollable);
    }
  }
  await Scrollable.ensureVisible(tester.element(finder.first), alignment: .5);
  await tester.pump();
}

Future<void> _tap(WidgetTester tester, Finder finder) async {
  await _reveal(tester, finder);
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

Future<ScannerPlatformFake> _signIn(
  WidgetTester tester,
  DriverApiFixture fixture,
) async {
  final camera = ScannerPlatformFake();
  final previous = MobileScannerPlatform.instance;
  MobileScannerPlatform.instance = camera;
  addTearDown(() => MobileScannerPlatform.instance = previous);
  await tester.pumpWidget(ApiApp(config: _config, httpAdapter: fixture));
  await tester.pumpAndSettle();
  await enterAccount(tester);
  return camera;
}

Future<void> _start(WidgetTester tester, ScannerPlatformFake camera) async {
  await _tap(tester, _byKey('nav-charging'));
  camera.emit('powerme:connector:PM-T96/2');
  await tester.pumpAndSettle();
  await _submitStart(tester);
}

Future<void> _submitStart(WidgetTester tester) async {
  final limit = _byKey('qr-charge-energy');
  await _reveal(tester, limit);
  await tester.enterText(limit, '10');
  await tester.pumpAndSettle();
  await _tap(tester, _byKey('qr-submit-start'));
}

Future<void> _openProgress(
  WidgetTester tester,
  DriverApiFixture fixture,
) async {
  await _start(tester, await _signIn(tester, fixture));
  await _tap(tester, _byKey('qr-follow-charge'));
}
