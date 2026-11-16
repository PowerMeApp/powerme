import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../core/l10n/app_copy.dart';
import '../core/theme/powerme_theme.dart';
import '../features/profile/application/profile_controller.dart';
import '../features/profile/presentation/profile_screen.dart';
import '../features/profile/presentation/profile_edit_screen.dart';
import '../features/profile/presentation/vehicle_edit_screen.dart';
import '../features/profile/presentation/vehicle_add_screen.dart';
import '../features/profile/presentation/api_vehicle_screens.dart';
import '../features/auth/application/auth_controller.dart';
import '../features/auth/presentation/auth_screen.dart';
import '../features/auth/presentation/onboarding_screen.dart';
import '../features/stations/presentation/discovery_screen.dart';
import '../features/stations/presentation/api_discovery_screen.dart';
import '../features/stations/presentation/api_station_detail_screen.dart';
import '../features/stations/presentation/api_suggestions_screen.dart';
import '../features/stations/domain/station_actions.dart';
import '../features/stations/presentation/station_detail_screen.dart';
import '../features/stations/presentation/station_actions_screens.dart';
import '../features/support/presentation/report_screen.dart';
import '../features/charging/presentation/charging_screens.dart';
import '../features/charging/presentation/qr_connect_screen.dart';
import '../features/payments/presentation/payment_screens.dart';
import '../features/history/presentation/history_screens.dart';
import '../features/loyalty/presentation/loyalty_screen.dart';

final apiRouterProvider = Provider<bool>((ref) => false);

final _apiVehiclePath = RegExp(r'^/vehicles/[1-9][0-9]{0,18}(/manage)?$');

final routerProvider = Provider<GoRouter>((ref) {
  final apiMode = ref.watch(apiRouterProvider);
  final registrationEnabled = ref.watch(registrationOptionsProvider).enabled;
  final refresh = _RouterRefresh();
  ref.listen(authControllerProvider, (_, _) => refresh.changed());
  String? pendingStation;
  final router = GoRouter(
    refreshListenable: refresh,
    redirect: (context, state) {
      final auth = ref.read(authControllerProvider);
      final path = state.uri.path;
      if (apiMode) {
        if (auth.restoring) return path == '/loading' ? null : '/loading';
        if (auth.scope == null) {
          return path == '/login' ||
                  (path == '/register' && registrationEnabled)
              ? null
              : '/login';
        }
        return path == '/profile' ||
                path == '/vehicles' ||
                path == '/vehicles/new' ||
                _apiVehiclePath.hasMatch(path) ||
                path == '/discover' ||
                path == '/scan' ||
                path == '/suggestions' ||
                RegExp(r'^/station/[1-9][0-9]{0,18}$').hasMatch(path)
            ? null
            : '/discover';
      }
      if (auth.scope == null &&
          RegExp(r'^/station/[a-zA-Z0-9_-]{1,100}$').hasMatch(path)) {
        pendingStation = path;
      }
      if (auth.restoring) return path == '/loading' ? null : '/loading';
      if (auth.scope == null) {
        return path == '/login' || path == '/register' ? null : '/login';
      }
      if (path == '/login' || path == '/register' || path == '/loading') {
        final destination = pendingStation ?? '/';
        pendingStation = null;
        return destination;
      }
      return null;
    },
    routes: [
      GoRoute(
        path: '/loading',
        builder: (context, state) => const Scaffold(
          body: Center(
            child: CircularProgressIndicator(
              semanticsLabel: 'Đang mở tài khoản',
            ),
          ),
        ),
      ),
      GoRoute(path: '/login', builder: (context, state) => const AuthScreen()),
      GoRoute(
        path: '/register',
        builder: (context, state) => const OnboardingScreen(),
      ),
      if (apiMode) ...[
        ShellRoute(
          builder: (context, state, child) => _PrivatePage(
            child: _AppShell(path: state.uri.path, apiMode: true, child: child),
          ),
          routes: [
            GoRoute(
              path: '/profile',
              builder: (context, state) =>
                  const Scaffold(body: ProfileScreen(apiMode: true)),
            ),
            GoRoute(
              path: '/discover',
              builder: (context, state) => const ApiDiscoveryScreen(),
            ),
            GoRoute(
              path: '/scan',
              builder: (context, state) => const QrConnectScreen(apiMode: true),
            ),
            GoRoute(
              path: '/suggestions',
              builder: (context, state) => const ApiSuggestionsScreen(),
            ),
          ],
        ),
        GoRoute(
          path: '/vehicles/new',
          builder: (context, state) =>
              const _PrivatePage(child: VehicleAddScreen()),
        ),
        GoRoute(
          path: '/vehicles',
          builder: (context, state) =>
              const _PrivatePage(child: VehicleGarageScreen()),
        ),
        GoRoute(
          path: '/vehicles/:id',
          builder: (context, state) => _PrivatePage(
            child: ApiVehicleDetailScreen(id: state.pathParameters['id']!),
          ),
          routes: [
            GoRoute(
              path: 'manage',
              builder: (context, state) => _PrivatePage(
                child: ApiVehicleDetailScreen(
                  id: state.pathParameters['id']!,
                  manage: true,
                ),
              ),
            ),
          ],
        ),
        GoRoute(
          path: '/station/:id',
          builder: (context, state) => _PrivatePage(
            child: ApiStationDetailScreen(id: state.pathParameters['id']!),
          ),
        ),
      ],
      if (!apiMode) ...[
        GoRoute(
          path: '/credit',
          builder: (context, state) =>
              const _PrivatePage(child: CreditScreen()),
        ),
        GoRoute(
          path: '/checkout/:id',
          builder: (context, state) => _PrivatePage(
            child: CheckoutScreen(
              key: ValueKey(state.pathParameters['id']),
              id: state.pathParameters['id']!,
            ),
          ),
        ),
        GoRoute(
          path: '/history',
          builder: (context, state) =>
              const _PrivatePage(child: HistoryScreen()),
        ),
        GoRoute(
          path: '/invoice/:id',
          builder: (context, state) => _PrivatePage(
            child: InvoiceScreen(id: state.pathParameters['id']!),
          ),
        ),
        GoRoute(
          path: '/loyalty',
          builder: (context, state) =>
              const _PrivatePage(child: LoyaltyScreen()),
        ),
        GoRoute(
          path: '/start',
          builder: (context, state) => _PrivatePage(
            child: StartScreen(
              key: ValueKey(state.uri.queryParameters['connector'] ?? ''),
              connector: state.uri.queryParameters['connector'] ?? '',
            ),
          ),
        ),
        GoRoute(
          path: '/statement/:id',
          builder: (context, state) => _PrivatePage(
            child: StatementScreen(id: state.pathParameters['id']!),
          ),
        ),
        ShellRoute(
          builder: (context, state, child) => _PrivatePage(
            child: _AppShell(path: state.uri.path, child: child),
          ),
          routes: [
            GoRoute(
              path: '/',
              builder: (context, state) => const DiscoveryScreen(),
            ),
            GoRoute(
              path: '/scan',
              builder: (context, state) => const QrConnectScreen(),
            ),
            GoRoute(
              path: '/charging',
              builder: (context, state) => const ActiveSessionScreen(),
            ),
            GoRoute(
              path: '/profile',
              builder: (context, state) => const ProfileScreen(),
            ),
          ],
        ),
        GoRoute(
          path: '/station/:id',
          builder: (context, state) => _PrivatePage(
            child: StationDetailScreen(id: state.pathParameters['id']!),
          ),
        ),
        GoRoute(
          path: '/suggestions',
          builder: (context, state) => _PrivatePage(
            child: SuggestionsScreen(
              initialMode: state.uri.queryParameters['mode'] == 'nearest'
                  ? SuggestionMode.nearest
                  : SuggestionMode.fastest,
            ),
          ),
        ),
        // GoRoute(
        //   path: '/reserve',
        //   builder: (context, state) => _PrivatePage(
        //     child: ReservationScreen(
        //       key: ValueKey(state.uri.queryParameters['connector'] ?? ''),
        //       connector: state.uri.queryParameters['connector'] ?? '',
        //     ),
        //   ),
        // ),
        GoRoute(
          path: '/report',
          builder: (context, state) => _PrivatePage(
            child: ReportScreen(
              key: ValueKey(state.uri.queryParameters['connector'] ?? ''),
              connector: state.uri.queryParameters['connector'] ?? '',
            ),
          ),
        ),
        GoRoute(
          path: '/profile/edit',
          builder: (context, state) =>
              const _PrivatePage(child: ProfileEditScreen()),
        ),
        GoRoute(
          path: '/vehicles/new',
          builder: (context, state) =>
              const _PrivatePage(child: VehicleEditScreen()),
        ),
        GoRoute(
          path: '/vehicles/:id/edit',
          builder: (context, state) => _PrivatePage(
            child: VehicleEditScreen(id: state.pathParameters['id']),
          ),
        ),
      ],
    ],
    errorBuilder: (context, state) => Scaffold(
      body: SafeArea(
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text('Không tìm thấy trang'),
              TextButton(
                onPressed: () => context.go('/'),
                child: const Text('Về trang chính'),
              ),
            ],
          ),
        ),
      ),
    ),
  );
  ref.onDispose(router.dispose);
  ref.onDispose(refresh.dispose);
  return router;
});

class _RouterRefresh extends ChangeNotifier {
  void changed() => notifyListeners();
}

class _PrivatePage extends ConsumerWidget {
  const _PrivatePage({required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scope = ref.watch(authControllerProvider).scope;
    return scope == null
        ? const SizedBox.shrink()
        : KeyedSubtree(
            key: ValueKey('${scope.principalId}/${scope.generation}'),
            child: child,
          );
  }
}

class _AppShell extends ConsumerWidget {
  const _AppShell({
    required this.path,
    required this.child,
    this.apiMode = false,
  });
  final String path;
  final Widget child;
  final bool apiMode;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final copy = AppCopy(ref.watch(profileControllerProvider).profile.language);
    final selected = switch (path) {
      '/charging' || '/scan' => 1,
      '/profile' => 2,
      _ => 0,
    };
    final paths = [
      apiMode ? '/discover' : '/',
      '/scan',
      '/profile',
    ];
    final destinations = [
      (
        key: 'nav-discovery',
        icon: Icons.explore_outlined,
        selected: Icons.explore,
        label: copy.home,
      ),
      (
        key: 'nav-charging',
        icon: Icons.qr_code_scanner_rounded,
        selected: Icons.qr_code_rounded,
        label: copy.scanQr,
      ),
      (
        key: 'nav-account',
        icon: Icons.person_outline_rounded,
        selected: Icons.person_rounded,
        label: copy.profile,
      ),
    ];
    void select(int index) {
      if (path != paths[index]) context.go(paths[index]);
    }

    final scaler = MediaQuery.textScalerOf(context);
    final labelSize = scaler.scale(12.5);
    final largeText = labelSize > 16;
    return Scaffold(
      body: child,
      bottomNavigationBar: DecoratedBox(
        decoration: BoxDecoration(
          border: Border(
            top: BorderSide(
              color: Theme.of(
                context,
              ).colorScheme.outline.withValues(alpha: .3),
            ),
          ),
        ),
        child: Padding(
          padding: const EdgeInsets.only(top: 1),
          child: NavigationBar(
            selectedIndex: selected,
            height: largeText ? 36 + labelSize * 3.7 : null,
            onDestinationSelected: select,
            destinations: [
              for (final (index, item) in destinations.indexed)
                if (largeText)
                  Semantics(
                    key: Key(item.key),
                    button: true,
                    selected: selected == index,
                    child: InkWell(
                      onTap: () => select(index),
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Icon(
                            selected == index ? item.selected : item.icon,
                            color: selected == index
                                ? PowerMeColors.teal
                                : PowerMeColors.muted,
                          ),
                          const SizedBox(height: 4),
                          Flexible(
                            child: Text(
                              item.label,
                              textAlign: TextAlign.center,
                              style: Theme.of(context).textTheme.labelMedium
                                  ?.copyWith(
                                    color: selected == index
                                        ? PowerMeColors.teal
                                        : PowerMeColors.muted,
                                  ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  )
                else
                  NavigationDestination(
                    key: Key(item.key),
                    icon: Icon(item.icon),
                    selectedIcon: Icon(item.selected),
                    label: item.label,
                  ),
            ],
          ),
        ),
      ),
    );
  }
}
