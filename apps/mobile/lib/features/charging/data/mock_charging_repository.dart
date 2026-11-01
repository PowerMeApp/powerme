import 'dart:async';
import '../../../demo/demo_store.dart';
import '../../../demo/charging_store.dart';
import '../../../demo/station_actions_store.dart';
import '../../auth/domain/auth_scope.dart';
import '../../stations/domain/station.dart';
import '../../stations/domain/station_actions.dart';
import '../domain/charging.dart';

export '../../../demo/charging_engine.dart' show aggregateVnd;

class MockChargingRepository
    implements ChargingRepository, ChargingPreparation {
  MockChargingRepository(this.store, this.charging, this.actions, this.scope);
  final DemoStore store;
  final ChargingStore charging;
  final StationActionsStore actions;
  final AuthScope scope;
  void guard() => store.requireScope(scope);
  String keyFor(String key) => '${scope.principalId}/$key';
  LocalSession owned(String id) {
    guard();
    final r = charging.sessions[id];
    if (r == null || r.owner != scope.principalId) {
      throw StateError('Không tìm thấy phiên sạc.');
    }
    return r;
  }

  @override
  Future<StartPreview> preview(
    String connectorId,
    String vehicleId,
    ChargingMode mode,
    int? limit,
  ) async => check(connectorId, vehicleId, mode, limit);
  StartPreview check(
    String connectorId,
    String vehicleId,
    ChargingMode mode,
    int? limit,
  ) {
    guard();
    final vehicles = store.profiles[scope.principalId]!.vehicles.where(
      (v) => v.id == vehicleId,
    );
    if (vehicles.isEmpty) throw StateError('Xe không thuộc tài khoản.');
    final parts = connectorId.split('/');
    final stations = store.stations.where((s) => s.id == parts.first);
    if (parts.length != 2 || stations.isEmpty) {
      throw StateError('Không tìm thấy cổng sạc.');
    }
    final station = stations.single;
    final connectors = station.connectors.where(
      (c) => c.number.toString() == parts[1],
    );
    if (connectors.isEmpty) throw StateError('Không tìm thấy cổng sạc.');
    final connector = connectors.single;
    if (mode != ChargingMode.autoFull && (limit == null || limit <= 0) ||
        mode == ChargingMode.autoFull && limit != null) {
      throw StateError('Nhập giới hạn lớn hơn 0 theo chế độ sạc.');
    }
    final credit = store.money.account(scope.principalId).balanceVnd;
    final hasOpen = charging.sessions.values.any(
      (s) =>
          s.owner == scope.principalId &&
          s.snapshot.state != SessionState.reconciled &&
          s.snapshot.state != SessionState.failed,
    );
    final connectorClaimed = charging.sessions.values.any(
      (s) => s.request.connectorId == connectorId && !s.snapshot.ended,
    );
    final heldByOther = actions.holds.values.any(
      (h) =>
          h.state == HoldState.active &&
          h.quote.expiresAt.isAfter(charging.clock()) &&
          h.quote.connectorId == connectorId &&
          actions.holdOwners[h.id] != scope.principalId,
    );
    final compatible =
        vehicles.single.connectors.contains(connector.type) &&
        (!station.vinfastOnly || vehicles.single.isVinFast);
    final available =
        connector.status == StationStatus.available &&
        connector.quality == DataQuality.observed &&
        !store.connectorOverrides.containsKey(connectorId) &&
        !heldByOther &&
        !connectorClaimed;
    final tariff = station.tariffVndPerKwh;
    final budget = (credit - 10000).clamp(0, 5000000);
    final maxWh = tariff == null ? 0 : budget * 1000 ~/ tariff;
    final capped = switch (mode) {
      ChargingMode.autoFull => null,
      ChargingMode.cost => limit?.clamp(0, budget),
      ChargingMode.energy => limit?.clamp(0, maxWh),
      ChargingMode.timed => limit?.clamp(0, maxWh ~/ 10),
    };
    final reason = !compatible
        ? 'Cổng không phù hợp với xe.'
        : !available
        ? 'Cổng chưa sẵn sàng hoặc đang được giữ.'
        : hasOpen
        ? 'Bạn đang có phiên sạc cần kiểm tra.'
        : credit < 50000
        ? 'Tín dụng chưa đạt mức bắt đầu.'
        : tariff == null
        ? 'Chưa có giá sạc để xác nhận.'
        : null;
    return StartPreview(
      connectorLabel: '${station.name} · Cổng ${connector.number}',
      creditVnd: credit,
      canStart: reason == null,
      tariffVndPerKwh: tariff,
      effectiveLimit: capped,
      reason: reason,
    );
  }

  @override
  Future<CommandOutcome> start(StartRequest request) async {
    guard();
    if (request.scope.principalId != scope.principalId ||
        request.scope.generation != scope.generation ||
        request.key.isEmpty) {
      throw StateError('Yêu cầu không thuộc phiên đăng nhập.');
    }
    final key = keyFor(request.key);
    final old = charging.commands[key];
    if (old != null) {
      if (charging.payloads[key] != request.fingerprint) {
        throw StateError('Mã yêu cầu đã dùng cho nội dung khác.');
      }
      return rebindCommand(old);
    }
    // Validation and connector claim share one synchronous store mutation.
    final p = check(
      request.connectorId,
      request.vehicleId,
      request.mode,
      request.limitValue,
    );
    final script = charging.nextScript;
    charging.payloads[key] = request.fingerprint;
    if (!p.canStart ||
        script == ChargingScript.rejected ||
        p.effectiveLimit != request.limitValue) {
      final reject = CommandOutcome(
        scope: scope,
        requestKey: request.key,
        status: CommandState.rejected,
        reasonCode: p.reason ?? 'Giới hạn đã thay đổi. Vui lòng kiểm tra lại.',
        version: 1,
      );
      charging.commands[key] = reject;
      return reject;
    }
    final id = 'session-${++charging.serial}';
    final at = charging.clock().toUtc();
    final snapshot = SessionSnapshot(
      scope: scope,
      sessionId: id,
      version: 1,
      observedAt: at,
      state: SessionState.pending,
      settlement: SettlementState.pending,
      connectionState: ConnectionState.online,
      paymentMode: switch (script) {
        ChargingScript.stationWallet => PaymentMode.stationWallet,
        ChargingScript.unattributed => PaymentMode.unattributed,
        _ => PaymentMode.csmsBilled,
      },
      quality: DataQuality.observed,
      connectorLabel: p.connectorLabel,
    );
    charging.sessions[id] = LocalSession(
      scope.principalId,
      request,
      p,
      script,
      snapshot,
      at,
    );
    store.connectorOverrides[request.connectorId] = StationStatus.unavailable;
    store.connectorClaimOwners[request.connectorId] = scope.principalId;
    store.connectorUpdatedAt[request.connectorId] = at;
    charging.nextScript = ChargingScript.normal;
    final outcome = CommandOutcome(
      scope: scope,
      commandId: 'start/$id',
      requestKey: request.key,
      status: script == ChargingScript.unknownStart
          ? CommandState.unknown
          : CommandState.accepted,
      sessionId: script == ChargingScript.unknownStart ? null : id,
      version: 1,
    );
    charging.commands[key] = outcome;
    return outcome;
  }

  @override
  Future<CommandOutcome> stop(String sessionId, String key) async {
    final r = owned(sessionId);
    final identity = keyFor(key);
    if (key.isEmpty) throw StateError('Thiếu mã yêu cầu.');
    final old = charging.commands[identity];
    if (old != null) {
      if (charging.payloads[identity] != 'stop/$sessionId') {
        throw StateError('Yêu cầu đã thay đổi.');
      }
      return rebindCommand(old);
    }

    if (!r.snapshot.ended && r.stopAt == null) {
      r.stopAt = charging.clock().toUtc();
      r.stopReason = 'Tài xế yêu cầu dừng';
    }
    final outcome = CommandOutcome(
      scope: scope,
      commandId: 'stop/$sessionId',
      requestKey: key,
      status: r.script == ChargingScript.unknownStop && !r.snapshot.ended
          ? CommandState.unknown
          : CommandState.accepted,
      sessionId: sessionId,
      version: 1,
    );
    charging.commands[identity] = outcome;
    charging.payloads[identity] = 'stop/$sessionId';
    return outcome;
  }

  @override
  Future<CommandOutcome> outcome(String key) async {
    guard();
    final identity = keyFor(key);
    var old = charging.commands[identity];
    if (old == null) {
      throw StateError('Chưa tìm thấy yêu cầu. Giữ nguyên mã để kiểm tra lại.');
    }
    if (old.status == CommandState.unknown) {
      final match = charging.sessions.entries.where(
        (e) => e.value.owner == scope.principalId && e.value.request.key == key,
      );
      old = CommandOutcome(
        scope: scope,
        commandId: old.commandId,
        requestKey: key,
        status: CommandState.accepted,
        sessionId: old.sessionId ?? match.first.key,
        version: old.version + 1,
      );
      charging.commands[identity] = old;
    }
    return rebindCommand(old);
  }

  CommandOutcome rebindCommand(CommandOutcome o) => CommandOutcome(
    scope: scope,
    requestKey: o.requestKey,
    status: o.status,
    version: o.version,
    sessionId: o.sessionId,
    commandId: o.commandId,
    reasonCode: o.reasonCode,
  );
  SessionSnapshot rebind(SessionSnapshot s) => SessionSnapshot(
    scope: scope,
    sessionId: s.sessionId,
    version: s.version,
    observedAt: s.observedAt,
    state: s.state,
    settlement: s.settlement,
    energyWh: s.energyWh,
    estimatedCostVnd: s.estimatedCostVnd,
    availableCreditVnd: s.availableCreditVnd,
    socPercent: s.socPercent,
    elapsedSeconds: s.elapsedSeconds,
    connectionState: s.connectionState,
    paymentMode: s.paymentMode,
    quality: s.quality,
    connectorLabel: s.connectorLabel,
    stopReason: s.stopReason,
    pauseCause: s.pauseCause,
    statement: s.statement == null
        ? null
        : Statement(
            scope: scope,
            sessionId: s.sessionId,
            version: s.statement!.version,
            debitVnd: s.statement!.debitVnd,
            balanceVnd: s.statement!.balanceVnd,
            earnedPoints: s.statement!.earnedPoints,
            segments: s.statement!.segments,
            stopReason: s.statement!.stopReason,
          ),
  );
  @override
  Future<SessionSnapshot?> current() async {
    guard();
    final list = charging.sessions.values.where(
      (r) => r.owner == scope.principalId,
    );
    if (list.isEmpty) return null;
    return rebind(list.last.snapshot);
  }

  @override
  Future<SessionSnapshot> snapshot(String sessionId) async =>
      rebind(owned(sessionId).snapshot);
  @override
  Stream<SessionSnapshot> watch(String sessionId) {
    owned(sessionId);
    return Stream<SessionSnapshot>.multi((sink) {
      final subscription = charging.events.stream
          .where((s) => s.sessionId == sessionId)
          .listen((s) {
            try {
              owned(sessionId);
              sink.add(rebind(s));
            } catch (e, st) {
              sink.addError(e, st);
            }
          }, onError: sink.addError);
      sink.add(rebind(owned(sessionId).snapshot));
      sink.onCancel = subscription.cancel;
    });
  }
}
