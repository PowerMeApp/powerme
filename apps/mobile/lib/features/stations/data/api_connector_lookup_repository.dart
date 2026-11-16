import 'package:dio/dio.dart';

import '../../../core/api/driver_api_exception.dart';
import '../../../core/api/driver_api_session.dart';
import '../domain/connector_lookup.dart';
import '../domain/station.dart';

class ApiConnectorLookupRepository implements ConnectorLookupRepository {
  ApiConnectorLookupRepository(this._session);

  final DriverApiSession _session;
  final _cancel = CancelToken();

  @override
  Future<ResolvedConnector> resolve(
    String vehicleId,
    ConnectorReference code,
  ) async {
    final json = await _session.readForVehicle(
      'connectors/by-code/${Uri.encodeComponent(code.displayCode)}/${code.number}',
      vehicleId,
      const {},
      cancel: _cancel,
    );
    final id = json['connector_id'];
    final name = json['site_name'];
    final online = json['is_online'];
    final rawStatus = json['status'];
    final issue = json['reported_issue'];
    if (id is! String ||
        !RegExp(r'^[1-9][0-9]{0,18}$').hasMatch(id) ||
        name is! String ||
        name.trim().isEmpty ||
        online is! bool ||
        rawStatus is! String ||
        (issue != null && issue is! bool) ||
        (json['display_code'] != null &&
            json['display_code'] != code.displayCode) ||
        json['connector_no'] != code.number) {
      throw const DriverApiException(DriverApiProblem.malformed);
    }
    final status = online
        ? switch (rawStatus) {
            'Available' => StationStatus.available,
            'Preparing' ||
            'Charging' ||
            'SuspendedEV' ||
            'SuspendedEVSE' => StationStatus.inUse,
            'Finishing' => StationStatus.freeingSoon,
            'Faulted' ||
            'Unavailable' ||
            'Reserved' => StationStatus.unavailable,
            _ => StationStatus.unknown,
          }
        : StationStatus.offline;
    return (
      id: id,
      displayCode: code.displayCode,
      number: code.number,
      stationName: name,
      status: status,
      reportedIssue: issue == true,
    );
  }

  void dispose() => _cancel.cancel();
}
