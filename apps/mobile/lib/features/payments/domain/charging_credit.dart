import '../../auth/domain/auth_scope.dart';

typedef CreditRead<T> = ({Future<T> result, void Function() cancel});

enum CreditStatus { active, inShortfall, closed, none }

enum LedgerKind { topUp, sessionDebit, refund, adjustment, reservationFee }

class ChargingCredit {
  const ChargingCredit({
    required this.balanceVnd,
    required this.heldVnd,
    required this.availableVnd,
    required this.status,
  });

  final int balanceVnd;
  final int heldVnd;
  final int availableVnd;
  final CreditStatus status;
}

class LedgerEntry {
  const LedgerEntry({
    required this.kind,
    required this.amountVnd,
    required this.createdAt,
    this.sessionId,
  });

  final LedgerKind kind;
  final int amountVnd;
  final DateTime createdAt;
  final String? sessionId;
}

class CreditLedgerPage {
  const CreditLedgerPage({
    required this.items,
    required this.page,
    required this.pageSize,
    required this.total,
  });

  final List<LedgerEntry> items;
  final int page;
  final int pageSize;
  final int total;

  Iterable<LedgerEntry> get sessionDebits =>
      items.where((entry) => entry.kind == LedgerKind.sessionDebit);

  bool get hasNext => page < 100000 && page * pageSize < total;
}

abstract interface class ChargingCreditRepository {
  CreditRead<ChargingCredit> summary(AuthScope scope);
  CreditRead<CreditLedgerPage> transactions(AuthScope scope, int page);
}
