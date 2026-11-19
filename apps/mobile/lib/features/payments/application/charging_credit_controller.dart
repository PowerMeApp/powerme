import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_scope.dart';
import '../domain/charging_credit.dart';

final chargingCreditRepositoryProvider = Provider<ChargingCreditRepository>(
  (ref) => throw StateError('Configure charging credit in ApiApp.'),
);

final chargingCreditProvider = FutureProvider.autoDispose<ChargingCredit>(
  (ref) =>
      _readOwnedCredit(ref, (repository, scope) => repository.summary(scope)),
  retry: (_, _) => null,
);

final creditLedgerProvider = FutureProvider.autoDispose
    .family<CreditLedgerPage, int>(
      (ref, page) => _readOwnedCredit(
        ref,
        (repository, scope) => repository.transactions(scope, page),
      ),
      retry: (_, _) => null,
    );

Future<T> _readOwnedCredit<T>(
  Ref ref,
  CreditRead<T> Function(ChargingCreditRepository, AuthScope) read,
) async {
  final scope = ref.watch(authScopeProvider);
  if (scope == signedOutScope) throw StateError('Driver is signed out.');
  final request = read(ref.watch(chargingCreditRepositoryProvider), scope);
  ref.onDispose(request.cancel);
  final result = await request.result;
  if (!ref.mounted || ref.read(authScopeProvider) != scope) {
    throw StateError('Driver session changed.');
  }
  return result;
}
