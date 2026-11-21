import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:driver_app/features/auth/application/auth_controller.dart';
import 'package:driver_app/features/loyalty/domain/loyalty.dart';

final loyaltyRepositoryProvider = Provider<LoyaltyRepository>(
  (ref) => throw StateError('Select loyalty adapter.'),
);
final loyaltyProvider = FutureProvider.autoDispose<LoyaltySnapshot>((
  ref,
) async {
  final scope = ref.watch(authScopeProvider);
  final result = await ref.watch(loyaltyRepositoryProvider).loyalty();
  if (!ref.mounted ||
      result.scope.principalId != scope.principalId ||
      result.scope.generation != scope.generation) {
    throw StateError('Không tìm thấy điểm thuộc tài khoản.');
  }
  return result;
});
