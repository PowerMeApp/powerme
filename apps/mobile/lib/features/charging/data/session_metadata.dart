import '../domain/charging.dart';

SessionOrigin sessionOrigin(Object? raw) => switch (raw) {
  'app_qr' => SessionOrigin.appQr,
  'rfid' => SessionOrigin.rfid,
  'hmi_password' => SessionOrigin.hmiPassword,
  'free_vend' => SessionOrigin.freeVend,
  _ => SessionOrigin.unknown,
};
PaymentMode sessionPaymentMode(Object? raw) => switch (raw) {
  'csms_billed' => PaymentMode.csmsBilled,
  'unattributed' => PaymentMode.unattributed,
  _ => PaymentMode.unknown,
};
SettlementState? sessionSettlement(Object? raw) => switch (raw) {
  null => null,
  'pending' => SettlementState.pending,
  'posted' => SettlementState.posted,
  'review' => SettlementState.review,
  'ineligible' => SettlementState.notApplicable,
  _ => SettlementState.unknown,
};
