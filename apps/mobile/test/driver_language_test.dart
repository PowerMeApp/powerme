import 'dart:async';
import 'dart:ui' show Tristate;

import 'package:dio/dio.dart';
import 'package:driver_app/app/driver_tab_bar.dart';
import 'package:driver_app/app/router.dart';
import 'package:driver_app/features/auth/application/auth_controller.dart';
import 'package:driver_app/features/auth/domain/auth_scope.dart';
import 'package:driver_app/features/profile/application/profile_controller.dart';
import 'package:driver_app/features/profile/data/api_profile_repository.dart';
import 'package:driver_app/features/profile/domain/driver_profile.dart';
import 'package:driver_app/features/profile/domain/profile_repository.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'driver_api_fixture.dart';
import 'driver_api_session_test.dart' show sessionWith;
import 'driver_api_widget_test.dart' show enterAccount;
import 't146_session_widget_test.dart' as journey;

DriverApiFixture languageFixture() {
  var selected = '9';
  return journey.fixtureWith((request) async {
    return switch ((request.method, request.path)) {
      ('GET', 'me') => reply(
        200,
        account(
          id: '7',
          vehicles: [
            ownVehicle(isDefault: selected == '9'),
            ownVehicle(
              id: '10',
              plate: '30A-123.45',
              model: leaf,
              isDefault: selected == '10',
            ),
          ],
        ),
      ),
      ('GET', 'credit') => reply(200, {
        'balance_vnd': 125000,
        'held_vnd': 0,
        'available_vnd': 125000,
        'status': 'active',
      }),
      ('PATCH', 'vehicles/10') => () {
        selected = '10';
        return reply(200, ownVehicle(id: '10', model: leaf));
      }(),
      _ => throw StateError('Unexpected language fixture request'),
    };
  }, overrideMe: true);
}

DriverProfile profileOf(ProviderContainer container) =>
    container.read(profileControllerProvider).profile;

void expectLanguage(ProviderContainer container, AppLanguage language) =>
    expect(profileOf(container).language, language);

Finder keyed(String key) => find.byKey(Key(key));

void expectAccountTab(String label) {
  final tab = find.descendant(
    of: find.byType(DriverTabBar),
    matching: find.text(label),
  );
  expect(tab, findsOneWidget);
}

void main() {
  test('local language survives account changes; fresh repo uses VI', () async {
    var second = false;
    final fixture = journey.fixtureWith(
      (r) async => switch (r.path) {
        'me' => reply(
          200,
          second
              ? account(id: '8', name: 'Second driver', withVehicle: false)
              : account(),
        ),
        _ => throw StateError('Unexpected request'),
      },
      overrideMe: true,
    );
    final session = sessionWith(fixture);
    final repo = ApiProfileRepository(session);
    expect(repo.read().language, AppLanguage.vietnamese);
    expect(repo.selectLanguage(AppLanguage.english).vehicles, isEmpty);
    expect(fixture.requests, isEmpty);
    await session.signIn('test@example.invalid', 'fixture password');
    final initial = repo.read();
    expect(initial.language, AppLanguage.english);
    final requests = fixture.requests.length;
    final vi = repo.selectLanguage(AppLanguage.vietnamese);
    expect(identical(vi.selectedVehicle, initial.selectedVehicle), isTrue);
    expect(identical(repo.read(), vi), isTrue);
    final en = repo.selectLanguage(AppLanguage.english);
    expect(identical(en.selectedVehicle, initial.selectedVehicle), isTrue);
    expect(fixture.requests, hasLength(requests));
    expect((await repo.refresh()).language, AppLanguage.english);
    session.signOut();
    final empty = repo.read();
    expect(empty.language, AppLanguage.english);
    expect(empty.displayName, isEmpty);
    expect(empty.vehicles, isEmpty);
    expect(empty.selectedVehicle, isNull);
    second = true;
    await session.signIn('other@example.invalid', 'fixture password');
    expect(repo.read().displayName, 'Second driver');
    expect(repo.read().vehicles, isEmpty);
    expect(repo.read().language, AppLanguage.english);
    expect(
      ApiProfileRepository(session).read().language,
      AppLanguage.vietnamese,
    );
  });

  for (final failure in ProfileFailure.values.where((f) => f.needsRefresh)) {
    test('language retains $failure lock and busy guard', () async {
      var failRead = false;
      Completer<ResponseBody>? pending;
      final fixture = DriverApiFixture((r) async {
        if (r.path == 'auth/login') return reply(200, tokens(accessA));
        if (r.path == 'me') {
          if (pending != null) return pending.future;
          return failRead ? reply(500, {}) : reply(200, account());
        }
        if (r.path == 'vehicles/9') {
          if (failure == ProfileFailure.mutationNeedsRefresh) {
            failRead = true;
            return reply(200, ownVehicle());
          }
          return failure == ProfileFailure.vehicleMissing
              ? reply(404, {'error': 'not_found'})
              : reply(500, {});
        }
        throw StateError('Unexpected request');
      });
      final session = sessionWith(fixture);
      await session.signIn('test@example.invalid', 'fixture password');
      final c = ProviderContainer.test(
        overrides: [
          authScopeProvider.overrideWithValue(
            AuthScope(principalId: session.account!.id, generation: 1),
          ),
          profileRepositoryProvider.overrideWithValue(
            ApiProfileRepository(session),
          ),
        ],
      );
      final controller = c.read(profileControllerProvider.notifier);
      expect(await controller.selectVehicle('9'), isFalse);
      expect(c.read(profileControllerProvider).failure, failure);
      final count = fixture.requests.length;
      controller.selectLanguage(AppLanguage.english);
      expectLanguage(c, AppLanguage.english);
      expect(c.read(profileControllerProvider).failure, failure);
      expect(c.read(profileControllerProvider).canChange, isFalse);
      expect(await controller.removeVehicle('9'), isFalse);
      expect(fixture.requests, hasLength(count));
      pending = Completer<ResponseBody>();
      final refresh = controller.refresh();
      expect(c.read(profileControllerProvider).busy, isTrue);
      controller.selectLanguage(AppLanguage.vietnamese);
      expectLanguage(c, AppLanguage.english);
      pending.complete(reply(200, account()));
      expect(await refresh, isTrue);
      expect(c.read(profileControllerProvider).failure, isNull);
      expect(c.read(profileControllerProvider).canChange, isTrue);
      expectLanguage(c, AppLanguage.english);
    });
  }

  for (final narrow in [false, true]) {
    testWidgets('API VI–EN–VI preserves route/auth/vehicle: narrow=$narrow', (
      tester,
    ) async {
      Future<void> tapKey(String key) => journey.tap(tester, keyed(key));
      final semantics = tester.ensureSemantics();
      try {
        await journey.viewport(tester, narrow);
        final fixture = languageFixture();
        await journey.login(tester, fixture);
        await journey.tap(tester, keyed('nav-account'));
        final c = journey.container(tester);
        final router = c.read(routerProvider);
        final scope = c.read(authScopeProvider);
        final vehicle = profileOf(c).selectedVehicle;
        await journey.reveal(tester, keyed('language-english'));
        final count = fixture.requests.length;
        await tapKey('language-english');
        final english = keyed('language-english');
        await journey.reveal(tester, english);
        final selection = find
            .ancestor(of: english, matching: find.byType(Semantics))
            .first;
        expect(
          tester.getSemantics(selection).flagsCollection.isSelected,
          Tristate.isTrue,
        );
        expect(tester.widget<OutlinedButton>(english).onPressed, isNotNull);
        for (final language in AppLanguage.values) {
          final control = keyed('language-${language.name}');
          await journey.reveal(tester, control);
          expect(tester.getSize(control).height, greaterThanOrEqualTo(48));
          expect(tester.getSize(control).width, greaterThanOrEqualTo(48));
        }
        expect(find.text('Language'), findsOneWidget);
        expect(find.text('Sign out'), findsOneWidget);
        expectAccountTab('Account');
        expect(c.read(authScopeProvider), same(scope));
        expect(c.read(routerProvider), same(router));
        expect(journey.path(tester), '/profile');
        expect(profileOf(c).selectedVehicle, same(vehicle));
        expect(fixture.requests, hasLength(count));
        await tapKey('nav-discovery');
        await tapKey('nav-account');
        expectLanguage(c, AppLanguage.english);
        await tapKey('refresh-profile');
        expectLanguage(c, AppLanguage.english);
        router.go('/vehicles/10/manage');
        await tester.pumpAndSettle();
        await tapKey('select-10');
        await tapKey('confirm-default-vehicle');
        expect(profileOf(c).vehicleId, '10');
        expectLanguage(c, AppLanguage.english);
        router.go('/profile');
        await tester.pumpAndSettle();
        await tapKey('language-vietnamese');
        expectLanguage(c, AppLanguage.vietnamese);
        expectAccountTab('Tài khoản');
        c
            .read(profileControllerProvider.notifier)
            .selectLanguage(AppLanguage.english);
        c.read(authControllerProvider.notifier).signOut();
        await tester.pumpAndSettle();
        expect(journey.path(tester), '/login');
        expect(profileOf(c).vehicles, isEmpty);
        expectLanguage(c, AppLanguage.english);
        await enterAccount(tester);
        await tapKey('nav-account');
        expectLanguage(c, AppLanguage.english);
        expect(profileOf(c).vehicleId, '10');
        expect(
          fixture.requests.where((r) => r.method != 'GET').map((r) => r.path),
          ['auth/login', 'vehicles/10', 'auth/login'],
        );
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      } finally {
        semantics.dispose();
      }
    });
  }
}
