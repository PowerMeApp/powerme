import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:powerme/features/charging/domain/charging_models.dart';
import 'package:powerme/features/charging/presentation/charging_controller.dart';
import 'package:powerme/features/stations/domain/station_models.dart';

void main() {
  final station = Station(
    id: 'station-test',
    name: 'Station test',
    address: 'Test address',
    distanceKm: 1,
    availability: StationAvailability.available,
    updatedAt: DateTime.utc(2026, 9, 14),
    connectors: const [
      Connector(
        id: 'connector-test',
        type: ConnectorType.ccs2,
        powerKw: 120,
        availability: StationAvailability.available,
      ),
    ],
  );

  test(
    'Accepted is not an active session until StartTransaction evidence',
    () async {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      final controller = container.read(chargingControllerProvider.notifier);

      await controller.startCommand(station, station.connectors.first);
      expect(
        container.read(chargingControllerProvider).commandStatus,
        CommandStatus.accepted,
      );
      expect(container.read(chargingControllerProvider).session, isNull);

      controller.simulateStartTransaction();
      final active = container.read(chargingControllerProvider);
      expect(active.sessionState, SessionState.charging);
      expect(active.session?.energyWh, 10000);
      expect(active.session?.soc, isNull);
    },
  );

  test(
    'stale and unknown stop preserve last-known data until evidence arrives',
    () async {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      final controller = container.read(chargingControllerProvider.notifier);
      await controller.startCommand(station, station.connectors.first);
      controller.simulateStartTransaction();
      controller.simulateStale();
      expect(
        container.read(chargingControllerProvider).dataQuality,
        DataQuality.stale,
      );
      expect(
        container.read(chargingControllerProvider).session?.energyWh,
        10000,
      );

      controller.requestStop();
      controller.simulateStopUnknown();
      expect(
        container.read(chargingControllerProvider).commandStatus,
        CommandStatus.unknown,
      );
      expect(container.read(chargingControllerProvider).summary, isNull);

      controller.simulateStopEvidence();
      expect(
        container.read(chargingControllerProvider).sessionState,
        SessionState.ended,
      );
      expect(
        container.read(chargingControllerProvider).summary?.amountVnd,
        30000,
      );
    },
  );
}
