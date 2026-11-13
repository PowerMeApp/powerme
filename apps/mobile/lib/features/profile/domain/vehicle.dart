class Vehicle {
  Vehicle({
    required this.id,
    required this.brand,
    required this.model,
    required List<String> connectors,
    this.plateNumber,
    bool? isVinFast,
  }) : connectors = List.unmodifiable(connectors),
       isVinFast = isVinFast ?? brand.trim().toLowerCase() == 'vinfast';
  final String id;
  final String brand;
  final String model;
  final List<String> connectors;
  final String? plateNumber;
  final bool isVinFast;
  String get label => '$brand $model';
}

class VehicleModel {
  const VehicleModel({
    required this.id,
    required this.brand,
    required this.model,
    required this.connector,
    this.batteryCapacityKwh,
    this.ratedRangeKm,
    this.maxDcKw,
  });

  final String id;
  final String brand;
  final String model;
  final String connector;
  final num? batteryCapacityKwh;
  final int? ratedRangeKm;
  final num? maxDcKw;

  String get label => '$brand $model · $connector';
}

class VehicleRegistration {
  const VehicleRegistration({
    required this.plateNumber,
    required this.modelId,
    required this.makeDefault,
  });

  final String plateNumber;
  final String modelId;
  final bool makeDefault;

  static bool acceptsPlate(String raw) {
    if (raw.length > 64) return false;
    final compact = raw.replaceAll(RegExp(r'[\s\uFEFF]'), '');
    // The API validates Unicode compatibility forms after NFKC normalization.
    if (compact.runes.any((rune) => rune > 127)) return true;
    return compact.length <= 12 &&
        RegExp(r'^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*$').hasMatch(compact) &&
        compact.replaceAll(RegExp(r'[.-]'), '').length >= 5;
  }
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
