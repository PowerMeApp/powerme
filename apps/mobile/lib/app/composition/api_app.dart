import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_config.dart';
import '../../core/api/driver_api_session.dart';
import '../../features/auth/application/auth_controller.dart';
import '../../features/auth/data/api_auth_repository.dart';
import '../../features/charging/application/charge_session_controller.dart';
import '../../features/charging/application/charge_start_controller.dart';
import '../../features/charging/data/api_charge_session_repository.dart';
import '../../features/charging/data/api_charge_start_repository.dart';
import '../../features/profile/application/profile_controller.dart';
import '../../features/profile/data/api_profile_repository.dart';
import '../../features/stations/application/connector_lookup_controller.dart';
import '../../features/stations/application/map_location_controller.dart';
import '../../features/stations/application/station_discovery_controller.dart';
import '../../features/stations/application/stations_controller.dart';
import '../../features/stations/data/api_connector_lookup_repository.dart';
import '../../features/stations/data/api_station_repository.dart';
import '../../features/stations/data/device_location_repository.dart';
import '../../features/stations/domain/map_location.dart';
import '../powerme_app.dart';
import '../router.dart';
import 'vietmap_config.dart';

final _apiSessionProvider = Provider<DriverApiSession>(
  (ref) => throw StateError('Configure the Driver API session in ApiApp.'),
);

class ApiApp extends StatelessWidget {
  const ApiApp({
    super.key,
    required this.config,
    this.httpAdapter,
    this.vietmapConfig,
    this.locationRepository,
  });

  final ApiConfig config;
  final HttpClientAdapter? httpAdapter;
  final VietmapConfig? vietmapConfig;
  final MapLocationRepository? locationRepository;

  @override
  Widget build(BuildContext context) => ProviderScope(
    overrides: [
      apiRouterProvider.overrideWithValue(true),
      registrationOptionsProvider.overrideWithValue((
        enabled: config.consentVersion != null,
        needsVehicle: false,
      )),
      _apiSessionProvider.overrideWith((ref) {
        final session = DriverApiSession(config, adapter: httpAdapter);
        ref.onDispose(session.dispose);
        return session;
      }),
      authRepositoryProvider.overrideWith(
        (ref) => ApiAuthRepository(
          ref.watch(_apiSessionProvider),
          consentVersion: config.consentVersion,
        ),
      ),
      profileRepositoryProvider.overrideWith(
        (ref) => ApiProfileRepository(ref.watch(_apiSessionProvider)),
      ),
      chargeStartRepositoryProvider.overrideWith(
        (ref) => ApiChargeStartRepository(ref.watch(_apiSessionProvider)),
      ),
      chargeSessionRepositoryProvider.overrideWith(
        (ref) => ApiChargeSessionRepository(ref.watch(_apiSessionProvider)),
      ),
      connectorLookupRepositoryProvider.overrideWith((ref) {
        ref.watch(discoverySessionProvider);
        final repository = ApiConnectorLookupRepository(
          ref.watch(_apiSessionProvider),
        );
        ref.onDispose(repository.dispose);
        return repository;
      }),
      stationRepositoryProvider.overrideWith((ref) {
        ref.watch(authScopeProvider);
        final repository = ApiStationRepository(
          ref.watch(_apiSessionProvider),
          ref.watch(discoveryVehicleProvider),
        );
        ref.onDispose(repository.dispose);
        return repository;
      }),
      vietmapConfigProvider.overrideWithValue(vietmapConfig),
      mapLocationRepositoryProvider.overrideWith(
        (ref) => locationRepository ?? DeviceLocationRepository(),
      ),
    ],
    child: const PowerMeApp(),
  );
}
