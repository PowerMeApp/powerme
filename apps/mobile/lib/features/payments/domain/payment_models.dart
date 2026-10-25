enum PaymentStatus { idle, pending, paid, failed, closed, unknown, expired }

class PaymentState {
  const PaymentState({
    this.status = PaymentStatus.idle,
    this.attemptId,
    this.billAmountVnd = 30000,
    this.message,
  });

  final PaymentStatus status;
  final String? attemptId;
  final int billAmountVnd;
  final String? message;

  bool get canCreateAttempt =>
      status == PaymentStatus.idle ||
      status == PaymentStatus.failed ||
      status == PaymentStatus.closed;

  PaymentState copyWith({
    PaymentStatus? status,
    String? attemptId,
    int? billAmountVnd,
    String? message,
    bool clearMessage = false,
  }) {
    return PaymentState(
      status: status ?? this.status,
      attemptId: attemptId ?? this.attemptId,
      billAmountVnd: billAmountVnd ?? this.billAmountVnd,
      message: clearMessage ? null : message ?? this.message,
    );
  }
}
