bool isEmailInput(String raw) =>
    RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(raw.trim());

// Check BE-30 input shape without changing the value CSMS canonicalizes.
bool isPhoneNumberInput(String raw) {
  if (raw.length > 32) return false;
  final compact = raw.replaceAll(RegExp(r'[\s.\-()]'), '');
  if (!RegExp(r'^\+?[0-9]+$').hasMatch(compact)) return false;
  final vnNsn = RegExp(r'^[1-9][0-9]{8,9}$');
  if (compact.startsWith('+')) {
    final digits = compact.substring(1);
    if (digits.startsWith('84')) {
      final nsn = digits.substring(2).replaceFirst(RegExp(r'^0'), '');
      return vnNsn.hasMatch(nsn);
    }
    return RegExp(r'^[1-9][0-9]{6,14}$').hasMatch(digits);
  }
  if (compact.startsWith('0')) return vnNsn.hasMatch(compact.substring(1));
  if (compact.startsWith('84')) return vnNsn.hasMatch(compact.substring(2));
  return false;
}
