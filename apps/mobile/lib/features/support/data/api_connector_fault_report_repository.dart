import 'package:dio/dio.dart';

import '../../../core/api/driver_api_exception.dart';
import '../../../core/api/driver_api_session.dart';
import '../../../core/api/driver_api_values.dart';
import '../../auth/domain/auth_scope.dart';
import '../domain/connector_fault_report.dart';

class ApiConnectorFaultReportRepository
    implements ConnectorFaultReportRepository {
  const ApiConnectorFaultReportRepository(this._session);

  final DriverApiSession _session;

  @override
  FaultReportWrite submit(AuthScope scope, String id, String description) {
    final cancel = CancelToken();
    final result = _session
        .reportConnectorFault(scope.principalId, id, description, cancel)
        .then((json) {
          final reportId = json['report_id'];
          final reportNo = json['report_no'];
          final time = driverApiTimestamp(json['reported_at']);
          final eventId = json['fault_event_id'];
          final reportedIssue = json['reported_issue'];
          if (!isDriverApiId(reportId) ||
              !isDriverApiId(reportNo) ||
              json['connector_id'] != id ||
              time == null ||
              !json.containsKey('fault_event_id') ||
              (eventId != null && !isDriverApiId(eventId)) ||
              reportedIssue is! bool) {
            throw const DriverApiException(DriverApiProblem.malformed);
          }
          return (
            id: reportId as String,
            number: reportNo as String,
            reportedAt: time,
            faultEventId: eventId as String?,
            reportedIssue: reportedIssue,
          );
        });
    return (result: result, cancel: cancel.cancel);
  }
}
