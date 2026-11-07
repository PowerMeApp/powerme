import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../domain/auth_repository.dart';
import '../domain/auth_scope.dart';

final authRepositoryProvider = Provider<AuthRepository>(
  (ref) => throw StateError('Select an auth adapter in composition.'),
);
final authControllerProvider = NotifierProvider<AuthController, AuthState>(
  AuthController.new,
);
const signedOutScope = AuthScope(principalId: '', generation: -1);
final authScopeProvider = Provider<AuthScope>(
  (ref) => ref.watch(authControllerProvider).scope ?? signedOutScope,
);

class AuthState {
  const AuthState({
    this.restoring = false,
    this.busy = false,
    this.scope,
    this.failure,
  });
  final bool restoring;
  final bool busy;
  final AuthScope? scope;
  final AuthFailure? failure;
}

class AuthController extends Notifier<AuthState> {
  int _generation = 0;
  @override
  AuthState build() {
    ref.watch(authRepositoryProvider);
    final generation = ++_generation;
    Future.microtask(() => _restore(generation));
    return const AuthState(restoring: true);
  }

  Future<void> _restore(int generation) async {
    if (!ref.mounted || generation != _generation) return;
    try {
      final principal = await ref.read(authRepositoryProvider).restore();
      if (!ref.mounted || generation != _generation) return;
      state = AuthState(
        scope: principal == null
            ? null
            : AuthScope(principalId: principal, generation: generation),
      );
    } catch (_) {
      if (ref.mounted && generation == _generation) {
        state = const AuthState(failure: AuthFailure.expired);
      }
    }
  }

  Future<void> signIn(String email, String password) => _authenticate(
    () => ref.read(authRepositoryProvider).signIn(email.trim(), password),
  );
  Future<void> register(Registration registration) => _authenticate(
    () => ref.read(authRepositoryProvider).register(registration),
  );
  Future<void> _authenticate(Future<String> Function() action) async {
    if (state.busy || state.restoring || state.scope != null) return;
    final generation = ++_generation;
    state = const AuthState(busy: true);
    try {
      final principal = await action();
      if (!ref.mounted || generation != _generation) return;
      state = AuthState(
        scope: AuthScope(principalId: principal, generation: generation),
      );
    } catch (error) {
      if (ref.mounted && generation == _generation) {
        state = AuthState(
          failure: error is AuthException
              ? error.failure
              : AuthFailure.unavailable,
        );
      }
    }
  }

  void clearFailure() {
    if (!state.busy && !state.restoring && state.scope == null) {
      state = const AuthState();
    }
  }

  void signOut() {
    ++_generation;
    ref.read(authRepositoryProvider).signOut();
    state = const AuthState();
  }
}
