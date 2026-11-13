import 'dart:convert';

import 'package:driver_app/app/composition/api_app.dart';
import 'package:driver_app/app/powerme_app.dart';
import 'package:driver_app/core/api/api_config.dart';
import 'package:driver_app/main.dart' as app;
import 'package:flutter/foundation.dart' show FlutterError;
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

const _tunnel = 'http://10.0.2.2:3811/api/driver/v1';
const _https = 'https://fixture.invalid/api/driver/v1';

void main() {
  test('loads the exact configured tunnel URL and consent version', () async {
    final config = await ApiConfig.load(
      _ConfigBundle(
        jsonEncode({
          'API_BASE_URL': _tunnel,
          'API_CONSENT_VERSION': 'fixture-v1',
        }),
      ),
      allowTunnelHttp: true,
    );
    expect(config.baseUrl.toString(), '$_tunnel/');
    expect(config.consentVersion, 'fixture-v1');
  });

  test('rejects missing, malformed, blank or invalid configuration', () async {
    for (final source in <String?>[
      null,
      '',
      '{',
      '[]',
      '{}',
      '{"API_BASE_URL":123}',
      '{"API_BASE_URL":" "}',
      '{"API_BASE_URL":"http://192.0.2.10:3000/api/driver/v1"}',
      '{"API_BASE_URL":"https://fixture.invalid:99999/api/driver/v1"}',
      '{"API_BASE_URL":"$_https","API_CONSENT_VERSION":12}',
      '{"API_BASE_URL":"$_https","API_CONSENT_VERSION":"invalid version"}',
    ]) {
      await expectLater(
        ApiConfig.load(_ConfigBundle(source), allowTunnelHttp: true),
        throwsFormatException,
        reason: 'Invalid fixture: $source',
      );
    }
  });

  test(
    'non-debug startup requires HTTPS and allows no consent version',
    () async {
      await expectLater(
        ApiConfig.load(
          _ConfigBundle('{"API_BASE_URL":"$_tunnel"}'),
          allowTunnelHttp: false,
        ),
        throwsFormatException,
      );
      final config = await ApiConfig.load(
        _ConfigBundle('{"API_BASE_URL":"$_https"}'),
        allowTunnelHttp: false,
      );
      expect(config.baseUrl.toString(), '$_https/');
      expect(config.consentVersion, isNull);
    },
  );

  testWidgets('main reads the bundled config and opens API sign-in', (
    tester,
  ) async {
    _mockRootAsset(tester, '{"API_BASE_URL":"$_tunnel"}');
    await app.main();
    await tester.pumpAndSettle();

    final apiApp = tester.widget<ApiApp>(find.byType(ApiApp));
    expect(apiApp.config.baseUrl.toString(), '$_tunnel/');
    expect(find.text('Đăng ký hiện chưa khả dụng.'), findsOneWidget);
  });

  testWidgets('main shows the connection error when config is missing', (
    tester,
  ) async {
    _mockRootAsset(tester, null);
    await app.main();
    await tester.pumpAndSettle();

    expect(find.text('Không thể kết nối với dịch vụ PowerMe.'), findsOneWidget);
    expect(find.byType(ApiApp), findsNothing);
    expect(find.byType(PowerMeApp), findsNothing);
  });
}

class _ConfigBundle extends CachingAssetBundle {
  _ConfigBundle(this.source);

  final String? source;

  @override
  Future<ByteData> load(String key) async {
    expect(key, ApiConfig.assetPath);
    final data = source;
    if (data == null) throw FlutterError('Missing asset');
    return _assetBytes(data);
  }
}

ByteData _assetBytes(String source) =>
    ByteData.sublistView(Uint8List.fromList(utf8.encode(source)));

void _mockRootAsset(WidgetTester tester, String? source) {
  final messenger = tester.binding.defaultBinaryMessenger;
  rootBundle.evict(ApiConfig.assetPath);
  messenger.setMockMessageHandler('flutter/assets', (message) async {
    if (message != null &&
        utf8.decode(Uint8List.sublistView(message)) == ApiConfig.assetPath) {
      return source == null ? null : _assetBytes(source);
    }
    return messenger.delegate.send('flutter/assets', message);
  });
  addTearDown(() {
    rootBundle.evict(ApiConfig.assetPath);
    messenger.setMockMessageHandler('flutter/assets', null);
  });
}
