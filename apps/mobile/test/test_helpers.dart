import 'package:driver_app/features/auth/application/auth_controller.dart';
import 'package:driver_app/features/auth/domain/auth_scope.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> signIn(
  WidgetTester tester, {
  String email = 'minh@powerme.local',
}) async {
  await tester.enterText(find.byKey(const Key('auth-email')), email);
  await tester.enterText(find.byKey(const Key('auth-password')), 'PowerMe123!');
  await tester.ensureVisible(find.byKey(const Key('auth-submit')));
  await tester.tap(find.byKey(const Key('auth-submit')));
  await tester.pumpAndSettle();
}

class TestSignedIn extends AuthController {
  @override
  AuthState build() => const AuthState(
    scope: AuthScope(principalId: 'test-driver', generation: 1),
  );
}
