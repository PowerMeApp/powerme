import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/driver_api_exception.dart';
import '../domain/connector_lookup.dart';
import 'station_discovery_controller.dart';

final connectorLookupRepositoryProvider =
    Provider.autoDispose<ConnectorLookupRepository>(
      (ref) => throw StateError('Configure connector lookup in ApiApp.'),
    );

enum ConnectorLookupFailure { invalidCode, notFound, unavailable }

class ConnectorLookupState {
  const ConnectorLookupState({this.busy = false, this.connector, this.failure});

  final bool busy;
  final ResolvedConnector? connector;
  final ConnectorLookupFailure? failure;
}

final connectorLookupProvider =
    NotifierProvider.autoDispose<
      ConnectorLookupController,
      ConnectorLookupState
    >(ConnectorLookupController.new);

class ConnectorLookupController extends Notifier<ConnectorLookupState> {
  @override
  ConnectorLookupState build() {
    ref.watch(discoverySessionProvider);
    ref.watch(connectorLookupRepositoryProvider);
    return const ConnectorLookupState();
  }

  void clear() => state = const ConnectorLookupState();

  void markReportedIssue(String id) {
    final connector = state.connector;
    if (connector == null || connector.id != id || connector.reportedIssue) {
      return;
    }
    state = ConnectorLookupState(
      connector: (
        id: connector.id,
        displayCode: connector.displayCode,
        number: connector.number,
        stationName: connector.stationName,
        status: connector.status,
        reportedIssue: true,
        canRequestStart: connector.canRequestStart,
      ),
    );
  }

  Future<void> resolve(String raw) async {
    final session = ref.read(discoverySessionProvider);
    if (state.busy || session.vehicleId.isEmpty) return;
    final code = parseConnectorReference(raw);
    if (code == null) {
      state = const ConnectorLookupState(
        failure: ConnectorLookupFailure.invalidCode,
      );
      return;
    }

    final pending = ConnectorLookupState(busy: true);
    state = pending;
    bool current() =>
        ref.mounted &&
        session == ref.read(discoverySessionProvider) &&
        identical(state, pending);
    try {
      final connector = await ref
          .read(connectorLookupRepositoryProvider)
          .resolve(session.vehicleId, code);
      if (current()) state = ConnectorLookupState(connector: connector);
    } catch (error) {
      if (!current()) return;
      state = ConnectorLookupState(
        failure: error is DriverApiException && error.status == 404
            ? ConnectorLookupFailure.notFound
            : ConnectorLookupFailure.unavailable,
      );
    }
  }
}
