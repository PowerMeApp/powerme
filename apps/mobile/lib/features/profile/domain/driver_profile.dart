import 'vehicle.dart';
export 'vehicle.dart';

enum AppLanguage { vietnamese, english }

class DriverProfile {
  const DriverProfile({
    required this.displayName,
    required this.language,
    this.email = '',
    this.vehicles = const [],
    this.selectedVehicleId,
    this.revision = 0,
  });

  final String displayName;
  static const empty = DriverProfile(
    displayName: '',
    language: AppLanguage.vietnamese,
  );
  final String email;
  final AppLanguage language;
  final List<Vehicle> vehicles;
  final String? selectedVehicleId;
  final int revision;

  Vehicle? get selectedVehicle {
    for (final vehicle in vehicles) {
      if (vehicle.id == selectedVehicleId) return vehicle;
    }
    return null;
  }

  String get vehicle => selectedVehicle?.label ?? '';
  String get vehicleId => selectedVehicle?.id ?? '';
  bool get isVinFast => selectedVehicle?.isVinFast ?? false;
  List<String> get compatibleConnectors =>
      selectedVehicle?.connectors ?? const [];

  DriverProfile withLanguage(AppLanguage language) =>
      copyWith(language: language);
  DriverProfile copyWith({
    String? displayName,
    AppLanguage? language,
    List<Vehicle>? vehicles,
    String? selectedVehicleId,
  }) => DriverProfile(
    displayName: displayName ?? this.displayName,
    email: email,
    language: language ?? this.language,
    vehicles: List.unmodifiable(vehicles ?? this.vehicles),
    selectedVehicleId: selectedVehicleId ?? this.selectedVehicleId,
    revision: revision + 1,
  );
}
