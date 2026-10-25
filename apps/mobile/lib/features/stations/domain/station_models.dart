enum ConnectorType { ccs2, chademo, type2 }

enum StationAvailability { available, busy, offline, faulted }

extension ConnectorTypeLabel on ConnectorType {
  String get label {
    switch (this) {
      case ConnectorType.ccs2:
        return 'CCS2';
      case ConnectorType.chademo:
        return 'CHAdeMO';
      case ConnectorType.type2:
        return 'Type 2';
    }
  }
}

class Connector {
  const Connector({
    required this.id,
    required this.type,
    required this.powerKw,
    required this.availability,
    this.pricePerKwh = 3500,
  });

  final String id;
  final ConnectorType type;
  final int powerKw;
  final StationAvailability availability;
  final int pricePerKwh;

  bool get isUsable => availability == StationAvailability.available;
}

class Station {
  const Station({
    required this.id,
    required this.name,
    required this.address,
    required this.distanceKm,
    required this.availability,
    required this.updatedAt,
    required this.connectors,
  });

  final String id;
  final String name;
  final String address;
  final double distanceKm;
  final StationAvailability availability;
  final DateTime updatedAt;
  final List<Connector> connectors;

  bool get hasAvailableConnector =>
      connectors.any((connector) => connector.isUsable);

  Connector? connectorById(String id) {
    for (final connector in connectors) {
      if (connector.id == id) return connector;
    }
    return null;
  }
}
