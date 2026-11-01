import '../../../demo/demo_store.dart';
import '../../../demo/station_actions_store.dart';
import '../../auth/domain/auth_scope.dart';
import '../domain/station.dart';
import '../domain/station_actions.dart';
import 'mock_station_repository.dart';

class MockStationActionsRepository implements StationActionsRepository {
  MockStationActionsRepository(this.store, this.actions, this.scope);
  final DemoStore store;
  final StationActionsStore actions;
  final AuthScope scope;
  void guard() => store.requireScope(scope);
  @override
  Future<StationOption> resolve(String reference) async {
    guard();
    final match = RegExp(
      r'^(?:powerme:connector:)?([a-z0-9-]{1,100})/([1-9][0-9]?)$',
    ).firstMatch(reference.trim());
    if (match == null) {
      throw StateError('Mã cổng không hợp lệ. Nhập mã trạm/số cổng.');
    }
    final options = await MockStationRepository(
      store,
      scope: scope,
      showRestricted: true,
    ).find(store.profile.vehicleId, '');
    guard();
    return options.firstWhere(
      (o) => o.connectorId == '${match[1]}/${match[2]}',
      orElse: () => throw StateError('Không tìm thấy cổng phù hợp với xe.'),
    );
  }

  @override
  Future<List<StationOption>> suggestions(
    String vehicleId,
    SuggestionMode mode,
    int? battery,
    int? target,
  ) {
    final repo = MockStationRepository(store, scope: scope)
      ..configureSuggestions(mode, battery, target);
    return repo.suggest(vehicleId);
  }

  @override
  Future<HoldQuote> quote(String connectorId) async {
    final o = await resolve(connectorId);
    guard();
    normalize();
    if (o.station.vinfastOnly && !store.profile.isVinFast ||
        o.status != StationStatus.available ||
        o.connector.quality != DataQuality.observed ||
        store.connectorOverrides.containsKey(connectorId)) {
      throw StateError('Cổng chưa đủ điều kiện giữ chỗ.');
    }
    if (store.money.account(scope.principalId).balanceVnd < 50000) {
      throw StateError('Cần ít nhất 50.000 đ tín dụng để giữ chỗ.');
    }
    final now = actions.clock().toUtc();
    final id = 'quote-${++actions.serial}';
    final quote = HoldQuote(
      id: id,
      connectorId: connectorId,
      version: 1,
      connectorLabel: '${o.station.name} · Cổng ${o.connector.number}',
      validUntil: now.add(const Duration(minutes: 2)),
      expiresAt: now.add(const Duration(minutes: 15)),
      freeCancelUntil: now.add(const Duration(minutes: 10)),
    );
    actions.quotes[id] = quote;
    actions.quoteOwners[id] = scope.principalId;
    return quote;
  }

  Reservation countdown(Reservation h) => Reservation(
    id: h.id,
    quote: h.quote,
    state: h.state,
    version: h.version,
    chargedFeeVnd: h.chargedFeeVnd,
    remainingSeconds: h.state == HoldState.active
        ? h.quote.expiresAt.difference(actions.clock()).inSeconds.clamp(0, 3600)
        : 0,
  );
  bool sameQuote(HoldQuote a, HoldQuote b) =>
      a.id == b.id &&
      a.connectorId == b.connectorId &&
      a.version == b.version &&
      a.expiresAt == b.expiresAt &&
      a.freeCancelUntil == b.freeCancelUntil &&
      a.validUntil == b.validUntil &&
      a.connectorLabel == b.connectorLabel &&
      a.feeVnd == b.feeVnd &&
      a.lateCancelFeeVnd == b.lateCancelFeeVnd;
  @override
  Future<Reservation> reserve(HoldQuote quote, String key) async {
    guard();
    if (key.isEmpty) throw StateError('Thiếu mã yêu cầu.');
    final dedup = '${scope.principalId}/$key';
    final prior = actions.holdKeys[dedup];
    if (prior != null) {
      final original = actions.quotes[quote.id];
      if (original == null ||
          !sameQuote(original, quote) ||
          prior.quote.id != quote.id) {
        throw StateError('Yêu cầu đã thay đổi.');
      }
      normalize();
      return countdown(actions.holds[prior.id]!);
    }
    final issued = actions.quotes[quote.id];
    if (issued == null ||
        actions.quoteOwners[quote.id] != scope.principalId ||
        !sameQuote(issued, quote) ||
        !issued.validUntil!.isAfter(actions.clock())) {
      throw StateError('Báo giá không hợp lệ hoặc đã hết hạn.');
    }
    await this.quote(quote.connectorId);
    guard();
    normalize();
    final concurrent = actions.holdKeys[dedup];
    if (concurrent != null) {
      if (concurrent.quote.id != quote.id) {
        throw StateError('Yêu cầu đã thay đổi.');
      }
      return countdown(actions.holds[concurrent.id]!);
    }
    if (store.money.account(scope.principalId).balanceVnd < 50000) {
      throw StateError('Cần ít nhất 50.000 đ tín dụng để giữ chỗ.');
    }
    if (actions.holds.values.any(
      (h) =>
          h.state == HoldState.active &&
          (actions.holdOwners[h.id] == scope.principalId ||
              h.quote.connectorId == quote.connectorId),
    )) {
      throw StateError('Đã có lượt giữ chỗ trên tài khoản hoặc cổng này.');
    }
    final now = actions.clock().toUtc();
    final confirmed = HoldQuote(
      id: quote.id,
      connectorId: quote.connectorId,
      version: quote.version,
      connectorLabel: quote.connectorLabel,
      validUntil: quote.validUntil,
      expiresAt: now.add(const Duration(minutes: 15)),
      freeCancelUntil: now.add(const Duration(minutes: 10)),
      feeVnd: quote.feeVnd,
      lateCancelFeeVnd: quote.lateCancelFeeVnd,
    );
    final hold = Reservation(
      id: 'hold-${++actions.serial}',
      quote: confirmed,
      state: HoldState.active,
      version: 1,
    );
    actions.holds[hold.id] = hold;
    actions.holdOwners[hold.id] = scope.principalId;
    actions.holdKeys[dedup] = hold;
    return countdown(hold);
  }

  void normalize() {
    for (final h in actions.holds.values.toList()) {
      if (h.state != HoldState.active) continue;
      final blocked =
          (store.connectorOverrides.containsKey(h.quote.connectorId) &&
              store.connectorClaimOwners[h.quote.connectorId] !=
                  actions.holdOwners[h.id]) ||
          actions.voidReasons.containsKey(h.id);
      if (blocked || !h.quote.expiresAt.isAfter(actions.clock())) {
        final next = Reservation(
          id: h.id,
          quote: h.quote,
          state: blocked ? HoldState.voided : HoldState.expired,
          version: h.version + 1,
          chargedFeeVnd: blocked ? 0 : h.quote.feeVnd,
        );
        actions.holds[h.id] = next;
        if (!blocked) {
          store.money.post(
            actions.holdOwners[h.id]!,
            'fee/${h.id}',
            'Phí không đến giữ chỗ',
            -next.chargedFeeVnd,
            actions.clock(),
          );
        }
      }
    }
  }

  @override
  Future<Reservation?> reservation() async {
    guard();
    normalize();
    final owned = actions.holds.values.where(
      (h) => actions.holdOwners[h.id] == scope.principalId,
    );
    return owned.isEmpty ? null : countdown(owned.last);
  }

  @override
  Future<Reservation> cancel(String id, String key) async {
    guard();
    normalize();
    final h = actions.holds[id];
    if (h == null || actions.holdOwners[id] != scope.principalId) {
      throw StateError('Không tìm thấy lượt giữ chỗ.');
    }
    if (h.state != HoldState.active) return h;
    final free = !actions.clock().isAfter(h.quote.freeCancelUntil);
    final next = Reservation(
      id: h.id,
      quote: h.quote,
      state: free ? HoldState.cancelledFree : HoldState.cancelledLate,
      version: h.version + 1,
      chargedFeeVnd: free ? 0 : h.quote.lateCancelFeeVnd,
    );
    actions.holds[id] = next;
    if (!free) {
      store.money.post(
        scope.principalId,
        'fee/$id',
        'Phí hủy giữ chỗ muộn',
        -next.chargedFeeVnd,
        actions.clock(),
      );
    }
    return next;
  }
}
