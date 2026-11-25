import 'package:dio/dio.dart';
import '../../../core/api/driver_api_exception.dart';
import '../../../core/api/driver_api_session.dart';
import '../../../core/api/driver_api_values.dart';
import '../../auth/domain/auth_scope.dart';
import '../domain/charge_session.dart';
import '../domain/charging.dart';
import '../domain/owned_sessions.dart';
import 'session_metadata.dart';

class ApiOwnedSessionRepository implements OwnedSessionRepository {
  const ApiOwnedSessionRepository(this._session);
  final DriverApiSession _session;
  @override
  ChargeSessionRead<OwnedSessionPage> list(
    AuthScope scope, {
    required OwnedSessionView view,
    int page = 1,
    int pageSize = 20,
  }) {
    final cancel = CancelToken();
    return (
      result: _list(scope, view, page, pageSize, cancel),
      cancel: cancel.cancel,
    );
  }

  Future<OwnedSessionPage> _list(
    AuthScope scope,
    OwnedSessionView view,
    int page,
    int pageSize,
    CancelToken cancel,
  ) async {
    if (page < 1 || page > 100000 || pageSize < 1 || pageSize > 100) {
      throw _invalid;
    }
    try {
      final json = await _session.readOwnedSessions(
        scope.principalId,
        view: view.name,
        page: page,
        pageSize: pageSize,
        cancel: cancel,
      );
      return decodeOwnedSessionPage(
        json,
        scope: scope,
        page: page,
        pageSize: pageSize,
      );
    } on DriverApiException {
      throw _invalid;
    }
  }
}

OwnedSessionPage decodeOwnedSessionPage(
  Map<String, dynamic> json, {
  required AuthScope scope,
  required int page,
  required int pageSize,
}) {
  final rows = json['items'];
  if (json['page'] is! int ||
      json['page_size'] is! int ||
      page < 1 ||
      page > 100000 ||
      pageSize < 1 ||
      pageSize > 100) {
    throw _invalid;
  }
  final total = _int(json['total']);
  if (rows is! List ||
      total == null ||
      json['page'] != page ||
      json['page_size'] != pageSize ||
      rows.length > pageSize ||
      rows.length > total ||
      rows.length > (total - (page - 1) * pageSize).clamp(0, pageSize)) {
    throw _invalid;
  }
  final items = rows
      .map((raw) {
        if (raw is! Map<String, dynamic>) throw _invalid;
        if (raw['status'] is! String ||
            raw['origin'] is! String ||
            raw['payment_mode'] is! String ||
            (raw['settlement_state'] != null &&
                raw['settlement_state'] is! String)) {
          throw _invalid;
        }
        final canStop = _bool(raw['can_stop']);
        final available = _bool(raw['statement_available']);
        final origin = sessionOrigin(raw['origin']);
        final payment = sessionPaymentMode(raw['payment_mode']);
        final status = SessionState.values.firstWhere(
          (v) => v.name == raw['status'],
          orElse: () => SessionState.unknown,
        );
        final amount = _int(raw['amount_vnd']);
        final stopped = _date(raw['stopped_at'], nullable: true);
        if ((canStop &&
                (origin != SessionOrigin.appQr ||
                    stopped != null ||
                    !isStoppableStatus(status))) ||
            (available && payment != PaymentMode.csmsBilled) ||
            (amount != null &&
                (!available || payment != PaymentMode.csmsBilled))) {
          throw _invalid;
        }
        return OwnedSessionSummary(
          scope: scope,
          id: _id(raw['session_id'])!,
          status: status,
          origin: origin,
          paymentMode: payment,
          canStop: canStop,
          statementAvailable: available,
          startedAt: _date(raw['started_at'])!,
          stoppedAt: stopped,
          updatedAt: _date(raw['updated_at'])!,
          energyWh: _int(raw['energy_wh']),
          amountVnd: amount,
          settlement: sessionSettlement(raw['settlement_state']),
          connectorId: _id(raw['connector_id'])!,
          connectorNo: _positive(raw['connector_no']),
          displayCode: _text(raw['charge_point_display_code']),
          siteId: _id(raw['site_id'], nullable: true),
          siteName: _text(raw['site_name']),
          vehicleId: _id(raw['vehicle_id'], nullable: true),
          vehicleLabel: _text(raw['vehicle_label']),
        );
      })
      .toList(growable: false);
  if (items.map((v) => v.id).toSet().length != items.length) throw _invalid;
  return OwnedSessionPage(
    items: List.unmodifiable(items),
    total: total,
    page: page,
    pageSize: pageSize,
  );
}

const _invalid = ChargeSessionException(ChargeSessionIssue.retry);
bool _bool(Object? v) => v is bool ? v : throw _invalid;
int? _int(Object? v) {
  if (v == null) return null;
  if (v is int && v >= 0 && v <= 9007199254740991) return v;
  throw _invalid;
}

int _positive(Object? v) => (_int(v) ?? 0) > 0 ? v as int : throw _invalid;
String? _id(Object? v, {bool nullable = false}) => v == null && nullable
    ? null
    : isDriverApiId(v)
    ? v as String
    : throw _invalid;
String? _text(Object? v) =>
    v == null || v is String ? v as String? : throw _invalid;
DateTime? _date(Object? v, {bool nullable = false}) {
  if (v == null && nullable) return null;
  final date = driverApiTimestamp(v);
  return date != null && date.isUtc ? date : throw _invalid;
}
