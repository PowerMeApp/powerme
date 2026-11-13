import 'dart:convert';

import 'package:flutter/foundation.dart' show FlutterError;
import 'package:flutter/services.dart';

class ApiConfig {
  const ApiConfig._(this.baseUrl, this.consentVersion);

  static const assetPath = 'config/api.local.json';

  final Uri baseUrl;
  final String? consentVersion;

  static Future<ApiConfig> load(
    AssetBundle bundle, {
    required bool allowTunnelHttp,
  }) async {
    final String source;
    try {
      source = await bundle.loadString(assetPath);
    } on FlutterError {
      throw const FormatException('Driver API configuration is unavailable');
    }
    final data = jsonDecode(source);
    if (data is! Map<String, dynamic> ||
        data['API_BASE_URL'] is! String ||
        (data.containsKey('API_CONSENT_VERSION') &&
            data['API_CONSENT_VERSION'] is! String)) {
      throw const FormatException('Invalid Driver API configuration');
    }
    return ApiConfig.parse(
      data['API_BASE_URL'] as String,
      consentVersion: data['API_CONSENT_VERSION'] as String? ?? '',
      allowTunnelHttp: allowTunnelHttp,
    );
  }

  factory ApiConfig.parse(
    String url, {
    String consentVersion = '',
    bool allowTunnelHttp = false,
  }) {
    final uri = Uri.tryParse(url.trim());
    if (uri == null ||
        uri.host.isEmpty ||
        uri.authority.contains('@') ||
        (uri.hasPort && (uri.port < 1 || uri.port > 65535)) ||
        uri.hasQuery ||
        uri.hasFragment ||
        !const {'/api/driver/v1', '/api/driver/v1/'}.contains(uri.path) ||
        (uri.scheme != 'https' &&
            !(uri.scheme == 'http' &&
                allowTunnelHttp &&
                const {
                  'localhost',
                  '127.0.0.1',
                  '10.0.2.2',
                }.contains(uri.host)))) {
      throw const FormatException('Invalid Driver API base URL');
    }
    if (consentVersion.isNotEmpty &&
        !RegExp(r'^[A-Za-z0-9._-]{1,20}$').hasMatch(consentVersion)) {
      throw const FormatException('Invalid Driver API consent version');
    }
    return ApiConfig._(
      uri.replace(path: '/api/driver/v1/'),
      consentVersion.isEmpty ? null : consentVersion,
    );
  }
}
