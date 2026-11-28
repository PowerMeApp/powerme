import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:dio/dio.dart';
import 'package:driver_app/app/composition/api_app.dart';
import 'package:driver_app/app/router.dart';
import 'package:driver_app/core/api/api_config.dart';
import 'package:driver_app/core/api/driver_api_session.dart';
import 'package:driver_app/core/widgets/flow_page.dart' show ValueLine;
import 'package:driver_app/features/auth/application/auth_controller.dart';
import 'package:driver_app/features/charging/presentation/charge_flow_visuals.dart';
import 'package:driver_app/features/charging/application/charge_session_controller.dart';
import 'package:driver_app/features/profile/domain/driver_profile.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'driver_api_fixture.dart';
import 'driver_api_widget_test.dart' show enterAccount;
import 'driver_discovery_fixture.dart' show page;
import 'scanner_platform_fake.dart';
import 't146_session_widget_test.dart' as journey;
import '../tool/capture_t146_sessions_test.dart' show loadFonts;

const _connectorPath = 'connectors/by-code/PM-T96/2';
const _progressPath = 'sessions/78/progress';
const _stopPath = 'sessions/78/stop';
const _statementPath = 'sessions/78/statement';
const _driver = '7';
const _msg30Vi =
    'Phiên sạc đã kết thúc tại trụ. Bảng kê của bạn sẽ sớm được hiển thị.';
const _msg30En =
    'This session has already ended at the charge point. Your charging statement will appear shortly.';
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
      expect(_count(fixture, _progressPath), 1);
      await _tap(tester, _byKey('nav-account'));
      await _tap(tester, _byKey('nav-charging'));
      expect(router.routeInformationProvider.value.uri.path, '/charge-session');
      expect(_byKey('qr-follow-charge'), findsNothing);
      expect(_count(fixture, _progressPath), 2);
      expect(find.text('Đang sạc'), findsOneWidget);
      expect(find.text('Đang chờ trụ báo cáo'), findsNothing);
      await _findText(tester, 'Số liệu sạc có thể chưa được cập nhật.');
      await _findText(tester, 'Chưa có số đo');
      expect(
        tester.widget<ChargeRing>(find.byType(ChargeRing)).fraction,
        isNull,
      );

      snapshot = _progress(consumed: 2500, estimate: 12500);
      final beforeSample = _count(fixture, _progressPath);
      await _tick(tester);
      expect(_count(fixture, _progressPath), beforeSample + 1);
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
      final settledReads = _count(fixture, _progressPath);
      await _tick(tester, const Duration(seconds: 20));
      expect(_count(fixture, _progressPath), settledReads);
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
      expect(_count(fixture, _progressPath), settledReads);
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

  testWidgets(
    'foreground QR detects the end and offers the session or scanner',
    (tester) async {
      final interrupted = Completer<ResponseBody>();
      final completed = _progress(status: 'review', meterStop: 500);
      var reads = 0;
      final fixture = _fixture((request) async {
        expect(request.path, _progressPath);
        return switch (++reads) {
          1 => reply(200, _progress()),
          2 => interrupted.future,
          3 => reply(
            200,
            _progress(
              status: 'closed',
              meterStop: 500,
              at: '2026-11-16T01:01:00Z',
            ),
          ),
          4 => reply(200, {...completed, 'session_id': '79'}),
          _ => reply(200, completed),
        };
      });
      await _start(tester, await _signIn(tester, fixture));
      await _tap(tester, find.byTooltip('Quay lại'));
      expect(reads, 1);
      expect(_byKey('qr-clear-charge'), findsNothing);
      await _tick(tester);
      await _tick(tester);
      await _tick(tester);
      expect(reads, 2);
      final backgroundRead = fixture.requests
          .lastWhere((r) => r.path == _progressPath)
          .cancelToken!;
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await _tick(tester, const Duration(seconds: 20));
      expect(backgroundRead.isCancelled, isTrue);
      expect(reads, 2);
      interrupted.complete(reply(200, completed));

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      await _tick(tester);
      expect(reads, 3);
      expect(_byKey('qr-clear-charge'), findsNothing);
      await _tick(tester);
      expect(reads, 4);
      expect(_byKey('qr-clear-charge'), findsNothing);
      await _tick(tester);
      expect(reads, 5);
      await _findText(tester, 'Phiên sạc đã kết thúc.');
      await _findText(tester, 'Quét mã khác');
      await _tap(tester, find.text('Xem phiên đã kết thúc'));
      await _findText(tester, 'Phiên đang chờ kiểm tra để quyết toán.');
      await _tap(tester, _byKey('charge-session-return-to-scan'));
      expect(_byKey('qr-manual-reference'), findsOneWidget);
      expect(_byKey('qr-follow-charge'), findsNothing);
      expect(reads, 6);
      expect(_count(fixture, 'charges'), 1);
    },
  );

  testWidgets('scan another code clears the previous manual entry from QR', (
    tester,
  ) async {
    final fixture = _fixture((request) async {
      expect(request.path, _progressPath);
      return reply(200, _progress(status: 'closed', meterStop: 400));
    });
    await _signIn(tester, fixture);
    await _tap(tester, _byKey('nav-charging'));
    final reference = _byKey('qr-manual-reference');
    await _reveal(tester, reference);
    await tester.enterText(reference, 'PM-T96/2');
    await _tap(tester, _byKey('qr-connect'));
    await _submitStart(tester);

    await _tick(tester);
    await _tap(tester, _byKey('charge-session-return-to-scan'));
    expect(tester.widget<TextField>(reference).controller!.text, isEmpty);
    expect(_byKey('qr-charge-energy'), findsNothing);
    expect(_count(fixture, _connectorPath), 1);
    expect(_count(fixture, _statementPath), 0);
    expect(_count(fixture, 'charges'), 1);
  });

  testWidgets('billing review, missing ownership and ineligible are bounded', (
    tester,
  ) async {
    var response = reply(200, _progress(status: 'review'));
    final fixture = _fixture((r) async {
      expect(r.path, _progressPath);
      return response;
    });
    await _openProgress(tester, fixture);
    await _findText(tester, 'Phiên đang chờ kiểm tra để quyết toán.');
    await _tick(tester, const Duration(seconds: 20));
    expect(_count(fixture, _progressPath), 1);
    response = reply(
      200,
      _progress(
        status: 'closed',
        settlement: 'posted',
        meterStop: 0,
        review: true,
      ),
    );
    await _tap(tester, find.text('Thử cập nhật'));
    await _findText(tester, 'Phiên đang chờ kiểm tra để quyết toán.');
    await _tick(tester, const Duration(seconds: 10));
    expect(_count(fixture, _progressPath), 2);
    response = reply(200, {..._progress(), 'session_id': '79'});
    await _tap(tester, find.text('Thử cập nhật'));
    expect(find.text('Không tìm thấy phiên sạc.'), findsOneWidget);
    expect(find.text('Trạng thái phiên'), findsNothing);
    response = reply(404, {'error': 'not_found'});
    await _tap(tester, find.text('Thử cập nhật'));
    await _tick(tester, const Duration(seconds: 20));
    expect(_count(fixture, _progressPath), 4);
    response = reply(
      200,
      _progress(
        status: 'reconciled',
        settlement: 'ineligible',
        meterStop: 0,
        energy: 0,
      ),
    );
    await _tap(tester, find.text('Thử cập nhật'));
    await _findText(tester, 'Phiên này không có bảng kê quyết toán.');
    await _tick(tester, const Duration(seconds: 20));
    expect(_count(fixture, _progressPath), 5);
    expect(_count(fixture, _statementPath), 0);
  });

  testWidgets(
    'statement recovery uses saved eligibility and verifies ownership',
    (tester) async {
      var meterAvailable = false;
      var reads = 0;
      final fixture = _fixture((r) async {
        if (r.path == _progressPath) {
          return reply(
            200,
            _progress(
              status: 'reconciled',
              settlement: 'posted',
              meterStop: meterAvailable ? 0 : null,
            ),
          );
        }
        expect(r.path, _statementPath);
        return switch (++reads) {
          1 => reply(404, {'error': 'not_found'}),
          2 => reply(200, {..._statement(), 'driver_id': '8'}),
          3 => reply(200, {..._statement(), 'session_id': '79'}),
          4 => reply(503, {'error': 'unavailable'}),
          5 => reply(200, {..._statement(), 'amount_vnd': '100'}),
          _ => reply(200, {
            ..._statement(),
            'energy_wh': 0,
            'amount_vnd': 0,
            'earned_points': 0,
          }),
        };
      });
      await _openProgress(tester, fixture);
      await _findText(tester, 'Chưa có chỉ số chốt để xác nhận bảng kê.');
      expect(reads, 0);
      meterAvailable = true;
      await _tap(tester, find.text('Thử cập nhật'));
      await _findText(tester, 'Bảng kê chưa có. Bạn có thể thử tải lại.');
      await _tick(tester, const Duration(seconds: 20));
      expect(reads, 1);
      for (var attempt = 2; attempt <= 6; attempt++) {
        await _tap(tester, find.text('Tải lại bảng kê'));
        expect(reads, attempt);
        if (attempt < 6) expect(find.text('Tín dụng đã trừ'), findsNothing);
      }
      await _findText(tester, '0 kWh');
      await _findText(tester, '0 đ');
      await _findText(tester, '0');
      expect(_count(fixture, _progressPath), 2);
    },
  );

  testWidgets(
    'logout rejects a late statement and direct access after re-login',
    (tester) async {
      final delayed = Completer<ResponseBody>();
      final fixture = _fixture(
        (r) async => switch (r.path) {
          _progressPath => reply(
            200,
            _progress(status: 'closed', settlement: 'posted', meterStop: 0),
          ),
          _statementPath => delayed.future,
          _ => throw StateError('Unexpected ${r.method} ${r.path}'),
        },
      );
      await _openProgress(tester, fixture);
      final scope = _container(tester);
      final token = fixture.requests.last.cancelToken!;
      scope.read(authControllerProvider.notifier).signOut();
      await tester.pumpAndSettle();
      expect(token.isCancelled, isTrue);
      await enterAccount(tester);
      delayed.complete(reply(200, _statement()));
      scope.read(routerProvider).go('/charge-session');
      await tester.pumpAndSettle();
      expect(_byKey('qr-manual-reference'), findsOneWidget);
      expect(find.text('Bảng kê phiên sạc'), findsNothing);
      expect(_count(fixture, _progressPath), 1);
      expect(_count(fixture, _statementPath), 1);
    },
  );

  testWidgets('tab switches keep a settling target until returning to scan', (
    tester,
  ) async {
    var snapshot = _progress(
      status: 'closed',
      settlement: 'pending',
      meterStop: 10400,
      energy: 10000,
    );
    final fixture = _fixture(
      (r) async => switch (r.path) {
        _progressPath => reply(200, snapshot),
        _statementPath => reply(200, _statement()),
        _ => throw StateError('Unexpected ${r.method} ${r.path}'),
      },
    );
    final camera = await _signIn(tester, fixture);
    await _start(tester, camera);
    final router = _container(tester).read(routerProvider);
    await _tap(tester, _byKey('nav-charging'));
    final cameraStarts = camera.starts;
    await _findText(tester, 'Đang chờ quyết toán.');
    await _tap(tester, _byKey('nav-account'));
    final before = _count(fixture, _progressPath);
    await _tick(tester, const Duration(seconds: 12));
    expect(_count(fixture, _progressPath), before);
    expect(camera.starts, cameraStarts);

    await _tap(tester, _byKey('nav-charging'));
    expect(router.routeInformationProvider.value.uri.path, '/charge-session');
    await _findText(tester, 'Đang chờ quyết toán.');
    snapshot = {...snapshot, 'settlement_state': 'posted'};
    await _tick(tester);
    await _findText(tester, 'Bảng kê phiên sạc');
    await _tap(tester, _byKey('nav-discovery'));
    await _tap(tester, _byKey('nav-charging'));
    await _findText(tester, 'Bảng kê phiên sạc');
    expect(camera.starts, cameraStarts);

    await _tap(tester, _byKey('charge-session-return-to-scan'));
    expect(router.routeInformationProvider.value.uri.path, '/scan');
    expect(_byKey('qr-manual-reference'), findsOneWidget);
    await _tap(tester, _byKey('nav-account'));
    await _tap(tester, _byKey('nav-charging'));
    expect(router.routeInformationProvider.value.uri.path, '/scan');
    expect(_byKey('qr-follow-charge'), findsNothing);
  });

  testWidgets('stop sheet at 320px/200% stays live and Back cancels', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(320, 600));
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(() async {
      tester.platformDispatcher.clearTextScaleFactorTestValue();
      await tester.binding.setSurfaceSize(null);
    });

    var snapshot = _progress(consumed: 2500, estimate: 12500);
    final fixture = _fixture((request) async {
      expect(request.path, _progressPath);
      return reply(200, snapshot);
    });
    await _openProgress(tester, fixture);
    await _tap(tester, _byKey('request-stop-charging'));
    final sheet = find.byType(BottomSheet);
    expect(sheet, findsOneWidget);
    final confirm = _byKey('confirm-stop-charging');
    await _reveal(tester, confirm);
    expect(confirm.hitTestable(), findsOneWidget);
    expect(_count(fixture, _stopPath), 0);
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(sheet, findsNothing);
    expect(_count(fixture, _stopPath), 0);

    await _tap(tester, _byKey('request-stop-charging'));
    snapshot = _progress(
      status: 'closed',
      settlement: 'pending',
      meterStop: 0,
      energy: 0,
    );
    await _tick(tester);
    expect(_count(fixture, _progressPath), 2);
    expect(tester.widget<FilledButton>(confirm).onPressed, isNull);
    await _tap(tester, find.byKey(const Key('continue-charging')));
    expect(sheet, findsNothing);
    expect(_byKey('request-stop-charging'), findsNothing);
    expect(_count(fixture, _stopPath), 0);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'lost stop response retries the original key and waits for effect',
    (tester) async {
      var snapshot = _progress(status: 'paused');
      final requests = <RequestOptions>[];
      final fixture = _fixture((request) async {
        if (request.path == _progressPath) return reply(200, snapshot);
        if (request.path == _statementPath) return reply(200, _statement());
        expect(request.path, _stopPath);
        expect(request.method, 'POST');
        expect(request.data, isNull);
        requests.add(request);
        if (requests.length == 1) {
          throw DioException(
            requestOptions: request,
            type: DioExceptionType.receiveTimeout,
          );
        }
        return reply(202, _stopSnapshot('accepted', 'stopping'));
      });
      await _openProgress(tester, fixture);
      await _tap(tester, _byKey('request-stop-charging'));
      expect(requests, isEmpty);
      await _tap(tester, find.byKey(const Key('continue-charging')));
      expect(requests, isEmpty);
      await _tap(tester, _byKey('request-stop-charging'));
      await _tap(tester, _byKey('confirm-stop-charging'));
      expect(requests, hasLength(1));
      final original = requests.single.headers['Idempotency-Key'];
      expect(original, matches(RegExp(r'^[a-f0-9-]{36}$')));
      await _findText(
        tester,
        'Chưa nhận được phản hồi. Bạn có thể gửi lại cùng yêu cầu.',
      );

      snapshot = _progress(status: 'stopping');
      await _tick(tester);
      expect(requests, hasLength(1));
      await _tap(tester, find.byTooltip('Quay lại'));
      await _tap(tester, _byKey('qr-follow-charge'));
      await _tap(tester, _byKey('retry-stop-charging'));
      expect(requests, hasLength(2));
      expect(requests.last.headers['Idempotency-Key'], original);
      await _findText(
        tester,
        'Đã ghi nhận yêu cầu dừng. Đang cập nhật tiến độ phiên.',
      );
      expect(find.text('Bảng kê phiên sạc'), findsNothing);
      expect(_count(fixture, _statementPath), 0);
      expect(_byKey('retry-stop-charging'), findsNothing);

      snapshot = _progress(
        status: 'closed',
        settlement: 'pending',
        meterStop: 0,
      );
      await _tick(tester);
      await _findText(tester, 'Đang chờ quyết toán.');
      expect(_count(fixture, _statementPath), 0);
      snapshot = {...snapshot, 'settlement_state': 'posted'};
      await _tick(tester);
      await _findText(tester, 'Tín dụng đã trừ');
      expect(_count(fixture, _statementPath), 1);
      expect(requests, hasLength(2));
      final progressReads = _count(fixture, _progressPath);
      await tester.binding.handlePopRoute();
      await _tick(tester, const Duration(seconds: 10));
      expect(_byKey('qr-manual-reference'), findsOneWidget);
      expect(_byKey('qr-follow-charge'), findsNothing);
      expect(_count(fixture, _progressPath), progressReads);
      expect(
        fixture.requests.where((r) => r.path.startsWith('charges/')),
        isEmpty,
      );
    },
  );

  testWidgets(
    'rejection permits a new confirmed key, pending conflict blocks it',
    (tester) async {
      final requests = <RequestOptions>[];
      final fixture = _fixture((request) async {
        if (request.path == _progressPath) {
          return reply(200, _progress(status: 'orphaned', online: false));
        }
        expect(request.path, _stopPath);
        requests.add(request);
        return requests.length == 1
            ? reply(202, _stopSnapshot('rejected', 'orphaned'))
            : reply(409, {'error': 'stop_pending_or_unknown'});
      });
      await _openProgress(tester, fixture);
      for (var i = 0; i < 2; i++) {
        await _tap(tester, _byKey('request-stop-charging'));
        await _tap(tester, _byKey('confirm-stop-charging'));
        expect(requests, hasLength(i + 1));
      }
      expect(
        requests.first.headers['Idempotency-Key'],
        isNot(requests.last.headers['Idempotency-Key']),
      );
      await _findText(
        tester,
        'Chưa xác nhận được kết quả dừng. Đang theo dõi phiên.',
      );
      expect(_byKey('request-stop-charging'), findsNothing);
      expect(_byKey('retry-stop-charging'), findsNothing);
      final reads = _count(fixture, _progressPath);
      await _tick(tester);
      expect(_count(fixture, _progressPath), greaterThan(reads));
      expect(requests, hasLength(2));
    },
  );

  testWidgets('a recovered rejection does not prove the intent was released', (
    tester,
  ) async {
    final keys = <Object?>[];
    final fixture = _fixture((request) async {
      if (request.path == _progressPath) return reply(200, _progress());
      expect(request.path, _stopPath);
      keys.add(request.headers['Idempotency-Key']);
      if (keys.length == 1) {
        throw DioException(
          requestOptions: request,
          type: DioExceptionType.receiveTimeout,
        );
      }
      return reply(202, _stopSnapshot('rejected', 'active'));
    });
    await _openProgress(tester, fixture);
    await _tap(tester, _byKey('request-stop-charging'));
    await _tap(tester, _byKey('confirm-stop-charging'));
    await _tap(tester, _byKey('retry-stop-charging'));
    expect(keys, hasLength(2));
    expect(keys.first, keys.last);
    await _findText(
      tester,
      'Chưa xác nhận được kết quả dừng. Đang theo dõi phiên.',
    );
    expect(_byKey('request-stop-charging'), findsNothing);
    expect(_byKey('retry-stop-charging'), findsNothing);
  });

  for (final (status, code, message) in [
    (409, 'session_not_stoppable', _msg30Vi),
    (404, 'not_found', 'Không tìm thấy phiên có thể dừng từ ứng dụng.'),
  ]) {
    testWidgets('stop HTTP $status leaves progress authoritative', (
      tester,
    ) async {
      var progress = _progress();
      final fixture = _fixture(
        (request) async => switch (request.path) {
          _progressPath => reply(200, progress),
          _stopPath => reply(status, {'error': code}),
          _ => throw StateError('Unexpected path'),
        },
      );
      await _openProgress(tester, fixture);
      await _tap(tester, _byKey('request-stop-charging'));
      await _tap(tester, _byKey('confirm-stop-charging'));
      await _findText(tester, message);
      expect(find.text('Đang sạc'), findsOneWidget);
      expect(_count(fixture, _statementPath), 0);
      expect(_byKey('request-stop-charging'), findsNothing);
      progress = _progress(
        status: 'closed',
        meterStop: 0,
        settlement: 'pending',
      );
      await _tick(tester);
      await _findText(tester, 'Đang chờ quyết toán.');
      expect(_count(fixture, _stopPath), 1);
    });
  }

  for (final english in [false, true]) {
    testWidgets('T163 MSG30 inline and immediate refresh English=$english', (
      tester,
    ) async {
      await journey.viewport(tester, english);
      const captureDir = String.fromEnvironment('T163_CAPTURE_DIR');
      final boundary = GlobalKey();
      if (captureDir.isNotEmpty) await tester.runAsync(loadFonts);
      var progress = _progress();
      final fixture = _fixture(
        (r) async => switch (r.path) {
          _progressPath => reply(200, progress),
          _stopPath => reply(409, {'error': 'session_not_stoppable'}),
          _statementPath => reply(200, _statement()),
          _ => throw StateError('Unexpected ${r.path}'),
        },
      );
      await _openProgress(tester, fixture, boundaryKey: boundary);
      journey.localize(
        _container(tester),
        english ? AppLanguage.english : AppLanguage.vietnamese,
      );
      await tester.pumpAndSettle();
      final reads = _count(fixture, _progressPath);
      final before = tester.binding.clock.now();
      await _tap(tester, _byKey('request-stop-charging'));
      await _tap(tester, _byKey('confirm-stop-charging'));
      expect(
        tester.binding.clock.now().difference(before),
        lessThan(const Duration(seconds: 5)),
      );
      expect(_count(fixture, _progressPath), reads + 1);
      await _findText(tester, english ? _msg30En : _msg30Vi);
      expect(find.byType(SnackBar), findsNothing);
      expect(_byKey('request-stop-charging'), findsNothing);
      expect(_byKey('retry-stop-charging'), findsNothing);
      final scope = _container(tester);
      final target = scope.read(confirmedChargeSessionProvider)!;
      final staleRead = scope
          .read(chargeSessionRepositoryProvider)
          .progress(target)
          .result;
      await tester.pumpAndSettle();
      final stale = await staleRead;
      for (final retry in [false, true]) {
        await scope
            .read(chargeStopProvider.notifier)
            .send(target, retry: retry, progress: stale);
      }
      expect(_count(fixture, _stopPath), 1);
      expect(_count(fixture, _statementPath), 0);
      progress = _progress(
        status: 'closed',
        meterStop: 10400,
        energy: 10000,
        settlement: 'pending',
      );
      await _tick(tester);
      await _findText(tester, english ? _msg30En : _msg30Vi);
      expect(_count(fixture, _statementPath), 0);
      if (captureDir.isNotEmpty) {
        await tester.runAsync(() async {
          final frame =
              await (boundary.currentContext!.findRenderObject()!
                      as RenderRepaintBoundary)
                  .toImage();
          final bytes = await frame.toByteData(format: ui.ImageByteFormat.png);
          final file = File(
            '$captureDir/${english ? '320-2x-en' : '390-1x-vi'}-msg30.png',
          );
          await file.parent.create(recursive: true);
          await file.writeAsBytes(bytes!.buffer.asUint8List());
          frame.dispose();
        });
      }
      progress = {
        ...progress,
        'settlement_state': 'posted',
        'statement_available': false,
        'origin': 'app_qr',
        'payment_mode': 'csms_billed',
        'can_stop': false,
      };
      await _tick(tester);
      expect(_count(fixture, _statementPath), 0);
      progress = {...progress, 'statement_available': true};
      await _tap(
        tester,
        find.text(english ? 'Refresh progress' : 'Thử cập nhật'),
      );
      expect(_count(fixture, _statementPath), 1);
      expect(_count(fixture, _stopPath), 1);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets(
    'T163 immediate refresh failure retains MSG30 without statement',
    (tester) async {
      var reads = 0;
      final fixture = _fixture(
        (r) async => switch (r.path) {
          _progressPath =>
            ++reads == 1
                ? reply(200, _progress())
                : reply(503, {'error': 'unavailable'}),
          _stopPath => reply(409, {'error': 'session_not_stoppable'}),
          _ => throw StateError('Unexpected ${r.path}'),
        },
      );
      await _openProgress(tester, fixture);
      await _tap(tester, _byKey('request-stop-charging'));
      await _tap(tester, _byKey('confirm-stop-charging'));
      expect(reads, 2);
      await _findText(tester, _msg30Vi);
      expect(_count(fixture, _statementPath), 0);
      expect(_byKey('retry-stop-charging'), findsNothing);
    },
  );

  for (final resume in [false, true]) {
    testWidgets(
      'T163 refresh coalesces behind an inflight read without overlap resume=$resume',
      (tester) async {
        final blocked = Completer<ResponseBody>();
        var reads = 0;
        var active = 0;
        var peak = 0;
        final fixture = _fixture((r) async {
          if (r.path == _stopPath) {
            return reply(409, {'error': 'session_not_stoppable'});
          }
          expect(r.path, _progressPath);
          active++;
          var counted = true;
          r.cancelToken?.whenCancel.then((_) {
            if (counted) active--;
            counted = false;
          });
          if (active > peak) peak = active;
          try {
            return ++reads == 2
                ? await blocked.future
                : reply(200, _progress());
          } finally {
            if (counted) active--;
            counted = false;
          }
        });
        await _openProgress(tester, fixture);
        await _tap(tester, _byKey('request-stop-charging'));
        await _tick(tester);
        expect(reads, 2);
        await _tap(tester, _byKey('confirm-stop-charging'));
        expect(reads, 2);
        if (resume) {
          final view = tester.widget<ListenableBuilder>(
            find
                .byWidgetPredicate(
                  (w) =>
                      w is ListenableBuilder &&
                      w.listenable is ChargeSessionController,
                )
                .first,
          );
          final controller = view.listenable as ChargeSessionController;
          controller.setVisible(false);
          controller.setVisible(true);
          controller.refreshProgress();
          await tester.pumpAndSettle();
          expect(reads, 3);
        }
        blocked.complete(reply(200, _progress()));
        await tester.pumpAndSettle();
        expect(reads, 3);
        expect(peak, 1);
        expect(_count(fixture, _stopPath), 1);
        expect(_count(fixture, _statementPath), 0);
        await _findText(tester, _msg30Vi);
      },
    );
  }

  for (final (status, code) in [
    (202, 'rejected'),
    (409, 'idempotency_conflict'),
    (409, 'other_conflict'),
  ]) {
    testWidgets('T163 excludes MSG30 for $status $code', (tester) async {
      final fixture = _fixture(
        (r) async => r.path == _progressPath
            ? reply(200, _progress())
            : reply(
                status,
                status == 202 ? _stopSnapshot(code, 'closed') : {'error': code},
              ),
      );
      await _openProgress(tester, fixture);
      final reads = _count(fixture, _progressPath);
      await _tap(tester, _byKey('request-stop-charging'));
      await _tap(tester, _byKey('confirm-stop-charging'));
      expect(_count(fixture, _progressPath), reads);
      expect(find.text(_msg30Vi), findsNothing);
      expect(find.text(_msg30En), findsNothing);
      if (status == 202) {
        await _findText(
          tester,
          'Hiện chưa thể yêu cầu dừng phiên. Đang cập nhật tiến độ.',
        );
      }
      expect(_count(fixture, _statementPath), 0);
    });
  }

  for (final logout in [false, true]) {
    testWidgets('T163 late stop guards logout=$logout', (tester) async {
      final delayed = Completer<ResponseBody>();
      final fixture = _fixture(
        (r) async =>
            r.path == _progressPath ? reply(200, _progress()) : delayed.future,
      );
      await _openProgress(tester, fixture);
      await _tap(tester, _byKey('request-stop-charging'));
      await _tap(tester, _byKey('confirm-stop-charging'));
      final reads = _count(fixture, _progressPath);
      if (logout) {
        _container(tester).read(authControllerProvider.notifier).signOut();
      } else {
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      }
      await tester.pumpAndSettle();
      delayed.complete(reply(409, {'error': 'session_not_stoppable'}));
      await tester.pumpAndSettle();
      expect(_count(fixture, _progressPath), reads);
      expect(_count(fixture, _statementPath), 0);
      if (!logout) {
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await tester.pumpAndSettle();
        expect(_count(fixture, _progressPath), reads + 1);
      }
      expect(tester.takeException(), isNull);
    });
  }

  test(
    'session reads reject path injection, out-of-range ID and wrong principal',
    () async {
      final fixture = _fixture(
        (r) async => throw StateError('Unexpected ${r.path}'),
      );
      final session = DriverApiSession(_config, adapter: fixture);
      addTearDown(session.dispose);
      await session.signIn('test@example.invalid', 'fixture password');
      for (final id in [
        '78/statement',
        '78?driver_id=8',
        '01',
        '9007199254740992',
      ]) {
        await expectLater(
          session.readChargeProgress(_driver, id, CancelToken()),
          throwsException,
        );
      }
      await expectLater(
        session.readChargeStatement('8', '78', CancelToken()),
        throwsException,
      );
      expect(fixture.requests.map((r) => r.path), ['auth/login', 'me']);
    },
  );
}

final _config = ApiConfig.parse('https://fixture.invalid/api/driver/v1');

DriverApiFixture _fixture(
  Future<ResponseBody> Function(RequestOptions) charge,
) => DriverApiFixture(
  (r) async => switch ((r.method, r.path)) {
    ('POST', 'auth/login') => reply(200, tokens(accessA)),
    ('POST', 'auth/refresh') => reply(200, tokens(accessB, login: false)),
    ('GET', 'me') => reply(200, account(id: _driver)),
    ('GET', 'sessions') => emptyActiveSessions(r),
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

Map<String, Object> _stopSnapshot(String command, String session) => {
  'command_id': '53',
  'command_status': command,
  'session_status': session,
  'effect_confirmed': false,
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
  DriverApiFixture fixture, {
  GlobalKey? boundaryKey,
}) async {
  final camera = ScannerPlatformFake();
  final previous = MobileScannerPlatform.instance;
  MobileScannerPlatform.instance = camera;
  addTearDown(() => MobileScannerPlatform.instance = previous);
  final app = ApiApp(config: _config, httpAdapter: fixture);
  await tester.pumpWidget(
    boundaryKey == null ? app : RepaintBoundary(key: boundaryKey, child: app),
  );
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
  DriverApiFixture fixture, {
  GlobalKey? boundaryKey,
}) async {
  await _start(
    tester,
    await _signIn(tester, fixture, boundaryKey: boundaryKey),
  );
  expect(
    _container(
      tester,
    ).read(routerProvider).routeInformationProvider.value.uri.path,
    '/charge-session',
  );
  expect(_byKey('qr-follow-charge'), findsNothing);
}
