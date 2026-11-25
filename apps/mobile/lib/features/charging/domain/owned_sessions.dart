import '../../auth/domain/auth_scope.dart';
import 'charge_session.dart';
import 'charging.dart';

enum OwnedSessionView { active, all }

class OwnedSessionSummary {
  const OwnedSessionSummary({
    required this.scope,
    required this.id,
    required this.status,
    required this.origin,
    required this.paymentMode,
    required this.canStop,
    required this.statementAvailable,
    required this.startedAt,
    required this.stoppedAt,
    required this.updatedAt,
    required this.energyWh,
    required this.amountVnd,
    required this.settlement,
    required this.connectorId,
    required this.connectorNo,
    required this.displayCode,
    required this.siteId,
    required this.siteName,
    required this.vehicleId,
    required this.vehicleLabel,
  });
  final AuthScope scope;
  final String id;
  final SessionState status;
  final SessionOrigin origin;
  final PaymentMode paymentMode;
  final bool canStop;
  final bool statementAvailable;
  final DateTime startedAt;
  final DateTime? stoppedAt;
  final DateTime updatedAt;
  final int? energyWh;
  final int? amountVnd;
  final SettlementState? settlement;
  final String connectorId;
  final int connectorNo;
  final String? displayCode;
  final String? siteId;
  final String? siteName;
  final String? vehicleId;
  final String? vehicleLabel;
  bool get statementEligible =>
      statementAvailable &&
      stoppedAt != null &&
      (status == SessionState.closed || status == SessionState.reconciled) &&
      settlement == SettlementState.posted;
}

class OwnedSessionPage {
  const OwnedSessionPage({
    required this.items,
    required this.total,
    required this.page,
    required this.pageSize,
  });
  final List<OwnedSessionSummary> items;
  final int total;
  final int page;
  final int pageSize;
  bool get hasNext => page < 100000 && page * pageSize < total;
}

abstract interface class OwnedSessionRepository {
  ChargeSessionRead<OwnedSessionPage> list(
    AuthScope scope, {
    required OwnedSessionView view,
    int page = 1,
    int pageSize = 20,
  });
}
