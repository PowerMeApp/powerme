import 'dart:async';
import 'dart:convert';
import 'package:driver_app/app/composition/vietmap_config.dart';
import 'package:driver_app/features/auth/application/auth_controller.dart';
import 'package:driver_app/features/auth/domain/auth_scope.dart';
import 'package:driver_app/features/stations/application/map_location_controller.dart';
import 'package:driver_app/features/stations/domain/map_location.dart';
import 'package:driver_app/features/stations/presentation/vietmap_surface.dart';
import 'package:flutter/material.dart';
import 'package:driver_app/features/stations/presentation/road_map_canvas.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class _Bundle extends CachingAssetBundle {
  _Bundle(this.content);
  final String content;
  @override
  Future<ByteData> load(String key) async =>
      ByteData.sublistView(Uint8List.fromList(utf8.encode(content)));
}

class _Location implements MapLocationRepository {
  int calls = 0;
  final result = Completer<MapLocation>();
  @override
  Future<MapLocation> current() {
    ++calls;
    return result.future;
  }
}

void main() {
  test(
    'Config invalid/missing data stays unconfigured; no key in diagnostics',
    () async {
      expect((await VietmapConfig.load(_Bundle('invalid'))).configured, false);
      expect(
        (await VietmapConfig.load(_Bundle('{"apiKey":42}'))).configured,
        false,
      );
      final config = await VietmapConfig.load(
        _Bundle('{"apiKey":"test value"}'),
      );
      expect(config.configured, true);
      final uri = Uri.parse(config.styleUrl);
      expect(uri.host, 'maps.vietmap.vn');
      expect(uri.path, '/maps/styles/dm/style.json');
      expect(uri.queryParameters['apikey'], 'test value');
      expect(config.toString(), isNot(contains('test value')));
    },
  );
  test(
    'Location only on intent, coalesces repeated taps, ignores disposed response',
    () async {
      final repo = _Location();
      final container = ProviderContainer(
        overrides: [
          authScopeProvider.overrideWithValue(
            const AuthScope(principalId: 'driver', generation: 1),
          ),
          mapLocationRepositoryProvider.overrideWithValue(repo),
        ],
      );
      final sub = container.listen(mapLocationControllerProvider, (_, _) {});
      final controller = container.read(mapLocationControllerProvider.notifier);
      expect(repo.calls, 0);
      final pending = controller.locate();
      await controller.locate();
      expect(repo.calls, 1);
      sub.close();
      container.dispose();
      repo.result.complete(const MapLocation(10, 106));
      await pending;
    },
  );
  for (final issue in LocationIssue.values) {
    test(
      'Location failure $issue stays explicit without fake coordinates',
      () async {
        final repo = _Location();
        final container = ProviderContainer(
          overrides: [
            authScopeProvider.overrideWithValue(
              const AuthScope(principalId: 'driver', generation: 1),
            ),
            mapLocationRepositoryProvider.overrideWithValue(repo),
          ],
        );
        final sub = container.listen(mapLocationControllerProvider, (_, _) {});
        final pending = container
            .read(mapLocationControllerProvider.notifier)
            .locate();
        repo.result.completeError(LocationFailure(issue));
        await pending;
        expect(container.read(mapLocationControllerProvider).issue, issue);
        expect(container.read(mapLocationControllerProvider).position, isNull);
        sub.close();
        container.dispose();
      },
    );
  }
  testWidgets(
    'Unconfigured live map shows recoverable state and never local schematic',
    (tester) async {
      final repo = _Location();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            authScopeProvider.overrideWithValue(
              const AuthScope(principalId: 'driver', generation: 1),
            ),
            mapLocationRepositoryProvider.overrideWithValue(repo),
          ],
          child: const MaterialApp(
            home: Scaffold(
              body: VietmapSurface(
                config: VietmapConfig(''),
                padding: EdgeInsets.all(20),
              ),
            ),
          ),
        ),
      );
      expect(find.text('Chưa thể mở bản đồ.'), findsOneWidget);
      expect(repo.calls, 0);
      expect(find.byType(RoadMapCanvas), findsNothing);
    },
  );
}
