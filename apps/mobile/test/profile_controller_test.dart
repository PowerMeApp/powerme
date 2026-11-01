import 'package:driver_app/demo/demo_store.dart';
import 'package:driver_app/features/auth/application/auth_controller.dart';
import 'package:driver_app/features/profile/application/profile_controller.dart';
import 'package:driver_app/features/profile/data/mock_profile_repository.dart';
import 'package:driver_app/features/profile/domain/driver_profile.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'Language writes reach shared store; a fresh composition resets demo data',
    () {
      final store = DemoStore();
      final container = ProviderContainer.test(
        overrides: [
          authScopeProvider.overrideWithValue(store.activeScope),
          profileRepositoryProvider.overrideWithValue(
            MockProfileRepository(store),
          ),
        ],
      );
      final initial = container.read(profileControllerProvider).profile;
      container
          .read(profileControllerProvider.notifier)
          .selectLanguage(AppLanguage.english);
      expect(store.profile.language, AppLanguage.english);
      expect(store.profile.displayName, initial.displayName);
      expect(store.profile.vehicle, initial.vehicle);
      container.invalidate(profileControllerProvider);
      expect(
        container.read(profileControllerProvider).profile.language,
        AppLanguage.english,
      );
      final fresh = ProviderContainer.test(
        overrides: [
          authScopeProvider.overrideWithValue(store.activeScope),
          profileRepositoryProvider.overrideWithValue(
            MockProfileRepository(DemoStore()),
          ),
        ],
      );
      expect(
        fresh.read(profileControllerProvider).profile.language,
        AppLanguage.vietnamese,
      );
    },
  );
}
