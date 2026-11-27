import 'package:driver_app/features/charging/application/owned_sessions_controller.dart';
import 'package:driver_app/features/charging/data/api_owned_session_repository.dart';
import 'package:dio/dio.dart';
import 'package:driver_app/app/powerme_app.dart';
import 'package:driver_app/app/router.dart';
import 'package:driver_app/core/api/driver_api_session.dart';
import 'package:driver_app/features/auth/application/auth_controller.dart';
import 'package:driver_app/features/auth/data/api_auth_repository.dart';
import 'package:driver_app/features/charging/application/charge_session_controller.dart';
import 'package:driver_app/features/charging/application/charge_start_controller.dart';
import 'package:driver_app/features/charging/data/api_charge_session_repository.dart';
import 'package:driver_app/features/charging/data/api_charge_start_repository.dart';
import 'package:driver_app/features/payments/application/charging_credit_controller.dart';
import 'package:driver_app/features/payments/application/credit_top_up_controller.dart';
import 'package:driver_app/features/payments/data/api_charging_credit_repository.dart';
import 'package:driver_app/features/payments/data/api_credit_top_up_repository.dart';
import 'package:driver_app/features/profile/application/profile_controller.dart';
import 'package:driver_app/features/profile/data/api_profile_repository.dart';
import 'package:driver_app/features/profile/domain/driver_profile.dart';
import 'package:driver_app/features/stations/application/connector_lookup_controller.dart';
import 'package:driver_app/features/stations/application/stations_controller.dart';
import 'package:driver_app/features/stations/application/map_location_controller.dart';
import 'package:driver_app/features/stations/domain/map_location.dart';
import 'package:driver_app/features/stations/data/api_connector_lookup_repository.dart';
import 'package:driver_app/features/stations/data/api_station_repository.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import '../driver_api_fixture.dart';
import '../driver_api_widget_test.dart' show api;
import '../driver_discovery_fixture.dart';
import 'charge_modes_fixture.dart';
import 'loyalty_api_fixture.dart';

Future<ProviderContainer> mountConsistencyApp(
  WidgetTester tester, {
  required Key boundaryKey,
  required AppLanguage language,
  ChargeModesFixture? chargeFixture,
  Future<ResponseBody?> Function(RequestOptions)? intercept,
}) async {
  final charging = chargeFixture ?? (ChargeModesFixture()..confirmed = true);
  final fixture = DriverApiFixture((request) async {
    final intercepted = await intercept?.call(request);
    if (intercepted != null) return intercepted;
    switch (request.path) {
      case 'me':
        return reply(200, account(vehicles: [leafVehicle()]));
      case 'stations':
        return reply(
          200,
          page(
            [
              {
                ...station('31', 'PowerMe Võ Văn Tần', smart: true),
                'est_wait_min': 5.0000001,
                'est_charge_min': 16.123456789,
                'est_total_min': 29.623456889,
              },
            ],
            rangeKm: 70,
            pageSize: request.queryParameters['sort'] == 'smart' ? 3 : 20,
          ),
        );
      case 'credit':
        return reply(200, {
          'balance_vnd': 74000,
          'held_vnd': 0,
          'available_vnd': 74000,
          'status': 'active',
        });
      case loyaltyQuotePath:
        return reply(200, loyaltyQuote());
      default:
        return charging.adapter.handler(request);
    }
  });
  final session = DriverApiSession(api, adapter: fixture);
  await tester.runAsync(
    () => session.signIn('test@example.invalid', 'fixture password'),
  );
  final container = ProviderContainer(
    overrides: [
      apiRouterProvider.overrideWithValue(true),
      mapLocationRepositoryProvider.overrideWithValue(_ConsistencyLocation()),
      authRepositoryProvider.overrideWithValue(
        ApiAuthRepository(session, consentVersion: null),
      ),
      profileRepositoryProvider.overrideWithValue(
        ApiProfileRepository(session),
      ),
      profileControllerProvider.overrideWith(() => _LocalizedProfile(language)),
      chargingCreditRepositoryProvider.overrideWithValue(
        ApiChargingCreditRepository(session),
      ),
      creditTopUpRepositoryProvider.overrideWithValue(
        ApiCreditTopUpRepository(session),
      ),
      chargeStartRepositoryProvider.overrideWithValue(
        ApiChargeStartRepository(session),
      ),
      ownedSessionRepositoryProvider.overrideWithValue(
        ApiOwnedSessionRepository(session),
      ),
      chargeSessionRepositoryProvider.overrideWithValue(
        ApiChargeSessionRepository(session),
      ),
      connectorLookupRepositoryProvider.overrideWithValue(
        ApiConnectorLookupRepository(session),
      ),
      stationRepositoryProvider.overrideWithValue(
        ApiStationRepository(session, '9'),
      ),
    ],
  );
  addTearDown(container.dispose);
  addTearDown(session.dispose);
  container.read(authControllerProvider);
  await tester.pump();
  container.read(routerProvider).go('/suggestions');
  await tester.pumpWidget(
    RepaintBoundary(
      key: boundaryKey,
      child: UncontrolledProviderScope(
        container: container,
        child: const PowerMeApp(),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return container;
}

class _LocalizedProfile extends ProfileController {
  _LocalizedProfile(this.language);
  final AppLanguage language;
  @override
  ProfileState build() {
    final p = super.build().profile;
    return ProfileState(
      DriverProfile(
        displayName: p.displayName,
        language: language,
        vehicles: p.vehicles,
        selectedVehicleId: p.selectedVehicleId,
        revision: p.revision,
      ),
    );
  }
}

class _ConsistencyLocation implements MapLocationRepository {
  @override
  Future<MapLocation> current() async => const MapLocation(10.77, 106.66);
}

Future<void> selectConsistencyOrigin(WidgetTester tester) async {
  final selector = find.byKey(const Key('open-discovery-origin'));
  if (selector.evaluate().isEmpty) {
    await tester.scrollUntilVisible(
      selector,
      160,
      scrollable: find.byType(Scrollable).first,
    );
  }
  await Scrollable.ensureVisible(tester.element(selector), alignment: .5);
  await tester.pump();
  await tester.tap(selector);
  await tester.pumpAndSettle();
  final location = find.byKey(const Key('discovery-use-location'));
  await Scrollable.ensureVisible(tester.element(location), alignment: .5);
  await tester.pump();
  await tester.tap(location);
  await tester.pumpAndSettle();
}
