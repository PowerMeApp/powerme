import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/auth_models.dart';

final authControllerProvider = NotifierProvider<AuthController, AuthState>(
  AuthController.new,
);

class AuthController extends Notifier<AuthState> {
  @override
  AuthState build() => const AuthState();

  Future<void> signIn(String email, String password) async {
    state = state.copyWith(isLoading: true, clearError: true);
    await Future<void>.delayed(const Duration(milliseconds: 350));
    if (!email.contains('@') || password.length < 6) {
      state = state.copyWith(
        isLoading: false,
        errorMessage: 'Email hoặc mật khẩu chưa hợp lệ.',
      );
      return;
    }
    state = AuthState(isAuthenticated: true, email: email.trim());
  }

  Future<void> register(String email, String password) async {
    state = state.copyWith(isLoading: true, clearError: true);
    await Future<void>.delayed(const Duration(milliseconds: 350));
    if (!email.contains('@') || password.length < 6) {
      state = state.copyWith(
        isLoading: false,
        errorMessage: 'Email hoặc mật khẩu chưa hợp lệ.',
      );
      return;
    }
    state = AuthState(isAuthenticated: true, email: email.trim());
  }

  void continueAsDemo() {
    state = const AuthState(
      isAuthenticated: true,
      email: 'driver.demo@powerme.local',
    );
  }

  void markSessionExpired() {
    state = state.copyWith(
      isAuthenticated: false,
      sessionExpired: true,
      errorMessage: 'Phiên đăng nhập đã hết hạn.',
    );
  }

  void signOut() {
    state = const AuthState();
  }
}
