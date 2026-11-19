final _id = RegExp(r'^[1-9][0-9]{0,18}$');

bool isDriverApiId(Object? value) =>
    value is String &&
    _id.hasMatch(value) &&
    (value.length < 19 || value.compareTo('9223372036854775807') <= 0);

final _timestamp = RegExp(
  r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$',
);

DateTime? driverApiTimestamp(Object? value) =>
    value is String && _timestamp.hasMatch(value)
    ? DateTime.tryParse(value)
    : null;
