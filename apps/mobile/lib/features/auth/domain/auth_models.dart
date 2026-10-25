class AuthState {
  const AuthState({
    this.isAuthenticated = false,
    this.isLoading = false,
    this.email,
    this.errorMessage,
    this.sessionExpired = false,
  });

  final bool isAuthenticated;
  final bool isLoading;
  final String? email;
  final String? errorMessage;
  final bool sessionExpired;

  AuthState copyWith({
    bool? isAuthenticated,
    bool? isLoading,
    String? email,
    String? errorMessage,
    bool clearError = false,
    bool? sessionExpired,
  }) {
    return AuthState(
      isAuthenticated: isAuthenticated ?? this.isAuthenticated,
      isLoading: isLoading ?? this.isLoading,
      email: email ?? this.email,
      errorMessage: clearError ? null : errorMessage ?? this.errorMessage,
      sessionExpired: sessionExpired ?? this.sessionExpired,
    );
  }
}
