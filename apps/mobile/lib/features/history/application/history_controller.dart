import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../auth/application/auth_controller.dart';
import '../domain/history.dart';
import '../../payments/domain/payments.dart';

final historyRepositoryProvider = Provider<HistoryRepository>(
  (ref) => throw StateError('Select history adapter.'),
);
final historyProvider = FutureProvider.autoDispose<HistorySnapshot>((
  ref,
) async {
  final scope = ref.watch(authScopeProvider);
  final result = await ref.watch(historyRepositoryProvider).history();
  if (!ref.mounted ||
      result.scope.principalId != scope.principalId ||
      result.scope.generation != scope.generation) {
    throw StateError('Không tìm thấy lịch sử thuộc tài khoản.');
  }
  return result;
});
final invoiceProvider = FutureProvider.autoDispose.family<TopUpOrder, String>((
  ref,
  id,
) async {
  final scope = ref.watch(authScopeProvider);
  final result = await ref.watch(historyRepositoryProvider).invoice(id);
  if (!ref.mounted ||
      result.id != id ||
      result.scope.principalId != scope.principalId ||
      result.scope.generation != scope.generation) {
    throw StateError('Không tìm thấy hóa đơn thuộc tài khoản.');
  }
  return result;
});
