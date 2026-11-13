import 'dart:async';
import 'package:driver_app/demo/demo_store.dart';
import 'package:driver_app/features/auth/application/auth_controller.dart';
import 'support/fake_auth_repository.dart';
import 'package:driver_app/features/auth/domain/auth_repository.dart';
import 'package:driver_app/features/auth/domain/auth_scope.dart';
import 'package:driver_app/features/profile/application/profile_controller.dart';
import 'package:driver_app/features/profile/data/mock_profile_repository.dart';
import 'package:driver_app/features/profile/domain/driver_profile.dart';
import 'package:driver_app/features/profile/domain/profile_repository.dart';
import 'package:driver_app/features/stations/application/stations_controller.dart';
import 'package:driver_app/features/stations/data/mock_station_repository.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

const leaf = VehicleDraft(
  brand: 'Nissan',
  model: 'Leaf',
  connectors: ['CHAdeMO'],
);
Registration registration({bool consent = true}) => Registration(
  displayName: 'Lan Nguyễn',
  email: 'lan@example.test',
  password: 'LocalPass123!',
  vehicle: leaf,
  consent: consent,
);

ProviderContainer composition(DemoStore store, AuthRepository auth) =>
    ProviderContainer.test(
      overrides: [
        authRepositoryProvider.overrideWithValue(auth),
        authScopeProvider.overrideWith((ref) {
          final scope =
              ref.watch(authControllerProvider).scope ?? signedOutScope;
          store.bind(scope);
          return scope;
        }),
        profileRepositoryProvider.overrideWith(
          (ref) =>
              MockProfileRepository(store, scope: ref.watch(authScopeProvider)),
        ),
        stationRepositoryProvider.overrideWith(
          (ref) =>
              MockStationRepository(store, scope: ref.watch(authScopeProvider)),
        ),
      ],
    );

void main() {
  test(
    'Mock credentials reject; consent and UTC receipt precede atomic registration; duplicates reject',
    () async {
      final store = DemoStore();
      final repo = FakeAuthRepository(
        store,
        clock: () => DateTime.utc(2026, 10, 29),
      );
      expect(await repo.restore(), isNull);
      await expectLater(
        repo.signIn('minh@powerme.local', 'wrong'),
        throwsA(isA<AuthException>()),
      );
      await expectLater(
        repo.register(registration(consent: false)),
        throwsA(isA<AuthException>()),
      );
      expect(store.profiles.length, 2);
      expect(repo.consentRecords, isEmpty);
      final principal = await repo.register(registration());
      expect(store.profiles[principal]!.vehicle, 'Nissan Leaf');
      expect(repo.consentRecords[principal]!.acceptedAt.isUtc, isTrue);
      expect(repo.consentRecords[principal]!.version, isNotEmpty);
      await expectLater(
        repo.register(registration()),
        throwsA(isA<AuthException>()),
      );
      expect(store.profiles.length, 3);
      expect(
        await repo.signIn(' LAN@EXAMPLE.TEST ', 'LocalPass123!'),
        principal,
      );
    },
  );

  test(
    'Restore gate, duplicate submission, late login/logout/restore and same-principal generation',
    () async {
      final repo = DeferredAuth();
      final container = ProviderContainer.test(
        overrides: [authRepositoryProvider.overrideWithValue(repo)],
      );
      final controller = container.read(authControllerProvider.notifier);
      expect(container.read(authControllerProvider).restoring, isTrue);
      await controller.signIn('A', 'password');
      expect(repo.logins, isEmpty);
      await Future<void>.delayed(Duration.zero);
      controller.signOut();
      repo.restored.complete('A');
      await Future<void>.delayed(Duration.zero);
      expect(container.read(authControllerProvider).scope, isNull);
      final old = controller.signIn('A', 'password');
      await controller.signIn('A', 'password');
      expect(repo.logins.length, 1);
      controller.signOut();
      final current = controller.signIn('B', 'password');
      repo.logins[0].complete('A');
      await old;
      expect(container.read(authControllerProvider).scope, isNull);
      repo.logins[1].complete('B');
      await current;
      final generation = container
          .read(authControllerProvider)
          .scope!
          .generation;
      controller.signOut();
      final again = controller.signIn('B', 'password');
      repo.logins.last.complete('B');
      await again;
      expect(
        container.read(authControllerProvider).scope!.generation,
        greaterThan(generation),
      );
    },
  );

  test(
    'Disposed login completion and logout before scheduled restore cannot revive auth',
    () async {
      final repo = DeferredAuth();
      final container = ProviderContainer(
        overrides: [authRepositoryProvider.overrideWithValue(repo)],
      );
      final controller = container.read(authControllerProvider.notifier);
      controller.signOut();
      await Future<void>.delayed(Duration.zero);
      expect(repo.restoreCalls, 0);
      final login = controller.signIn('A', 'password');
      container.dispose();
      repo.logins.single.complete('A');
      await login;
    },
  );

  test(
    'Vehicle validation, CRUD, selection, revision races, missing owner and last-vehicle removal',
    () async {
      final store = DemoStore();
      final repo = MockProfileRepository(store);
      await expectLater(
        repo.saveVehicle(
          const VehicleDraft(brand: '', model: '', connectors: []),
          null,
          0,
        ),
        throwsA(isA<ProfileException>()),
      );
      var profile = await repo.saveVehicle(leaf, null, 0);
      final id = profile.vehicles.last.id;
      profile = await repo.selectVehicle(id, profile.revision);
      expect(profile.vehicle, 'Nissan Leaf');
      final revision = profile.revision;
      final update = repo.saveVehicle(
        const VehicleDraft(brand: 'BYD', model: 'Atto 3', connectors: ['CCS2']),
        id,
        revision,
      );
      final raced = repo.removeVehicle(id, revision);
      profile = await update;
      await expectLater(raced, throwsA(isA<ProfileException>()));
      expect(profile.vehicle, 'BYD Atto 3');
      await expectLater(
        repo.selectVehicle('vehicle-leaf', profile.revision),
        throwsA(isA<ProfileException>()),
      );
      profile = await repo.removeVehicle(id, profile.revision);
      expect(profile.vehicleId, 'vehicle-ioniq5');
      profile = await repo.removeVehicle(profile.vehicleId, profile.revision);
      expect(profile.selectedVehicle, isNull);
      expect(profile.vehicles, isEmpty);
      profile = await repo.saveVehicle(leaf, null, profile.revision);
      expect(profile.selectedVehicle, isNotNull);
    },
  );

  test(
    'Logout rejects in-flight repository mutation including same account new generation',
    () async {
      final store = DemoStore();
      final repo = MockProfileRepository(store);
      final pending = repo.updateName('Old response', 0);
      store.bind(const AuthScope(principalId: 'driver-minh', generation: 2));
      await expectLater(pending, throwsStateError);
      expect(store.profile.displayName, 'Minh Nguyễn');
      store.bind(const AuthScope(principalId: 'driver-an', generation: 3));
      expect(() => repo.read(), throwsStateError);
      expect(
        () => MockStationRepository(
          store,
          scope: const AuthScope(principalId: 'driver-minh', generation: 1),
        ).getById('station-powerme-center'),
        throwsStateError,
      );
    },
  );

  test(
    'Real composition A/logout/B clears private state and old mutation; edit compatibility refreshes',
    () async {
      final store = DemoStore();
      final auth = FakeAuthRepository(store);
      final container = composition(store, auth);
      final controller = container.read(authControllerProvider.notifier);
      await Future<void>.delayed(Duration.zero);
      await controller.signIn('minh@powerme.local', 'PowerMe123!');
      final profile = container.read(profileControllerProvider.notifier);
      final stationSubscription = container.listen(
        stationsControllerProvider,
        (_, _) {},
      );
      addTearDown(stationSubscription.close);
      await Future<void>.delayed(Duration.zero);
      expect(
        container
            .read(stationsControllerProvider)
            .stations
            .any((s) => s.vinfastOnly),
        isFalse,
      );
      expect(await profile.saveVehicle(leaf, 'vehicle-ioniq5'), isTrue);
      await container.pump();
      await Future<void>.delayed(Duration.zero);
      expect(
        container.read(stationsControllerProvider).stations.map((s) => s.id),
        ['station-powerme-airport'],
      );
      final old = profile.updateName('Must not appear');
      controller.signOut();
      expect(container.read(profileControllerProvider).profile.displayName, '');
      expect(container.read(stationsControllerProvider).options, isEmpty);
      await controller.signIn('an@powerme.local', 'PowerMe123!');
      expect(await old, isFalse);
      expect(
        container.read(profileControllerProvider).profile.displayName,
        'An Trần',
      );
      expect(store.profiles['driver-minh']!.displayName, 'Minh Nguyễn');
    },
  );

  test(
    'Mock repository cancellation does not create account after logout',
    () async {
      final store = DemoStore();
      final repo = FakeAuthRepository(store);
      final pending = repo.register(registration());
      repo.signOut();
      await expectLater(pending, throwsA(isA<AuthException>()));
      expect(store.profiles.length, 2);
      expect(repo.consentRecords, isEmpty);
    },
  );
}

class DeferredAuth implements AuthRepository {
  final restored = Completer<String?>();
  final logins = <Completer<String>>[];
  int restoreCalls = 0;
  @override
  Future<String?> restore() {
    restoreCalls++;
    return restored.future;
  }

  @override
  Future<String> signIn(String email, String password) {
    final result = Completer<String>();
    logins.add(result);
    return result.future;
  }

  @override
  Future<String> register(Registration registration) =>
      signIn(registration.email, registration.password);
  @override
  void signOut() {}
}
