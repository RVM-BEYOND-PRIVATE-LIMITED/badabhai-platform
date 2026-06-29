// ASSUMED CONTRACT — reconcile with backend.
//
// The real /auth/* request + response shapes are NOT finalized. EVERY assumption
// about the wire format lives in THIS file so reconciling with the backend is a
// single-file change. Each assumed field is flagged inline with `// ASSUMED:`.
//
// NOTE (live status): the pin/*, token/refresh, and devices endpoints do NOT yet
// exist on the live backend — REAL mode will 404 on them; that is EXPECTED in
// PASS 1. Mock mode (USE_MOCKS=true, see MockAuthApi) is the walkable path now.

import 'package:equatable/equatable.dart';

import 'auth_failure.dart';
import 'authed_client.dart';

/// A token set the client holds after OTP/PIN verify or a refresh.
///
/// [access] is the in-memory bearer; [refresh] is rotated on every refresh and
/// persisted in secure storage; [accessExpiresAt] is the client-computed absolute
/// expiry (`now + access_expires_in`).
class AuthTokens extends Equatable {
  const AuthTokens({
    required this.access,
    required this.refresh,
    required this.accessExpiresAt,
  });

  final String access;
  final String refresh;
  final DateTime accessExpiresAt;

  /// Parses `{ access_token, refresh_token, access_expires_in }`.
  factory AuthTokens.fromJson(Map<String, dynamic> json) {
    final int expiresIn =
        (json['access_expires_in'] as num?)?.toInt() ?? 0; // ASSUMED: seconds
    return AuthTokens(
      access: json['access_token'] as String? ?? '', // ASSUMED: field name
      refresh: json['refresh_token'] as String? ?? '', // ASSUMED: field name
      accessExpiresAt: DateTime.now().add(Duration(seconds: expiresIn)),
    );
  }

  @override
  List<Object?> get props => <Object?>[access, refresh, accessExpiresAt];
}

/// Result of POST /auth/otp/verify.
class OtpVerifyResult extends Equatable {
  const OtpVerifyResult({
    required this.workerId,
    required this.isNewUser,
    required this.pinSet,
    required this.tokens,
  });

  final String workerId;
  final bool isNewUser;
  final bool pinSet;
  final AuthTokens tokens;

  factory OtpVerifyResult.fromJson(Map<String, dynamic> json) =>
      OtpVerifyResult(
        workerId: json['worker_id'] as String? ?? '', // ASSUMED: field name
        isNewUser: json['is_new_user'] as bool? ?? false, // ASSUMED
        pinSet: json['pin_set'] as bool? ?? false, // ASSUMED
        tokens: AuthTokens.fromJson(json),
      );

  @override
  List<Object?> get props => <Object?>[workerId, isNewUser, pinSet, tokens];
}

/// Result of POST /auth/otp/request.
class OtpRequestResult extends Equatable {
  const OtpRequestResult({required this.resendIn});

  /// Seconds before the worker can request another OTP.
  final Duration resendIn;

  factory OtpRequestResult.fromJson(Map<String, dynamic> json) =>
      OtpRequestResult(
        // ASSUMED: field name `resend_in_seconds`.
        resendIn:
            Duration(seconds: (json['resend_in_seconds'] as num?)?.toInt() ?? 0),
      );

  @override
  List<Object?> get props => <Object?>[resendIn];
}

/// One known device for this worker. Result item of GET /auth/devices.
class AuthDevice extends Equatable {
  const AuthDevice({
    required this.deviceId,
    required this.label,
    required this.lastSeenAt,
    required this.current,
  });

  final String deviceId;
  final String label;
  final DateTime? lastSeenAt;

  /// True for the device making the request (cannot be revoked from here).
  final bool current;

  factory AuthDevice.fromJson(Map<String, dynamic> json) => AuthDevice(
        deviceId: json['device_id'] as String? ?? '', // ASSUMED: field name
        label: json['label'] as String? ?? '', // ASSUMED
        lastSeenAt: _parseDate(json['last_seen_at']), // ASSUMED: ISO-8601
        current: json['current'] as bool? ?? false, // ASSUMED
      );

  static DateTime? _parseDate(Object? raw) =>
      raw is String ? DateTime.tryParse(raw) : null;

  @override
  List<Object?> get props => <Object?>[deviceId, label, lastSeenAt, current];
}

/// The single isolated contract layer for /auth/*.
///
/// Every method funnels through [AuthedClient.send] (which signs, refreshes, and
/// retries) and parses the assumed shapes above into typed results. On a 4xx /
/// 409 / 429 it throws a typed [AuthFailure] built from `{ code, message,
/// retry_after_seconds, attempts_left }`. PASS 2's cubits call these methods and
/// react to the typed results / failures.
class AuthApi {
  AuthApi(AuthedClient client) : _maybeClient = client;

  /// Subclass seam: [MockAuthApi] overrides every method and never touches the
  /// client, so it constructs with a null client (the real plugin/network is
  /// never reachable in mock mode).
  AuthApi.withoutClient() : _maybeClient = null;

  final AuthedClient? _maybeClient;

  /// The signing client. Throws if a mock subclass left a method un-overridden
  /// and fell through to the real network path — a guard, never expected to fire.
  AuthedClient get _client => _maybeClient ??
      (throw StateError(
        'AuthApi used without a client — a MockAuthApi method fell through to '
        'the real network path; add the missing override.',
      ));

  /// POST /auth/otp/request {phone} → {ok, resend_in_seconds}.
  Future<OtpRequestResult> otpRequest(String phoneE164) async {
    final AuthResponse res = await _client.send(
      HttpMethod.post,
      '/auth/otp/request',
      body: <String, dynamic>{'phone': phoneE164}, // ASSUMED: key `phone`
      idempotent: true,
    );
    _throwIfError(res);
    return OtpRequestResult.fromJson(res.body);
  }

  /// POST /auth/otp/verify {phone, otp} → tokens + worker flags.
  Future<OtpVerifyResult> otpVerify(String phoneE164, String otp) async {
    final AuthResponse res = await _client.send(
      HttpMethod.post,
      '/auth/otp/verify',
      body: <String, dynamic>{
        'phone': phoneE164, // ASSUMED: key `phone`
        'otp': otp, // ASSUMED: key `otp`
      },
      idempotent: true,
    );
    _throwIfError(res);
    return OtpVerifyResult.fromJson(res.body);
  }

  /// POST /auth/pin/set (bearer) {pin} → {ok}.
  Future<void> pinSet(String pin) async {
    final AuthResponse res = await _client.send(
      HttpMethod.post,
      '/auth/pin/set',
      body: <String, dynamic>{'pin': pin}, // ASSUMED: key `pin`
      authed: true,
      idempotent: true,
    );
    _throwIfError(res);
  }

  /// POST /auth/pin/verify {pin} (+ persisted refresh token) → tokens.
  ///
  /// ASSUMED: the server reads the refresh token from secure storage via the
  /// body field `refresh_token`; if the backend instead reads it from a cookie /
  /// header, change it here. The verified PIN mints a fresh token pair.
  Future<AuthTokens> pinVerify(String pin, {required String refreshToken}) async {
    final AuthResponse res = await _client.send(
      HttpMethod.post,
      '/auth/pin/verify',
      body: <String, dynamic>{
        'pin': pin, // ASSUMED: key `pin`
        'refresh_token': refreshToken, // ASSUMED: key `refresh_token`
      },
      idempotent: true,
    );
    _throwIfError(res);
    return AuthTokens.fromJson(res.body);
  }

  /// POST /auth/token/refresh {refresh_token} → tokens.
  ///
  /// NOTE: [AuthedClient] also performs refresh internally (single-flight) during
  /// reactive/proactive flows; this explicit method exists for callers that want
  /// to refresh on demand (e.g. silent login at startup in PASS 2).
  Future<AuthTokens> tokenRefresh(String refreshToken) async {
    final AuthResponse res = await _client.send(
      HttpMethod.post,
      '/auth/token/refresh',
      body: <String, dynamic>{'refresh_token': refreshToken}, // ASSUMED
      idempotent: true,
    );
    _throwIfError(res);
    return AuthTokens.fromJson(res.body);
  }

  /// POST /auth/logout (bearer) → 204. Revokes THIS device's refresh token.
  Future<void> logout() async {
    final AuthResponse res = await _client.send(
      HttpMethod.post,
      '/auth/logout',
      body: <String, dynamic>{},
      authed: true,
      idempotent: true,
    );
    _throwIfError(res);
  }

  /// GET /auth/devices (bearer) → {devices:[...]}.
  Future<List<AuthDevice>> listDevices() async {
    final AuthResponse res = await _client.send(
      HttpMethod.get,
      '/auth/devices',
      authed: true,
    );
    _throwIfError(res);
    final List<dynamic> devices =
        res.body['devices'] as List<dynamic>? ?? <dynamic>[]; // ASSUMED key
    return devices
        .whereType<Map<String, dynamic>>()
        .map(AuthDevice.fromJson)
        .toList();
  }

  /// POST /auth/devices/{id}/revoke (bearer) → {ok}.
  Future<void> revokeDevice(String deviceId) async {
    final AuthResponse res = await _client.send(
      HttpMethod.post,
      '/auth/devices/$deviceId/revoke',
      body: <String, dynamic>{},
      authed: true,
      idempotent: true,
    );
    _throwIfError(res);
  }

  /// Throws a typed [AuthFailure] for any non-2xx, parsed from the assumed error
  /// body `{ code, message, retry_after_seconds, attempts_left }`. Drives logic
  /// off `code`, never `message`.
  void _throwIfError(AuthResponse res) {
    if (res.isSuccess) return;
    final Map<String, dynamic> body = res.body;
    final String code = (body['code'] as String?) ?? // ASSUMED: key `code`
        _fallbackCodeFor(res.statusCode);
    final int? retrySeconds =
        (body['retry_after_seconds'] as num?)?.toInt(); // ASSUMED key
    final int? attemptsLeft =
        (body['attempts_left'] as num?)?.toInt(); // ASSUMED key
    throw AuthFailure(
      code,
      retryAfter:
          retrySeconds == null ? null : Duration(seconds: retrySeconds),
      attemptsLeft: attemptsLeft,
    );
  }

  String _fallbackCodeFor(int status) {
    if (status == 401) return AuthErrorCode.tokenExpired;
    return AuthErrorCode.unknown;
  }
}
