import 'package:driver_app/demo/demo_store.dart';
import 'package:driver_app/features/profile/domain/driver_profile.dart';
import 'package:driver_app/features/auth/domain/auth_repository.dart';
import 'package:driver_app/features/auth/domain/auth_scope.dart';

class FakeAuthRepository implements AuthRepository {
  FakeAuthRepository(this.store, {DateTime Function()? clock})
    : _clock = clock ?? DateTime.now;
  final DemoStore store;
  final DateTime Function() _clock;
  final _accounts = <String, ({String principal, String password})>{
    'minh@powerme.local': (principal: 'driver-minh', password: 'PowerMe123!'),
    'driver@powerme.local': (principal: 'driver-minh', password: 'PowerMe123!'),
    'an@powerme.local': (principal: 'driver-an', password: 'PowerMe123!'),
  };
  final consentRecords = <String, ({String version, DateTime acceptedAt})>{};
  int _request = 0;
  int _account = 0;
  @override
  Future<String?> restore() async => null;
  @override
  Future<String> signIn(String email, String password) async {
    final request = ++_request;
    await Future<void>.delayed(Duration.zero);
    _requireCurrent(request);
    final account = _accounts[email.trim().toLowerCase()];
    if (account == null || account.password != password) {
      throw const AuthException(AuthFailure.invalidCredentials);
    }
    return account.principal;
  }

  @override
  Future<String> register(Registration registration) async {
    final request = ++_request;
    await Future<void>.delayed(Duration.zero);
    _requireCurrent(request);
    if (!registration.consent) {
      throw const AuthException(AuthFailure.consentRequired);
    }
    final email = registration.email.trim().toLowerCase();
    final vehicle = registration.vehicle;
    if (!RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(email) ||
        registration.password.length < 8 ||
        registration.displayName.trim().isEmpty ||
        registration.displayName.trim().length > 80 ||
        vehicle == null ||
        !vehicle.valid) {
      throw const AuthException(AuthFailure.invalidRegistration);
    }
    if (_accounts.containsKey(email)) {
      throw const AuthException(AuthFailure.emailInUse);
    }
    final principal = 'registered-${++_account}';
    final id = 'vehicle-${++store.nextVehicle}';
    store.profiles[principal] = DriverProfile(
      displayName: registration.displayName.trim(),
      email: email,
      language: AppLanguage.vietnamese,
      selectedVehicleId: id,
      vehicles: [
        Vehicle(
          id: id,
          brand: vehicle.brand.trim(),
          model: vehicle.model.trim(),
          connectors: vehicle.connectors,
        ),
      ],
    );
    consentRecords[principal] = (
      version: 'powerme-consent-local-v1',
      acceptedAt: _clock().toUtc(),
    );
    _accounts[email] = (principal: principal, password: registration.password);
    return principal;
  }

  void _requireCurrent(int request) {
    if (request != _request) throw const AuthException(AuthFailure.expired);
  }

  @override
  void signOut() {
    ++_request;
    store.bind(const AuthScope(principalId: '', generation: -1));
  }
}
