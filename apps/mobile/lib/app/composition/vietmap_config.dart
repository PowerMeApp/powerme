import '../../features/stations/domain/map_location.dart';
import 'dart:convert';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

// Initial viewport only; device position is supplied exclusively by GPS.
const vietmapInitialCenter = MapLocation(10.87534, 106.80003);

final vietmapConfigProvider = Provider<VietmapConfig?>((ref) => null);

class VietmapConfig {
  const VietmapConfig(this._key);
  final String _key;
  bool get configured => _key.trim().isNotEmpty;
  String get styleUrl => Uri.https(
    'maps.vietmap.vn',
    '/maps/styles/dm/style.json',
    {'apikey': _key},
  ).toString();

  static Future<VietmapConfig> load(AssetBundle bundle) async {
    try {
      final data = jsonDecode(
        await bundle.loadString('config/vietmap.local.json'),
      );
      final key = data is Map ? data['apiKey'] : null;
      return VietmapConfig(key is String ? key.trim() : '');
    } catch (_) {
      return const VietmapConfig('');
    }
  }

  @override
  String toString() => 'VietmapConfig(configured: $configured)';
}
