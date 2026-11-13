import '../domain/vehicle.dart';

class VehicleCatalog {
  VehicleCatalog(this._models);

  final List<VehicleModel> _models;

  Iterable<String> get brands {
    final names = <String, String>{};
    for (final model in _models) {
      names.putIfAbsent(model.brand.toLowerCase(), () => model.brand);
    }
    return names.values;
  }

  VehicleModel? find(String? id) =>
      _models.where((model) => model.id == id).firstOrNull;

  Iterable<VehicleModel> matching({required String query, String? brand}) {
    final term = query.trim().toLowerCase();
    final brandKey = brand?.toLowerCase();
    return _models.where((model) {
      final modelBrand = model.brand.toLowerCase();
      return (brandKey == null || modelBrand == brandKey) &&
          '$modelBrand ${model.model.toLowerCase()}'.contains(term);
    });
  }
}
