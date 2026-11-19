import '../../auth/domain/auth_scope.dart';

final _control = RegExp(r'[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]');

String? faultDescription(String input) {
  // Match JavaScript trim and the server's code point count.
  final description = input.replaceAll(
    RegExp(
      r'^[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$',
    ),
    '',
  );
  final length = description.runes.length;
  return length >= 5 && length <= 500 && !_control.hasMatch(description)
      ? description
      : null;
}

typedef FaultReportReceipt = ({
  String id,
  String number,
  DateTime reportedAt,
  String? faultEventId,
  bool reportedIssue,
});

typedef FaultReportWrite = ({
  Future<FaultReportReceipt> result,
  void Function() cancel,
});

abstract interface class ConnectorFaultReportRepository {
  FaultReportWrite submit(AuthScope scope, String id, String description);
}
