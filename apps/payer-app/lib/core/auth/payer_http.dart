import 'dart:convert';

import 'package:http/http.dart' as http;

import 'payer_token_store.dart';

/// HTTP verbs [PayerHttp] speaks.
enum PayerMethod { get, post, patch, delete }

/// A decoded payer-API response: the HTTP status + the parsed JSON body (`{}`
/// when empty / non-object). Mirrors the worker app's `AuthResponse`.
class PayerResponse {
  const PayerResponse(this.statusCode, this.body);

  final int statusCode;
  final Map<String, dynamic> body;

  bool get isSuccess => statusCode >= 200 && statusCode < 300;
}

/// Thin authed wrapper over an [http.Client] for the payer API.
///
/// Responsibilities (kept deliberately small):
///  - prefixes [baseUrl], encodes/decodes JSON,
///  - attaches `Authorization: Bearer <token>` from [PayerTokenStore] when
///    [authed] is true,
///  - on a 401 for an authed call: attempts ONE silent token refresh via
///    [refreshToken] (`POST /payer/refresh`), persists the rotated bearer, and
///    RETRIES the original request once. Only if the refresh itself fails (or
///    the retry still 401s) does it clear the token store and invoke [onReauth]
///    (the app routes back to Login),
///  - NEVER logs a token and NEVER puts `payer_id` in a request body (the server
///    derives the payer from the bearer).
class PayerHttp {
  PayerHttp({
    required this.baseUrl,
    required PayerTokenStore tokenStore,
    http.Client? client,
    void Function()? onReauth,
    Future<String?> Function()? refreshToken,
  })  : _tokenStore = tokenStore,
        _client = client ?? http.Client(),
        _onReauth = onReauth,
        _refreshToken = refreshToken;

  final String baseUrl;
  final PayerTokenStore _tokenStore;
  final http.Client _client;
  final void Function()? _onReauth;

  /// Mints a fresh access token from the current bearer (`POST /payer/refresh`),
  /// or `null` if refresh failed. Injected (not called at construction) so the
  /// auth API — which itself is built over this [PayerHttp] — can be wired in a
  /// second pass without a construction cycle.
  final Future<String?> Function()? _refreshToken;

  /// Single-flight guard: concurrent 401s share ONE in-flight refresh instead of
  /// each firing their own.
  Future<String?>? _pendingRefresh;

  void dispose() => _client.close();

  /// The single entry point. Returns the decoded [PayerResponse]; the caller maps
  /// it to a typed result.
  ///
  /// On a 401 for an authed call it transparently refreshes + retries once (see
  /// the class doc). The refresh/logout calls themselves never trigger a nested
  /// refresh — that would loop.
  Future<PayerResponse> send(
    PayerMethod method,
    String path, {
    Map<String, dynamic>? body,
    bool authed = true,
  }) async {
    final PayerResponse res =
        await _rawSend(method, path, body: body, authed: authed);

    // Only authed calls take part in the 401 → refresh → retry dance.
    if (!authed || res.statusCode != 401) return res;

    // Never refresh (or force-reauth on) the refresh/logout calls themselves —
    // doing so would loop. Surface their 401 to the caller untouched.
    if (_isNoRefreshPath(path)) return res;

    // Attempt a single token refresh (single-flight across concurrent 401s).
    final String? newToken =
        _refreshToken == null ? null : await _refreshOnce();
    if (newToken == null || newToken.isEmpty) {
      // Refresh unavailable or failed → the session is dead. Guaranteed local
      // wipe + bounce back to Login.
      await _forceReauth();
      return res; // the original 401
    }

    // Persist the rotated bearer and retry the original request exactly once.
    await _tokenStore.saveAccessToken(newToken);
    final PayerResponse retry =
        await _rawSend(method, path, body: body, authed: authed);
    if (retry.statusCode == 401) await _forceReauth();
    return retry;
  }

  /// One HTTP round-trip + decode, with the current bearer. No 401 handling —
  /// that lives in [send] so a retry can reuse this without recursing.
  Future<PayerResponse> _rawSend(
    PayerMethod method,
    String path, {
    Map<String, dynamic>? body,
    bool authed = true,
  }) async {
    final Uri uri = Uri.parse('$baseUrl$path');
    final Map<String, String> headers = <String, String>{
      'accept': 'application/json',
    };
    if (body != null) headers['content-type'] = 'application/json';
    if (authed) {
      final String? token = _tokenStore.accessToken;
      if (token != null && token.isNotEmpty) {
        headers['authorization'] = 'Bearer $token';
      }
    }

    final String? encoded = body == null ? null : jsonEncode(body);
    final http.Response res = switch (method) {
      PayerMethod.get => await _client.get(uri, headers: headers),
      PayerMethod.post =>
        await _client.post(uri, headers: headers, body: encoded),
      PayerMethod.patch =>
        await _client.patch(uri, headers: headers, body: encoded),
      PayerMethod.delete =>
        await _client.delete(uri, headers: headers, body: encoded),
    };
    return _decode(res);
  }

  /// Wipes the local session and bounces to Login. Called only when refresh is
  /// impossible or has failed — never on a transient, recoverable 401.
  Future<void> _forceReauth() async {
    await _tokenStore.clear();
    _onReauth?.call();
  }

  /// Coalesces concurrent refreshes into one in-flight call.
  Future<String?> _refreshOnce() {
    final Future<String?>? existing = _pendingRefresh;
    if (existing != null) return existing;
    final Future<String?> future = _refreshToken!();
    _pendingRefresh = future;
    future.whenComplete(() {
      if (identical(_pendingRefresh, future)) _pendingRefresh = null;
    });
    return future;
  }

  /// The refresh + logout endpoints must never themselves trigger a refresh (a
  /// 401 there is terminal, not recoverable).
  static bool _isNoRefreshPath(String path) =>
      path == '/payer/refresh' || path == '/payer/logout';

  PayerResponse _decode(http.Response res) {
    final Map<String, dynamic> body = res.body.isEmpty
        ? <String, dynamic>{}
        : () {
            try {
              final dynamic decoded = jsonDecode(res.body);
              if (decoded is Map<String, dynamic>) return decoded;
              // Some payer routes return a top-level JSON array (e.g.
              // GET /payer/job-postings, GET /payer/agency/jobs). Wrap it under
              // `items` so the typed clients read a stable envelope.
              if (decoded is List<dynamic>) {
                return <String, dynamic>{'items': decoded};
              }
              return <String, dynamic>{};
            } catch (_) {
              return <String, dynamic>{};
            }
          }();
    return PayerResponse(res.statusCode, body);
  }
}
