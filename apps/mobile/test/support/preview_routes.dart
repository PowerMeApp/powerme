import 'package:driver_app/app/router.dart';
import 'package:driver_app/features/profile/presentation/profile_edit_screen.dart';
import 'package:driver_app/features/profile/presentation/vehicle_edit_screen.dart';
import 'package:driver_app/features/stations/presentation/discovery_screen.dart';
import 'package:driver_app/features/stations/domain/station_actions.dart';
import 'package:driver_app/features/stations/presentation/station_detail_screen.dart';
import 'package:driver_app/features/stations/presentation/station_actions_screens.dart';
import 'preview_report_screen.dart';
import 'package:driver_app/features/charging/presentation/charging_screens.dart';
import 'preview_payment_screens.dart';
import 'package:driver_app/features/history/presentation/history_screens.dart';
import 'preview_loyalty_screen.dart';
import 'package:driver_app/features/charging/presentation/qr_connect_screen.dart';
import 'package:driver_app/features/profile/presentation/profile_screen.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

List<RouteBase> buildPreviewRoutes() => [
  GoRoute(
    path: '/credit',
    builder: (context, state) =>
        const DriverPrivatePage(child: PreviewTopUpScreen()),
  ),
  GoRoute(
    path: '/checkout/:id',
    builder: (context, state) => DriverPrivatePage(
      child: CheckoutScreen(
        key: ValueKey(state.pathParameters['id']),
        id: state.pathParameters['id']!,
      ),
    ),
  ),
  GoRoute(
    path: '/history',
    builder: (context, state) =>
        const DriverPrivatePage(child: HistoryScreen()),
  ),
  GoRoute(
    path: '/invoice/:id',
    builder: (context, state) => DriverPrivatePage(
      child: InvoiceScreen(id: state.pathParameters['id']!),
    ),
  ),
  GoRoute(
    path: '/loyalty',
    builder: (context, state) =>
        const DriverPrivatePage(child: LoyaltyScreen()),
  ),
  GoRoute(
    path: '/start',
    builder: (context, state) => DriverPrivatePage(
      child: StartScreen(
        key: ValueKey(state.uri.queryParameters['connector'] ?? ''),
        connector: state.uri.queryParameters['connector'] ?? '',
      ),
    ),
  ),
  GoRoute(
    path: '/statement/:id',
    builder: (context, state) => DriverPrivatePage(
      child: StatementScreen(id: state.pathParameters['id']!),
    ),
  ),
  ShellRoute(
    builder: (context, state, child) => DriverPrivatePage(
      child: DriverAppShell(path: state.uri.path, child: child),
    ),
    routes: [
      GoRoute(path: '/', builder: (context, state) => const DiscoveryScreen()),
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
    builder: (context, state) => DriverPrivatePage(
      child: StationDetailScreen(id: state.pathParameters['id']!),
    ),
  ),
  GoRoute(
    path: '/suggestions',
    builder: (context, state) => DriverPrivatePage(
      child: SuggestionsScreen(
        initialMode: state.uri.queryParameters['mode'] == 'nearest'
            ? SuggestionMode.nearest
            : SuggestionMode.fastest,
      ),
    ),
  ),
  GoRoute(
    path: '/report',
    builder: (context, state) => DriverPrivatePage(
      child: ReportScreen(
        key: ValueKey(state.uri.queryParameters['connector'] ?? ''),
        connector: state.uri.queryParameters['connector'] ?? '',
      ),
    ),
  ),
  GoRoute(
    path: '/profile/edit',
    builder: (context, state) =>
        const DriverPrivatePage(child: ProfileEditScreen()),
  ),
  GoRoute(
    path: '/vehicles/new',
    builder: (context, state) =>
        const DriverPrivatePage(child: VehicleEditScreen()),
  ),
  GoRoute(
    path: '/vehicles/:id/edit',
    builder: (context, state) => DriverPrivatePage(
      child: VehicleEditScreen(id: state.pathParameters['id']),
    ),
  ),
];
