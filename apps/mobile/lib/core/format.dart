import 'l10n/app_copy.dart';

String estimatedMinutes(num? value, AppCopy copy) {
  if (value == null || !value.isFinite || value < 0) {
    return copy.text('Chưa xác định', 'Unknown');
  }
  final whole = value.ceil();
  return copy.text('$whole phút', '$whole min');
}

String vnd(int? value, {AppCopy? copy, bool signed = false}) {
  if (value == null) {
    return copy?.text('Chưa xác định', 'Unknown') ?? 'Chưa xác định';
  }
  final separator = copy?.text('.', ',') ?? '.';
  final amount = value.abs().toString().replaceAllMapped(
    RegExp(r'(\d)(?=(\d{3})+(?!\d))'),
    (match) => '${match[1]}$separator',
  );
  final sign = value < 0
      ? '−'
      : signed && value > 0
      ? '+'
      : '';
  return '$sign$amount${copy?.text(' đ', ' VND') ?? ' đ'}';
}

String minutes(int? seconds) =>
    seconds == null ? 'Chưa xác định' : '${(seconds / 60).ceil()} phút';
String ict(DateTime at) {
  final d = at.toUtc().add(const Duration(hours: 7));
  return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')} · ${d.day}/${d.month}';
}

String ictDateTime(DateTime at) {
  final d = at.toUtc().add(const Duration(hours: 7));
  String twoDigits(int value) => value.toString().padLeft(2, '0');
  return '${twoDigits(d.hour)}:${twoDigits(d.minute)} · '
      '${twoDigits(d.day)}/${twoDigits(d.month)}/${d.year} ICT';
}

String failureText(Object error) => error is StateError
    ? error.message.toString()
    : 'Chưa tải được. Vui lòng thử lại.';
