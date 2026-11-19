final _gateway = RegExp(
  r'^https://sandbox\.vnpayment\.vn(?::443)?/paymentv2/vpcpay\.html\?',
  caseSensitive: false,
);
final _invalidUrlCharacter = RegExp(r'[\x00-\x20\x7f\\#]|%(?![0-9a-fA-F]{2})');

String? validatedVnpayCheckoutUrl(Object? value) {
  if (value is! String ||
      !_gateway.hasMatch(value) ||
      _invalidUrlCharacter.hasMatch(value)) {
    return null;
  }
  final uri = Uri.tryParse(value);
  if (uri == null || uri.query.isEmpty) return null;
  return value;
}
