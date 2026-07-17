import 'dart:convert';

import 'package:http/http.dart' as http;

import '../../features/swipe/domain/job_detail.dart';
import '../config/app_config.dart' show resolveApiBaseUrl;
import 'api_models.dart';

// Re-export the response models so screens that import this file get them too.
export 'api_models.dart';

/// Current DPDP consent version. Mirrors `CURRENT_CONSENT_VERSION` in
/// packages/types — keep these in sync when the consent copy changes.
const String kConsentVersion = '2026-06-01';

/// Hard ceiling on any single HTTP request.
///
/// `package:http` has NO default timeout, so a stalled connection hangs the
/// future FOREVER — the screen spins with no error and no retry. Our workers are
/// on 2G/3G where a dead-but-open socket is routine, so an explicit bound is
/// mandatory. A [TimeoutException] maps to a NetworkFailure via `mapError`, so
/// the UI shows an honest "couldn't reach the server" with a Try-again instead
/// of an infinite spinner. 15s is generous for a slow link yet bounded.
const Duration kRequestTimeout = Duration(seconds: 15);

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
  ApiClient({
    String? baseUrl,
    http.Client? client,
    this.onSessionTokenRefreshed,
    this.onUnauthorized,
    this.currentAuthToken,
  })  : baseUrl = baseUrl ?? resolveApiBaseUrl(),
        _client = client ?? http.Client();

  final String baseUrl;
  final http.Client _client;

  /// Optional callback invoked when a worker-authenticated response hands back a
  /// fresh rolling token in the `x-session-token` header (see WorkerAuthGuard).
  /// Lets the caller (e.g. a screen) update the stored session token so the
  /// session stays alive without a separate refresh call. Never logs the token.
  final void Function(String freshToken)? onSessionTokenRefreshed;

  /// Invoked ONCE when a worker-scoped call comes back 401 (#351).
  ///
  /// Every worker-scoped product call (feed, chat, resume, profile, voice,
  /// notifications, applications) goes through THIS client using
  /// SessionRepository.sessionToken as its bearer — not through AuthedClient's
  /// refresh interceptor. Without this hook a 401 was simply mapped to
  /// UnauthorizedFailure: nothing refreshed with the perfectly good persisted
  /// refresh token, and nothing fired ReauthSignal, so AuthSessionManager stayed
  /// `authenticated` and the router actively BOUNCED the worker away from
  /// /login. Every tab showed "Please log in again" forever with no way out.
  ///
  /// Return true when auth was renewed and the request deserves one retry.
  /// Returning false (or an unrecoverable refresh, which flips the manager to
  /// loggedOut and frees the router) leaves the original 401 to surface.
  final Future<bool> Function()? onUnauthorized;

  /// Reads the CURRENT bearer, after [onUnauthorized] renewed it. Callers pass
  /// their token by value, so the retry would otherwise re-send the same dead
  /// one and 401 again.
  final String? Function()? currentAuthToken;

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

  /// GET /workers/me/resume-fields — the worker-editable "safe fields" (their OWN
  /// name spelling + display prefs) for the edit screen. Worker-scoped
  /// (WorkerAuthGuard + ConsentGuard); the worker is taken from [authToken], never
  /// the body. `full_name` is a self-read of the owner's own name (never logged).
  Future<ResumeFieldsDto> getResumeFields({required String authToken}) async {
    final Map<String, dynamic> json =
        await _get('/workers/me/resume-fields', authToken: authToken);
    return ResumeFieldsDto.fromJson(json);
  }

  /// PATCH /workers/me/resume-prefs — persist the resume display prefs. Sends both
  /// flags (the backend requires at least one). Worker from [authToken]; the
  /// response is only `{ ok: true }`, so nothing is parsed back.
  Future<void> updateResumePrefs({
    required bool showPhoto,
    required bool nightShiftReady,
    required String authToken,
  }) async {
    await _patch(
      '/workers/me/resume-prefs',
      <String, dynamic>{
        'show_photo': showPhoto,
        'night_shift_ready': nightShiftReady,
      },
      authToken: authToken,
    );
  }

  /// POST /workers/me/photo/upload-url (ADR-0032) — mints a signed slot for the
  /// profile-photo bytes. Worker from [authToken]; the body is empty JSON — the
  /// SERVER chooses the object key. The bytes are then PUT to `upload_url`
  /// (RealPhotoUploader) and the returned `storage_path` is registered via
  /// [confirmPhoto]. A 503 means photos are not enabled server-side.
  /// PRIVACY: the returned url is SIGNED — never log it.
  Future<PhotoUploadTicket> requestPhotoUploadUrl({
    required String authToken,
  }) async {
    final Map<String, dynamic> json = await _post(
      '/workers/me/photo/upload-url',
      <String, dynamic>{},
      authToken: authToken,
    );
    return PhotoUploadTicket.fromJson(json);
  }

  /// POST /workers/me/photo (ADR-0032) — confirms the uploaded photo: the server
  /// re-verifies the minted path belongs to this worker and validates the object
  /// (JPEG/PNG ≤ 2MB) before persisting the pointer. Worker from [authToken].
  Future<void> confirmPhoto({
    required String storagePath,
    required String authToken,
  }) async {
    await _post(
      '/workers/me/photo',
      <String, dynamic>{'storage_path': storagePath},
      authToken: authToken,
    );
  }

  /// GET /workers/me/photo-url (ADR-0032) — a short-lived signed READ url for the
  /// worker's OWN photo. 404 when no photo (callers map that to "none", not an
  /// error); 503 while photos are disabled. PRIVACY: the url is SIGNED — fetch on
  /// view, hold in memory only, never log or persist it.
  Future<String> getMyPhotoUrl({required String authToken}) async {
    final Map<String, dynamic> json =
        await _get('/workers/me/photo-url', authToken: authToken);
    return json['url'] as String? ?? '';
  }

  /// DELETE /workers/me/photo (ADR-0032) — removes the worker's photo (pointer +
  /// object). Idempotent server-side; worker from [authToken].
  Future<void> deleteMyPhoto({required String authToken}) async {
    await _delete('/workers/me/photo', authToken: authToken);
  }

  /// GET /workers/:id/profile — worker + latest profile + latest generated
  /// resume. Used to restore `profileId` (and reuse an existing resume) after a
  /// login that skipped in-session profiling.
  Future<WorkerProfileBundle> getWorkerProfile({
    required String workerId,
    required String authToken,
  }) async {
    final Map<String, dynamic> json =
        await _get('/workers/$workerId/profile', authToken: authToken);
    return WorkerProfileBundle.fromJson(json);
  }

  /// POST /resume/generate — worker-scoped (TD70 item 5): requires [authToken]
  /// (WorkerAuthGuard); the server derives the worker from the token. The body
  /// worker_id is legacy back-compat and MUST match the session worker (else 404).
  Future<ResumeResult> generateResume({
    required String workerId,
    required String profileId,
    required String authToken,
  }) async {
    final Map<String, dynamic> json = await _post(
      '/resume/generate',
      <String, dynamic>{
        'worker_id': workerId,
        'profile_id': profileId,
      },
      authToken: authToken,
    );
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

  /// Lists the wired interview kits (GET /interview-kits). PUBLIC route — content
  /// is per-trade and PII-free, so NO auth token is sent (per-IP rate-limited
  /// server-side; a 429 surfaces as RateLimitedFailure via mapError). Response is
  /// `{ kits: [{trade_key, display_name}] }`; an empty list is a valid "no kits".
  Future<List<InterviewKitListItem>> getInterviewKits() async {
    final Map<String, dynamic> json = await _get('/interview-kits');
    final List<dynamic> kits = json['kits'] as List<dynamic>? ?? <dynamic>[];
    return kits
        .whereType<Map<String, dynamic>>()
        .map(InterviewKitListItem.fromJson)
        .toList();
  }

  /// Fetches the full static kit for one trade (GET /interview-kits/:tradeKey).
  /// PUBLIC + PII-free; NO auth token. [tradeKey] is a lowercase slug. A 404
  /// (unknown trade) / 429 (rate cap) surfaces as a typed [Failure] via mapError.
  Future<InterviewKitContentDto> getInterviewKit(String tradeKey) async {
    final Map<String, dynamic> json = await _get('/interview-kits/$tradeKey');
    return InterviewKitContentDto.fromJson(json);
  }

  /// Fetches the worker's own profile-summary card
  /// (GET /workers/me/profile-summary — WorkerAuthGuard + ConsentGuard).
  /// Worker-scoped: the worker is derived from [authToken], never a param (a 401
  /// means re-login, a 403 means consent is required). The response is PII-FREE
  /// by contract — there is NO name (an open §2 escalation, omitted server-side)
  /// and never a phone; `city` is the only sensitive field and must NEVER be
  /// logged. `strength` is an integer signal count, not a fraction.
  Future<ProfileSummaryDto> getProfileSummary({
    required String authToken,
  }) async {
    final Map<String, dynamic> json =
        await _get('/workers/me/profile-summary', authToken: authToken);
    return ProfileSummaryDto.fromJson(json);
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
  ///
  /// [limit] defaults to 50 (the backend's cap) so the LIBERAL alpha feed shows
  /// every open job while volume is small — the feed applies no location/trade
  /// filter server-side, so nothing is dropped between here and the deck.
  Future<List<FeedItem>> getFeed({
    required String authToken,
    int limit = 50,
  }) async {
    final Map<String, dynamic> json =
        await _get('/feed?limit=$limit', authToken: authToken);
    final List<dynamic> jobs = json['jobs'] as List<dynamic>? ?? <dynamic>[];
    return jobs
        .whereType<Map<String, dynamic>>()
        .map(FeedItem.fromJson)
        .toList();
  }

  /// Fetches the FULL worker-visible posting for one job (GET /jobs/:jobId —
  /// the ADR-0024 addendum, 2026-07-16). Worker-scoped — requires [authToken]
  /// (WorkerAuthGuard + ConsentGuard: a 401 means re-login, a 403 means consent
  /// is required); a 404 is the neutral "Job not found" for unknown/closed jobs.
  ///
  /// PII-free by contract: title, place, pay band, experience window,
  /// needed-by, shift, description, requirements and benefits — NEVER an
  /// employer/payer field of any kind (employer names are PII, CLAUDE.md §2).
  /// [JobDetail.fromJson] parses NAMED keys only, so a contract-violating
  /// employer-shaped key in the body is ignored, never surfaced.
  Future<JobDetail> jobDetail(String jobId, {required String authToken}) async {
    final Map<String, dynamic> json =
        await _get('/jobs/$jobId', authToken: authToken);
    return JobDetail.fromJson(json);
  }

  /// Fetches the worker's own applied/skipped jobs for the "Applied jobs" screen
  /// (GET /workers/me/applications — WorkerAuthGuard + ConsentGuard). Worker-scoped
  /// — the worker is derived from [authToken] (never a param), like [getFeed]. The
  /// response is an OBJECT `{worker_id, applications:[...]}`, NOT a bare array;
  /// the list mixes applied + skipped, and the repository filters to
  /// `action == 'applied'`. Coarse, PII-free fields only.
  Future<List<AppliedJob>> getMyApplications({required String authToken}) async {
    final Map<String, dynamic> json =
        await _get('/workers/me/applications', authToken: authToken);
    final List<dynamic> apps =
        json['applications'] as List<dynamic>? ?? <dynamic>[];
    return apps
        .whereType<Map<String, dynamic>>()
        .map(AppliedJob.fromJson)
        .toList();
  }

  /// Fetches the worker's Alerts feed (GET /workers/me/notifications —
  /// WorkerAuthGuard + ConsentGuard). Worker-scoped: the worker is derived from
  /// [authToken], never a param. The response is an OBJECT `{notifications:[...]}`.
  /// Rows are faceless + PII-free by contract (server-rendered copy — never an
  /// employer, pay, name, or phone).
  Future<List<WorkerNotification>> getMyNotifications({
    required String authToken,
  }) async {
    final Map<String, dynamic> json =
        await _get('/workers/me/notifications', authToken: authToken);
    final List<dynamic> rows =
        json['notifications'] as List<dynamic>? ?? <dynamic>[];
    return rows
        .whereType<Map<String, dynamic>>()
        .map(WorkerNotification.fromJson)
        .toList();
  }

  /// Mints a signed upload slot for a voice clip (POST /voice/upload-url —
  /// A2-storage, WorkerAuthGuard + ConsentGuard). Worker-scoped: requires
  /// [authToken]; the body is empty JSON — the server derives the worker from
  /// the token and returns `{storage_path, upload_url, expires_in}`. The clip
  /// bytes are then PUT to `upload_url` (see RealVoiceStorageUploader) and the
  /// returned `storage_path` is registered via [uploadVoiceNote].
  ///
  /// A 503 means voice uploads are not enabled server-side — the caller maps it
  /// to the honest [VoiceUnavailableFailure] copy. PRIVACY: the returned url is
  /// SIGNED — never log it.
  Future<VoiceUploadTicket> requestVoiceUploadUrl({
    required String authToken,
  }) async {
    final Map<String, dynamic> json = await _post(
      '/voice/upload-url',
      <String, dynamic>{},
      authToken: authToken,
    );
    return VoiceUploadTicket.fromJson(json);
  }

  /// Fetches a registered voice note + its transcript once STT has landed
  /// (GET /voice/:voiceNoteId — WorkerAuthGuard). Worker-scoped: requires
  /// [authToken]; the server checks the note belongs to the token's worker.
  /// `transcript_text`/`transcript_english` are null while transcription is
  /// still pending. PRIVACY: the transcript is worker content — never log it.
  Future<VoiceNoteDetail> fetchVoiceNote({
    required String authToken,
    required String voiceNoteId,
  }) async {
    final Map<String, dynamic> json =
        await _get('/voice/$voiceNoteId', authToken: authToken);
    return VoiceNoteDetail.fromJson(json);
  }

  /// Registers an already-stored voice clip (POST /voice/upload — A2a,
  /// WorkerAuthGuard + ConsentGuard). Worker-scoped: requires [authToken]. The
  /// server derives the worker from the token; the body carries only the
  /// [sessionId], the server-side [storagePath] (≤512 chars, must be the exact
  /// path minted by [requestVoiceUploadUrl] — the API rejects paths outside
  /// `voice-notes/<workerId>/`), and [durationSeconds] (>0, ≤120). PII-FREE —
  /// no audio bytes, no transcript.
  Future<VoiceUploadResult> uploadVoiceNote({
    required String authToken,
    required String sessionId,
    required String storagePath,
    required int durationSeconds,
  }) async {
    final Map<String, dynamic> json = await _post(
      '/voice/upload',
      <String, dynamic>{
        'session_id': sessionId,
        'storage_path': storagePath,
        'duration_seconds': durationSeconds,
      },
      authToken: authToken,
    );
    return VoiceUploadResult.fromJson(json);
  }

  /// Enqueues an STT job for a registered voice note (POST /voice/transcribe —
  /// A2b, same guard). Worker-scoped: requires [authToken]. Poll [getAiJob] on
  /// the returned `ai_job_id` until it is terminal.
  Future<TranscribeResult> transcribeVoiceNote({
    required String authToken,
    required String voiceNoteId,
  }) async {
    final Map<String, dynamic> json = await _post(
      '/voice/transcribe',
      <String, dynamic>{'voice_note_id': voiceNoteId},
      authToken: authToken,
    );
    return TranscribeResult.fromJson(json);
  }

  /// Polls [getAiJob] until the job reaches a terminal state (completed OR
  /// failed) and returns it. Bounded: [maxAttempts] tries spaced [pollInterval]
  /// apart. Throws [ProfileExtractionTimeout] (reused as a generic AI-job
  /// timeout) if the budget is exhausted while still queued/running.
  Future<AiJob> awaitAiJob(
    String aiJobId, {
    int maxAttempts = 40,
    Duration pollInterval = const Duration(milliseconds: 350),
  }) async {
    for (int attempt = 0; attempt < maxAttempts; attempt++) {
      final AiJob job = await getAiJob(aiJobId);
      if (job.isTerminal) return job;
      await Future<void>.delayed(pollInterval);
    }
    throw ProfileExtractionTimeout(aiJobId);
  }

  /// Creates a worker referral invite (POST /invites — A3, WorkerAuthGuard only,
  /// NO consent gate). Worker-scoped: requires [authToken]. An empty body is
  /// valid; [campaign] (1–64 chars) is optional. Returns the invite id + code +
  /// server-relative link. PII-FREE.
  Future<InviteResult> createInvite({
    required String authToken,
    String? campaign,
  }) async {
    final Map<String, dynamic> json = await _post(
      '/invites',
      <String, dynamic>{
        if (campaign != null && campaign.isNotEmpty) 'campaign': campaign,
      },
      authToken: authToken,
    );
    return InviteResult.fromJson(json);
  }

  /// Starts the DPDP account-delete flow (POST /auth/account/delete/request —
  /// A4, WorkerAuthGuard). Worker-scoped: requires [authToken]; no body. Returns
  /// `{success, resend_in_seconds}` (the OTP cooldown).
  Future<AccountDeleteRequestResult> requestAccountDelete({
    required String authToken,
  }) async {
    final Map<String, dynamic> json = await _post(
      '/auth/account/delete/request',
      <String, dynamic>{},
      authToken: authToken,
    );
    return AccountDeleteRequestResult.fromJson(json);
  }

  /// Confirms the account delete with the OTP (POST /auth/account/delete/confirm
  /// — A4 + ADR-0031, WorkerAuthGuard). Worker-scoped: requires [authToken]. The
  /// API returns 200 `{success, scheduled_for}` (was 204): the delete is only
  /// SCHEDULED — the 7-day grace starts and the session stays valid so the
  /// worker can cancel. FAIL-CLOSED: a 401 (bad OTP) / 429 (rate) / 503 surfaces
  /// as an [ApiException] the caller maps to honest copy.
  Future<AccountDeleteConfirmResult> confirmAccountDelete({
    required String authToken,
    required String otp,
  }) async {
    final Map<String, dynamic> json = await _post(
      '/auth/account/delete/confirm',
      <String, dynamic>{'otp': otp},
      authToken: authToken,
    );
    return AccountDeleteConfirmResult.fromJson(json);
  }

  /// Cancels a pending account deletion (POST /auth/account/delete/cancel —
  /// ADR-0031, WorkerAuthGuard). Worker-scoped: requires [authToken]; the body
  /// is empty — the worker is taken from the token, never the body. Idempotent
  /// server-side: cancelling with nothing pending is a 200 no-op.
  Future<void> cancelAccountDelete({required String authToken}) async {
    await _post(
      '/auth/account/delete/cancel',
      <String, dynamic>{},
      authToken: authToken,
    );
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
  }) {
    final Uri uri = Uri.parse('$baseUrl$path');
    final String encoded = jsonEncode(body);
    return _send(
      (String? token) => _client.post(
        uri,
        headers: _headers(contentType: true, authToken: token),
        body: encoded,
      ),
      authToken,
    );
  }

  /// Issues [request], and on a 401 for a worker-scoped call gives auth ONE
  /// chance to renew before retrying with the fresh bearer (#351).
  ///
  /// Bounded to a single retry — [onUnauthorized] renews at most once per call,
  /// so a genuinely dead session surfaces its 401 instead of looping. Only fires
  /// when the caller actually sent a bearer: an unauthenticated 401 is a real
  /// answer, not a stale token.
  Future<Map<String, dynamic>> _send(
    Future<http.Response> Function(String? authToken) request,
    String? authToken,
  ) async {
    http.Response res = await request(authToken).timeout(kRequestTimeout);

    final Future<bool> Function()? renew = onUnauthorized;
    // Conditions inlined so `authToken` promotes to non-null for the retry.
    if (res.statusCode == 401 &&
        renew != null &&
        authToken != null &&
        authToken.isNotEmpty) {
      final bool renewed = await renew();
      if (renewed) {
        // Re-read the bearer: the caller's copy is the one that just 401'd.
        final String fresh = currentAuthToken?.call() ?? authToken;
        res = await request(fresh).timeout(kRequestTimeout);
      }
    }
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
  }) {
    final Uri uri = Uri.parse('$baseUrl$path');
    final String encoded = jsonEncode(body);
    return _send(
      (String? token) => _client.patch(
        uri,
        headers: _headers(contentType: true, authToken: token),
        body: encoded,
      ),
      authToken,
    );
  }

  Future<Map<String, dynamic>> _delete(String path, {String? authToken}) {
    final Uri uri = Uri.parse('$baseUrl$path');
    return _send(
      (String? token) => _client.delete(
        uri,
        headers: _headers(contentType: false, authToken: token),
      ),
      authToken,
    );
  }

  /// GET JSON and return the decoded object. Throws [ApiException] on non-2xx.
  ///
  /// When [authToken] is supplied it is sent as `Authorization: Bearer <token>`.
  Future<Map<String, dynamic>> _get(String path, {String? authToken}) {
    final Uri uri = Uri.parse('$baseUrl$path');
    return _send(
      (String? token) => _client.get(
        uri,
        headers: _headers(contentType: false, authToken: token),
      ),
      authToken,
    );
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
