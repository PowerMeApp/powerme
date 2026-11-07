class Vehicle {
  Vehicle({
    required this.id,
    required this.brand,
    required this.model,
    required List<String> connectors,
  }) : connectors = List.unmodifiable(connectors);
  final String id;
  final String brand;
  final String model;
  final List<String> connectors;
  bool get isVinFast => brand.trim().toLowerCase() == 'vinfast';
  String get label => '$brand $model';
}

class VehicleDraft {
  const VehicleDraft({
    required this.brand,
    required this.model,
    required this.connectors,
  });
  final String brand;
  final String model;
  final List<String> connectors;
  bool get valid =>
      brand.trim().isNotEmpty &&
      brand.trim().length <= 60 &&
      model.trim().isNotEmpty &&
      model.trim().length <= 80 &&
      connectors.isNotEmpty &&
      connectors.toSet().length == connectors.length &&
      connectors.every(supportedConnectors.contains);
  static const supportedConnectors = ['CCS2', 'Type 2', 'CHAdeMO'];
}
