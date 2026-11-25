import '../../profile/domain/vehicle.dart';

enum AuthFailure {
  invalidCredentials,
  invalidRegistration,
  consentRequired,
  emailInUse,
  phoneInUse,
  accountLocked,
  unavailable,
  expired,
  accessDenied,
  connection,
  rateLimited,
  profileUnavailable,
  registrationUnavailable,
  registrationUnconfirmed,
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
    this.phoneNumber,
    this.vehicle,
    required this.consent,
  });
  final String displayName;
  final String email;
  final String password;
  final String? phoneNumber;
  final VehicleDraft? vehicle;
  final bool consent;
}

abstract interface class AuthRepository {
  Future<String?> restore();
  Future<String> signIn(String identifier, String password);
  Future<String> register(Registration registration);
  void signOut();
}

abstract interface class AuthSessionEvents {
  Stream<AuthFailure> get sessionEnded;
}
