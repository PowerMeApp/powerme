import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';

import 'api_config.dart';
import 'driver_account_response.dart';
import 'driver_api_exception.dart';

enum DriverSessionEnd { expired, forbidden }

class DriverApiSession {
  DriverApiSession(ApiConfig config, {HttpClientAdapter? adapter})
    : _dio = Dio(
        BaseOptions(
          baseUrl: config.baseUrl.toString(),
          connectTimeout: const Duration(seconds: 10),
          sendTimeout: const Duration(seconds: 10),
          receiveTimeout: const Duration(seconds: 15),
          followRedirects: false,
          responseType: ResponseType.plain,
          headers: {'Accept': 'application/json'},
        ),
      ) {
    if (adapter != null) _dio.httpClientAdapter = adapter;
  }

  final Dio _dio;
  final _ended = StreamController<DriverSessionEnd>.broadcast(sync: true);
  _Session? _session;
  DriverAccountResponse? get account => _session?.account;
  Stream<DriverSessionEnd> get ended => _ended.stream;

  Future<String> signIn(String email, String password) => _authenticate(
    'auth/login',
    {'email': email, 'password': password},
    status: 200,
  );

  Future<String> register(Map<String, Object?> fields) =>
      _authenticate('auth/register', fields, status: 201);

  Future<String> _authenticate(
    String path,
    Map<String, Object?> fields, {
    required int status,
  }) async {
    signOut();
    final session = _Session();
    _session = session;
    var registrationAccepted = false;
    try {
      final json = await _request(
        session,
        path,
        method: 'POST',
        body: fields,
        expectedStatus: status,
      );
      registrationAccepted = path == 'auth/register';
      session.accessToken = _readAccessToken(json);
      session.refreshToken = _token(json['refresh_token']);
      final refreshTtl = json['refresh_expires_in'];
      if (refreshTtl is! int || refreshTtl <= 0) throw _malformed;
      final account = await _readMe(session);
      _requireCurrent(session);
      session.account = account;
      return account.id;
    } catch (error) {
      if (identical(_session, session)) signOut();
      if (registrationAccepted &&
          error is DriverApiException &&
          error.problem != DriverApiProblem.ended) {
        throw const DriverApiException(
          DriverApiProblem.registrationUnconfirmed,
        );
      }
      rethrow;
    }
  }

  Future<DriverAccountResponse> refreshAccount() async {
    return _refreshAccount(_activeSession());
  }

  _Session _activeSession() {
    final session = _session;
    if (session == null || session.account == null) throw _sessionEnded;
    return session;
  }

  Future<DriverAccountResponse> _refreshAccount(_Session session) async {
    final principal = session.account?.id;
    final account = await _readMe(session);
    _requireCurrent(session);
    if (account.id != principal) {
      _end(session, DriverSessionEnd.expired);
      throw _sessionEnded;
    }
    session.account = account;
    return account;
  }

  Future<DriverAccountResponse> _readMe(_Session session) async =>
      DriverAccountResponse.fromJson(await _protectedRead(session, 'me'));

  Future<List<DriverVehicleModelResponse>> listVehicleModels() async =>
      DriverVehicleModelResponse.catalog(
        await _protectedRead(_activeSession(), 'vehicle-models'),
      );

  Future<Map<String, dynamic>> startCharge({
    required String principalId,
    required String key,
    required String connectorId,
    required String vehicleId,
    required int energyLimitWh,
  }) async {
    final session = _ownedSession(principalId);
    final body = <String, Object?>{
      'connector_id': connectorId,
      'vehicle_id': vehicleId,
      'mode': 'energy_kwh',
      'energy_limit_wh': energyLimitWh,
    };
    return _withProtectedSession(
      session,
      (token) => _request(
        session,
        'charges',
        method: 'POST',
        expectedStatus: 202,
        body: body,
        accessToken: token,
        idempotencyKey: key,
      ),
    );
  }

  Future<Map<String, dynamic>> readCharge(
    String principalId,
    String key,
  ) async => _protectedRead(
    _ownedSession(principalId),
    'charges/${Uri.encodeComponent(key)}',
  );

  Future<Map<String, dynamic>> readCredit(
    String principalId,
    CancelToken cancel,
  ) => _readForPrincipal(principalId, 'credit', cancel);

  Future<Map<String, dynamic>> readCreditTransactions(
    String principalId,
    int page,
    int pageSize,
    CancelToken cancel,
  ) => _readForPrincipal(principalId, 'credit/transactions', cancel, {
    'page': page,
    'page_size': pageSize,
  });

  Future<Map<String, dynamic>> stopCharge(
    String principalId,
    String sessionId,
    String key,
  ) async {
    _validateSessionId(sessionId);
    final session = _ownedSession(principalId);
    return _withProtectedSession(
      session,
      (token) => _request(
        session,
        'sessions/$sessionId/stop',
        method: 'POST',
        expectedStatus: 202,
        accessToken: token,
        idempotencyKey: key,
      ),
    );
  }

  Future<Map<String, dynamic>> readChargeProgress(
    String principalId,
    String sessionId,
    CancelToken cancel,
  ) async {
    _validateSessionId(sessionId);
    return _readForPrincipal(
      principalId,
      'sessions/$sessionId/progress',
      cancel,
    );
  }

  Future<Map<String, dynamic>> readChargeStatement(
    String principalId,
    String sessionId,
    CancelToken cancel,
  ) async {
    // The ledger returns PostgreSQL bigint IDs as strings.
    if (!_statementSessionId.hasMatch(sessionId) ||
        (sessionId.length == 19 &&
            sessionId.compareTo('9223372036854775807') > 0)) {
      throw _malformed;
    }
    return _readForPrincipal(
      principalId,
      'sessions/$sessionId/statement',
      cancel,
    );
  }

  void _validateSessionId(String sessionId) {
    if (!_chargeSessionId.hasMatch(sessionId) ||
        int.parse(sessionId) > 9007199254740991) {
      throw _malformed;
    }
  }

  Future<Map<String, dynamic>> _readForPrincipal(
    String principalId,
    String path,
    CancelToken cancel, [
    Map<String, Object?>? query,
  ]) async {
    final session = _ownedSession(principalId);
    session.reads.add(cancel);
    try {
      return await _protectedRead(session, path, query, cancel);
    } finally {
      session.reads.remove(cancel);
    }
  }

  _Session _ownedSession(String principalId) {
    final session = _activeSession();
    if (session.account!.id != principalId) throw _sessionEnded;
    return session;
  }

  Future<Map<String, dynamic>> readForVehicle(
    String path,
    String vehicleId,
    Map<String, Object?> query, {
    CancelToken? cancel,
  }) async {
    final session = _activeSession();
    if (!session.account!.vehicles.any((vehicle) => vehicle.id == vehicleId)) {
      throw const DriverApiException(DriverApiProblem.http, status: 404);
    }
    if (cancel != null) session.reads.add(cancel);
    try {
      return await _protectedRead(session, path, {
        ...query,
        'vehicle_id': vehicleId,
      }, cancel);
    } finally {
      session.reads.remove(cancel);
    }
  }

  Future<DriverAccountResponse> addVehicle({
    required String plateNumber,
    required String modelId,
    required bool makeDefault,
  }) => _writeVehicles('vehicles', 'POST', 201, {
    'plate_number': plateNumber,
    'vehicle_model_id': modelId,
    if (makeDefault) 'is_default': true,
  });

  Future<DriverAccountResponse> setDefaultVehicle(String id) => _writeVehicles(
    'vehicles/${Uri.encodeComponent(id)}',
    'PATCH',
    200,
    {'is_default': true},
  );

  Future<DriverAccountResponse> removeVehicle(String id) =>
      _writeVehicles('vehicles/${Uri.encodeComponent(id)}', 'DELETE', 204);

  Future<DriverAccountResponse> _writeVehicles(
    String path,
    String method,
    int expectedStatus, [
    Map<String, Object?>? body,
  ]) async {
    final session = _activeSession();
    final accessToken = session.accessToken;
    Future<Response<String>> send(String token) => _send(
      session,
      path,
      method: method,
      expectedStatus: expectedStatus,
      body: body,
      accessToken: token,
    );
    try {
      try {
        await send(accessToken);
      } on DriverApiException catch (error) {
        // The Driver API rejects this request before the write handler runs.
        if (error.status != 401 || error.code != 'unauthorized') rethrow;
        await _renewAccessToken(session, accessToken);
        await send(session.accessToken);
      }
    } on DriverApiException catch (error) {
      _endOnAuthFailure(session, error);
      rethrow;
    }
    try {
      return await _refreshAccount(session);
    } on DriverApiException {
      _requireCurrent(session);
      throw const DriverApiException(DriverApiProblem.accountRefreshRequired);
    }
  }

  Future<Map<String, dynamic>> _protectedRead(
    _Session session,
    String path, [
    Map<String, Object?>? query,
    CancelToken? cancel,
  ]) => _withProtectedSession(
    session,
    (token) => _get(session, path, token, query, cancel),
    cancel: cancel,
  );

  Future<Map<String, dynamic>> _withProtectedSession(
    _Session session,
    Future<Map<String, dynamic>> Function(String token) request, {
    CancelToken? cancel,
  }) async {
    _requireCurrent(session);
    final accessToken = session.accessToken;
    try {
      try {
        return await request(accessToken);
      } on DriverApiException catch (error) {
        if (error.status != 401) rethrow;
        if (cancel?.isCancelled == true) throw _sessionEnded;
      }
      await _renewAccessToken(session, accessToken);
      if (cancel?.isCancelled == true) throw _sessionEnded;
      return await request(session.accessToken);
    } on DriverApiException catch (error) {
      _endOnAuthFailure(session, error);
      rethrow;
    }
  }

  Future<void> _renewAccessToken(_Session session, String rejectedToken) async {
    _requireCurrent(session);
    if (session.accessToken == rejectedToken) await _refreshOnce(session);
    _requireCurrent(session);
  }

  void _endOnAuthFailure(_Session session, DriverApiException error) {
    switch (error.status) {
      case 401:
        _end(session, DriverSessionEnd.expired);
      case 403:
        _end(session, DriverSessionEnd.forbidden);
    }
  }

  Future<Map<String, dynamic>> _get(
    _Session session,
    String path,
    String token,
    Map<String, Object?>? query, [
    CancelToken? cancel,
  ]) => _request(
    session,
    path,
    accessToken: token,
    expectedStatus: 200,
    query: query,
    cancel: cancel,
  );

  Future<void> _refreshOnce(_Session session) =>
      session.refreshInFlight ??= _refresh(session).whenComplete(() {
        session.refreshInFlight = null;
      });

  Future<void> _refresh(_Session session) async {
    final json = await _request(
      session,
      'auth/refresh',
      method: 'POST',
      body: {'refresh_token': session.refreshToken},
      expectedStatus: 200,
    );
    session.accessToken = _readAccessToken(json);
  }

  Future<Map<String, dynamic>> _request(
    _Session session,
    String path, {
    String method = 'GET',
    required int expectedStatus,
    Map<String, Object?>? body,
    Map<String, Object?>? query,
    String? accessToken,
    String? idempotencyKey,
    CancelToken? cancel,
  }) async {
    final response = await _send(
      session,
      path,
      method: method,
      expectedStatus: expectedStatus,
      body: body,
      query: query,
      accessToken: accessToken,
      idempotencyKey: idempotencyKey,
      cancel: cancel,
    );
    return _decodeObject(response.data) ?? (throw _malformed);
  }

  Future<Response<String>> _send(
    _Session session,
    String path, {
    required String method,
    required int expectedStatus,
    Map<String, Object?>? body,
    Map<String, Object?>? query,
    String? accessToken,
    String? idempotencyKey,
    CancelToken? cancel,
  }) async {
    _requireCurrent(session);
    late final Response<String> response;
    try {
      response = await _dio.request<String>(
        path,
        data: body,
        queryParameters: query,
        cancelToken: cancel ?? session.cancel,
        options: Options(
          method: method,
          contentType: body == null ? null : Headers.jsonContentType,
          headers: {
            if (accessToken != null) 'Authorization': 'Bearer $accessToken',
            'Idempotency-Key': ?idempotencyKey,
          },
        ),
      );
    } on DioException catch (error) {
      _requireCurrent(session);
      final status = error.response?.statusCode;
      final json = _decodeObject(error.response?.data);
      throw DriverApiException(
        status == null ? DriverApiProblem.connection : DriverApiProblem.http,
        status: status,
        code: switch (json?['error']) {
          'unauthorized' => 'unauthorized',
          'not_found' => 'not_found',
          'invalid_credentials' => 'invalid_credentials',
          'invalid_email' => 'invalid_email',
          'invalid_password' => 'invalid_password',
          'invalid_input' => 'invalid_input',
          'email_taken' => 'email_taken',
          'consent_required' => 'consent_required',
          'invalid_plate_number' => 'invalid_plate_number',
          'unknown_vehicle_model' => 'unknown_vehicle_model',
          'plate_taken' => 'plate_taken',
          'vehicle_in_use' => 'vehicle_in_use',
          'location_consent_required' => 'location_consent_required',
          'origin_coordinates_required' => 'origin_coordinates_required',
          'invalid_search' => 'invalid_search',
          'provider_unavailable' => 'provider_unavailable',
          'station_location_unavailable' => 'station_location_unavailable',
          'idempotency_conflict' => 'idempotency_conflict',
          'stop_pending_or_unknown' => 'stop_pending_or_unknown',
          'session_not_stoppable' => 'session_not_stoppable',
          'invalid_idempotency_key' => 'invalid_idempotency_key',
          'reserved_idempotency_key' => 'reserved_idempotency_key',
          'credit_unavailable' => 'credit_unavailable',
          'connector_unavailable' => 'connector_unavailable',
          'connector_busy_or_unknown' => 'connector_busy_or_unknown',
          'tariff_unavailable' => 'tariff_unavailable',
          'vehicle_not_owned_or_incompatible' =>
            'vehicle_not_owned_or_incompatible',
          'unsupported_mode' => 'unsupported_mode',
          _ => null,
        },
        mapAvailability: switch ((status, json?['error'], json?['detail'])) {
          (503, 'provider_unavailable', 'unconfigured') =>
            DriverMapAvailability.unconfigured,
          (503, 'provider_unavailable', 'credentials') =>
            DriverMapAvailability.credentials,
          _ => null,
        },
      );
    }
    _requireCurrent(session);
    if (response.statusCode != expectedStatus) throw _malformed;
    return response;
  }

  void _requireCurrent(_Session session) {
    if (!identical(_session, session)) throw _sessionEnded;
  }

  void _end(_Session session, DriverSessionEnd reason) {
    if (!identical(_session, session)) return;
    final wasSignedIn = session.account != null;
    signOut();
    if (wasSignedIn) _ended.add(reason);
  }

  void signOut() {
    final session = _session;
    _session = null;
    if (session == null) return;
    session.account = null;
    session.accessToken = '';
    session.refreshToken = '';
    session.cancel.cancel();
    for (final cancel in session.reads) {
      cancel.cancel();
    }
  }

  void dispose() {
    signOut();
    _dio.close(force: true);
    unawaited(_ended.close());
  }
}

class _Session {
  final cancel = CancelToken();
  final reads = <CancelToken>{};
  String accessToken = '';
  String refreshToken = '';
  Future<void>? refreshInFlight;
  DriverAccountResponse? account;
}

const _malformed = DriverApiException(DriverApiProblem.malformed);
const _sessionEnded = DriverApiException(DriverApiProblem.ended);
final _chargeSessionId = RegExp(r'^[1-9][0-9]{0,15}$');
final _statementSessionId = RegExp(r'^[1-9][0-9]{0,18}$');

Map<String, dynamic>? _decodeObject(Object? body) {
  if (body is! String || body.isEmpty) return null;
  try {
    final json = jsonDecode(body);
    return json is Map<String, dynamic> ? json : null;
  } on FormatException {
    return null;
  }
}

String _readAccessToken(Map<String, dynamic> json) {
  if (json['token_type'] != 'Bearer' || json['expires_in'] != 900) {
    throw _malformed;
  }
  return _token(json['access_token']);
}

String _token(Object? value) {
  if (value is! String ||
      value.length > 8185 ||
      !RegExp(
        r'^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$',
      ).hasMatch(value)) {
    throw _malformed;
  }
  return value;
}
