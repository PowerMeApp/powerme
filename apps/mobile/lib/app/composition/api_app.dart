import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_config.dart';
import '../../core/api/driver_api_session.dart';
import '../../features/auth/application/auth_controller.dart';
import '../../features/auth/data/api_auth_repository.dart';
import '../../features/profile/application/profile_controller.dart';
import '../../features/profile/data/api_profile_repository.dart';
import '../powerme_app.dart';
import '../router.dart';

final _apiSessionProvider = Provider<DriverApiSession>(
  (ref) => throw StateError('Configure the Driver API session in ApiApp.'),
);

class ApiApp extends StatelessWidget {
  const ApiApp({super.key, required this.config, this.httpAdapter});

  final ApiConfig config;
  final HttpClientAdapter? httpAdapter;

  @override
  Widget build(BuildContext context) => ProviderScope(
    overrides: [
      accountOnlyRouterProvider.overrideWithValue(true),
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
    ],
    child: const PowerMeApp(),
  );
}
