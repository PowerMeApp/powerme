import 'package:dio/dio.dart';

import '../../../core/api/driver_api_session.dart';
import '../../auth/domain/auth_scope.dart';
import '../domain/charging_credit.dart';

class ApiChargingCreditRepository implements ChargingCreditRepository {
  const ApiChargingCreditRepository(this._session);

  final DriverApiSession _session;
  static const _pageSize = 20;

  @override
  CreditRead<ChargingCredit> summary(AuthScope scope) => _read((cancel) async {
    final json = await _session.readCredit(scope.principalId, cancel);
    return ChargingCredit(
      balanceVnd: _integer(json['balance_vnd']),
      heldVnd: _integer(json['held_vnd'], minimum: 0),
      availableVnd: _integer(json['available_vnd']),
      status: switch (json['status']) {
        'active' => CreditStatus.active,
        'in_shortfall' => CreditStatus.inShortfall,
        'closed' => CreditStatus.closed,
        'none' => CreditStatus.none,
        _ => throw const FormatException('Invalid credit status'),
      },
    );
  });

  @override
  CreditRead<CreditLedgerPage> transactions(AuthScope scope, int page) =>
      _read((cancel) async {
        final json = await _session.readCreditTransactions(
          scope.principalId,
          page,
          _pageSize,
          cancel,
        );
        final items = json['items'];
        if (items is! List ||
            items.length > _pageSize ||
            json['page'] is! int ||
            json['page'] != page ||
            json['page_size'] is! int ||
            json['page_size'] != _pageSize) {
          throw const FormatException('Invalid ledger page');
        }
        return CreditLedgerPage(
          items: List.unmodifiable(items.map(_entry)),
          page: page,
          pageSize: _pageSize,
          total: _integer(json['total'], minimum: 0),
        );
      });

  LedgerEntry _entry(Object? raw) {
    if (raw is! Map<String, dynamic>) {
      throw const FormatException('Invalid ledger entry');
    }
    final timestamp = raw['created_at'];
    final createdAt = timestamp is String ? DateTime.tryParse(timestamp) : null;
    if (createdAt == null || !createdAt.isUtc) {
      throw const FormatException('Invalid ledger timestamp');
    }
    return LedgerEntry(
      kind: switch (raw['transaction_type']) {
        'top_up' => LedgerKind.topUp,
        'session_debit' => LedgerKind.sessionDebit,
        'refund' => LedgerKind.refund,
        'adjustment' => LedgerKind.adjustment,
        'reservation_fee' => LedgerKind.reservationFee,
        _ => throw const FormatException('Invalid ledger entry type'),
      },
      amountVnd: _integer(raw['amount_vnd']),
      createdAt: createdAt,
      sessionId: _sessionId(raw['session_id']),
    );
  }

  CreditRead<T> _read<T>(Future<T> Function(CancelToken) load) {
    final token = CancelToken();
    return (result: load(token), cancel: token.cancel);
  }
}

int _integer(Object? value, {int minimum = -9007199254740991}) {
  if (value is int && value >= minimum && value <= 9007199254740991) {
    return value;
  }
  throw const FormatException('Invalid credit amount or count');
}

final _id = RegExp(r'^[1-9][0-9]{0,18}$');

String? _sessionId(Object? value) {
  if (value == null) return null;
  if (value is String && _id.hasMatch(value)) return value;
  throw const FormatException('Invalid ledger session ID');
}
