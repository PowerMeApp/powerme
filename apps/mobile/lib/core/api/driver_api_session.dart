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
    final session = _session;
    final previous = session?.account;
    if (session == null || previous == null) throw _sessionEnded;
    final account = await _readMe(session);
    _requireCurrent(session);
    if (account.id != previous.id) {
      _end(session, DriverSessionEnd.expired);
      throw _sessionEnded;
    }
    session.account = account;
    return account;
  }

  Future<DriverAccountResponse> _readMe(_Session session) async {
    final accessToken = session.accessToken;
    try {
      try {
        return await _getMe(session, accessToken);
      } on DriverApiException catch (error) {
        if (error.status != 401) rethrow;
      }
      _requireCurrent(session);
      if (session.accessToken == accessToken) {
        await _refreshOnce(session);
      }
      _requireCurrent(session);
      return await _getMe(session, session.accessToken);
    } on DriverApiException catch (error) {
      if (error.status == 401 || error.status == 403) {
        _end(
          session,
          error.status == 403
              ? DriverSessionEnd.forbidden
              : DriverSessionEnd.expired,
        );
      }
      rethrow;
    }
  }

  Future<DriverAccountResponse> _getMe(_Session session, String token) async {
    final json = await _request(
      session,
      'me',
      accessToken: token,
      expectedStatus: 200,
    );
    return DriverAccountResponse.fromJson(json);
  }

  Future<void> _refreshOnce(_Session session) =>
      session.refreshInFlight ??= _refresh(session).whenComplete(() {
        session.refreshInFlight = null;
      });

  Future<void> _refresh(_Session session) async {
    final json = await _request(
      session,
      'auth/refresh',
      body: {'refresh_token': session.refreshToken},
      expectedStatus: 200,
    );
    session.accessToken = _readAccessToken(json);
  }

  Future<Map<String, dynamic>> _request(
    _Session session,
    String path, {
    required int expectedStatus,
    Map<String, Object?>? body,
    String? accessToken,
  }) async {
    _requireCurrent(session);
    late final Response<String> response;
    try {
      response = await _dio.request<String>(
        path,
        data: body,
        cancelToken: session.cancel,
        options: Options(
          method: body == null ? 'GET' : 'POST',
          contentType: body == null ? null : Headers.jsonContentType,
          headers: accessToken == null
              ? null
              : {'Authorization': 'Bearer $accessToken'},
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
          'invalid_credentials' => 'invalid_credentials',
          'invalid_email' => 'invalid_email',
          'invalid_password' => 'invalid_password',
          'invalid_input' => 'invalid_input',
          'email_taken' => 'email_taken',
          'consent_required' => 'consent_required',
          _ => null,
        },
      );
    }
    _requireCurrent(session);
    final json = _decodeObject(response.data);
    if (response.statusCode != expectedStatus || json == null) throw _malformed;
    return json;
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
  }

  void dispose() {
    signOut();
    _dio.close(force: true);
    unawaited(_ended.close());
  }
}

class _Session {
  final cancel = CancelToken();
  String accessToken = '';
  String refreshToken = '';
  Future<void>? refreshInFlight;
  DriverAccountResponse? account;
}

const _malformed = DriverApiException(DriverApiProblem.malformed);
const _sessionEnded = DriverApiException(DriverApiProblem.ended);

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
