enum DriverApiProblem {
  http,
  connection,
  malformed,
  ended,
  registrationUnconfirmed,
  accountRefreshRequired,
}

enum DriverMapAvailability { unconfigured, credentials }

typedef DriverTopUpConflict = ({
  String id,
  bool confirming,
  String? paymentUrl,
});

class DriverApiException implements Exception {
  const DriverApiException(
    this.problem, {
    this.status,
    this.code,
    this.mapAvailability,
    this.topUpConflict,
  });

  final DriverApiProblem problem;
  final int? status;
  final String? code;
  final DriverMapAvailability? mapAvailability;
  final DriverTopUpConflict? topUpConflict;
}
