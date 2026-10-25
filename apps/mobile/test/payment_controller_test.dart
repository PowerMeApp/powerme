import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:powerme/features/payments/domain/payment_models.dart';
import 'package:powerme/features/payments/presentation/payment_controller.dart';

void main() {
  test('unknown payment does not become paid from a client timeout', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final controller = container.read(paymentControllerProvider.notifier);

    controller.createAttempt(30000);
    controller.simulateUnknown();
    controller.simulatePaid();

    expect(
      container.read(paymentControllerProvider).status,
      PaymentStatus.unknown,
    );
    expect(container.read(paymentControllerProvider).canCreateAttempt, isFalse);
  });

  test('failed payment can create a new attempt explicitly', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final controller = container.read(paymentControllerProvider.notifier);

    controller.createAttempt(30000);
    controller.simulateFailed();
    expect(
      container.read(paymentControllerProvider).status,
      PaymentStatus.failed,
    );
    expect(container.read(paymentControllerProvider).canCreateAttempt, isTrue);
  });
}
