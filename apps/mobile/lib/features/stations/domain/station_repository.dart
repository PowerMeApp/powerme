import 'station.dart';
import 'station_actions.dart';

abstract interface class StationSuggestionPreferences {
  void configureSuggestions(SuggestionMode mode, int? battery, int? target);
}

abstract interface class StationRepository {
  Future<List<StationOption>> find(String vehicleId, String query);
  Future<List<StationOption>> suggest(String vehicleId);
  Station? getById(String id);
}
