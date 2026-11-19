import 'station.dart';

typedef ConnectorReference = ({String displayCode, int number});

final _canonicalConnector = RegExp(
  r'^(?:powerme:connector:)?([^/\\:\x00-\x1f\x7f]{1,100})/([12])$',
);

ConnectorReference? parseConnectorReference(String text) {
  final input = text.trim();
  final match = _canonicalConnector.firstMatch(input);
  if (match == null || match.end != input.length) return null;
  final code = match[1]!;
  if (code.trim().isEmpty || code == '.' || code == '..') return null;
  return (displayCode: code, number: int.parse(match[2]!));
}

typedef ResolvedConnector = ({
  String id,
  String displayCode,
  int number,
  String stationName,
  StationStatus status,
  bool reportedIssue,
  bool canRequestStart,
});

abstract interface class ConnectorLookupRepository {
  Future<ResolvedConnector> resolve(String vehicleId, ConnectorReference code);
}
