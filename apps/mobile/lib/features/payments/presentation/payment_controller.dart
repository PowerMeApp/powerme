import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/payment_models.dart';

final paymentControllerProvider =
    NotifierProvider<PaymentController, PaymentState>(PaymentController.new);

class PaymentController extends Notifier<PaymentState> {
  @override
  PaymentState build() => const PaymentState();

  void createAttempt(int amountVnd) {
    if (!state.canCreateAttempt) return;
    state = PaymentState(
      status: PaymentStatus.pending,
      attemptId: 'attempt-sim-001',
      billAmountVnd: amountVnd,
      message: 'Đang chờ kết quả từ cổng thanh toán mô phỏng.',
    );
  }

  void simulatePaid() {
    if (state.status != PaymentStatus.pending) return;
    state = state.copyWith(
      status: PaymentStatus.paid,
      message: 'Đã xác nhận thanh toán từ backend mô phỏng.',
    );
  }

  void simulateFailed() {
    if (state.status != PaymentStatus.pending) return;
    state = state.copyWith(
      status: PaymentStatus.failed,
      message: 'Cổng thanh toán báo giao dịch thất bại.',
    );
  }

  void simulateClosedCheckout() {
    if (state.status != PaymentStatus.pending) return;
    state = state.copyWith(
      status: PaymentStatus.closed,
      message: 'Checkout đã đóng. Kết quả server vẫn có thể đến sau.',
    );
  }

  void simulateUnknown() {
    if (state.status != PaymentStatus.pending) return;
    state = state.copyWith(
      status: PaymentStatus.unknown,
      message: 'Chưa xác định được kết quả. Hãy tra cứu attempt hiện có.',
    );
  }

  void queryStatus() {
    if (state.status != PaymentStatus.unknown &&
        state.status != PaymentStatus.closed) {
      return;
    }
    state = state.copyWith(
      message: 'Đã gửi yêu cầu tra cứu trạng thái hiện có.',
    );
  }
}
