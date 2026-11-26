import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:dio/dio.dart';
import 'package:flutter/rendering.dart';
import 'package:driver_app/features/profile/domain/driver_profile.dart';
import '../tool/capture_t146_sessions_test.dart' as capture;
import 'package:driver_app/features/charging/application/charge_session_controller.dart';
import 'package:driver_app/features/charging/application/charge_start_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'driver_api_fixture.dart';
import 't146_session_fixture.dart';
import 't146_session_widget_test.dart' as journey;

Map<String, dynamic> pendingRfid() => {
  ...externalProgress(status: 'reconciled', closed: true, costEstimate: 45000),
  'settlement_state': 'pending',
};
Map<String, dynamic> postedRfid() => {
  ...pendingRfid(),
  'settlement_state': 'posted',
  'statement_available': true,
};
Map<String, Object> statement() => {
  'session_id': '78',
  'driver_id': '7',
  'energy_wh': 1200,
  'amount_vnd': 6000,
  'earned_points': 6,
  'debit_id': '21',
  'loyalty_entry_id': '22',
  'created_at': '2026-11-24T02:01:00Z',
};
void main() {
  for (final narrow in [false, true]) {
    testWidgets(
      'RFID pending polls read-only then loads its posted statement once narrow=$narrow',
      (tester) async {
        await journey.viewport(tester, narrow);
        if (const String.fromEnvironment('T148_CAPTURE_DIR') != '') {
          await tester.runAsync(capture.loadFonts);
        }
        var snapshot = pendingRfid();
        final fixture = journey.fixtureWith(
          (r) async => switch (r.path) {
            'sessions' => reply(200, ownedPageJson([ownedSessionJson()])),
            'sessions/78/progress' => reply(200, snapshot),
            'sessions/78/statement' => reply(200, statement()),
            _ => throw StateError('Unexpected ${r.method} ${r.path}'),
          },
          withVehicle: false,
        );
        final boundary = GlobalKey();
        await journey.login(tester, fixture, boundaryKey: boundary);
        if (narrow) {
          journey.localize(journey.container(tester), AppLanguage.english);
          await tester.pumpAndSettle();
        }
        await journey.tap(tester, find.byKey(const Key('nav-charging')));
        final reads = journey.count(fixture, 'sessions/78/progress');
        await journey.reveal(
          tester,
          find.text(narrow ? 'Estimate unavailable' : 'Chưa có tạm tính'),
        );
        expect(find.textContaining('45', skipOffstage: false), findsNothing);
        expect(
          find.text('Không tính qua app', skipOffstage: false),
          findsNothing,
        );
        expect(
          find.text('Not billed in app', skipOffstage: false),
          findsNothing,
        );
        expect(journey.container(tester).read(chargeStartProvider), isNull);
        expect(find.byKey(const Key('request-stop-charging')), findsNothing);
        expect(find.byKey(const Key('retry-stop-charging')), findsNothing);
        await journey.reveal(
          tester,
          find.text(narrow ? 'Settlement is pending.' : 'Đang chờ quyết toán.'),
        );
        expect(
          find.text(narrow ? 'Credit debited' : 'Tín dụng đã trừ'),
          findsNothing,
        );
        final refresh = find.widgetWithText(
          OutlinedButton,
          narrow ? 'Refresh progress' : 'Thử cập nhật',
        );
        await journey.reveal(tester, refresh);
        expect(tester.getSize(refresh).height, greaterThanOrEqualTo(48));
        await captureFrame(tester, boundary, narrow, 'pending');
        snapshot = postedRfid();
        await journey.tick(tester);
        expect(journey.count(fixture, 'sessions/78/progress'), reads + 1);
        await journey.reveal(
          tester,
          find.text(narrow ? 'Charging statement' : 'Bảng kê phiên sạc'),
        );
        expect(journey.count(fixture, 'sessions/78/statement'), 1);
        await journey.reveal(
          tester,
          find.text(narrow ? 'Points earned' : 'Điểm nhận được'),
        );
        expect(
          find.text(narrow ? 'Credit debited' : 'Tín dụng đã trừ'),
          findsOneWidget,
        );
        expect(find.textContaining(narrow ? '6,000' : '6.000'), findsOneWidget);
        expect(find.text('6'), findsOneWidget);
        await captureFrame(tester, boundary, narrow, 'posted');
        await journey.tick(tester, const Duration(seconds: 20));
        expect(journey.count(fixture, 'sessions/78/statement'), 1);
        expect(
          fixture.requests.where((r) => r.method == 'POST').map((r) => r.path),
          ['auth/login'],
        );
        expect(
          journey.container(tester).read(currentChargeStopProvider),
          isNull,
        );
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets(
    'RFID budget expires without resetting; manual refresh recovers the statement',
    (tester) async {
      var snapshot = pendingRfid();
      final fixture = rfidFixture((r) async => reply(200, snapshot));
      await open(tester, fixture);
      await journey.tick(tester);
      expect(journey.count(fixture, 'sessions/78/progress'), 2);
      await journey.tick(tester, const Duration(seconds: 115));
      final expired = journey.count(fixture, 'sessions/78/progress');
      await journey.tick(tester, const Duration(minutes: 1));
      expect(journey.count(fixture, 'sessions/78/progress'), expired);
      await journey.tap(
        tester,
        find.widgetWithText(OutlinedButton, 'Thử cập nhật'),
      );
      expect(journey.count(fixture, 'sessions/78/progress'), expired + 1);
      await journey.tick(tester, const Duration(seconds: 20));
      expect(journey.count(fixture, 'sessions/78/progress'), expired + 1);
      snapshot = postedRfid();
      await journey.tap(
        tester,
        find.widgetWithText(OutlinedButton, 'Thử cập nhật'),
      );
      expect(journey.count(fixture, 'sessions/78/statement'), 1);
      expect(journey.count(fixture, 'sessions/78/progress'), expired + 2);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'RFID no-overlap/background cancellation rejects late posted data; hidden time consumes budget',
    (tester) async {
      final blocked = Completer<ResponseBody>();
      var reads = 0;
      final fixture = rfidFixture(
        (r) async => switch (++reads) {
          1 => reply(200, pendingRfid()),
          2 => blocked.future,
          _ => reply(200, postedRfid()),
        },
      );
      await open(tester, fixture);
      await journey.tick(tester);
      expect(reads, 2);
      await journey.tick(tester, const Duration(seconds: 20));
      expect(reads, 2);
      final cancel = fixture.requests
          .lastWhere((r) => r.path == 'sessions/78/progress')
          .cancelToken!;
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await journey.tick(tester, const Duration(seconds: 120));
      expect(cancel.isCancelled, true);
      expect(reads, 2);
      blocked.complete(reply(200, postedRfid()));
      await tester.pumpAndSettle();
      expect(journey.count(fixture, 'sessions/78/statement'), 0);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(reads, 2);
      await journey.reveal(
        tester,
        find.widgetWithText(OutlinedButton, 'Thử cập nhật'),
      );
      expect(
        tester
            .widget<OutlinedButton>(
              find.widgetWithText(OutlinedButton, 'Thử cập nhật'),
            )
            .onPressed,
        isNotNull,
      );
      await journey.tap(
        tester,
        find.widgetWithText(OutlinedButton, 'Thử cập nhật'),
      );
      expect(reads, 3);
      expect(journey.count(fixture, 'sessions/78/statement'), 1);
      await tester.pumpWidget(const SizedBox());
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'disposing a pending RFID view cancels reads and drops late posted responses',
    (tester) async {
      final blocked = Completer<ResponseBody>();
      var reads = 0;
      final fixture = rfidFixture(
        (r) async => ++reads == 1 ? reply(200, pendingRfid()) : blocked.future,
      );
      await open(tester, fixture);
      await journey.tick(tester);
      final cancel = fixture.requests
          .lastWhere((r) => r.path == 'sessions/78/progress')
          .cancelToken!;
      await tester.pumpWidget(const SizedBox());
      expect(cancel.isCancelled, true);
      blocked.complete(reply(200, postedRfid()));
      await tester.pump(const Duration(minutes: 3));
      expect(reads, 2);
      expect(journey.count(fixture, 'sessions/78/statement'), 0);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'review stays manual and resumes only after server evidence leaves review',
    (tester) async {
      var snapshot = {...pendingRfid(), 'status': 'review'};
      final fixture = rfidFixture((r) async => reply(200, snapshot));
      await open(tester, fixture);
      final before = journey.count(fixture, 'sessions/78/progress');
      await journey.tick(tester, const Duration(seconds: 20));
      expect(journey.count(fixture, 'sessions/78/progress'), before);
      snapshot = pendingRfid();
      await journey.tap(
        tester,
        find.widgetWithText(OutlinedButton, 'Thử cập nhật'),
      );
      snapshot = postedRfid();
      await journey.tick(tester);
      expect(journey.count(fixture, 'sessions/78/statement'), 1);
      await tester.pumpWidget(const SizedBox());
    },
  );
  for (final patch in <Map<String, dynamic>>[
    {'origin': 'free_vend'},
    {'payment_mode': 'unattributed'},
    {'origin': 'future'},
    {'payment_mode': 'future'},
  ]) {
    testWidgets(
      'stopped nonbillable/unknown RFID metadata does not poll: $patch',
      (tester) async {
        final fixture = rfidFixture(
          (r) async => reply(200, {...pendingRfid(), ...patch}),
        );
        await open(tester, fixture);
        final reads = journey.count(fixture, 'sessions/78/progress');

        await journey.tick(tester, const Duration(minutes: 3));
        expect(journey.count(fixture, 'sessions/78/progress'), reads);
        expect(journey.count(fixture, 'sessions/78/statement'), 0);
        expect(find.byKey(const Key('request-stop-charging')), findsNothing);
        expect(find.byKey(const Key('retry-stop-charging')), findsNothing);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }
}

DriverApiFixture rfidFixture(
  Future<ResponseBody> Function(RequestOptions) progress,
) => journey.fixtureWith(
  (r) async => switch (r.path) {
    'sessions' => reply(200, ownedPageJson([ownedSessionJson()])),
    'sessions/78/progress' => progress(r),
    'sessions/78/statement' => reply(200, statement()),
    _ => throw StateError('Unexpected ${r.method} ${r.path}'),
  },
  withVehicle: false,
);
Future<void> open(WidgetTester tester, DriverApiFixture fixture) async {
  await journey.login(tester, fixture);
  await journey.tap(tester, find.byKey(const Key('nav-charging')));
}

Future<void> captureFrame(
  WidgetTester tester,
  GlobalKey boundary,
  bool narrow,
  String state,
) async {
  const output = String.fromEnvironment('T148_CAPTURE_DIR');
  if (output.isEmpty) return;
  await tester.pumpAndSettle();
  await tester.runAsync(() async {
    final image =
        await (boundary.currentContext!.findRenderObject()!
                as RenderRepaintBoundary)
            .toImage();
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await Directory(output).create(recursive: true);
    await File(
      '$output/${narrow ? '320-2x-en' : '390-1x-vi'}-$state.png',
    ).writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
  expect(tester.takeException(), isNull);
}
