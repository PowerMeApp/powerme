String vnd(int? value) => value == null
    ? 'Chưa xác định'
    : '${value.toString().replaceAllMapped(RegExp(r'(\d)(?=(\d{3})+(?!\d))'), (m) => '${m[1]}.')} đ';
String minutes(int? seconds) =>
    seconds == null ? 'Chưa xác định' : '${(seconds / 60).ceil()} phút';
String ict(DateTime at) {
  final d = at.toUtc().add(const Duration(hours: 7));
  return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')} · ${d.day}/${d.month}';
}

String failureText(Object error) => error is StateError
    ? error.message.toString()
    : 'Chưa tải được. Vui lòng thử lại.';
