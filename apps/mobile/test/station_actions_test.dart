import 'package:flutter_test/flutter_test.dart';
import 'package:driver_app/demo/demo_store.dart';
import 'package:driver_app/demo/station_actions_store.dart';
import 'package:driver_app/features/auth/domain/auth_scope.dart';
import 'package:driver_app/features/stations/data/mock_station_actions_repository.dart';
import 'package:driver_app/features/stations/domain/station_actions.dart';
import 'package:driver_app/features/stations/domain/station.dart';
import 'package:driver_app/features/support/data/mock_support_repository.dart';

void main() {
  const connector = 'station-powerme-center/1';
  late DemoStore store;
  late StationActionsStore actions;
  late MockStationActionsRepository repo;
  late DateTime now;
  setUp(() {
    now = DateTime.utc(2026, 10, 29, 3);
    store = DemoStore();
    actions = StationActionsStore(clock: () => now);
    repo = MockStationActionsRepository(store, actions, store.activeScope);
  });
  test(
    'Authoritative quote, minimum credit, duplicate and one active race',
    () async {
      final q = await repo.quote(connector);
      expect(
        q.freeCancelUntil,
        q.expiresAt.subtract(const Duration(minutes: 5)),
      );
      final forged = HoldQuote(
        id: q.id,
        connectorId: q.connectorId,
        version: q.version,
        expiresAt: q.expiresAt,
        freeCancelUntil: q.freeCancelUntil,
        feeVnd: 1,
      );
      await expectLater(repo.reserve(forged, 'forged'), throwsStateError);
      final result = await Future.wait([
        repo.reserve(q, 'one'),
        repo.reserve(q, 'one'),
      ]);
      expect(result[0].id, result[1].id);
      await expectLater(repo.reserve(q, 'other'), throwsStateError);
      final balance = store.money.account('driver-minh');
      expect(balance.balanceVnd, 320000);
      await repo.cancel(result[0].id, 'cancel');
      balance.balanceVnd = 49999;
      await expectLater(repo.quote(connector), throwsStateError);
    },
  );
  test(
    'Cutoff inclusive, late fee once, expiry and void precede no-show',
    () async {
      var h = await repo.reserve(await repo.quote(connector), 'first');
      now = h.quote.freeCancelUntil;
      expect((await repo.cancel(h.id, 'cancel')).chargedFeeVnd, 0);
      h = await repo.reserve(await repo.quote(connector), 'second');
      now = h.quote.freeCancelUntil.add(const Duration(seconds: 1));
      expect((await repo.cancel(h.id, 'cancel2')).chargedFeeVnd, 10000);
      await repo.cancel(h.id, 'again');
      expect(store.money.account('driver-minh').entries.length, 1);
      h = await repo.reserve(await repo.quote(connector), 'third');
      now = h.quote.expiresAt;
      store.connectorOverrides[connector] = StationStatus.offline;
      expect((await repo.reservation())!.state, HoldState.voided);
      expect(store.money.account('driver-minh').balanceVnd, 310000);
      store.connectorOverrides.clear();
      h = await repo.reserve(await repo.quote(connector), 'fourth');
      now = h.quote.expiresAt;
      expect((await repo.reservation())!.chargedFeeVnd, 20000);
      await repo.reservation();
      expect(store.money.account('driver-minh').balanceVnd, 290000);
    },
  );
  test(
    'Other owner expired hold releases connector; old scope cannot mutate',
    () async {
      final h = await repo.reserve(await repo.quote(connector), 'old');
      now = h.quote.expiresAt;
      store.profiles['driver-other'] = store.profile;
      const next = AuthScope(principalId: 'driver-other', generation: 2);
      store.bind(next);
      final other = MockStationActionsRepository(store, actions, next);
      expect(
        (await other.reserve(await other.quote(connector), 'new')).state,
        HoldState.active,
      );
      await expectLater(repo.cancel(h.id, 'wrong'), throwsStateError);
      await expectLater(other.cancel(h.id, 'wrong'), throwsStateError);
      expect(store.money.account('driver-minh').balanceVnd, 300000);
    },
  );
  test(
    'Suggestion target, cost ordering, nullable estimates and actual range',
    () async {
      final a = await repo.suggestions(
        'vehicle-ioniq5',
        SuggestionMode.cheapest,
        30,
        80,
      );
      final b = await repo.suggestions(
        'vehicle-ioniq5',
        SuggestionMode.cheapest,
        30,
        60,
      );
      expect(a.length, 3);
      expect(a.first.station.id, 'station-evone-thao-dien');
      expect(a.first.estimatedCostVnd, greaterThan(b.first.estimatedCostVnd!));
      expect(a.first.chargingSeconds, greaterThan(b.first.chargingSeconds!));
      expect(
        (await repo.suggestions(
          'vehicle-ioniq5',
          SuggestionMode.fastest,
          1,
          80,
        )),
        isEmpty,
      );
      final missing = await repo.suggestions(
        'vehicle-ioniq5',
        SuggestionMode.fastest,
        null,
        80,
      );
      expect(missing.first.estimatedCostVnd, isNull);
      expect(missing.first.rangeLabel, 'Chưa xác định tầm hoạt động');
      await expectLater(
        repo.suggestions('not-owned', SuggestionMode.fastest, 30, 80),
        throwsStateError,
      );
    },
  );
  test(
    'Report saved acknowledgment and payload-bound dedup; QR is identity only',
    () async {
      final support = MockSupportRepository(
        store,
        actions,
        store.activeScope,
        repo,
      );
      await expectLater(
        repo.resolve('https://evil.test/run'),
        throwsStateError,
      );
      expect(
        (await repo.resolve('powerme:connector:$connector')).connectorId,
        connector,
      );
      await expectLater(
        support.submit(connector, 'Khác', 'a', 'r'),
        throwsStateError,
      );
      final one = await support.submit(connector, 'Khác', 'Cổng bị lỗi', 'r');
      expect(
        (await support.submit(connector, 'Khác', 'Cổng bị lỗi', 'r')).id,
        one.id,
      );
      await expectLater(
        support.submit(connector, 'Khác', 'Nội dung khác', 'r'),
        throwsStateError,
      );
      expect((await support.ownedReports()).length, 1);
    },
  );
}
