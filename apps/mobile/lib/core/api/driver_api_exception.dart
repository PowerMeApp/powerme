enum DriverApiProblem {
  http,
  connection,
  malformed,
  ended,
  registrationUnconfirmed,
  accountRefreshRequired,
}

class DriverApiException implements Exception {
  const DriverApiException(this.problem, {this.status, this.code});

  final DriverApiProblem problem;
  final int? status;
  final String? code;
}
