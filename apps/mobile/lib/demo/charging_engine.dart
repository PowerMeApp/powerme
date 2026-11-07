import '../features/charging/domain/charging.dart';
import '../features/stations/domain/station_actions.dart';
import '../features/stations/domain/station.dart';
import 'demo_store.dart';
import 'charging_store.dart';
import 'station_actions_store.dart';

int aggregateVnd(Iterable<(int, int)> portions) =>
    (portions.fold<int>(0, (sum, p) => sum + p.$1 * p.$2) + 500) ~/ 1000;

class MockChargingEngine {
  MockChargingEngine(this.store, this.charging, this.actions);
  final DemoStore store;
  final ChargingStore charging;
  final StationActionsStore actions;
  void step() {
    for (final record in charging.sessions.values.toList()) {
      final previous = record.snapshot;
      final next = advance(record);
      if (!identical(previous, next)) charging.events.add(next);
    }
  }

  SessionSnapshot advance(LocalSession r) {
    final s = r.snapshot;
    if (s.state == SessionState.reconciled || s.state == SessionState.failed) {
      return s;
    }
    final now = charging.clock().toUtc();
    final age = now.difference(r.startedAt).inSeconds;
    if (age < 1) return s;
    final tariff = r.preview.tariffVndPerKwh!;
    final budgetWh = (r.preview.creditVnd - 10000) * 1000 ~/ tariff;
    final targetWh = switch (r.request.mode) {
      ChargingMode.autoFull => 50820,
      ChargingMode.timed => r.request.limitValue! * 10,
      ChargingMode.energy => r.request.limitValue!,
      ChargingMode.cost => r.request.limitValue! * 1000 ~/ tariff,
    };
    final endWh = targetWh < budgetWh ? targetWh : budgetWh;
    final limitAt = r.startedAt.add(Duration(seconds: 1 + (endWh + 9) ~/ 10));
    if (!now.isBefore(limitAt) && r.stopAt == null) {
      r.stopAt = limitAt;
      r.stopReason = targetWh >= budgetWh
          ? 'Ngưỡng tín dụng còn lại'
          : 'Đạt giới hạn sạc';
    }
    var state = SessionState.active;
    var settlement = SettlementState.pending;
    var connection = ConnectionState.online;
    var quality = DataQuality.observed;
    var observedAt = now;
    var elapsed = age - 1;
    var energy = (elapsed * 10).clamp(0, endWh);
    Statement? statement;
    final stopAge = r.stopAt == null ? -1 : now.difference(r.stopAt!).inSeconds;
    final disconnected =
        r.script == ChargingScript.orphaned && age >= 4 ||
        r.script == ChargingScript.offlineCutoff &&
            stopAge >= 0 &&
            stopAge < 300;
    if (disconnected) {
      connection = ConnectionState.offline;
      quality = DataQuality.stale;
      observedAt = s.observedAt;
      elapsed = s.elapsedSeconds ?? 0;
      energy = s.energyWh ?? 0;
      final offlineSince = r.script == ChargingScript.orphaned
          ? r.startedAt.add(const Duration(seconds: 4))
          : r.stopAt!;
      state = now.difference(offlineSince).inSeconds > 120
          ? SessionState.orphaned
          : s.state;
    } else if (r.script == ChargingScript.failed && age >= 2) {
      state = SessionState.failed;
      r.stopReason = 'Trạm từ chối bắt đầu';
      energy = 0;
      elapsed = 0;
      settlement = SettlementState.notApplicable;
      store.connectorOverrides.remove(r.request.connectorId);
      store.connectorClaimOwners.remove(r.request.connectorId);
      store.connectorUpdatedAt[r.request.connectorId] = now;
    } else if (r.script == ChargingScript.review && age >= 4) {
      state = SessionState.review;
      settlement = SettlementState.review;
      energy = s.energyWh ?? 0;
      elapsed = s.elapsedSeconds ?? 0;
    } else if (stopAge >= 0) {
      final stopElapsed = r.stopAt!.difference(r.startedAt).inSeconds - 1;
      elapsed = stopElapsed.clamp(0, 1000000);
      energy = (elapsed * 10).clamp(0, endWh);
      if (r.script == ChargingScript.offlineCutoff && stopAge >= 300) {
        energy = endWh + 3000;
        elapsed += 300;
      }
      state = stopAge < 2
          ? SessionState.stopping
          : stopAge < 4
          ? SessionState.closed
          : SessionState.reconciled;
      if (state == SessionState.reconciled) {
        final debit = aggregateVnd([(energy, tariff)]);
        if (s.paymentMode == PaymentMode.csmsBilled) {
          store.money.post(
            r.owner,
            'session/${s.sessionId}',
            'Sạc tại ${r.preview.connectorLabel}',
            -debit,
            now,
            points: debit ~/ 1000,
          );
          settlement = SettlementState.posted;
          statement = Statement(
            scope: s.scope,
            sessionId: s.sessionId,
            version: s.version + 1,
            debitVnd: debit,
            balanceVnd: store.money.account(r.owner).balanceVnd,
            earnedPoints: debit ~/ 1000,
            segments: [
              TariffSegment('Khung giờ hiện tại', energy, tariff, debit),
            ],
            stopReason: r.stopReason ?? 'Đạt giới hạn',
          );
        } else {
          settlement = s.paymentMode == PaymentMode.unattributed
              ? SettlementState.review
              : SettlementState.notApplicable;
        }
        store.reportedConnectors.remove(r.request.connectorId);
        store.connectorOverrides.remove(r.request.connectorId);
        store.connectorClaimOwners.remove(r.request.connectorId);
        store.connectorUpdatedAt[r.request.connectorId] = now;
      }
    } else if (r.script == ChargingScript.paused && age >= 3) {
      state = SessionState.paused;
      energy = s.energyWh ?? 0;
      elapsed = s.elapsedSeconds ?? 0;
    }
    if (!r.effectConfirmed && state != SessionState.failed && !disconnected) {
      r.effectConfirmed = true;
      for (final h in actions.holds.values.toList()) {
        if (h.state == HoldState.active &&
            actions.holdOwners[h.id] == r.owner &&
            h.quote.connectorId.split('/').first ==
                r.request.connectorId.split('/').first &&
            h.quote.expiresAt.isAfter(
              r.startedAt.add(const Duration(seconds: 1)),
            ) &&
            s.paymentMode == PaymentMode.csmsBilled) {
          actions.holds[h.id] = Reservation(
            id: h.id,
            quote: h.quote,
            state: HoldState.fulfilled,
            version: h.version + 1,
          );
        }
      }
    }
    if (!s.ended &&
        state != SessionState.reconciled &&
        state != SessionState.failed) {
      store.connectorOverrides[r.request.connectorId] = StationStatus.inUse;
    }
    final hasMetrics = !disconnected || s.energyWh != null;
    final cost = disconnected
        ? s.estimatedCostVnd
        : hasMetrics
        ? aggregateVnd([(energy, tariff)])
        : null;
    final available =
        store.money.account(r.owner).balanceVnd -
        (settlement != SettlementState.posted &&
                s.paymentMode == PaymentMode.csmsBilled
            ? cost ?? 0
            : 0);
    if (state == s.state &&
        settlement == s.settlement &&
        connection == s.connectionState &&
        quality == s.quality &&
        observedAt == s.observedAt &&
        cost == s.estimatedCostVnd &&
        available == s.availableCreditVnd) {
      return s;
    }
    final next = SessionSnapshot(
      scope: s.scope,
      sessionId: s.sessionId,
      version: s.version + 1,
      observedAt: observedAt,
      state: state,
      settlement: settlement,
      energyWh: disconnected
          ? s.energyWh
          : hasMetrics
          ? energy
          : null,
      estimatedCostVnd: cost,
      availableCreditVnd: available,
      socPercent: disconnected
          ? s.socPercent
          : hasMetrics
          ? (30 + energy * 100 ~/ 72600).clamp(0, 100)
          : null,
      elapsedSeconds: disconnected
          ? s.elapsedSeconds
          : hasMetrics
          ? elapsed
          : null,
      connectionState: connection,
      paymentMode: s.paymentMode,
      quality: quality,
      statement: statement,
      connectorLabel: r.preview.connectorLabel,
      stopReason: r.stopReason,
      pauseCause: state == SessionState.paused
          ? 'Xe tạm ngừng nhận điện'
          : null,
    );
    r.snapshot = next;
    return next;
  }
}
