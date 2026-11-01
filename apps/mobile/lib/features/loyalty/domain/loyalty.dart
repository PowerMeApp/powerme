import '../../auth/domain/auth_scope.dart';

class PointLot {
  const PointLot(this.id, this.points, this.expiresAt);
  final String id;
  final int points;
  final DateTime expiresAt;
}

class PointMovement {
  const PointMovement(this.reference, this.label, this.points, this.at);
  final String reference;
  final String label;
  final int points;
  final DateTime at;
}

class LoyaltySnapshot {
  const LoyaltySnapshot(
    this.scope,
    this.version,
    this.available,
    this.reserved,
    this.expiringSoon,
    this.lots,
    this.entries,
  );
  final AuthScope scope;
  final int version;
  final int available;
  final int reserved;
  final int expiringSoon;
  final List<PointLot> lots;
  final List<PointMovement> entries;
}

abstract interface class LoyaltyRepository {
  Future<LoyaltySnapshot> loyalty();
}
