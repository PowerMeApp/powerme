import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/driver_api_exception.dart';
import '../../../core/api/driver_api_values.dart';
import '../../auth/application/auth_controller.dart';
import '../../stations/application/connector_lookup_controller.dart';
import '../../stations/application/station_discovery_controller.dart';
import '../domain/connector_fault_report.dart';

class FaultReportTarget {
  const FaultReportTarget({
    required this.session,
    required this.connectorId,
    required this.label,
    this.stationId,
  });

  final DiscoverySession session;
  final String connectorId;
  final String label;
  final String? stationId;
}

final connectorFaultReportRepositoryProvider =
    Provider<ConnectorFaultReportRepository>(
      (ref) => throw StateError('Configure connector reports in ApiApp.'),
    );

final validFaultReportTargetProvider = Provider.autoDispose
    .family<bool, FaultReportTarget>((ref, target) {
      final session = ref.watch(discoverySessionProvider);
      final station = target.stationId == null
          ? null
          : ref.watch(selectedDiscoveryStationProvider);
      return session.scope != signedOutScope &&
          session == target.session &&
          isDriverApiId(target.connectorId) &&
          (target.stationId == null
              ? ref.watch(connectorLookupProvider).connector?.id ==
                    target.connectorId
              : (station?.id == target.stationId &&
                    station!.connectors.any(
                      (port) => port.id == target.connectorId,
                    )));
    });

enum FaultReportIssue { invalid, missing, duplicate, unavailable }

class ConnectorFaultReportState {
  const ConnectorFaultReportState({
    this.busy = false,
    this.receipt,
    this.issue,
  });

  final bool busy;
  final FaultReportReceipt? receipt;
  final FaultReportIssue? issue;
}

final connectorFaultReportProvider = NotifierProvider.autoDispose
    .family<
      ConnectorFaultReportController,
      ConnectorFaultReportState,
      FaultReportTarget
    >(ConnectorFaultReportController.new);

final reportedSelectedConnectorsProvider =
    NotifierProvider<ReportedSelectedConnectors, Set<String>>(
      ReportedSelectedConnectors.new,
    );

class ReportedSelectedConnectors extends Notifier<Set<String>> {
  @override
  Set<String> build() {
    ref.watch(selectedDiscoveryStationProvider);
    return const {};
  }

  void mark(String id) => state = {...state, id};
}

class ConnectorFaultReportController
    extends Notifier<ConnectorFaultReportState> {
  ConnectorFaultReportController(this.target);

  final FaultReportTarget target;
  FaultReportWrite? _write;

  @override
  ConnectorFaultReportState build() {
    ref.listen(validFaultReportTargetProvider(target), (_, valid) {
      if (!valid) _write?.cancel();
    });
    ref.onDispose(() => _write?.cancel());
    return const ConnectorFaultReportState();
  }

  Future<void> submit(String input, bool Function() routeCurrent) async {
    bool current() =>
        ref.mounted &&
        routeCurrent() &&
        ref.read(validFaultReportTargetProvider(target));
    if (state.busy || state.receipt != null || !current()) return;
    final description = faultDescription(input);
    if (description == null) {
      state = const ConnectorFaultReportState(issue: FaultReportIssue.invalid);
      return;
    }
    state = const ConnectorFaultReportState(busy: true);
    final request = ref
        .read(connectorFaultReportRepositoryProvider)
        .submit(target.session.scope, target.connectorId, description);
    _write = request;
    try {
      final receipt = await request.result;
      if (!current()) return;
      state = ConnectorFaultReportState(receipt: receipt);
      if (receipt.reportedIssue) {
        if (target.stationId == null) {
          ref
              .read(connectorLookupProvider.notifier)
              .markReportedIssue(target.connectorId);
        } else {
          ref
              .read(reportedSelectedConnectorsProvider.notifier)
              .mark(target.connectorId);
        }
        ref.invalidate(discoverySearchProvider);
      }
    } on DriverApiException catch (error) {
      if (!current()) return;
      state = ConnectorFaultReportState(
        issue: switch ((error.status, error.code)) {
          (400, _) => FaultReportIssue.invalid,
          (404, _) => FaultReportIssue.missing,
          (409, 'duplicate_report') => FaultReportIssue.duplicate,
          _ => FaultReportIssue.unavailable,
        },
      );
    } finally {
      if (identical(_write, request)) {
        _write = null;
        if (ref.mounted && routeCurrent() && state.busy) {
          state = const ConnectorFaultReportState();
        }
      }
    }
  }
}
