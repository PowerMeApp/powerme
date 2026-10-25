import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../features/auth/presentation/auth_controller.dart';
import '../features/auth/presentation/auth_screen.dart';
import '../features/charging/presentation/charging_screen.dart';
import '../features/history/presentation/history_screen.dart';
import '../features/payments/presentation/payment_screen.dart';
import '../features/profile/presentation/account_screen.dart';
import '../features/stations/presentation/discovery_screen.dart';
import '../features/stations/presentation/reservation_screen.dart';
import '../features/stations/presentation/scan_screen.dart';
import '../features/stations/presentation/station_detail_screen.dart';
import '../features/support/presentation/support_screen.dart';
import 'shell_screen.dart';

final routerProvider = Provider<GoRouter>((ref) {
  final auth = ref.watch(authControllerProvider);
  return GoRouter(
    initialLocation: auth.isAuthenticated ? '/discover' : '/auth',
    redirect: (context, state) {
      final isAuthRoute = state.matchedLocation == '/auth';
      if (!auth.isAuthenticated && !isAuthRoute) return '/auth';
      if (auth.isAuthenticated && isAuthRoute) return '/discover';
      return null;
    },
    routes: [
      GoRoute(path: '/auth', builder: (_, _) => const AuthScreen()),
      StatefulShellRoute.indexedStack(
        builder: (_, _, navigationShell) =>
            ShellScreen(navigationShell: navigationShell),
        branches: [
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/discover',
                builder: (_, _) => const DiscoveryScreen(),
                routes: [
                  GoRoute(
                    path: 'station/:stationId',
                    builder: (_, state) => StationDetailScreen(
                      stationId: state.pathParameters['stationId']!,
                    ),
                  ),
                ],
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/charging',
                builder: (_, _) => const ChargingScreen(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/history',
                builder: (_, _) => const HistoryScreen(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/account',
                builder: (_, _) => const AccountScreen(),
              ),
            ],
          ),
        ],
      ),
      GoRoute(path: '/payment', builder: (_, _) => const PaymentScreen()),
      GoRoute(path: '/support', builder: (_, _) => const SupportScreen()),
      GoRoute(path: '/scan', builder: (_, _) => const ScanScreen()),
      GoRoute(
        path: '/reservation/:stationId',
        builder: (_, state) =>
            ReservationScreen(stationId: state.pathParameters['stationId']!),
      ),
    ],
  );
});
