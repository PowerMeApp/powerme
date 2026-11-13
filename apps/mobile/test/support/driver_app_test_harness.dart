import 'dart:async';

import 'package:driver_app/app/composition/vietmap_config.dart';
import 'package:driver_app/app/powerme_app.dart';
import 'package:driver_app/demo/charging_engine.dart';
import 'package:driver_app/demo/charging_store.dart';
import 'package:driver_app/demo/demo_store.dart';
import 'package:driver_app/demo/payment_engine.dart';
import 'package:driver_app/demo/payment_store.dart';
import 'package:driver_app/demo/station_actions_store.dart';
import 'package:driver_app/features/auth/application/auth_controller.dart';
import 'package:driver_app/features/charging/application/charging_controller.dart';
import 'package:driver_app/features/charging/data/mock_charging_repository.dart';
import 'package:driver_app/features/history/application/history_controller.dart';
import 'package:driver_app/features/loyalty/application/loyalty_controller.dart';
import 'package:driver_app/features/payments/application/payments_controller.dart';
import 'package:driver_app/features/payments/data/mock_payments_repository.dart';
import 'package:driver_app/features/profile/application/profile_controller.dart';
import 'package:driver_app/features/profile/data/mock_profile_repository.dart';
import 'package:driver_app/features/stations/application/map_location_controller.dart';
import 'package:driver_app/features/stations/application/station_actions_controller.dart';
import 'package:driver_app/features/stations/application/stations_controller.dart';
import 'package:driver_app/features/stations/data/device_location_repository.dart';
import 'package:driver_app/features/stations/data/mock_station_actions_repository.dart';
import 'package:driver_app/features/stations/data/mock_station_repository.dart';
import 'package:driver_app/features/support/application/support_controller.dart';
import 'package:driver_app/features/support/data/mock_support_repository.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/material.dart';

import 'fake_auth_repository.dart';

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

class DriverAppTestHarness extends StatelessWidget {
  const DriverAppTestHarness({super.key, this.clock, this.mapConfig});
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
        (ref) => FakeAuthRepository(ref.watch(_storeProvider)),
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
