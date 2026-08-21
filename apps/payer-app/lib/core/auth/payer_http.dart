import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'payer_token_store.dart';

/// Hard ceiling on any single HTTP request.
///
/// `package:http` has NO default timeout, so a stalled connection hangs the
/// future FOREVER — the screen spins with no error and no retry. Payers on a
/// weak link would sit on a dead spinner indefinitely. A [TimeoutException]
/// surfaces as a normal transport failure, so the UI can show an honest error
/// with a retry. 15s is generous for a slow link yet bounded.
const Duration kRequestTimeout = Duration(seconds: 15);

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
///  - adopts the ROLLING session token the server hands back in the
///    `x-session-token` response header (see [_adoptRollingToken]) — the
///    proactive half of session upkeep, so a long-lived screen (the job-posting
///    chat) never has to fall through a 401 mid-flow,
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

  /// Bounded auto-retry for a transient TRANSPORT failure on an IDEMPOTENT GET —
  /// a dropped socket on a weak link or a cold first-connection that never reached
  /// the server. This is what turns the "load failed → tap Retry → it works" dance
  /// into a self-healing first load.
  ///
  /// DELIBERATELY does NOT retry any server RESPONSE (incl. 5xx): a 5xx means the
  /// server answered, so retrying would amplify load on an already-struggling
  /// backend — with every client firing the same GET in synchronized waves, a brief
  /// blip becomes a thundering-herd outage. A 5xx surfaces at once with the honest
  /// "problem on our side" copy and a MANUAL retry the user paces themselves.
  /// Timeouts are not retried either (see the loop). Only GET is retried — a
  /// POST/PATCH/DELETE that failed AFTER the server saw it would double-submit.
  static const int _kGetRetries = 2;
  static const Duration _kRetryBackoff = Duration(milliseconds: 300);

  void dispose() => _client.close();

  /// The single entry point. Returns the decoded [PayerResponse]; the caller maps
  /// it to a typed result.
  ///
  /// On a 401 for an authed call it transparently refreshes + retries once (see
  /// the class doc). The refresh/logout calls themselves never trigger a nested
  /// refresh — that would loop.
  /// [idempotencyKey], when non-null, is sent as the `idempotency-key` request
  /// header. It lets the SERVER dedupe a repeated write (a user re-tap after a
  /// timeout) — it does NOT make this method auto-retry. Writes still run exactly
  /// once per call here; the key only makes a *caller-driven* retry safe.
  Future<PayerResponse> send(
    PayerMethod method,
    String path, {
    Map<String, dynamic>? body,
    bool authed = true,
    String? idempotencyKey,
  }) async {
    final PayerResponse res = await _rawSend(method, path,
        body: body, authed: authed, idempotencyKey: idempotencyKey);

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
    // The same [idempotencyKey] rides along so the post-refresh retry replays
    // (not re-grants) if the pre-refresh attempt had already reached the server.
    await _tokenStore.saveAccessToken(newToken);
    final PayerResponse retry = await _rawSend(method, path,
        body: body, authed: authed, idempotencyKey: idempotencyKey);
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
    String? idempotencyKey,
  }) async {
    final Uri uri = Uri.parse('$baseUrl$path');
    final Map<String, String> headers = <String, String>{
      'accept': 'application/json',
    };
    if (body != null) headers['content-type'] = 'application/json';
    // A caller-supplied idempotency key lets the server collapse a repeated
    // write (reserve-before-grant, replay the original balance) — never a PII
    // value; a random, single-purchase token.
    if (idempotencyKey != null && idempotencyKey.isNotEmpty) {
      headers['idempotency-key'] = idempotencyKey;
    }
    if (authed) {
      final String? token = _tokenStore.accessToken;
      if (token != null && token.isNotEmpty) {
        headers['authorization'] = 'Bearer $token';
      }
    }

    final String? encoded = body == null ? null : jsonEncode(body);

    // Idempotent GETs auto-retry a transient failure (see [_kGetRetries]); every
    // other verb runs exactly once so a write is never silently repeated.
    final bool retriable = method == PayerMethod.get;
    final int attempts = retriable ? _kGetRetries + 1 : 1;

    for (int attempt = 0; attempt < attempts; attempt++) {
      final bool lastAttempt = attempt == attempts - 1;
      try {
        // Every verb is bounded by kRequestTimeout — `package:http` has no default
        // timeout, so a stalled socket would hang the future forever (infinite
        // spinner, no error, no retry).
        final http.Response res = await switch (method) {
          PayerMethod.get => _client.get(uri, headers: headers),
          PayerMethod.post => _client.post(uri, headers: headers, body: encoded),
          PayerMethod.patch => _client.patch(uri, headers: headers, body: encoded),
          PayerMethod.delete => _client.delete(uri, headers: headers, body: encoded),
        }
            .timeout(kRequestTimeout);

        // The server ANSWERED — return it as-is (2xx/4xx/5xx). We never retry a
        // response: a 5xx retry would amplify load on a failing backend (see
        // [_kGetRetries]); a 4xx/2xx would not change on a retry.
        // Persist a rolling refresh BEFORE decoding, so the very next call already
        // signs with the fresh bearer even if this response is an error the caller
        // rethrows.
        await _adoptRollingToken(path, res, authed: authed);
        return _decode(res);
      } on TimeoutException {
        // A timeout means the server ACCEPTED the request but did not answer inside
        // kRequestTimeout. Retrying would just multiply the wait (up to N×15s) on a
        // genuinely slow/hung server without helping — so surface it AT ONCE. This
        // is what keeps the worst case one timeout, never a ~45s spinner (the "late
        // out" the retry must not cause). The screen shows the honest 'server slow'
        // reason and a manual Retry.
        rethrow;
      } on Exception {
        // A FAST transport failure — connection refused/reset: a cold first-
        // connection or a dropped socket on a weak link. It fails in well under the
        // timeout, so retrying an idempotent GET is cheap and heals the common blip.
        if (!retriable || lastAttempt) rethrow;
        await Future<void>.delayed(_kRetryBackoff * (attempt + 1));
      }
    }
    // Unreachable: the loop always returns a response or rethrows on the last
    // attempt. Present so the analyzer sees a definite return.
    throw StateError('payer request retry loop exited without a result');
  }

  /// Adopts the rolling session token `PayerAuthGuard` returns in the
  /// `x-session-token` response header once the current one is past its
  /// half-life (`apps/api/src/payers/payer-auth.guard.ts` — it re-mints and
  /// `res.setHeader("x-session-token", fresh.token)`).
  ///
  /// WHY THIS EXISTS: the client used to ignore that header entirely and only
  /// recover REACTIVELY, after a request had already come back 401. That is a
  /// visible failure for any screen that holds a long conversation open — the
  /// AI job-posting chat (ADR-0035) can sit past the half-life mid-draft, and
  /// the payer would eat a failed turn (and, if the refresh call itself failed,
  /// a bounce to Login with the draft on screen) for a session the server had
  /// already offered to renew. Reading the header keeps the session alive with
  /// no extra round trip; the 401 → refresh → retry path below stays as the
  /// last-resort recovery it always was.
  ///
  /// Deliberately narrow:
  ///  - only for [authed] calls (an anonymous call never carries one),
  ///  - never on `/payer/refresh` / `/payer/logout` ([_isNoRefreshPath]) — the
  ///    refresh response's own body token is what `send` persists, and adopting
  ///    a token on the way OUT of logout would re-seed a session being killed,
  ///  - a no-op when the header is absent, empty, or identical to what is
  ///    already stored (no pointless secure-storage write per request).
  ///
  /// NEVER logs the token (CLAUDE.md §2).
  Future<void> _adoptRollingToken(
    String path,
    http.Response res, {
    required bool authed,
  }) async {
    if (!authed) return;
    if (_isNoRefreshPath(path)) return;
    // `package:http` lower-cases response header names.
    final String? fresh = res.headers['x-session-token'];
    if (fresh == null || fresh.isEmpty) return;
    if (fresh == _tokenStore.accessToken) return;
    try {
      await _tokenStore.saveAccessToken(fresh);
    } catch (_) {
      // Best-effort: saveAccessToken updates the in-memory bearer BEFORE it writes,
      // so a secure-storage failure (Keystore error on a restored-backup / low-end
      // device) still leaves this and the next request correctly signed. Swallow it
      // — it must NOT bubble into the request's transport-error path (this runs
      // AFTER a successful response) and trigger a pointless re-GET or a false
      // "connection failed" on a call the server already answered.
    }
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
