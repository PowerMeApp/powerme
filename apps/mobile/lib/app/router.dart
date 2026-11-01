import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../core/l10n/app_copy.dart';
import '../features/profile/application/profile_controller.dart';
import '../features/profile/presentation/profile_screen.dart';
import '../features/profile/presentation/profile_edit_screen.dart';
import '../features/profile/presentation/vehicle_edit_screen.dart';
import '../features/auth/application/auth_controller.dart';
import '../features/auth/presentation/auth_screen.dart';
import '../features/auth/presentation/onboarding_screen.dart';
import '../features/stations/presentation/discovery_screen.dart';
import '../features/stations/domain/station_actions.dart';
import '../features/stations/presentation/station_detail_screen.dart';
import '../features/stations/presentation/station_actions_screens.dart';
import '../features/support/presentation/report_screen.dart';
import '../features/charging/presentation/charging_screens.dart';
import '../features/charging/presentation/qr_connect_screen.dart';
import '../features/payments/presentation/payment_screens.dart';
import '../features/history/presentation/history_screens.dart';
import '../features/loyalty/presentation/loyalty_screen.dart';

final routerProvider = Provider<GoRouter>((ref) {
  final refresh = _RouterRefresh();
  ref.listen(authControllerProvider, (_, _) => refresh.changed());
  String? pendingStation;
  final router = GoRouter(
    refreshListenable: refresh,
    redirect: (context, state) {
      final auth = ref.read(authControllerProvider);
      final path = state.uri.path;
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
        path: '/credit',
        builder: (context, state) => const _PrivatePage(child: CreditScreen()),
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
        builder: (context, state) => const _PrivatePage(child: HistoryScreen()),
      ),
      GoRoute(
        path: '/invoice/:id',
        builder: (context, state) =>
            _PrivatePage(child: InvoiceScreen(id: state.pathParameters['id']!)),
      ),
      GoRoute(
        path: '/loyalty',
        builder: (context, state) => const _PrivatePage(child: LoyaltyScreen()),
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
  const _AppShell({required this.path, required this.child});
  final String path;
  final Widget child;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final copy = AppCopy(ref.watch(profileControllerProvider).profile.language);
    final selected = switch (path) {
      '/charging' || '/scan' => 1,
      '/profile' => 2,
      _ => 0,
    };
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
            onDestinationSelected: (index) {
              if (index != selected) {
                context.go(['/', '/scan', '/profile'][index]);
              }
            },
            destinations: [
              NavigationDestination(
                key: const Key('nav-discovery'),
                icon: const Icon(Icons.explore_outlined),
                selectedIcon: const Icon(Icons.explore),
                label: copy.home,
              ),
              NavigationDestination(
                key: const Key('nav-charging'),
                icon: const Icon(Icons.qr_code_scanner_rounded),
                selectedIcon: const Icon(Icons.qr_code_rounded),
                label: copy.scanQr,
              ),
              NavigationDestination(
                key: const Key('nav-account'),
                icon: const Icon(Icons.person_outline_rounded),
                selectedIcon: const Icon(Icons.person_rounded),
                label: copy.profile,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
