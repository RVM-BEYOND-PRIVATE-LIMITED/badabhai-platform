import 'dart:convert';
import 'dart:math' as math;

import 'package:http/http.dart' as http;

import '../../features/job_search/domain/job_search_item.dart';
import '../../features/swipe/domain/job_detail.dart';
import '../auth/account_deleted_signal.dart';
import '../config/app_config.dart' show resolveApiBaseUrl;
import '../config/build_info.dart';
import 'api_models.dart';

// Re-export the response models so screens that import this file get them too.
export 'api_models.dart';

/// Current DPDP consent version. Mirrors `CURRENT_CONSENT_VERSION` in
/// packages/types — keep these in sync when the consent copy changes.
///
/// 2026-08-28: bumped alongside the voice consent notice copy landing in
/// `consent_screen.dart` (#1270, approved in #1269) — the version bump and
/// the words it certifies move together, never separately.
const String kConsentVersion = '2026-08-28';

/// Hard ceiling on any single HTTP request.
///
/// `package:http` has NO default timeout, so a stalled connection hangs the
/// future FOREVER — the screen spins with no error and no retry. Our workers are
/// on 2G/3G where a dead-but-open socket is routine, so an explicit bound is
/// mandatory. A [TimeoutException] maps to a NetworkFailure via `mapError`, so
/// the UI shows an honest "couldn't reach the server" with a Try-again instead
/// of an infinite spinner. 15s is generous for a slow link yet bounded.
const Duration kRequestTimeout = Duration(seconds: 15);

/// Default number of polls' worth of BUDGET for an async AI job (#378).
///
/// Kept at 40 because it defines the total wait together with
/// [kAiJobPollInterval] (40 x 350ms = 14s) — it is no longer the number of
/// requests actually made. See [buildAiJobPollSchedule].
const int kAiJobPollMaxAttempts = 40;

/// Base gap between AI-job polls — also the FIRST gap. See
/// [buildAiJobPollSchedule].
const Duration kAiJobPollInterval = Duration(milliseconds: 350);

/// Poll BUDGET for a PROFILE EXTRACTION job — the same class of bug TD59 fixed
/// for transcription, on the route it was never applied to.
///
/// THE SERVER'S STRUCTURAL CEILING IS ~50s OF AI ALONE. One extraction job makes
/// TWO sequential provider calls, and the API allows each of them 25s
/// (`PROFILE_JOB_TIMEOUT_MS` in `apps/api/src/ai/ai.service.ts`):
///
///   1. `/profile/parse`     — types the deterministic answer map
///   2. `/profiling/extract` — Phase C, reads the conversation for
///                             `experiences[]` ("A SECOND CALL, AND
///                             DELIBERATELY SO"), when the LLM interview is on
///
/// On top of that sit BullMQ queue pickup, the provenance gates, the projector
/// and the profile write. So the old default — [kAiJobPollMaxAttempts] x
/// [kAiJobPollInterval] = **14s** — did not merely risk the failure, it
/// GUARANTEED it on the real path: the worker was told "Profile taiyaar nahi ho
/// payi. Zyada time lag raha hai." while the server was still working, then
/// completed, billed and stored the profile they had just been told they did not
/// have. Verified on a real device against the live backend.
///
/// The API comment that set 25s reasoned "safe to be this long because NOBODY IS
/// WAITING: the only caller is the BullMQ extraction job, minutes after the
/// interview closed." This screen is what was waiting. Both halves are corrected
/// together, because that assumption is what would re-break this later.
///
/// 90s EXCEEDS THE CEILING WITH MARGIN, the same shape as
/// [kVoiceTranscriptWaitBudget]'s 150s over its own ~140s ceiling. It is a
/// ceiling to STOP the bug, not a tuned value — the real number should come from
/// measured staging p50/p95, and the better fix is to stop BLOCKING on the job
/// at all (show "profile ban rahi hai" and resolve when it lands), which removes
/// the latency dependency instead of lengthening the wait.
const Duration kProfileExtractWaitBudget = Duration(seconds: 90);

/// [kProfileExtractWaitBudget] expressed as poll attempts for
/// [ApiClient.awaitProfileId] (total budget is `attempts x`
/// [kAiJobPollInterval]). [buildAiJobPollSchedule]'s exponential backoff keeps
/// the request COUNT modest across the longer wait — this buys time, not traffic.
const int kProfileExtractPollMaxAttempts =
    90 * 1000 ~/ 350; // kProfileExtractWaitBudget / kAiJobPollInterval ~= 257

/// Poll BUDGET for a VOICE TRANSCRIPTION job (#635 / TD59) — deliberately far
/// larger than the extraction default of [kAiJobPollMaxAttempts] x
/// [kAiJobPollInterval] (14s).
///
/// TD59: the server's STRUCTURAL ceiling for even a SHORT answer is ~140s
/// (storage 20s fetch + Sarvam 60s + translate 60s). A 14s client budget
/// therefore guarantees the exact failure — the client gives up and tells the
/// worker to retry WHILE the server completes, bills and stores the transcript.
/// The transcription budget must EXCEED the server ceiling; 150s covers it with
/// margin, and [buildAiJobPollSchedule]'s exponential backoff keeps the request
/// COUNT modest across the longer wait.
///
/// This is a ceiling to STOP the bug, not a tuned value: the final number should
/// come from measured staging p50/p95. TD59's own preferred prescription is the
/// server-side merge (backend B5), which removes the latency dependency entirely
/// rather than merely lengthening the budget — consume it here once it lands.
const Duration kVoiceTranscriptWaitBudget = Duration(seconds: 150);

/// [kVoiceTranscriptWaitBudget] expressed as poll attempts for
/// [ApiClient.awaitAiJob] (total budget is `attempts x` [kAiJobPollInterval]).
const int kVoiceTranscriptPollMaxAttempts =
    150 * 1000 ~/ 350; // kVoiceTranscriptWaitBudget / kAiJobPollInterval ~= 428

/// Builds the delay schedule for [ApiClient.awaitProfileId] /
/// [ApiClient.awaitAiJob] — one delay per poll, in order (#378).
///
/// The old cadence was a FLAT [pollInterval] repeated [maxAttempts] times:
/// 350ms x 40 = ~3 requests/second sustained for 14s. The *wait* is not the
/// problem — an LLM extraction genuinely takes seconds and the profiling /
/// voice UX is tuned to that budget (see #282) — the *request count* is: up to
/// 40 round-trips per extraction on a metered prepaid connection, holding the
/// cellular radio in its high-power state, with every device on the network
/// hitting `/ai-jobs` in lockstep at the same fixed rate.
///
/// So: same total budget, spent differently. Gaps grow 350ms -> 700ms -> 1.4s
/// -> 2.8s (capped at 8x the base, so a slow job still gets checked a few times
/// a minute), each carries +/-25% jitter so a herd of devices de-syncs, and the
/// tail gap is clamped so the delays sum to EXACTLY
/// `pollInterval * maxAttempts`. Net effect: ~8 requests instead of 40 across
/// the SAME 14s — the wait is never shortened, only the polling is.
///
/// The first poll still fires immediately (no initial delay): a job that is
/// already terminal — a fast/cached transcription, or a re-await after the
/// screen rebuilt — must not be made artificially slower.
List<Duration> buildAiJobPollSchedule({
  int maxAttempts = kAiJobPollMaxAttempts,
  Duration pollInterval = kAiJobPollInterval,
  math.Random? random,
}) {
  final int base = pollInterval.inMicroseconds;
  final int budget = base * maxAttempts;
  if (base <= 0 || budget <= 0) return const <Duration>[];

  final math.Random rnd = random ?? math.Random();
  final int cap = base * 8;
  final List<Duration> delays = <Duration>[];
  int spent = 0;
  int next = base;

  while (spent < budget) {
    // Jitter in [0.75, 1.25). Applied to the UNJITTERED curve so drift can't
    // compound across attempts.
    final int jittered = math.max(1, (next * (0.75 + rnd.nextDouble() * 0.5)).round());
    // Clamp the tail: overrunning would extend the timeout past what callers
    // budgeted, and stopping short would shorten the wait — both are wrong.
    final int delay = spent + jittered >= budget ? budget - spent : jittered;
    delays.add(Duration(microseconds: delay));
    spent += delay;
    next = math.min(next * 2, cap);
  }
  return delays;
}

/// The CLOSED set of `resume.shared` channels — MUST match the server's
/// `ShareResumeSchema` enum EXACTLY (`channel` in apps/api/src/resume/resume.dto.ts):
/// `whatsapp` | `link` | `download` | `other`.
///
/// A drift here would post a channel the server's zod schema rejects (400), so
/// a test pins this set to the published contract rather than trusting it stays
/// in step by hand. PII-FREE BY CONSTRUCTION: a channel is a fixed enum token,
/// never a link, phone, or name — which is exactly why `resume.shared` can
/// carry it (CLAUDE.md §3 Privacy First).
const Set<String> kResumeShareChannels = <String>{
  'whatsapp',
  'link',
  'download',
  'other',
};

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
    this.onAccountDeleted,
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

  /// Invoked ONCE when any response carries the RESERVED account-deleted
  /// contract: HTTP 410 Gone with body `{ "code": "WORKER_ACCOUNT_DELETED" }`
  /// (a valid worker token whose row no longer exists server-side).
  ///
  /// 410 is reserved EXCLUSIVELY for this, and the predicate is deliberately
  /// BOTH the status AND the code — a bare 410 or any other `code` must never
  /// trigger it, because a false destructive logout is unacceptable. The seam
  /// still throws the [ApiException] afterward so the in-flight call fails
  /// cleanly; this hook only lets the app root wipe + return to phone login.
  final void Function()? onAccountDeleted;

  /// Reads the CURRENT bearer, after [onUnauthorized] renewed it. Callers pass
  /// their token by value, so the retry would otherwise re-send the same dead
  /// one and 401 again.
  final String? Function()? currentAuthToken;

  /// Accepts consent for the SESSION worker. Worker-scoped — requires
  /// [authToken]; the subject is taken from the token by `WorkerAuthGuard`,
  /// never from the body.
  ///
  /// There is deliberately no `workerId` parameter. Consent is the DPDP gate
  /// (invariant #6), and while this route was unauthenticated with a body
  /// `worker_id` it could be forged for any worker by anyone. Removing the
  /// parameter makes that unexpressible from the client, rather than merely
  /// discouraged.
  Future<void> acceptConsent({
    required String authToken,
    required List<String> purposes,
    String consentVersion = kConsentVersion,
  }) async {
    await _post(
      '/consent/accept',
      <String, dynamic>{
        'consent_version': consentVersion,
        'purposes': purposes,
      },
      authToken: authToken,
    );
  }

  /// Withdraws DPDP consent for the SESSION worker (POST /consent/withdraw —
  /// WorkerAuthGuard, no body, 200 `{ ok: true }`). Mirrors [acceptConsent]: the
  /// subject is taken from the bearer, never the body, so there is no id to send.
  ///
  /// SIDE EFFECT the caller MUST honour (confirmed in consent.service.ts): the
  /// server stamps `revokedAt` on the worker's latest consent row AND revokes
  /// EVERY active session (`sessions.revokeAll`), the current device included.
  /// The 200 returns before that token dies, but the next authed call will 401 —
  /// so the client hard-logs-out after a success and the worker must re-login and
  /// re-consent (next login returns `consent_accepted:false`, driving the gate).
  Future<void> withdrawConsent({required String authToken}) async {
    await _post(
      '/consent/withdraw',
      const <String, dynamic>{},
      authToken: authToken,
    );
  }

  /// Starts a chat session. Worker-scoped — requires [authToken]; the worker is
  /// taken from the token (WorkerAuthGuard + ConsentGuard), never from the body.
  ///
  /// Returns the session id plus [ChatSessionStart.openingText] when the API
  /// serves the one-shot opener. The opener is RENDERED ONLY — it is never posted
  /// back as a chat message, so it never enters the stored transcript that
  /// extraction reads.
  Future<ChatSessionStart> startSession({required String authToken}) async {
    final Map<String, dynamic> json = await _post(
      '/chat/session',
      <String, dynamic>{},
      authToken: authToken,
    );
    return ChatSessionStart.fromJson(json);
  }

  /// The worker's LATEST chat session id, or null if they have none (GET
  /// /chat/session/latest). Worker-scoped: the worker is taken from [authToken],
  /// never a param. Lets the app re-attach to the signup profiling session after a
  /// cold restart — the session id is in-memory only, so without this the "Bada
  /// Bhai" tab would start a fresh empty thread and orphan the earlier Q&A. The
  /// response is `{ session_id: <uuid> | null }`.
  Future<String?> latestChatSessionId({required String authToken}) async {
    final Map<String, dynamic> json =
        await _get('/chat/session/latest', authToken: authToken);
    final Object? id = json['session_id'];
    return id is String && id.isNotEmpty ? id : null;
  }

  /// Posts a worker message. Worker-scoped — requires [authToken]; the worker is
  /// taken from the token, never from the body.
  ///
  /// [submissionId] (#870) is the per-submission id minted by the caller once per
  /// physical send and re-sent verbatim on a retry. ADDITIVE and backward-
  /// compatible: the body stays `{session_id, text}` and the key is added ONLY
  /// when non-null, so an older server (which strips unknown keys) is unaffected.
  Future<ChatReply> sendMessage({
    required String sessionId,
    required String authToken,
    required String text,
    String? submissionId,
  }) async {
    final Map<String, dynamic> json = await _post(
      '/chat/message',
      <String, dynamic>{
        'session_id': sessionId,
        'text': text,
        if (submissionId != null) 'submission_id': submissionId,
      },
      authToken: authToken,
    );
    return ChatReply.fromJson(json);
  }

  /// Fetches the persisted chat transcript, oldest-first (#502 transcript
  /// hydration — GET /chat/sessions/:sessionId/messages). Worker-scoped: requires
  /// [authToken]; the server proves the session belongs to the token's worker
  /// (a 404 for not-found OR not-owner — no existence oracle). Used to REDRAW a
  /// conversation whose in-memory transcript was lost (a >5min background re-lock
  /// rebuilds [ChatBloc] with only its opener). The response is
  /// `{ messages: [{direction, body_text, created_at}] }` in chronological order
  /// — do NOT re-sort; the server already guarantees it.
  Future<List<SessionMessage>> listSessionMessages({
    required String sessionId,
    required String authToken,
  }) async {
    final Map<String, dynamic> json = await _get(
      '/chat/sessions/$sessionId/messages',
      authToken: authToken,
    );
    final List<dynamic> rows =
        json['messages'] as List<dynamic>? ?? <dynamic>[];
    return rows
        .whereType<Map<String, dynamic>>()
        .map(SessionMessage.fromJson)
        .toList();
  }

  /// Extracts the worker's profile from their chat answers.
  ///
  /// Extraction runs as a background job on the API. This method enqueues the
  /// job (POST /profile/extract -> 202) and then polls
  /// GET /workers/me/ai-jobs/{id} until
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
    return awaitProfileId(enqueued.aiJobId, authToken: authToken);
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

  /// Fetches the current state of an async AI job — `GET /workers/me/ai-jobs/{id}`.
  ///
  /// Worker-scoped and AUTHENTICATED. This used to call the ops route
  /// `GET /ai-jobs/{id}` with no credential at all; once that route was put behind
  /// InternalServiceGuard every poll 401'd, which broke profile extraction and voice
  /// transcription in any real build (mocks hid it). The worker route enforces
  /// ownership server-side, so a job belonging to someone else answers 404 — the
  /// same answer as a job that does not exist.
  Future<AiJob> getAiJob(String aiJobId, {required String authToken}) async {
    final Map<String, dynamic> json = await _get(
      '/workers/me/ai-jobs/$aiJobId',
      authToken: authToken,
    );
    return AiJob.fromJson(json);
  }

  /// Polls [getAiJob] until the job completes and yields a `profile_id`.
  ///
  /// Bounded poll over a total budget of `maxAttempts * pollInterval`
  /// ([kProfileExtractWaitBudget], 90s by default), spent on a jittered
  /// exponential-backoff schedule rather than a flat 350ms drumbeat (#378 —
  /// same wait, far fewer requests; see [buildAiJobPollSchedule]). Throws
  /// [ApiException] if the job fails, or [ProfileExtractionTimeout] if the
  /// budget is exhausted while still queued/running.
  ///
  /// THE DEFAULT IS NOT [kAiJobPollMaxAttempts], and that is the fix rather than
  /// a preference: 14s is under a THIRD of the server's ~50s structural ceiling
  /// for this job, so it timed out on the real path every time. See
  /// [kProfileExtractWaitBudget] for the arithmetic.
  Future<String> awaitProfileId(
    String aiJobId, {
    required String authToken,
    int maxAttempts = kProfileExtractPollMaxAttempts,
    Duration pollInterval = kAiJobPollInterval,
  }) async {
    final List<Duration> schedule = buildAiJobPollSchedule(
      maxAttempts: maxAttempts,
      pollInterval: pollInterval,
    );
    for (int attempt = 0; attempt < schedule.length; attempt++) {
      final AiJob job = await getAiJob(aiJobId, authToken: authToken);
      if (job.isCompleted) {
        final String? profileId = job.profileId;
        if (profileId == null || profileId.isEmpty) {
          throw ApiException(502, 'profile job completed without a profile id');
        }
        return profileId;
      }
      if (job.isFailed) {
        // The server no longer sends the raw failure reason (it can carry
        // infrastructure detail). This message was the fallback anyway: the UI
        // maps on status code, never on the text.
        throw ApiException(502, 'profile extraction failed');
      }
      await Future<void>.delayed(schedule[attempt]);
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

  /// POST /workers/me/actions/batch (#707) — record worker engagement action
  /// signals on the event spine (WorkerAuthGuard + ConsentGuard). The acting
  /// worker comes from [authToken]; the body carries NO worker_id (the schema is
  /// strict). [actions] is a list of `{action_type, source_surface, context}` —
  /// `context` is ids/enums/counts only, never worker text (a fail-closed PII
  /// guard rejects it server-side). Best-effort telemetry: the caller swallows
  /// failures and never retries on a critical path.
  Future<void> recordWorkerActions({
    required String authToken,
    required List<Map<String, dynamic>> actions,
  }) async {
    await _post(
      '/workers/me/actions/batch',
      <String, dynamic>{'actions': actions},
      authToken: authToken,
    );
  }

  /// POST /workers/me/feedback — the worker's free-text app feedback for the
  /// admin console. Worker-scoped (WorkerAuthGuard + ConsentGuard); the worker
  /// comes from [authToken], never the body. [category] is an OPTIONAL coarse tag
  /// (a fixed enum wire token) and [message] is the worker's own words. The
  /// response is only `{ ok: true }`, so nothing is parsed back.
  ///
  /// [screen] is the ROUTE PATTERN the worker was on when they tapped Feedback
  /// (`/jobs/:id/apply`), already normalized by [normalizeScreenContext] — never a
  /// concrete path, so it carries no identifier. OPTIONAL on the wire: the key is
  /// omitted when it is null, which is what every already-released build sends.
  ///
  /// [attachmentPaths] are the server-owned storage keys of up to 3 images the
  /// worker attached (`feedback-attachments/<workerId>/<uuid>.jpg`), each minted
  /// by [mintFeedbackAttachmentUploadUrl] and PUT to storage BEFORE this call. It
  /// is OMITTED from the body when null OR empty, so a submission with no image is
  /// byte-identical to what every already-released build sends (and the retry-
  /// without-`screen` path below is unaffected). The server re-validates each path
  /// against the minted-key regex — the client never asserts ownership.
  ///
  /// BACKEND: the endpoint is owned by the API/admin team (raised separately) —
  /// this is the client half of the contract.
  Future<void> submitFeedback({
    required String authToken,
    required String message,
    String? category,
    String? screen,
    List<String>? attachmentPaths,
  }) async {
    await _post(
      '/workers/me/feedback',
      <String, dynamic>{
        'message': message,
        if (category != null) 'category': category,
        if (screen != null) 'screen': screen,
        if (attachmentPaths != null && attachmentPaths.isNotEmpty)
          'attachment_paths': attachmentPaths,
      },
      authToken: authToken,
    );
  }

  /// POST /workers/me/feedback/attachment/upload-url — mints a signed slot for ONE
  /// feedback image (up to 3 per submission). Worker from [authToken]; the body is
  /// EMPTY — the SERVER chooses the object key
  /// (`feedback-attachments/<workerId>/<uuid>.jpg`). The bytes are then PUT to
  /// `upload_url` (RealFeedbackAttachmentUploader) and the returned `storage_path`
  /// rides back on [submitFeedback]'s `attachment_paths`.
  ///
  /// A 503 means feedback attachments are dormant server-side (bucket unset); a
  /// 404 that this endpoint is not deployed on that build. The caller treats both
  /// as "drop this image" — the worker's TEXT feedback still sends. Reuses
  /// [PhotoUploadTicket] (identical wire shape: `storage_path` / `upload_url` /
  /// `expires_in`). PRIVACY: the returned url is SIGNED — never log it.
  Future<PhotoUploadTicket> mintFeedbackAttachmentUploadUrl({
    required String authToken,
  }) async {
    final Map<String, dynamic> json = await _post(
      '/workers/me/feedback/attachment/upload-url',
      <String, dynamic>{},
      authToken: authToken,
    );
    return PhotoUploadTicket.fromJson(json);
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

  /// GET /workers/me/work-preferences/options (#1296) — the chip vocabulary for
  /// the post-interview finishing form. Each field is a `{ slug: "English label" }`
  /// map; the English labels are what print on the résumé, so the client renders
  /// chips from THIS rather than a hard-coded list that would drift from the
  /// server enum. Worker from [authToken].
  Future<WorkPrefOptionsDto> getWorkPreferenceOptions({
    required String authToken,
  }) async {
    final Map<String, dynamic> json = await _get(
      '/workers/me/work-preferences/options',
      authToken: authToken,
    );
    return WorkPrefOptionsDto.fromJson(json);
  }

  /// PUT /workers/me/employment (#1296) — REPLACES the worker's whole work-history
  /// list (sending `[]` clears it). [employments] are the already-wire-shaped
  /// entry maps (the repository builds them from typed models, so this stays
  /// HTTP-only). Worker from [authToken]; the response `{ ok, employer_count }`
  /// echoes no employer name, so nothing is parsed back.
  Future<void> updateEmployment({
    required List<Map<String, dynamic>> employments,
    required String authToken,
  }) async {
    await _put(
      '/workers/me/employment',
      <String, dynamic>{'employments': employments},
      authToken: authToken,
    );
  }

  /// PUT /workers/me/work-preferences (#1296) — the closed-set finishing pages.
  /// [fields] is the already-built body: an ABSENT key leaves the stored value
  /// alone, an empty list clears that row ("none of these"), and a `null` scalar
  /// un-ticks it — the repository owns that three-state shaping. A city the
  /// gazetteer cannot resolve is a 400 naming the value, surfaced as an
  /// [ApiException] the caller shows rather than swallows. Worker from [authToken].
  Future<void> updateWorkPreferences({
    required Map<String, dynamic> fields,
    required String authToken,
  }) async {
    await _put(
      '/workers/me/work-preferences',
      fields,
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

  /// GET /workers/me/profile — worker-self view of the current profile + latest
  /// generated resume. Used to restore `profileId` (and reuse an existing resume)
  /// after a login that skipped in-session profiling.
  Future<WorkerProfileBundle> getWorkerProfile({
    required String workerId,
    required String authToken,
  }) async {
    final Map<String, dynamic> json =
        await _get('/workers/me/profile', authToken: authToken);
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

  /// GET /resume/document (#1343) — the worker's OWN latest resume as
  /// STRUCTURED DATA: the SAME projection the PDF template renders from, so
  /// the resume tab stops re-parsing `resume_text` for `Label: value` lines.
  ///
  /// Worker-scoped: requires [authToken] (WorkerAuthGuard + ConsentGuard on
  /// the server). NO resume id in the path — unlike [downloadResume] /
  /// [shareResume], the server derives BOTH the worker AND which resume from
  /// the session token alone, so there is nothing here to enumerate.
  ///
  /// `document: null` in a successful response is an ORDINARY, non-error
  /// answer (every resume rendered before this column shipped has none, and
  /// one still pending its first render has none either) — [ResumeDocumentResponse]
  /// carries it through as null rather than throwing, and the CALLER must fall
  /// back to the existing `resume_text` rendering on it. A 404 ("no resume row
  /// at all yet") is left to throw as [ApiException] like any other failure.
  Future<ResumeDocumentResponse> getResumeDocument({
    required String authToken,
  }) async {
    final Map<String, dynamic> json =
        await _get('/resume/document', authToken: authToken);
    return ResumeDocumentResponse.fromJson(json);
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

  /// Reports that the worker shared their resume (POST /resume/:id/share —
  /// WorkerAuthGuard; the server derives the worker from the token and emits
  /// `resume.shared`, so the metric stops reading zero-by-construction, #1317).
  /// Worker-scoped: requires [authToken].
  ///
  /// [channel] is one of the CLOSED [kResumeShareChannels] enum
  /// (whatsapp | link | download | other) — NEVER a link or any PII; the server
  /// re-validates it against the same closed set (`ShareResumeSchema`) and a
  /// value outside it is a 400. Best-effort telemetry: the caller fires this
  /// AFTER a successful native share and swallows any failure, so a lost report
  /// never costs the worker their share. The response is `{ ok }`, so nothing is
  /// parsed back.
  Future<void> shareResume({
    required String resumeId,
    required String channel,
    required String authToken,
  }) async {
    await _post(
      '/resume/$resumeId/share',
      <String, dynamic>{'channel': channel},
      authToken: authToken,
    );
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
  ///
  /// [shift] ('day' | 'night' | 'rotational') and [payMin] (a ₹/month floor) are
  /// OPTIONAL server-side narrowing params (the ADR-0024 addendum put shift + pay
  /// on the `/feed` wire). Each is appended only when non-null, so the call is
  /// backward-compatible — the feed works with neither set.
  Future<List<FeedItem>> getFeed({
    required String authToken,
    int limit = 50,
    String? tradeKey,
    String? city,
    String? shift,
    int? payMin,
  }) async {
    final Map<String, String> queryParams = <String, String>{'limit': limit.toString()};
    if (tradeKey != null) queryParams['trade_key'] = tradeKey;
    if (city != null) queryParams['city'] = city;
    if (shift != null) queryParams['shift'] = shift;
    if (payMin != null) queryParams['pay_min'] = payMin.toString();

    final Uri uri = Uri(path: '/feed', queryParameters: queryParams);
    
    final Map<String, dynamic> json =
        await _get(uri.toString(), authToken: authToken);
    final List<dynamic> jobs = json['jobs'] as List<dynamic>? ?? <dynamic>[];
    return jobs
        .whereType<Map<String, dynamic>>()
        .map(FeedItem.fromJson)
        .toList();
  }

  /// Searches OPEN jobs by title/skill + location — the Indeed-style
  /// `GET /jobs/search` (worker types "CNC operator" + "Kota, Rajasthan").
  /// Worker-scoped: requires [authToken]; the API guards this with
  /// WorkerAuthGuard + ConsentGuard (a 401 means re-login, a 403 means consent),
  /// and the worker is derived from the bearer, never a param.
  ///
  /// Ranking is deterministic BACKEND-SIDE — the client never ranks. The
  /// response is PII-free by contract: coarse title/place, pay band, year-count
  /// experience window and coarse shift only, NEVER an employer name (same rule
  /// as `/feed`).
  ///
  /// Each of [q] / [city] / [state] is appended ONLY when non-empty, so the call
  /// mirrors how [getFeed] builds its Uri: an empty dimension is simply not sent.
  /// [limit] (server caps at 50) and [page] (1-based) are always sent. Returns
  /// one [JobSearchPage] — the items plus the `page`/`limit`/`has_more` envelope
  /// the caller pages on.
  Future<JobSearchPage> searchJobs({
    required String authToken,
    String? q,
    String? city,
    String? state,
    int limit = 20,
    int page = 1,
  }) async {
    final Map<String, String> queryParams = <String, String>{
      'limit': limit.toString(),
      'page': page.toString(),
    };
    if (q != null && q.isNotEmpty) queryParams['q'] = q;
    if (city != null && city.isNotEmpty) queryParams['city'] = city;
    if (state != null && state.isNotEmpty) queryParams['state'] = state;

    final Uri uri = Uri(path: '/jobs/search', queryParameters: queryParams);

    final Map<String, dynamic> json =
        await _get(uri.toString(), authToken: authToken);
    return JobSearchPage.fromJson(json);
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

  /// Marks the worker's Alerts read up to now (POST /workers/me/notifications/read —
  /// WorkerAuthGuard + ConsentGuard). Worker-scoped: the worker is derived from
  /// [authToken], never a body. Sets the SERVER-SIDE read watermark so read-state
  /// is CROSS-DEVICE (a later `getMyNotifications` returns `read: true` for these
  /// on any device). Empty body; the response is ignored. Callers invoke this
  /// FAIL-SOFT — an older API without the route simply keeps local-only read state.
  Future<void> markNotificationsRead({required String authToken}) async {
    await _post('/workers/me/notifications/read', <String, dynamic>{},
        authToken: authToken);
  }

  /// The worker's master Notifications on/off preference (GET
  /// /workers/me/notification-prefs — WorkerAuthGuard). Worker-scoped: the worker
  /// is derived from [authToken]. `{ notifications_enabled: bool }`. ABSENT/older
  /// API → defaults ON (true), so the client keeps its local value — fail-soft.
  Future<bool> getNotificationPrefs({required String authToken}) async {
    final Map<String, dynamic> json =
        await _get('/workers/me/notification-prefs', authToken: authToken);
    return json['notifications_enabled'] as bool? ?? true;
  }

  /// Sets the master Notifications on/off preference (PATCH
  /// /workers/me/notification-prefs — WorkerAuthGuard). Worker-scoped. When OFF,
  /// the backend skips every push fan-out to this worker (the gate lives in the
  /// send path, `PushService.deliver`, not here) — EXCEPT security alerts, which
  /// always send. The only two push templates today are the account-takeover
  /// tripwires (`worker.device_registered` — SIM-swap login; `worker.logged_out_all`),
  /// and a convenience toggle must not be able to disarm the alarm that reports
  /// its own misuse (an attacker on a stolen session could otherwise silence it).
  /// Callers invoke this best-effort.
  Future<void> updateNotificationPrefs({
    required bool enabled,
    required String authToken,
  }) async {
    await _patch(
      '/workers/me/notification-prefs',
      <String, dynamic>{'notifications_enabled': enabled},
      authToken: authToken,
    );
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

  // ---- Voice-form profiling (#699) — worker-authed + consent-gated, exactly
  // like /chat/*. The worker is taken from the token; no id is ever in a body.
  // These return the raw JSON so the parsing lives in HttpVoiceFormGateway (which
  // owns the voice_form domain shapes; ApiClient must not depend on them). A
  // missing/foreign session is a 404, a stale answer a 409 — both surface as
  // ApiException for the gateway to handle. ---------------------------------

  /// POST /profiling/session — reattach to a live interview or open one. Empty
  /// body (the server rejects any field). Returns `{session_id, step}`.
  Future<Map<String, dynamic>> profilingStart({required String authToken}) =>
      _post('/profiling/session', const <String, dynamic>{},
          authToken: authToken);

  /// POST /profiling/answer — submit ONE answer. [body] is
  /// `{session_id, question_key, answer}`; option KEYS only, never labels.
  /// Returns `{step}`.
  ///
  /// A SPOKEN answer is transcribed by the server IN-REQUEST (storage fetch +
  /// Sarvam STT + translate) before the next question is chosen, so this one
  /// route can legitimately take up to the ~140s STT ceiling. The default 15s
  /// [kRequestTimeout] would abort it while the answer is being saved — a lost-
  /// answer / double-submit. Reuse [kVoiceTranscriptWaitBudget] (150s, the
  /// SAME server-ceiling constant TD59 sized for transcription) so the client
  /// waits out the transcription instead of racing it.
  Future<Map<String, dynamic>> profilingAnswer({
    required String authToken,
    required Map<String, dynamic> body,
  }) =>
      _post('/profiling/answer', body,
          authToken: authToken, timeout: kVoiceTranscriptWaitBudget);

  /// POST /profiling/correct — a targeted correction of an already-SETTLED answer
  /// (#700). [body] is `{session_id, question_key, answer}`, the same four-member
  /// answer union as `/answer` (option KEYS / voice_note_id, never labels/bytes).
  /// Returns `{session_id, question_key, row, correction_count,
  /// profile_rebuild_required}`. A 409 means the question is still on screen (only
  /// a settled answer is correctable); a 422 means the words parsed to no value.
  ///
  /// Uses the long [kVoiceTranscriptWaitBudget] like `/answer`: a SPOKEN
  /// correction is transcribed in-request, so 15s would abort it mid-STT.
  Future<Map<String, dynamic>> profilingCorrect({
    required String authToken,
    required Map<String, dynamic> body,
  }) =>
      _post('/profiling/correct', body,
          authToken: authToken, timeout: kVoiceTranscriptWaitBudget);

  /// POST /profiling/finalize — commit the reviewed session. Idempotent. Returns
  /// `{session_id, committed}`.
  Future<Map<String, dynamic>> profilingFinalize({
    required String authToken,
    required String sessionId,
  }) =>
      _post('/profiling/finalize', <String, dynamic>{'session_id': sessionId},
          authToken: authToken);

  /// GET /profiling/session/:id — the review rows (and completeness) for the
  /// review screen. Returns `{session_id, complete, rows}`.
  Future<Map<String, dynamic>> profilingSession({
    required String authToken,
    required String sessionId,
  }) =>
      _get('/profiling/session/$sessionId', authToken: authToken);

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
  /// failed) and returns it. Bounded by the same `maxAttempts * pollInterval`
  /// budget as [awaitProfileId], spent on the jittered backoff schedule from
  /// [buildAiJobPollSchedule] (#378 — transcription waits are the other hot
  /// polling path). Throws [ProfileExtractionTimeout] (reused as a generic
  /// AI-job timeout) if the budget is exhausted while still queued/running.
  Future<AiJob> awaitAiJob(
    String aiJobId, {
    required String authToken,
    int maxAttempts = kAiJobPollMaxAttempts,
    Duration pollInterval = kAiJobPollInterval,
  }) async {
    final List<Duration> schedule = buildAiJobPollSchedule(
      maxAttempts: maxAttempts,
      pollInterval: pollInterval,
    );
    for (int attempt = 0; attempt < schedule.length; attempt++) {
      final AiJob job = await getAiJob(aiJobId, authToken: authToken);
      if (job.isTerminal) return job;
      await Future<void>.delayed(schedule[attempt]);
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

  /// Attributes a referral to the CURRENT worker (POST /referrals/attribute).
  /// Worker-scoped — requires [authToken] (WorkerAuthGuard); the invited worker
  /// is taken from the SESSION token, NEVER the body. [code] is the opaque
  /// 12-lowercase-hex referral code from a shared `/i/<code>` deep link
  /// (worker→worker ADR-0020 + agency ADR-0022 invites share this same shape).
  ///
  /// Call this ONLY AFTER consent has been accepted — the endpoint is
  /// consent-gated + idempotent server-side, and it is a best-effort side-signal
  /// that must never block onboarding. The response is NEUTRAL by contract
  /// (`{ ok: true }` regardless of outcome — NO-ORACLE: it never reveals whether
  /// the code matched or attribution happened), so the body is ignored here.
  /// PII-FREE: the code is opaque and carries no worker identity, and is never
  /// logged.
  ///
  /// [source] is an OPTIONAL, observability-only install-source leg from the
  /// closed enum `app_link` | `install_referrer` | `custom_scheme` | `unknown`:
  /// which surface delivered the code (an https App Link, Play's install
  /// referrer, or the `badabhai://` custom scheme). It is sent only when non-null
  /// — the server treats a missing value as `unknown` — so the call stays
  /// backward-compatible. Like the code it is opaque + PII-free and never logged.
  Future<void> attributeReferral({
    required String authToken,
    required String code,
    String? source,
  }) async {
    await _post(
      '/referrals/attribute',
      <String, dynamic>{
        'code': code,
        if (source != null) 'source': source,
      },
      authToken: authToken,
    );
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

  /// TEST-ONLY: immediately delete the signed-in worker's own account
  /// (POST /auth/account/delete/immediate — worker-scoped, no body, no grace).
  /// Exists purely so QA can trigger the account-deletion flow without a DBA;
  /// it is reachable only from the [kEnableTestDelete] Profile button.
  ///
  /// Contract: any 2xx = SUCCESS (the account is gone). A non-2xx throws
  /// [ApiException] (as [_post] already does), so 404 — the endpoint being
  /// DISABLED on that server — surfaces as `ApiException(404)`, distinct from
  /// other failures the caller may want to word differently.
  Future<void> deleteAccountImmediatelyForTest({
    required String authToken,
  }) async {
    await _post(
      '/auth/account/delete/immediate',
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
  ///
  /// [timeout] overrides the per-request ceiling for the rare route whose server
  /// work legitimately outruns [kRequestTimeout] (e.g. `/profiling/answer`, which
  /// transcribes a spoken answer IN-REQUEST). Defaults to [kRequestTimeout] so
  /// every other endpoint is unchanged.
  Future<Map<String, dynamic>> _post(
    String path,
    Map<String, dynamic> body, {
    String? authToken,
    Duration timeout = kRequestTimeout,
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
      timeout: timeout,
    );
  }

  /// Issues [request], and on a 401 for a worker-scoped call gives auth ONE
  /// chance to renew before retrying with the fresh bearer (#351).
  ///
  /// Bounded to a single retry — [onUnauthorized] renews at most once per call,
  /// so a genuinely dead session surfaces its 401 instead of looping. Only fires
  /// when the caller actually sent a bearer: an unauthenticated 401 is a real
  /// answer, not a stale token.
  ///
  /// [timeout] bounds each attempt (original and the post-renew retry alike).
  /// Defaults to [kRequestTimeout]; a long-running route passes its own budget.
  Future<Map<String, dynamic>> _send(
    Future<http.Response> Function(String? authToken) request,
    String? authToken, {
    Duration timeout = kRequestTimeout,
  }) async {
    http.Response res = await request(authToken).timeout(timeout);

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
        res = await request(fresh).timeout(timeout);
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

  Future<Map<String, dynamic>> _put(
    String path,
    Map<String, dynamic> body, {
    String? authToken,
  }) {
    final Uri uri = Uri.parse('$baseUrl$path');
    final String encoded = jsonEncode(body);
    return _send(
      (String? token) => _client.put(
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
  ///
  /// EVERY request carries `x-app-build` (#966) — a PII-free commit SHA / build
  /// number — so the server can attribute a request to a specific app build from
  /// its logs and a client-side bug can be tied to a build without asking the
  /// tester to dig. This is the single choke-point for outbound headers, so the
  /// stamp rides uniformly on every call.
  Map<String, String> _headers({required bool contentType, String? authToken}) {
    final Map<String, String> headers = <String, String>{
      'accept': 'application/json',
      'x-app-build': kAppBuild,
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
      // Attach the decoded body so a typed error caller can read structured
      // detail (e.g. the profiling stale-answer 409's `stale_reason`, #806)
      // without a second round trip. Null when the body is not a JSON object.
      final Map<String, dynamic>? errorBody = _tryDecodeMap(res.body);
      // The RESERVED account-deleted contract: a valid worker token whose row no
      // longer exists → 410 Gone + { code: WORKER_ACCOUNT_DELETED }. Fire the
      // hard-logout signal, then STILL throw below so this in-flight call fails
      // cleanly (never swallowed). Guarded on BOTH the status AND the code so a
      // bare 410 — or any other 410 — can never cause a false destructive logout.
      if (isWorkerAccountDeletedResponse(res.statusCode, errorBody)) {
        onAccountDeleted?.call();
      }
      throw ApiException(
        res.statusCode,
        _messageFrom(res.body),
        body: errorBody,
      );
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

  /// Best-effort decode of a response body to a `Map<String,dynamic>`, or null
  /// when it is empty, not JSON, or not a JSON object. NEVER throws — a garbage
  /// error body must not become a second failure over the top of the first.
  Map<String, dynamic>? _tryDecodeMap(String body) {
    if (body.isEmpty) return null;
    try {
      final dynamic decoded = jsonDecode(body);
      return decoded is Map<String, dynamic> ? decoded : null;
    } catch (_) {
      return null;
    }
  }
}
