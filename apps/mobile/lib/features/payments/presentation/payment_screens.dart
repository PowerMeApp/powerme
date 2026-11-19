import '../../../core/l10n/app_copy.dart';
import '../../profile/domain/driver_profile.dart';
import '../domain/payments.dart';

String topUpLabel(
  TopUpState s, [
  AppCopy copy = const AppCopy(AppLanguage.vietnamese),
]) => switch (s) {
  TopUpState.pending => copy.text('Chờ thanh toán', 'Awaiting payment'),
  TopUpState.unknown => copy.text(
    'Chưa rõ kết quả · đang kiểm tra',
    'Result unknown · checking',
  ),
  TopUpState.verified => copy.text(
    'Đã xác nhận thanh toán · chờ ghi tín dụng',
    'Payment verified · awaiting credit posting',
  ),
  TopUpState.posted => copy.text('Đã ghi tín dụng', 'Credit posted'),
  TopUpState.failed => copy.text('Thanh toán bị từ chối', 'Payment declined'),
  TopUpState.expired => copy.text('Lần nạp đã hết hạn', 'Top-up expired'),
  TopUpState.refundPending => copy.text(
    'Thanh toán đến trễ · chờ hoàn về nguồn',
    'Late payment · awaiting refund to source',
  ),
  TopUpState.refunded => copy.text(
    'Đã hoàn về nguồn thanh toán',
    'Refunded to payment source',
  ),
};
String invoiceLabel(
  InvoiceState s, [
  AppCopy copy = const AppCopy(AppLanguage.vietnamese),
]) => switch (s) {
  InvoiceState.pending => copy.text('Đang chờ phát hành', 'Pending issuance'),
  InvoiceState.issued => copy.text('Đã phát hành', 'Issued'),
  InvoiceState.failed => copy.text(
    'Chưa phát hành được · chờ xử lý',
    'Issuance failed · under review',
  ),
};
