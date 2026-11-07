import '../features/payments/domain/payments.dart';
import '../features/loyalty/domain/loyalty.dart';

typedef MoneyEntry = CreditEntry;

class MoneyAccount {
  MoneyAccount() {
    lots.add(PointLot('welcome-credit', 1800, DateTime.utc(2027, 10, 20)));
  }
  int balanceVnd = 320000;
  int reservedPoints = 0;
  int version = 1;
  int get points => lots.fold(0, (sum, l) => sum + l.points);
  final lots = <PointLot>[];
  final pointEntries = <PointMovement>[];
  final reservations = <String, List<PointLot>>{};
  final entries = <CreditEntry>[];
  final posted = <String>{};
}

class MoneyStore {
  final accounts = <String, MoneyAccount>{};
  MoneyAccount account(String owner) =>
      accounts.putIfAbsent(owner, MoneyAccount.new);
  void post(
    String owner,
    String reference,
    String label,
    int amount,
    DateTime at, {
    int points = 0,
  }) {
    final a = account(owner);
    if (!a.posted.add(reference)) return;
    a.balanceVnd += amount;
    a.version++;
    a.entries.insert(0, CreditEntry(reference, label, amount, at.toUtc()));
    if (points != 0) {
      adjustPoints(owner, 'points/$reference', label, points, at);
    }
  }

  void expire(String owner, DateTime now) {
    final a = account(owner);
    for (final lot in a.lots.toList()) {
      if (!lot.expiresAt.isAfter(now)) {
        a.lots.remove(lot);
        a.pointEntries.insert(
          0,
          PointMovement(
            'expiry/${lot.id}',
            'Điểm hết hạn',
            -lot.points,
            now.toUtc(),
          ),
        );
        a.version++;
      }
    }
  }

  void adjustPoints(
    String owner,
    String reference,
    String label,
    int points,
    DateTime now,
  ) {
    final a = account(owner);
    if (!a.posted.add(reference)) return;
    if (points > 0) {
      a.lots.add(
        PointLot(
          reference,
          points,
          DateTime.utc(
            now.year + 1,
            now.month,
            now.day,
            now.hour,
            now.minute,
            now.second,
          ),
        ),
      );
    } else {
      take(a, -points);
    }
    a.version++;
    a.pointEntries.insert(
      0,
      PointMovement(reference, label, points, now.toUtc()),
    );
  }

  List<PointLot> take(MoneyAccount a, int points) {
    if (points > a.points) throw StateError('Điểm không còn đủ.');
    a.lots.sort((x, y) => x.expiresAt.compareTo(y.expiresAt));
    final used = <PointLot>[];
    var remaining = points;
    while (remaining > 0) {
      final l = a.lots.removeAt(0);
      final count = remaining < l.points ? remaining : l.points;
      used.add(PointLot(l.id, count, l.expiresAt));
      if (l.points > count) {
        a.lots.insert(0, PointLot(l.id, l.points - count, l.expiresAt));
      }
      remaining -= count;
    }
    return used;
  }

  void reservePoints(String owner, String reference, int points, DateTime now) {
    expire(owner, now);
    final a = account(owner);
    if (a.reservations.containsKey(reference)) return;
    a.reservations[reference] = take(a, points);
    a.reservedPoints += points;
    a.version++;
  }

  void finishPoints(
    String owner,
    String reference,
    DateTime now, {
    required bool commit,
  }) {
    final a = account(owner);
    final lots = a.reservations.remove(reference);
    if (lots == null) return;
    final count = lots.fold<int>(0, (sum, l) => sum + l.points);
    a.reservedPoints -= count;
    if (commit) {
      a.pointEntries.insert(
        0,
        PointMovement(
          reference,
          'Đổi điểm khi nạp tín dụng',
          -count,
          now.toUtc(),
        ),
      );
    } else {
      a.lots.addAll(lots);
      expire(owner, now);
    }
    a.version++;
  }
}
