import 'dart:convert';

import 'package:http/http.dart' as http;

import 'api_models.dart';

// Re-export the response models so screens that import this file get them too.
export 'api_models.dart';

/// Current DPDP consent version. Mirrors `CURRENT_CONSENT_VERSION` in
/// packages/types — keep these in sync when the consent copy changes.
const String kConsentVersion = '2026-06-01';

/// HTTP client for the NestJS API (see apps/api).
///
/// Base URL is supplied at build time:
///   flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3001
/// (10.0.2.2 is the Android emulator's alias for the host machine.)
///
/// PRIVACY: the worker's raw answers are sent to the API, which stores PII only
/// in the `workers` table and pseudonymizes before any LLM call. This client
/// never talks to an LLM directly.
class ApiClient {
  ApiClient({String? baseUrl, http.Client? client, this.onSessionTokenRefreshed})
      : baseUrl = baseUrl ??
            const String.fromEnvironment(
              'API_BASE_URL',
              defaultValue: 'http://localhost:3001',
            ),
        _client = client ?? http.Client();

  final String baseUrl;
  final http.Client _client;

  /// Optional callback invoked when a worker-authenticated response hands back a
  /// fresh rolling token in the `x-session-token` header (see WorkerAuthGuard).
  /// Lets the caller (e.g. a screen) update the stored session token so the
  /// session stays alive without a separate refresh call. Never logs the token.
  final void Function(String freshToken)? onSessionTokenRefreshed;

  Future<void> requestOtp(String phoneE164) async {
    await _post('/auth/otp/request', <String, dynamic>{'phone': phoneE164});
  }

  Future<VerifyOtpResult> verifyOtp(String phoneE164, String otp) async {
    final Map<String, dynamic> json = await _post(
      '/auth/otp/verify',
      <String, dynamic>{'phone': phoneE164, 'otp': otp},
    );
    return VerifyOtpResult.fromJson(json);
  }

  Future<void> acceptConsent({
    required String workerId,
    required List<String> purposes,
    String consentVersion = kConsentVersion,
  }) async {
    await _post('/consent/accept', <String, dynamic>{
      'worker_id': workerId,
      'consent_version': consentVersion,
      'purposes': purposes,
    });
  }

  /// Starts a chat session. Worker-scoped — requires [authToken]; the worker is
  /// taken from the token (WorkerAuthGuard + ConsentGuard), never from the body.
  Future<String> startSession({required String authToken}) async {
    final Map<String, dynamic> json = await _post(
      '/chat/session',
      <String, dynamic>{},
      authToken: authToken,
    );
    return json['session_id'] as String;
  }

  /// Posts a worker message. Worker-scoped — requires [authToken]; the worker is
  /// taken from the token, never from the body.
  Future<ChatReply> sendMessage({
    required String sessionId,
    required String authToken,
    required String text,
  }) async {
    final Map<String, dynamic> json = await _post(
      '/chat/message',
      <String, dynamic>{
        'session_id': sessionId,
        'text': text,
      },
      authToken: authToken,
    );
    return ChatReply.fromJson(json);
  }

  /// Extracts the worker's profile from their chat answers.
  ///
  /// Extraction runs as a background job on the API. This method enqueues the
  /// job (POST /profile/extract -> 202) and then polls GET /ai-jobs/{id} until
  /// the job completes, returning the resulting `profile_id`. Callers can treat
  /// this as a single awaitable that yields a usable profile id.
  ///
  /// Throws [ApiException] if the job fails, or [ProfileExtractionTimeout] if it
  /// does not finish within the bounded poll budget.
  Future<String> extractProfile({
    required String authToken,
    String? sessionId,
  }) async {
    final EnqueueResult enqueued = await enqueueProfileExtraction(
      authToken: authToken,
      sessionId: sessionId,
    );
    return awaitProfileId(enqueued.aiJobId);
  }

  /// Enqueues a profile-extraction job. Returns the job id to poll. Worker-scoped
  /// — requires [authToken]; the worker is taken from the token, not the body.
  Future<EnqueueResult> enqueueProfileExtraction({
    required String authToken,
    String? sessionId,
  }) async {
    final Map<String, dynamic> json = await _post(
      '/profile/extract',
      <String, dynamic>{
        if (sessionId != null) 'session_id': sessionId,
      },
      authToken: authToken,
    );
    return EnqueueResult.fromJson(json);
  }

  /// Fetches the current state of an async AI job.
  Future<AiJob> getAiJob(String aiJobId) async {
    final Map<String, dynamic> json = await _get('/ai-jobs/$aiJobId');
    return AiJob.fromJson(json);
  }

  /// Polls [getAiJob] until the job completes and yields a `profile_id`.
  ///
  /// Bounded poll: [maxAttempts] tries spaced [pollInterval] apart. Throws
  /// [ApiException] if the job fails, or [ProfileExtractionTimeout] if the
  /// budget is exhausted while still queued/running.
  Future<String> awaitProfileId(
    String aiJobId, {
    int maxAttempts = 40,
    Duration pollInterval = const Duration(milliseconds: 350),
  }) async {
    for (int attempt = 0; attempt < maxAttempts; attempt++) {
      final AiJob job = await getAiJob(aiJobId);
      if (job.isCompleted) {
        final String? profileId = job.profileId;
        if (profileId == null || profileId.isEmpty) {
          throw ApiException(502, 'profile job completed without a profile id');
        }
        return profileId;
      }
      if (job.isFailed) {
        throw ApiException(
          502,
          job.errorMessage ?? 'profile extraction failed',
        );
      }
      await Future<void>.delayed(pollInterval);
    }
    throw ProfileExtractionTimeout(aiJobId);
  }

  /// Confirms a profile. Worker-scoped — requires [authToken]; the worker is
  /// taken from the token, never from the body.
  Future<void> confirmProfile({
    required String authToken,
    required String profileId,
  }) async {
    await _post(
      '/profile/confirm',
      <String, dynamic>{
        'profile_id': profileId,
      },
      authToken: authToken,
    );
  }

  /// Records the worker's real name (PATCH /workers/me/name). Worker-scoped —
  /// requires [authToken] (WorkerAuthGuard + ConsentGuard); the worker is taken
  /// from the token, never from the body. The name is PII: it is sent once over
  /// TLS, encrypted at rest by the API, and NEVER returned or logged. The
  /// response is only `{ ok: true }`, so nothing is parsed back.
  Future<void> updateName({
    required String fullName,
    required String authToken,
  }) async {
    await _patch(
      '/workers/me/name',
      <String, dynamic>{'full_name': fullName},
      authToken: authToken,
    );
  }

  Future<ResumeResult> generateResume({
    required String workerId,
    required String profileId,
  }) async {
    final Map<String, dynamic> json = await _post('/resume/generate', <String, dynamic>{
      'worker_id': workerId,
      'profile_id': profileId,
    });
    return ResumeResult.fromJson(json);
  }

  /// Fetches a short-lived SIGNED url to the worker's own resume PDF
  /// (GET /resume/:id/download — ADR-0009 Stream C / G1c). Worker-scoped:
  /// requires [authToken] (WorkerAuthGuard); the server derives the worker from
  /// the token and emits `resume.downloaded`. PRIVACY: the returned url embeds a
  /// token and must NEVER be logged.
  Future<ResumeDownload> downloadResume({
    required String resumeId,
    required String authToken,
  }) async {
    final Map<String, dynamic> json =
        await _get('/resume/$resumeId/download', authToken: authToken);
    return ResumeDownload.fromJson(json);
  }

  /// Fetches a short-lived SIGNED url to a trade's interview-kit PDF
  /// (GET /interview-kit/:tradeKey/download). PUBLIC route — the content is
  /// per-trade and PII-free, so NO auth token is sent. [tradeKey] is a lowercase
  /// slug. PRIVACY: the returned url embeds a token and must NEVER be logged.
  Future<InterviewKitDownload> downloadInterviewKit(String tradeKey) async {
    final Map<String, dynamic> json =
        await _get('/interview-kit/$tradeKey/download?source=worker_app');
    return InterviewKitDownload.fromJson(json);
  }

  /// Logs the worker out — best-effort token revocation. Worker-scoped: sends
  /// the bearer [authToken]; the API returns 204 (no body). The caller should
  /// clear local session state regardless of the outcome (offline-safe).
  Future<void> logout({required String authToken}) async {
    await _post('/auth/logout', <String, dynamic>{}, authToken: authToken);
  }

  /// Fetches the alpha swipe-to-apply feed (ADR-0009): up to [limit] open jobs
  /// in deterministic seed order. Worker-scoped — requires [authToken] (the
  /// session token from OTP verify); the API guards this with WorkerAuthGuard +
  /// ConsentGuard, so a 401 means re-login and a 403 means consent is required.
  ///
  /// Returns PII-free coarse job fields only (no employer, no pay).
  Future<List<FeedItem>> getFeed({
    required String authToken,
    int limit = 20,
  }) async {
    final Map<String, dynamic> json =
        await _get('/feed?limit=$limit', authToken: authToken);
    final List<dynamic> jobs = json['jobs'] as List<dynamic>? ?? <dynamic>[];
    return jobs
        .whereType<Map<String, dynamic>>()
        .map(FeedItem.fromJson)
        .toList();
  }

  /// Records an APPLY decision on [jobId] (idempotent server-side). Worker-scoped
  /// — requires [authToken]. [rank] is the 1-based feed position the apply was
  /// taken from (nullable); [sourceSurface] mirrors the API enum and defaults to
  /// "feed".
  Future<ApplyResult> applyToJob(
    String jobId, {
    required String authToken,
    int? rank,
    String sourceSurface = 'feed',
  }) async {
    final Map<String, dynamic> json = await _post(
      '/applications/$jobId/apply',
      <String, dynamic>{
        'rank': rank,
        'source_surface': sourceSurface,
      },
      authToken: authToken,
    );
    return ApplyResult.fromJson(json);
  }

  /// Records a SKIP decision on [jobId] (idempotent server-side). Worker-scoped
  /// — requires [authToken]. [reason] is a coarse, non-PII enum
  /// ("not_interested" | "too_far" | "low_pay" | "wrong_trade" | "other") and
  /// defaults to "other".
  Future<SkipResult> skipJob(
    String jobId, {
    required String authToken,
    String reason = 'other',
  }) async {
    final Map<String, dynamic> json = await _post(
      '/applications/$jobId/skip',
      <String, dynamic>{'reason': reason},
      authToken: authToken,
    );
    return SkipResult.fromJson(json);
  }

  /// Closes the underlying HTTP client. Call when the client is no longer used.
  void dispose() => _client.close();

  /// POST JSON and return the decoded object. Throws [ApiException] on non-2xx.
  ///
  /// When [authToken] is supplied it is sent as `Authorization: Bearer <token>`
  /// (required by worker-scoped routes). A null in [body] is encoded as JSON null,
  /// which the API accepts for nullable fields (e.g. `rank`).
  Future<Map<String, dynamic>> _post(
    String path,
    Map<String, dynamic> body, {
    String? authToken,
  }) async {
    final Uri uri = Uri.parse('$baseUrl$path');
    final http.Response res = await _client.post(
      uri,
      headers: _headers(contentType: true, authToken: authToken),
      body: jsonEncode(body),
    );
    return _decode(res);
  }

  /// PATCH JSON and return the decoded object. Throws [ApiException] on non-2xx.
  ///
  /// When [authToken] is supplied it is sent as `Authorization: Bearer <token>`
  /// (required by worker-scoped routes).
  Future<Map<String, dynamic>> _patch(
    String path,
    Map<String, dynamic> body, {
    String? authToken,
  }) async {
    final Uri uri = Uri.parse('$baseUrl$path');
    final http.Response res = await _client.patch(
      uri,
      headers: _headers(contentType: true, authToken: authToken),
      body: jsonEncode(body),
    );
    return _decode(res);
  }

  /// GET JSON and return the decoded object. Throws [ApiException] on non-2xx.
  ///
  /// When [authToken] is supplied it is sent as `Authorization: Bearer <token>`.
  Future<Map<String, dynamic>> _get(String path, {String? authToken}) async {
    final Uri uri = Uri.parse('$baseUrl$path');
    final http.Response res = await _client.get(
      uri,
      headers: _headers(contentType: false, authToken: authToken),
    );
    return _decode(res);
  }

  /// Builds request headers, adding the bearer token only when present.
  Map<String, String> _headers({required bool contentType, String? authToken}) {
    final Map<String, String> headers = <String, String>{
      'accept': 'application/json',
    };
    if (contentType) headers['content-type'] = 'application/json';
    if (authToken != null && authToken.isNotEmpty) {
      headers['authorization'] = 'Bearer $authToken';
    }
    return headers;
  }

  /// Shared response handling: surfaces a rolling refresh token, then decodes or
  /// throws [ApiException] on non-2xx.
  Map<String, dynamic> _decode(http.Response res) {
    final String? fresh = res.headers['x-session-token'];
    if (fresh != null && fresh.isNotEmpty) {
      onSessionTokenRefreshed?.call(fresh);
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ApiException(res.statusCode, _messageFrom(res.body));
    }
    if (res.body.isEmpty) return <String, dynamic>{};
    final dynamic decoded = jsonDecode(res.body);
    return decoded is Map<String, dynamic> ? decoded : <String, dynamic>{};
  }

  String _messageFrom(String body) {
    try {
      final dynamic decoded = jsonDecode(body);
      if (decoded is Map<String, dynamic> && decoded['message'] != null) {
        return decoded['message'].toString();
      }
    } catch (_) {
      // fall through to raw body
    }
    return body.isEmpty ? 'request failed' : body;
  }
}
