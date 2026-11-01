import '../../profile/domain/vehicle.dart';

enum AuthFailure {
  invalidCredentials,
  invalidRegistration,
  consentRequired,
  emailInUse,
  unavailable,
  expired,
}

class AuthException implements Exception {
  const AuthException(this.failure);
  final AuthFailure failure;
}

class Registration {
  const Registration({
    required this.displayName,
    required this.email,
    required this.password,
    required this.vehicle,
    required this.consent,
  });
  final String displayName;
  final String email;
  final String password;
  final VehicleDraft vehicle;
  final bool consent;
}

abstract interface class AuthRepository {
  Future<String?> restore();
  Future<String> signIn(String email, String password);
  Future<String> register(Registration registration);
  void signOut();
}
