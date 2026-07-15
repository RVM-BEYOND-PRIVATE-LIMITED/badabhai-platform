// CONTRACT LAYER for /auth/* — reconciled with the REAL backend (ADR-0026 Phase 4).
//
// EVERY /auth/* request + response shape lives in THIS file so the wire contract is
// a single-file change. The login/refresh/pin/devices field names + routes below are
// confirmed against apps/api (auth.dto.ts, devices.dto.ts, pin.dto.ts). A handful of
// genuinely still-flexible fields (otp/request resend key, error envelope keys) keep
// their `// ASSUMED:` marker; the confirmed ones no longer carry it.

import 'dart:io' show Platform;

import 'package:equatable/equatable.dart';
import 'package:flutter/foundation.dart' show kIsWeb;

import 'auth_failure.dart';
import 'authed_client.dart';
import 'device_id.dart';

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

  /// Parses `{ access_token, refresh_token, expires_in_seconds }` (the shared
  /// shape of /auth/otp/verify, /auth/token/refresh, /auth/pin/verify).
  factory AuthTokens.fromJson(Map<String, dynamic> json) {
    final int expiresIn = (json['expires_in_seconds'] as num?)?.toInt() ?? 0;
    return AuthTokens(
      access: json['access_token'] as String? ?? '',
      refresh: json['refresh_token'] as String? ?? '',
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
    this.consentAccepted,
  });

  final String workerId;
  final bool isNewUser;
  final bool pinSet;
  final AuthTokens tokens;

  /// TD62 — does this worker hold an ACTIVE DPDP consent (`consent_accepted` on
  /// LoginResponse)? TRI-STATE by design: `null` when the field is ABSENT (an
  /// older server) — NEVER defaulted to true/false, so an old API can't brick
  /// routing. Only a definitive `false` forces the consent gate.
  final bool? consentAccepted;

  factory OtpVerifyResult.fromJson(Map<String, dynamic> json) =>
      OtpVerifyResult(
        workerId: json['worker_id'] as String? ?? '',
        // Backend key is `is_new_worker` (LoginResponse); client field stays
        // `isNewUser` (its meaning — a worker without a remembered PIN).
        isNewUser: json['is_new_worker'] as bool? ?? false,
        // `pin_set` (LoginResponse) — does this worker already have a PIN.
        pinSet: json['pin_set'] as bool? ?? false,
        tokens: AuthTokens.fromJson(json),
        // TD62: absent (old server) → null; present → the definitive boolean.
        consentAccepted: json['consent_accepted'] as bool?,
      );

  @override
  List<Object?> get props =>
      <Object?>[workerId, isNewUser, pinSet, tokens, consentAccepted];
}

/// Result of POST /auth/pin/verify — the minted token pair plus the TD62
/// consent signal (`consent_accepted` on PinVerifyResponse, same tri-state
/// semantics as [OtpVerifyResult.consentAccepted]).
class PinVerifyResult extends Equatable {
  const PinVerifyResult({required this.tokens, this.consentAccepted});

  final AuthTokens tokens;

  /// `null` when the server didn't send the field (older API) — pass-through.
  final bool? consentAccepted;

  factory PinVerifyResult.fromJson(Map<String, dynamic> json) =>
      PinVerifyResult(
        tokens: AuthTokens.fromJson(json),
        consentAccepted: json['consent_accepted'] as bool?,
      );

  @override
  List<Object?> get props => <Object?>[tokens, consentAccepted];
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

/// One trusted device for this worker. Result item of GET /auth/devices
/// (DeviceListItem). There is NO server `label` — the UI derives a display
/// label from [platform] + [model].
class AuthDevice extends Equatable {
  const AuthDevice({
    required this.id,
    required this.platform,
    required this.model,
    required this.appVersion,
    required this.trustedAt,
    required this.lastSeenAt,
    required this.isCurrent,
  });

  /// Opaque device row id — the value passed to DELETE /auth/devices/{id}.
  final String id;
  final String platform;
  final String? model;
  final String? appVersion;
  final DateTime? trustedAt;
  final DateTime? lastSeenAt;

  /// True for the device making the request (cannot be revoked from here).
  final bool isCurrent;

  factory AuthDevice.fromJson(Map<String, dynamic> json) => AuthDevice(
        id: json['id'] as String? ?? '',
        platform: json['platform'] as String? ?? '',
        model: json['model'] as String?,
        appVersion: json['app_version'] as String?,
        trustedAt: _parseDate(json['trusted_at']),
        lastSeenAt: _parseDate(json['last_seen_at']),
        isCurrent: json['is_current'] as bool? ?? false,
      );

  static DateTime? _parseDate(Object? raw) =>
      raw is String ? DateTime.tryParse(raw) : null;

  @override
  List<Object?> get props =>
      <Object?>[id, platform, model, appVersion, trustedAt, lastSeenAt, isCurrent];
}

/// The /auth/* endpoints whose error mapping differs by HTTP status. The real
/// backend (ADR-0026) returns plain NestJS `{ statusCode, message }` with NO
/// `code` field, so the failure code is derived from `(endpoint, statusCode)`.
enum _AuthEndpoint {
  otpRequest,
  otpVerify,
  pinSet,
  pinVerify,
  tokenRefresh,
  authed, // logout / devices (bearer): 401 → reauthRequired, else unknown
  pinResetRequest,
  pinResetConfirm,
}

/// The single isolated contract layer for /auth/*.
///
/// Every method funnels through [AuthedClient.send] (which signs, refreshes, and
/// retries) and parses the confirmed response shapes above into typed results.
/// On a non-2xx it throws a typed [AuthFailure] built by [_failureFor] from the
/// `(endpoint kind, HTTP statusCode)` pair — the real backend sends plain
/// `{ statusCode, message }` with NO `code` and NO attempts/retry metadata. PASS
/// 2's cubits call these methods and react to the typed results / failures.
class AuthApi {
  /// [deviceId] supplies the SAME stable device id sent as the `X-Device-Id`
  /// header, so the `device_info` block on OTP verify binds the session to the
  /// already-known device (ADR-0026 Phase 2). Optional so tests can omit it
  /// (then `device_info` is simply not sent — login still works, no device bound).
  AuthApi(AuthedClient client, {DeviceIdProvider? deviceId})
      : _maybeClient = client,
        _deviceId = deviceId;

  /// Subclass seam: [MockAuthApi] overrides every method and never touches the
  /// client, so it constructs with a null client (the real plugin/network is
  /// never reachable in mock mode).
  AuthApi.withoutClient()
      : _maybeClient = null,
        _deviceId = null;

  final AuthedClient? _maybeClient;
  final DeviceIdProvider? _deviceId;

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
    _check(res, _AuthEndpoint.otpRequest);
    return OtpRequestResult.fromJson(res.body);
  }

  /// POST /auth/otp/verify {phone, otp, device_info?} → tokens + worker flags.
  ///
  /// Sends the OPTIONAL `device_info` block (ADR-0026 Phase 2) so the session is
  /// bound to this trusted device — without it the Phase-3 trusted-device
  /// PIN-unlock gate can never pass. `device_id` is the same PII-free UUID sent
  /// as the `X-Device-Id` header; `platform` is the host OS.
  Future<OtpVerifyResult> otpVerify(String phoneE164, String otp) async {
    final Map<String, dynamic> body = <String, dynamic>{
      'phone': phoneE164,
      'otp': otp,
    };
    final Map<String, dynamic>? deviceInfo = await _buildDeviceInfo();
    if (deviceInfo != null) body['device_info'] = deviceInfo;

    final AuthResponse res = await _client.send(
      HttpMethod.post,
      '/auth/otp/verify',
      body: body,
      idempotent: true,
    );
    _check(res, _AuthEndpoint.otpVerify);
    return OtpVerifyResult.fromJson(res.body);
  }

  /// Builds the `device_info` block from the persisted device id + host platform,
  /// matching the backend [DeviceInfoSchema] (device_id 8–256 chars, platform
  /// enum). Returns null when no device-id provider is wired (then no device is
  /// bound). `model` / `app_version` / `push_token` are optional and omitted here.
  Future<Map<String, dynamic>?> _buildDeviceInfo() async {
    final DeviceIdProvider? provider = _deviceId;
    if (provider == null) return null;
    final String deviceId = await provider.getOrCreate();
    if (deviceId.length < 8) return null; // schema guard — never send an invalid id
    return <String, dynamic>{
      'device_id': deviceId,
      'platform': _platformName(),
    };
  }

  static String _platformName() {
    if (kIsWeb) return 'web';
    if (Platform.isAndroid) return 'android';
    if (Platform.isIOS) return 'ios';
    return 'unknown';
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
    _check(res, _AuthEndpoint.pinSet);
  }

  /// POST /auth/pin/verify {pin} (+ persisted refresh token) → tokens (+ the
  /// TD62 `consent_accepted` signal).
  ///
  /// ASSUMED: the server reads the refresh token from secure storage via the
  /// body field `refresh_token`; if the backend instead reads it from a cookie /
  /// header, change it here. The verified PIN mints a fresh token pair.
  Future<PinVerifyResult> pinVerify(String pin,
      {required String refreshToken}) async {
    final AuthResponse res = await _client.send(
      HttpMethod.post,
      '/auth/pin/verify',
      body: <String, dynamic>{
        'pin': pin, // ASSUMED: key `pin`
        'refresh_token': refreshToken, // ASSUMED: key `refresh_token`
      },
      idempotent: true,
    );
    _check(res, _AuthEndpoint.pinVerify);
    return PinVerifyResult.fromJson(res.body);
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
    _check(res, _AuthEndpoint.tokenRefresh);
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
    _check(res, _AuthEndpoint.authed);
  }

  /// GET /auth/devices (bearer) → `{ devices: [...] }` — the CONFIRMED
  /// DeviceListResponse shape (apps/api/src/auth/devices.dto.ts; root key
  /// `devices`, items = DeviceListItem). A non-2xx throws via [_check] (401 →
  /// reauthRequired). A 2xx whose `devices` value is MISSING or not a list is a
  /// contract violation → an EXPLICIT [AuthErrorCode.contractError], never a
  /// silent empty list (which would read as "no devices"). A present-but-empty
  /// list is valid and returns `[]`.
  Future<List<AuthDevice>> listDevices() async {
    final AuthResponse res = await _client.send(
      HttpMethod.get,
      '/auth/devices',
      authed: true,
    );
    _check(res, _AuthEndpoint.authed);
    final Object? devices = res.body['devices'];
    if (devices is! List) {
      // Shape drift (e.g. wrong root key / null) — fail loud, don't swallow it
      // into an empty list. The devices view then shows the honest parse reason.
      throw AuthFailure(
        AuthErrorCode.contractError,
        statusCode: res.statusCode,
      );
    }
    return devices
        .whereType<Map<String, dynamic>>()
        .map(AuthDevice.fromJson)
        .toList();
  }

  /// DELETE /auth/devices/{id} (bearer) → 204. Revokes that trusted device.
  Future<void> revokeDevice(String deviceId) async {
    final AuthResponse res = await _client.send(
      HttpMethod.delete,
      '/auth/devices/$deviceId',
      authed: true,
      idempotent: true,
    );
    _check(res, _AuthEndpoint.authed);
  }

  /// POST /auth/pin/reset/request {phone} → 200 {success:true}. Idempotent; no
  /// bearer — starts the dedicated forgot-PIN OTP flow. 429 → rate-limited,
  /// 503 → unavailable.
  Future<void> pinResetRequest(String phoneE164) async {
    final AuthResponse res = await _client.send(
      HttpMethod.post,
      '/auth/pin/reset/request',
      body: <String, dynamic>{'phone': phoneE164},
      idempotent: true,
    );
    _check(res, _AuthEndpoint.pinResetRequest);
  }

  /// POST /auth/pin/reset/confirm {phone, otp, pin} → 204. Idempotent; no
  /// bearer — proves the OTP and sets the NEW PIN in one step. 401 → bad/expired
  /// OTP, 400 → weak/format PIN, 429 → rate-limited.
  Future<void> pinResetConfirm(
    String phoneE164,
    String otp,
    String pin,
  ) async {
    final AuthResponse res = await _client.send(
      HttpMethod.post,
      '/auth/pin/reset/confirm',
      body: <String, dynamic>{'phone': phoneE164, 'otp': otp, 'pin': pin},
      idempotent: true,
    );
    _check(res, _AuthEndpoint.pinResetConfirm);
  }

  /// Throws a typed [AuthFailure] for any non-2xx, derived from the
  /// `(endpoint, HTTP status)` pair. The real backend (ADR-0026) sends plain
  /// `{ statusCode, message }` with NO `code` and NO attempts/retry metadata, so
  /// the code is computed here, never read off the body. The PII-free server
  /// `message` is carried through for the few codes that surface it (rate-limit /
  /// unavailable / weak-PIN); PIN-verify is a NEUTRAL 401 with no oracle.
  void _check(AuthResponse res, _AuthEndpoint endpoint) {
    if (res.isSuccess) return;
    throw _failureFor(endpoint, res.statusCode, res.body['message'] as String?);
  }

  AuthFailure _failureFor(_AuthEndpoint endpoint, int status, String? message) {
    final String code = _codeFor(endpoint, status);
    return AuthFailure(
      code,
      statusCode: status,
      // Carry the PII-free server message when present; else the curated copy
      // wins downstream (authErrorMessage only prefers it for select codes).
      message: (message != null && message.isNotEmpty)
          ? message
          : 'Please try again.',
    );
  }

  /// The (endpoint, status) → code table. See the per-method doc comments and the
  /// confirmed backend status codes (ADR-0026 / apps/api/src/auth/*).
  String _codeFor(_AuthEndpoint endpoint, int status) {
    switch (endpoint) {
      case _AuthEndpoint.otpRequest:
        if (status == 429) return AuthErrorCode.otpRateLimited;
        if (status == 503) return AuthErrorCode.unavailable;
        return AuthErrorCode.unknown;
      case _AuthEndpoint.otpVerify:
        if (status == 401) return AuthErrorCode.otpInvalid;
        if (status == 429) return AuthErrorCode.otpRateLimited;
        if (status == 503) return AuthErrorCode.unavailable;
        return AuthErrorCode.unknown;
      case _AuthEndpoint.pinSet:
        if (status == 400) return AuthErrorCode.pinWeak;
        if (status == 503) return AuthErrorCode.unavailable;
        return AuthErrorCode.unknown;
      case _AuthEndpoint.pinVerify:
        // NEUTRAL: every PIN failure is one opaque 401 — no oracle.
        if (status == 401) return AuthErrorCode.pinVerifyFailed;
        return AuthErrorCode.unknown;
      case _AuthEndpoint.tokenRefresh:
        if (status == 401) return AuthErrorCode.reauthRequired;
        return AuthErrorCode.network;
      case _AuthEndpoint.authed:
        if (status == 401) return AuthErrorCode.reauthRequired;
        return AuthErrorCode.unknown;
      case _AuthEndpoint.pinResetRequest:
        if (status == 429) return AuthErrorCode.otpRateLimited;
        if (status == 503) return AuthErrorCode.unavailable;
        return AuthErrorCode.unknown;
      case _AuthEndpoint.pinResetConfirm:
        if (status == 401) return AuthErrorCode.otpInvalid;
        if (status == 400) return AuthErrorCode.pinWeak;
        if (status == 429) return AuthErrorCode.otpRateLimited;
        return AuthErrorCode.unknown;
    }
  }
}
