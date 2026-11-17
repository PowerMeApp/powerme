enum DriverApiProblem {
  http,
  connection,
  malformed,
  ended,
  registrationUnconfirmed,
  accountRefreshRequired,
}

enum DriverMapAvailability { unconfigured, credentials }

class DriverApiException implements Exception {
  const DriverApiException(
    this.problem, {
    this.status,
    this.code,
    this.mapAvailability,
  });

  final DriverApiProblem problem;
  final int? status;
  final String? code;
  final DriverMapAvailability? mapAvailability;
}
