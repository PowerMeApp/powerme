import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:driver_app/demo/demo_store.dart';
import 'package:driver_app/demo/charging_store.dart';
import 'package:driver_app/demo/charging_engine.dart';
import 'package:driver_app/demo/station_actions_store.dart';
import 'package:driver_app/features/auth/domain/auth_scope.dart';
import 'package:driver_app/features/auth/application/auth_controller.dart';
import 'package:driver_app/features/charging/domain/charging.dart';
import 'package:driver_app/features/charging/data/mock_charging_repository.dart';
import 'package:driver_app/features/charging/application/charging_controller.dart';
import 'package:driver_app/features/stations/data/mock_station_actions_repository.dart';
import 'package:driver_app/features/stations/domain/station_actions.dart';

void main() {
  late DateTime now;
  late DemoStore store;
  late ChargingStore engine;
  late StationActionsStore actions;
  late MockChargingRepository repo;
  Future<SessionSnapshot> tick(String id) async {
    MockChargingEngine(store, engine, actions).step();
    return repo.snapshot(id);
  }

  StartRequest request({
    ChargingMode mode = ChargingMode.energy,
    int? limit = 1000,
    String key = 'start',
  }) => StartRequest(
    scope: store.activeScope,
    connectorId: 'station-powerme-center/1',
    vehicleId: store.profile.vehicleId,
    mode: mode,
    limitValue: limit,
    key: key,
  );
  setUp(() {
    now = DateTime.utc(2026, 10, 29, 3);
    store = DemoStore();
    engine = ChargingStore(clock: () => now);
    actions = StationActionsStore(clock: () => now);
    repo = MockChargingRepository(store, engine, actions, store.activeScope);
  });
  test('Half-up rounds aggregate once, including fractional portions', () {
    expect(aggregateVnd([(1, 4500)]), 5);
    expect(aggregateVnd([(1, 4200)]), 4);
    expect(aggregateVnd([(1, 4500), (1, 4500)]), 9);
  });
  test(
    'Accepted before effect; stable snapshots independent of reads; limit settle once',
    () async {
      final start = await repo.start(request());
      final id = start.sessionId!;
      expect(start.status, CommandState.accepted);
      expect((await tick(id)).state, SessionState.pending);
      expect((await tick(id)).energyWh, isNull);
      now = now.add(const Duration(seconds: 20));
      final first = await tick(id);
      for (var i = 0; i < 20; i++) {
        final repeated = await tick(id);
        expect(repeated.version, first.version);
        expect(repeated.energyWh, first.energyWh);
      }
      expect(first.energyWh, 190);
      now = now.add(const Duration(seconds: 85));
      final closed = await tick(id);
      expect(closed.state, SessionState.reconciled);
      expect(closed.statement!.debitVnd, 4500);
      expect(closed.statement!.earnedPoints, 4);
      expect(store.money.account('driver-minh').entries.length, 1);
      final version = closed.version;
      await repo.stop(id, 'late-stop');
      now = now.add(const Duration(days: 1));
      expect((await tick(id)).version, version);
      expect(store.money.account('driver-minh').entries.length, 1);
    },
  );
  for (final mode in ChargingMode.values) {
    test('Mode ${mode.name} caps credit and enforces limit', () async {
      store.money.account('driver-minh').balanceVnd = 50000;
      final input = mode == ChargingMode.autoFull ? null : 9999999;
      final preview = await repo.preview(
        'station-powerme-center/1',
        store.profile.vehicleId,
        mode,
        input,
      );
      expect(preview.canStart, isTrue);
      if (input != null) expect(preview.effectiveLimit!, lessThan(input));
      final o = await repo.start(
        request(mode: mode, limit: preview.effectiveLimit),
      );
      now = now.add(const Duration(hours: 4));
      final s = await tick(o.sessionId!);
      expect(s.state, SessionState.reconciled);
      expect(s.statement!.debitVnd, lessThanOrEqualTo(40000));
      expect(s.statement!.balanceVnd, greaterThanOrEqualTo(10000));
    });
  }
  test('Atomic same/different keys and cross-owner connector claim', () async {
    final results = await Future.wait([
      repo.start(request()),
      repo.start(request()),
      repo.start(request(key: 'second')),
    ]);
    expect(results[0].sessionId, results[1].sessionId);
    expect(results[2].status, CommandState.rejected);
    expect(engine.sessions.length, 1);
    await expectLater(repo.start(request(limit: 2000)), throwsStateError);
    store.profiles['driver-other'] = store.profile;
    const other = AuthScope(principalId: 'driver-other', generation: 2);
    store.bind(other);
    final r = MockChargingRepository(store, engine, actions, other);
    expect(
      (await r.start(request(key: 'other'))).status,
      CommandState.rejected,
    );
    await expectLater(r.snapshot(results[0].sessionId!), throwsStateError);
    await expectLater(repo.snapshot(results[0].sessionId!), throwsStateError);
  });
  test(
    'Unknown start/stop recover original key, stop accepted before closed',
    () async {
      engine.nextScript = ChargingScript.unknownStart;
      final o = await repo.start(request());
      expect(o.status, CommandState.unknown);
      expect(o.sessionId, isNull);
      expect((await repo.start(request())).status, CommandState.unknown);
      final recovered = await repo.outcome('start');
      expect(recovered.status, CommandState.accepted);
      now = now.add(const Duration(seconds: 5));
      expect((await tick(recovered.sessionId!)).state, SessionState.active);
      final stopped = await repo.stop(recovered.sessionId!, 'stop');
      expect(stopped.status, CommandState.accepted);
      expect((await tick(recovered.sessionId!)).state, SessionState.stopping);
      now = now.add(const Duration(seconds: 2));
      expect(
        (await tick(recovered.sessionId!)).settlement,
        SettlementState.pending,
      );
      now = now.add(const Duration(seconds: 2));
      expect(
        (await tick(recovered.sessionId!)).settlement,
        SettlementState.posted,
      );
      expect(engine.commands.length, 2);
    },
  );
  test(
    'Offline retains null/last known, orphaned after actual 120s; no poll acceleration',
    () async {
      engine.nextScript = ChargingScript.orphaned;
      final id = (await repo.start(request())).sessionId!;
      now = now.add(const Duration(seconds: 2));
      final online = await tick(id);
      now = now.add(const Duration(seconds: 3));
      final offline = await tick(id);
      expect(offline.energyWh, online.energyWh);
      expect(offline.observedAt, online.observedAt);
      expect(offline.state, SessionState.active);
      for (var i = 0; i < 10; i++) {
        expect((await tick(id)).state, SessionState.active);
      }
      now = now.add(const Duration(seconds: 120));
      expect((await tick(id)).state, SessionState.orphaned);
      expect(online.staleAt(now), isFalse);
      expect(offline.quality, DataQuality.stale);
    },
  );
  test(
    'Offline cutoff can settle shortfall only after recovered evidence',
    () async {
      store.money.account('driver-minh').balanceVnd = 50000;
      engine.nextScript = ChargingScript.offlineCutoff;
      final id = (await repo.start(
        request(mode: ChargingMode.autoFull, limit: null),
      )).sessionId!;
      now = now.add(const Duration(seconds: 5));
      final known = await tick(id);
      now = now.add(const Duration(seconds: 900));
      final offline = await tick(id);
      expect(offline.energyWh, known.energyWh);
      expect(offline.statement, isNull);
      now = now.add(const Duration(seconds: 300));
      final posted = await tick(id);
      expect(posted.statement!.balanceVnd, lessThan(0));
      expect(posted.statement!.stopReason, 'Ngưỡng tín dụng còn lại');
      expect(
        (await repo.preview(
          'station-powerme-center/1',
          store.profile.vehicleId,
          ChargingMode.autoFull,
          null,
        )).canStart,
        isFalse,
      );
    },
  );
  test(
    'Wallet/unattributed do not debit/earn; failed/review/pause explicit',
    () async {
      for (final script in [
        ChargingScript.stationWallet,
        ChargingScript.unattributed,
        ChargingScript.failed,
        ChargingScript.review,
        ChargingScript.paused,
      ]) {
        final local = DemoStore();
        final clock = ChargingStore(clock: () => now)..nextScript = script;
        final r = MockChargingRepository(
          local,
          clock,
          actions,
          local.activeScope,
        );
        final id = (await r.start(
          StartRequest(
            scope: local.activeScope,
            connectorId: 'station-powerme-center/1',
            vehicleId: local.profile.vehicleId,
            mode: ChargingMode.autoFull,
            limitValue: null,
            key: script.name,
          ),
        )).sessionId!;
        now = now.add(const Duration(seconds: 5));
        MockChargingEngine(local, clock, actions).step();
        var snapshot = await r.snapshot(id);
        if (script == ChargingScript.failed) {
          expect(snapshot.state, SessionState.failed);
        }
        if (script == ChargingScript.review) {
          expect(snapshot.state, SessionState.review);
        }
        if (script == ChargingScript.paused) {
          expect(snapshot.state, SessionState.paused);
        }
        if (script == ChargingScript.stationWallet ||
            script == ChargingScript.unattributed) {
          await r.stop(id, 'stop');
          now = now.add(const Duration(seconds: 5));
          MockChargingEngine(local, clock, actions).step();
          snapshot = await r.snapshot(id);
          expect(snapshot.statement, isNull);
          expect(local.money.account('driver-minh').entries, isEmpty);
        }
      }
    },
  );
  test('Hold fulfillment waits for csms billed started evidence', () async {
    final stations = MockStationActionsRepository(
      store,
      actions,
      store.activeScope,
    );
    final hold = await stations.reserve(
      await stations.quote('station-powerme-center/1'),
      'hold',
    );
    final id = (await repo.start(request())).sessionId!;
    expect(actions.holds[hold.id]!.state, HoldState.active);
    now = now.add(const Duration(seconds: 1));
    await tick(id);
    expect(actions.holds[hold.id]!.state, HoldState.fulfilled);
  });
  test(
    'Controller rejects wrong scope/resource/stale snapshots and cleans subscriptions',
    () async {
      final fake = EvidenceRepository(store.activeScope);
      final container = ProviderContainer.test(
        overrides: [
          authScopeProvider.overrideWithValue(store.activeScope),
          chargingRepositoryProvider.overrideWithValue(fake),
        ],
      );
      final c = container.read(chargingControllerProvider.notifier);
      await c.start(request());
      c.apply(fake.evidence(2));
      c.apply(fake.evidence(1));
      c.apply(fake.evidence(3, id: 'other'));
      c.apply(
        fake.evidence(
          3,
          scope: const AuthScope(principalId: 'driver-minh', generation: 0),
        ),
      );
      expect(container.read(chargingControllerProvider).session!.version, 2);
      final pending = c.resync('owned');
      container.dispose();
      fake.pending.complete(fake.evidence(3));
      await pending;
      expect(fake.events.hasListener, isFalse);
      await fake.events.close();
    },
  );
}

class EvidenceRepository implements ChargingRepository {
  EvidenceRepository(this.scope);
  final AuthScope scope;
  final events = StreamController<SessionSnapshot>.broadcast(sync: true);
  final pending = Completer<SessionSnapshot>();
  SessionSnapshot evidence(
    int version, {
    String id = 'owned',
    AuthScope? scope,
  }) => SessionSnapshot(
    scope: scope ?? this.scope,
    sessionId: id,
    version: version,
    observedAt: DateTime.utc(2026),
    state: SessionState.active,
    settlement: SettlementState.pending,
    connectionState: ConnectionState.online,
    paymentMode: PaymentMode.csmsBilled,
    quality: DataQuality.observed,
  );
  @override
  Future<CommandOutcome> start(StartRequest request) async => CommandOutcome(
    scope: scope,
    requestKey: request.key,
    status: CommandState.accepted,
    version: 1,
    sessionId: 'owned',
  );
  @override
  Future<SessionSnapshot> snapshot(String id) => pending.future;
  @override
  Stream<SessionSnapshot> watch(String id) => events.stream;
  @override
  Future<CommandOutcome> stop(String id, String key) =>
      throw UnimplementedError();
  @override
  Future<CommandOutcome> outcome(String key) => throw UnimplementedError();
}
