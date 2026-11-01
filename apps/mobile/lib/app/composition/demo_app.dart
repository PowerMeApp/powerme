import 'vietmap_config.dart';
import '../../features/stations/application/map_location_controller.dart';
import '../../features/stations/data/device_location_repository.dart';
import 'dart:async';
import 'package:flutter/material.dart';
import '../../demo/charging_engine.dart';
import '../../demo/payment_store.dart';
import '../../demo/payment_engine.dart';
import '../../features/payments/application/payments_controller.dart';
import '../../features/payments/data/mock_payments_repository.dart';
import '../../features/history/application/history_controller.dart';
import '../../features/loyalty/application/loyalty_controller.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../demo/demo_store.dart';
import '../../demo/station_actions_store.dart';
import '../../demo/charging_store.dart';
import '../../features/charging/application/charging_controller.dart';
import '../../features/charging/data/mock_charging_repository.dart';
import '../../features/stations/application/station_actions_controller.dart';
import '../../features/stations/data/mock_station_actions_repository.dart';
import '../../features/support/application/support_controller.dart';
import '../../features/support/data/mock_support_repository.dart';
import '../../features/auth/application/auth_controller.dart';
import '../../features/auth/data/mock_auth_repository.dart';
import '../../features/profile/application/profile_controller.dart';
import '../../features/profile/data/mock_profile_repository.dart';
import '../../features/stations/application/stations_controller.dart';
import '../../features/stations/data/mock_station_repository.dart';
import '../powerme_app.dart';

final _clockProvider = Provider<DateTime Function()>((ref) => DateTime.now);
final _storeProvider = Provider((ref) => DemoStore());
final _paymentsStoreProvider = Provider((ref) {
  final store = PaymentStore(clock: ref.watch(_clockProvider));
  final engine = MockPaymentEngine(ref.watch(_storeProvider), store);
  final timer = Timer.periodic(
    const Duration(seconds: 1),
    (_) => engine.step(),
  );
  ref.onDispose(timer.cancel);
  return store;
});
final _paymentsAdapterProvider = Provider(
  (ref) => MockPaymentsRepository(
    ref.watch(_storeProvider),
    ref.watch(_paymentsStoreProvider),
    ref.watch(_chargingProvider),
    ref.watch(_actionsProvider),
    ref.watch(authScopeProvider),
  ),
);
final _actionsProvider = Provider(
  (ref) => StationActionsStore(clock: ref.watch(_clockProvider)),
);
final _chargingProvider = Provider((ref) {
  final store = ChargingStore(clock: ref.watch(_clockProvider));
  final engine = MockChargingEngine(
    ref.watch(_storeProvider),
    store,
    ref.watch(_actionsProvider),
  );
  final timer = Timer.periodic(
    const Duration(seconds: 1),
    (_) => engine.step(),
  );
  ref.onDispose(() {
    timer.cancel();
    store.events.close();
  });
  return store;
});

class DemoApp extends StatelessWidget {
  const DemoApp({super.key, this.clock, this.mapConfig});
  final DateTime Function()? clock;
  final VietmapConfig? mapConfig;

  @override
  Widget build(BuildContext context) => ProviderScope(
    overrides: [
      vietmapConfigProvider.overrideWithValue(mapConfig),
      mapLocationRepositoryProvider.overrideWithValue(
        DeviceLocationRepository(),
      ),
      if (clock != null) _clockProvider.overrideWithValue(clock!),
      paymentsRepositoryProvider.overrideWith(
        (ref) => ref.watch(_paymentsAdapterProvider),
      ),
      historyRepositoryProvider.overrideWith(
        (ref) => ref.watch(_paymentsAdapterProvider),
      ),
      loyaltyRepositoryProvider.overrideWith(
        (ref) => ref.watch(_paymentsAdapterProvider),
      ),
      chargingRepositoryProvider.overrideWith(
        (ref) => MockChargingRepository(
          ref.watch(_storeProvider),
          ref.watch(_chargingProvider),
          ref.watch(_actionsProvider),
          ref.watch(authScopeProvider),
        ),
      ),
      authRepositoryProvider.overrideWith(
        (ref) => MockAuthRepository(ref.watch(_storeProvider)),
      ),
      authScopeProvider.overrideWith((ref) {
        final scope = ref.watch(authControllerProvider).scope ?? signedOutScope;
        ref.watch(_storeProvider).bind(scope);
        return scope;
      }),
      profileRepositoryProvider.overrideWith(
        (ref) => MockProfileRepository(
          ref.watch(_storeProvider),
          scope: ref.watch(authScopeProvider),
        ),
      ),
      stationRepositoryProvider.overrideWith(
        (ref) => MockStationRepository(
          ref.watch(_storeProvider),
          scope: ref.watch(authScopeProvider),
          showRestricted: ref.watch(showRestrictedProvider),
        ),
      ),
      stationActionsRepositoryProvider.overrideWith(
        (ref) => MockStationActionsRepository(
          ref.watch(_storeProvider),
          ref.watch(_actionsProvider),
          ref.watch(authScopeProvider),
        ),
      ),
      supportRepositoryProvider.overrideWith(
        (ref) => MockSupportRepository(
          ref.watch(_storeProvider),
          ref.watch(_actionsProvider),
          ref.watch(authScopeProvider),
          ref.watch(stationActionsRepositoryProvider),
        ),
      ),
    ],
    child: const PowerMeApp(),
  );
}
