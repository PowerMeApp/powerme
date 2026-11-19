import 'dart:io';
import 'dart:ui' as ui;

import 'package:driver_app/app/composition/api_app.dart';
import 'package:driver_app/core/api/api_config.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../test/driver_api_fixture.dart';
import '../test/driver_api_widget_test.dart' show enterAccount;
import '../test/driver_discovery_fixture.dart' show page;
import '../test/scanner_platform_fake.dart';

void main() {
  testWidgets('Capture M06–M09 from the QR and session routes', (tester) async {
    await tester.runAsync(_loadFonts);
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    tester.view.padding = const FakeViewPadding(top: 24, bottom: 24);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPadding);

    final camera = ScannerPlatformFake();
    final previous = MobileScannerPlatform.instance;
    MobileScannerPlatform.instance = camera;
    addTearDown(() => MobileScannerPlatform.instance = previous);
    var started = false;
    var stopping = false;
    final adapter = DriverApiFixture(
      (request) async => switch ((request.method, request.path)) {
        ('POST', 'auth/login') => reply(200, tokens(accessA)),
        ('GET', 'me') => reply(
          200,
          account(vehicles: [ownVehicle(model: _ioniq5)]),
        ),
        ('GET', 'stations') => reply(200, page([])),
        ('GET', 'connectors/by-code/PM-T96/2') => reply(200, {
          'connector_id': '31',
          'display_code': 'PM-T96',
          'connector_no': 2,
          'site_name': 'Trạm PowerMe T96',
          'status': 'Preparing',
          'is_online': true,
          'reported_issue': false,
        }),
        ('POST', 'charges') => reply(202, _start(started: false)),
        ('GET', final path) when path.startsWith('charges/') => reply(
          200,
          _start(started: started),
        ),
        ('POST', 'sessions/78/stop') => reply(202, {
          'command_id': '53',
          'command_status': 'accepted',
          'session_status': 'stopping',
          'effect_confirmed': false,
        }),
        ('GET', 'sessions/78/progress') => reply(200, {
          'session_id': '78',
          'status': stopping ? 'stopping' : 'active',
          'updated_at': '2026-11-16T01:02:00Z',
          'meter_start_wh': 400,
          'meter_stop_wh': null,
          'energy_wh': null,
          'consumed_wh': 24650,
          'limit_value': 35000,
          'estimated_cost_vnd': 94900,
          'telemetry_quality': 'observed',
          'charge_point': {'is_online': true},
        }),
        _ => throw StateError('Unexpected ${request.method} ${request.path}'),
      },
    );
    final boundaryKey = GlobalKey();
    await tester.pumpWidget(
      RepaintBoundary(
        key: boundaryKey,
        child: ApiApp(
          config: ApiConfig.parse('https://fixture.invalid/api/driver/v1'),
          httpAdapter: adapter,
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.runAsync(
      () => precacheImage(
        const AssetImage('assets/brand/powerme-secondary-icon.png'),
        boundaryKey.currentContext!,
      ),
    );
    await enterAccount(tester);

    Future<void> tap(String key) async {
      final target = find.byKey(Key(key));
      if (target.hitTestable().evaluate().isEmpty) {
        await tester.ensureVisible(target);
        await tester.pumpAndSettle();
      }
      expect(target.hitTestable(), findsOneWidget, reason: key);
      await tester.tap(target);
      await tester.pumpAndSettle();
    }

    Future<void> capture(String name) async {
      expect(tester.takeException(), isNull);
      final boundary =
          boundaryKey.currentContext!.findRenderObject()!
              as RenderRepaintBoundary;
      await tester.runAsync(() async {
        final output = File('build/previews/stitch-charging/$name.png');
        await output.parent.create(recursive: true);
        final image = await boundary.toImage();
        expect((image.width, image.height), (390, 844));
        final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
        await output.writeAsBytes(bytes!.buffer.asUint8List());
        image.dispose();
      });
    }

    await tap('nav-charging');
    camera.emit('powerme:connector:PM-T96/2');
    await tester.pumpAndSettle();
    expect(find.text('Hyundai IONIQ 5 · 51A-00001'), findsOneWidget);
    expect(find.text('Chuẩn sạc của xe · CCS2'), findsOneWidget);
    await capture('M06-connector');
    await tester.enterText(find.byKey(const Key('qr-charge-energy')), '35');
    await tap('qr-submit-start');
    expect(find.text('Đã chấp nhận'), findsOneWidget);
    expect(find.byKey(const Key('qr-follow-charge')), findsNothing);
    await capture('M07-start-pending');

    started = true;
    await tester.pump(const Duration(milliseconds: 1500));
    await tester.pumpAndSettle();
    await tap('qr-follow-charge');
    await capture('M08-active');

    await tap('request-stop-charging');
    expect(adapter.requests.where((r) => r.path.endsWith('/stop')), isEmpty);
    await capture('M09-A-confirm-stop');

    stopping = true;
    await tap('confirm-stop-charging');
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
    expect(find.text('Yêu cầu dừng sạc'), findsOneWidget);
    expect(find.text('Chờ xác nhận dừng'), findsOneWidget);
    await capture('M09-stop-pending');
  });
}

const _ioniq5 = {
  'vehicle_model_id': '30',
  'brand': 'Hyundai',
  'model_name': 'IONIQ 5',
  'connector_type': 'ccs2',
  'is_vinfast': false,
  'battery_capacity_kwh': null,
  'rated_range_km': null,
  'max_dc_kw': null,
};

Map<String, Object?> _start({required bool started}) => {
  'intent_id': '41',
  'command_id': '52',
  'session_id': started ? '78' : null,
  'outcome': started ? 'active' : 'accepted',
  'effect_confirmed': started,
  'version': started ? 2 : 1,
  'max_energy_wh': null,
};

Future<void> _loadFonts() async {
  const fonts = String.fromEnvironment('POWERME_PREVIEW_FONTS');
  expect(fonts, isNotEmpty, reason: 'Pass POWERME_PREVIEW_FONTS from the SDK.');
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
}
