import '../../../core/api/driver_api_exception.dart';
import '../../../core/api/driver_api_session.dart';
import '../domain/auth_repository.dart';

class ApiAuthRepository implements AuthRepository, AuthSessionEvents {
  ApiAuthRepository(this._session, {required this._consentVersion});

  final DriverApiSession _session;
  final String? _consentVersion;

  @override
  Stream<AuthFailure> get sessionEnded => _session.ended.map(
    (reason) => switch (reason) {
      DriverSessionEnd.expired => AuthFailure.expired,
      DriverSessionEnd.forbidden => AuthFailure.accessDenied,
    },
  );

  @override
  Future<String?> restore() async => _session.account?.id;

  @override
  Future<String> signIn(String email, String password) =>
      _authenticate(() => _session.signIn(email, password));

  @override
  Future<String> register(Registration registration) async {
    final version = _consentVersion;
    if (version == null) {
      throw const AuthException(AuthFailure.registrationUnavailable);
    }
    if (!registration.consent) {
      throw const AuthException(AuthFailure.consentRequired);
    }
    return _authenticate(
      () => _session.register({
        'email': registration.email.trim(),
        'password': registration.password,
        'full_name': registration.displayName.trim(),
        'consent': true,
        'consent_version': version,
      }),
      registering: true,
    );
  }

  Future<String> _authenticate(
    Future<String> Function() action, {
    bool registering = false,
  }) async {
    try {
      return await action();
    } on DriverApiException catch (error) {
      final failure = switch (error) {
        DriverApiException(problem: DriverApiProblem.registrationUnconfirmed) =>
          AuthFailure.registrationUnconfirmed,
        DriverApiException(code: 'invalid_credentials') =>
          AuthFailure.invalidCredentials,
        DriverApiException(code: 'email_taken') => AuthFailure.emailInUse,
        DriverApiException(code: 'consent_required') =>
          AuthFailure.consentRequired,
        DriverApiException(status: 400) when registering =>
          AuthFailure.invalidRegistration,
        DriverApiException(status: 401) => AuthFailure.expired,
        DriverApiException(status: 403) => AuthFailure.accessDenied,
        DriverApiException(status: 429) => AuthFailure.rateLimited,
        DriverApiException(problem: DriverApiProblem.ended) =>
          AuthFailure.expired,
        _ when registering => AuthFailure.registrationUnconfirmed,
        DriverApiException(problem: DriverApiProblem.connection) =>
          AuthFailure.connection,
        DriverApiException(problem: DriverApiProblem.malformed) =>
          AuthFailure.profileUnavailable,
        _ => AuthFailure.unavailable,
      };
      throw AuthException(failure);
    }
  }

  @override
  void signOut() => _session.signOut();
}
