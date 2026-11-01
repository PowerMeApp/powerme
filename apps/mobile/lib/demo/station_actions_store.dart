import '../features/stations/domain/station_actions.dart';
import '../features/support/domain/support_repository.dart';

class StationActionsStore {
  StationActionsStore({DateTime Function()? clock})
    : clock = clock ?? DateTime.now;
  final DateTime Function() clock;
  final holds = <String, Reservation>{};
  final holdOwners = <String, String>{};
  final holdKeys = <String, Reservation>{};
  final quotes = <String, HoldQuote>{};
  final quoteOwners = <String, String>{};
  final voidReasons = <String, String>{};
  final reports = <String, List<FaultReport>>{};
  final reportKeys = <String, FaultReport>{};
  int serial = 0;
}
