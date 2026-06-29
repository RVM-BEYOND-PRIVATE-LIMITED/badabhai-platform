import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:uuid/uuid.dart';

import 'auth_failure.dart';
import 'device_id.dart';
import 'locale_store.dart';
import 'reauth_signal.dart';
import 'secure_token_store.dart';

/// HTTP methods this client speaks. Mutating methods (everything but GET) carry
/// an `Idempotency-Key`.
enum HttpMethod { get, post, put, patch, delete }

/// A decoded auth response: status + parsed JSON body (`{}` when empty). The
/// interceptor returns this from [AuthedClient.send]; [AuthApi] maps it to typed
/// results.
class AuthResponse {
  const AuthResponse(this.statusCode, this.body);

  final int statusCode;
  final Map<String, dynamic> body;

  bool get isSuccess => statusCode >= 200 && statusCode < 300;
}

/// The signing + refreshing HTTP core of persistent auth — the "interceptor".
///
/// Every call goes through [send], which:
///  - injects `X-Device-Id` + `X-Locale` on ALL requests,
///  - adds `Authorization: Bearer <access>` when `authed`,
///  - adds an `Idempotency-Key` (reused on retry) when `idempotent`,
///  - PROACTIVELY refreshes the access token if it is expired / within the skew,
///  - REACTIVELY refreshes once on a 401 and retries the original request a
///    single time with the new token,
///  - dedupes concurrent refreshes behind ONE shared Future (single-flight),
///  - retries a flaky idempotent write (bounded, same key) on transport errors,
///  - on an unrecoverable refresh failure: clears the store + fires [ReauthSignal].
///
/// SECURITY: it never logs a token; the refresh/access tokens only ever move
/// between [SecureTokenStore] and request headers.
class AuthedClient {
  AuthedClient({
    required this.baseUrl,
    required SecureTokenStore tokenStore,
    required DeviceIdProvider deviceId,
    required LocaleStore localeStore,
    required ReauthSignal reauthSignal,
    http.Client? client,
    Uuid? uuid,
    this.refreshSkew = const Duration(seconds: 30),
    this.maxNetworkRetries = 2,
    this.retryBackoff = const Duration(milliseconds: 300),
  })  : _tokenStore = tokenStore,
        _deviceId = deviceId,
        _localeStore = localeStore,
        _reauthSignal = reauthSignal,
        _uuid = uuid ?? const Uuid(),
        _client = client ?? http.Client();

  final String baseUrl;
  final SecureTokenStore _tokenStore;
  final DeviceIdProvider _deviceId;
  final LocaleStore _localeStore;
  final ReauthSignal _reauthSignal;
  final Uuid _uuid;
  final http.Client _client;

  /// Refresh the access token this far BEFORE its real expiry, to avoid racing a
  /// just-expired token.
  final Duration refreshSkew;

  /// Bounded transport retries for an idempotent write (same Idempotency-Key).
  final int maxNetworkRetries;

  /// Backoff between transport retries.
  final Duration retryBackoff;

  /// Single-flight guard: while a refresh is in-flight, all callers await this
  /// same Future instead of issuing parallel `/auth/token/refresh` calls.
  Future<void>? _inFlightRefresh;

  void dispose() => _client.close();

  /// The one entry point every auth call funnels through.
  ///
  /// [authed] adds the bearer token (and enables proactive/reactive refresh).
  /// [idempotent] adds an `Idempotency-Key` reused across retries — pass true for
  /// mutating writes that must not double-apply.
  Future<AuthResponse> send(
    HttpMethod method,
    String path, {
    Map<String, dynamic>? body,
    bool authed = false,
    bool idempotent = false,
  }) async {
    // One key per logical request, reused on every retry of THIS call.
    final String? idempotencyKey = idempotent ? _uuid.v4() : null;

    if (authed) {
      await _ensureFreshAccessToken();
    }

    AuthResponse res = await _attempt(
      method,
      path,
      body: body,
      authed: authed,
      idempotencyKey: idempotencyKey,
    );

    // Reactive refresh: a single retry on 401.
    if (authed && _isUnauthorized(res)) {
      final bool refreshed = await _refresh();
      if (refreshed) {
        res = await _attempt(
          method,
          path,
          body: body,
          authed: authed,
          idempotencyKey: idempotencyKey,
        );
      }
    }

    return res;
  }

  /// Issues one HTTP attempt, with bounded transport-level retries for idempotent
  /// writes (same key, same body). Throws [AuthFailure] with `NETWORK` if the
  /// retries are exhausted.
  Future<AuthResponse> _attempt(
    HttpMethod method,
    String path, {
    Map<String, dynamic>? body,
    required bool authed,
    required String? idempotencyKey,
  }) async {
    final int attempts = idempotencyKey != null ? maxNetworkRetries + 1 : 1;
    for (int i = 0; i < attempts; i++) {
      try {
        return await _rawSend(
          method,
          path,
          body: body,
          authed: authed,
          idempotencyKey: idempotencyKey,
        );
      } on SocketException {
        // transient — fall through to retry / surface as NETWORK below
      } on TimeoutException {
        // transient — fall through to retry / surface as NETWORK below
      } on http.ClientException {
        // transient — fall through to retry / surface as NETWORK below
      }
      if (i < attempts - 1) {
        await Future<void>.delayed(retryBackoff * (i + 1));
      }
    }
    throw AuthFailure(
      AuthErrorCode.network,
      message: 'Could not reach the server.',
    );
  }

  /// Builds + dispatches a single request and decodes the response. Surfaces a
  /// fresh rolling `x-session-token` (parity with the legacy ApiClient seam).
  Future<AuthResponse> _rawSend(
    HttpMethod method,
    String path, {
    Map<String, dynamic>? body,
    required bool authed,
    required String? idempotencyKey,
  }) async {
    final Uri uri = Uri.parse('$baseUrl$path');
    final Map<String, String> headers = await _buildHeaders(
      authed: authed,
      hasBody: body != null,
      idempotencyKey: idempotencyKey,
    );
    final String? encoded = body == null ? null : jsonEncode(body);

    final http.Response res = switch (method) {
      HttpMethod.get => await _client.get(uri, headers: headers),
      HttpMethod.post =>
        await _client.post(uri, headers: headers, body: encoded),
      HttpMethod.put =>
        await _client.put(uri, headers: headers, body: encoded),
      HttpMethod.patch =>
        await _client.patch(uri, headers: headers, body: encoded),
      HttpMethod.delete =>
        await _client.delete(uri, headers: headers, body: encoded),
    };

    return _decode(res);
  }

  Future<Map<String, String>> _buildHeaders({
    required bool authed,
    required bool hasBody,
    required String? idempotencyKey,
  }) async {
    final Map<String, String> headers = <String, String>{
      'accept': 'application/json',
      'X-Device-Id': await _deviceId.getOrCreate(),
      'X-Locale': _localeStore.read(),
    };
    if (hasBody) headers['content-type'] = 'application/json';
    if (idempotencyKey != null) headers['Idempotency-Key'] = idempotencyKey;
    if (authed) {
      final String? access = _tokenStore.accessToken;
      if (access != null && access.isNotEmpty) {
        headers['authorization'] = 'Bearer $access';
      }
    }
    return headers;
  }

  AuthResponse _decode(http.Response res) {
    final Map<String, dynamic> body = res.body.isEmpty
        ? <String, dynamic>{}
        : () {
            try {
              final dynamic decoded = jsonDecode(res.body);
              return decoded is Map<String, dynamic>
                  ? decoded
                  : <String, dynamic>{};
            } catch (_) {
              return <String, dynamic>{};
            }
          }();
    return AuthResponse(res.statusCode, body);
  }

  bool _isUnauthorized(AuthResponse res) => res.statusCode == 401;

  /// Proactive refresh: if the access token is missing or within [refreshSkew] of
  /// expiry, refresh before the request goes out.
  Future<void> _ensureFreshAccessToken() async {
    final String? access = _tokenStore.accessToken;
    final DateTime? expiresAt = await _tokenStore.readAccessExpiresAt();
    final bool expiredOrSoon = expiresAt == null ||
        DateTime.now().add(refreshSkew).isAfter(expiresAt);
    if (access == null || access.isEmpty || expiredOrSoon) {
      await _refresh();
    }
  }

  /// Single-flight token refresh. Returns true if a usable access token is now in
  /// memory. On an unrecoverable failure it clears the store and fires the reauth
  /// signal (and returns false). Concurrent callers share one in-flight refresh.
  Future<bool> _refresh() {
    final Future<void>? existing = _inFlightRefresh;
    if (existing != null) {
      return existing.then((_) => _tokenStore.accessToken != null);
    }
    final Future<void> run = _doRefresh();
    _inFlightRefresh = run;
    return run.then((_) => _tokenStore.accessToken != null).whenComplete(() {
      _inFlightRefresh = null;
    });
  }

  Future<void> _doRefresh() async {
    final String? refreshToken = await _tokenStore.readRefreshToken();
    if (refreshToken == null || refreshToken.isEmpty) {
      await _forceReauth();
      return;
    }

    AuthResponse res;
    try {
      res = await _attempt(
        HttpMethod.post,
        '/auth/token/refresh',
        body: <String, dynamic>{'refresh_token': refreshToken},
        authed: false,
        // Refresh is naturally idempotent on the wire; reuse one key for its own
        // bounded transport retries.
        idempotencyKey: _uuid.v4(),
      );
    } on AuthFailure {
      // Pure transport failure — leave the persisted refresh token intact so a
      // later call can retry; do NOT force reauth on a flaky network.
      rethrow;
    }

    if (res.isSuccess) {
      await _persistTokens(res.body);
      return;
    }

    // Non-2xx: the real backend collapses every unrecoverable refresh (invalid /
    // reuse / requires_otp) to a NEUTRAL 401 (403 defensive). Force a fresh OTP
    // login on those; treat anything else (5xx) as transient.
    if (res.statusCode == 401 || res.statusCode == 403) {
      await _forceReauth();
      return;
    }
    // 5xx / other: transient — surface as network so the caller can back off.
    throw AuthFailure(AuthErrorCode.network, message: 'Refresh failed.');
  }

  /// Persists a token set from a `{ access_token, refresh_token,
  /// expires_in_seconds }` body (TokenRefreshResponse) and updates the in-memory
  /// access token.
  Future<void> _persistTokens(Map<String, dynamic> body) async {
    final String? access = body['access_token'] as String?;
    final String? refresh = body['refresh_token'] as String?;
    final int expiresIn = (body['expires_in_seconds'] as num?)?.toInt() ?? 0;
    if (refresh != null && refresh.isNotEmpty) {
      await _tokenStore.saveTokens(
        refreshToken: refresh,
        accessExpiresAt: DateTime.now().add(Duration(seconds: expiresIn)),
        accessToken: access,
      );
    } else {
      // No rotated refresh in the body (defensive): still refresh the access
      // token + expiry in memory/storage.
      _tokenStore.accessToken = access;
      await _tokenStore
          .writeAccessExpiresAt(DateTime.now().add(Duration(seconds: expiresIn)));
    }
  }

  Future<void> _forceReauth() async {
    await _tokenStore.clear();
    _reauthSignal.requireReauth();
  }
}
