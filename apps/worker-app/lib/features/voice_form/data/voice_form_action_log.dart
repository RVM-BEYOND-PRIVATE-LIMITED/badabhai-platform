import 'dart:async';

import 'package:meta/meta.dart';

import '../../../core/api/api_client.dart';
import '../../../core/di/locator.dart';
import '../../../core/observability/analytics.dart';
import '../../../core/session/session_repository.dart';

/// A batch of buffered action events → the sink that emits them (#707).
typedef VoiceActionSink = Future<void> Function(List<BbAnalyticsEvent>);

/// Client-side batcher for the two voice-form action signals (#639):
/// `question_audio_played` (a MANUAL replay only) and `profiling_answer_spoken`.
///
/// Two rules the epic is strict about:
///  - **Never on the critical path.** [recordQuestionAudioPlayed] /
///    [recordAnswerSpoken] are synchronous buffer appends — they can never delay
///    or block an accessibility affordance (the replay). Emission happens later,
///    in [flush], and is best-effort: a failed sink is swallowed.
///  - **Ids/enums/counts only.** The buffered [BbAnalyticsEvent]s carry a 1-based
///    `question_index` count — never the question text, the transcript, or any
///    id. `analytics_pii_test.dart` scans the whole event set to keep it that way.
///
/// #707 — the default sink is now the BACKEND EVENT SPINE (`POST
/// /workers/me/actions/batch`), the audit-truth `events` table the ranking
/// reads, with Firebase kept only as a non-authoritative mirror. Firebase alone
/// left both signals unvalidated (no `action.recorded` row) and unattributable
/// (no join key back to the worker), so "this worker cannot read the screen"
/// could not feed the engagement ranking input it exists for.
class VoiceFormActionLog {
  VoiceFormActionLog({VoiceActionSink? sink}) : _sink = sink ?? _defaultSink;

  final VoiceActionSink _sink;
  final List<BbAnalyticsEvent> _buffer = <BbAnalyticsEvent>[];

  /// Buffered-but-unflushed count (test seam).
  int get pending => _buffer.length;

  /// A MANUAL replay of question [questionIndex] (1-based). Never call this for
  /// autoplay — the whole value of the signal is that it is deliberate.
  void recordQuestionAudioPlayed(int questionIndex) => _buffer
      .add(BbAnalytics.questionAudioPlayed(questionIndex: questionIndex));

  /// A spoken answer to question [questionIndex] (1-based).
  void recordAnswerSpoken(int questionIndex) =>
      _buffer.add(BbAnalytics.profilingAnswerSpoken(questionIndex: questionIndex));

  /// Best-effort flush of the whole batch in ONE call. Never throws; a failed
  /// flush is dropped, not retried on the critical path. Safe to call repeatedly.
  Future<void> flush() async {
    if (_buffer.isEmpty) return;
    final List<BbAnalyticsEvent> batch = List<BbAnalyticsEvent>.of(_buffer);
    _buffer.clear();
    try {
      await _sink(batch);
    } catch (_) {
      // Best-effort — telemetry is never allowed to surface or block.
    }
  }
}

/// The default sink (#707): POST the batch to the event spine (authoritative),
/// then mirror to Firebase (non-authoritative, for the product dashboard). The
/// spine is resolved lazily from the locator so a plain unit test with no DI
/// graph degrades to the mirror alone.
Future<void> _defaultSink(List<BbAnalyticsEvent> events) async {
  if (locator.isRegistered<ApiClient>() &&
      locator.isRegistered<SessionRepository>()) {
    await VoiceActionSpine(
      locator<ApiClient>(),
      locator<SessionRepository>(),
    ).flush(events);
  }
  // Mirror, second and non-authoritative — never blocks the spine write.
  for (final BbAnalyticsEvent e in events) {
    unawaited(BbAnalytics.instance.log(e));
  }
}

/// Writes voice-form action signals to the backend event spine (#707):
/// `POST /workers/me/actions/batch`, worker-authed + consent-gated.
class VoiceActionSpine {
  const VoiceActionSpine(this._api, this._session);

  final ApiClient _api;
  final SessionRepository _session;

  /// The `source_surface` every action is tagged with server-side.
  ///
  /// `worker_app`, NOT `voice_form`. `ACTION_SOURCE_SURFACES` is
  /// `["worker_app", "ops_console", "system"]` — it names the APPLICATION that produced
  /// the action, not the screen. `source_surface` is a `z.enum` on a `.strict()` schema,
  /// so `voice_form` made every flush a 400 that this class then swallowed as
  /// best-effort: a spine sink that never wrote to the spine, silently, which is the
  /// exact failure #707 was opened to end.
  ///
  /// Source of truth: `packages/event-schema/src/payloads.ts` (ACTION_SOURCE_SURFACES).
  /// `apps/api/src/actions/worker-app-action-contract.test.ts` READS THIS CONSTANT out of
  /// this file and parses the resulting body with the real schema, because a Dart literal
  /// and a TypeScript enum cannot otherwise disagree loudly — a `MockClient` returns 201
  /// to anything, which is exactly how this shipped green.
  static const String kSourceSurface = 'worker_app';

  /// The screen, which the surface enum has no room for, carried in `context` instead.
  /// A short enum-ish string: primitives only, ≤40-char key, ≤120-char value, and it
  /// passes the server's fail-closed PII guard.
  static const String kScreen = 'voice_form';

  /// The server bounds ONE request at 100 actions and rejects the whole batch above it.
  /// A long session with many replays can exceed that, and a 400 here would drop every
  /// buffered signal at once rather than the excess — so the flush is chunked.
  static const int kMaxPerRequest = 100;

  /// Best-effort batch write. Never throws. A 401/403 (consent revoked / session
  /// gone) is a STOP — dropped, never retried; any other status (the abuse cap,
  /// a 5xx) is likewise dropped, because a rejected telemetry flush must stay
  /// droppable and off the replay button's path.
  Future<void> flush(List<BbAnalyticsEvent> events) async {
    if (events.isEmpty) return;
    final String? token = _session.sessionToken;
    if (token == null) return; // no session → nothing to attribute to
    final List<Map<String, dynamic>> actions =
        events.map(toAction).toList(growable: false);
    for (int i = 0; i < actions.length; i += kMaxPerRequest) {
      final int end =
          i + kMaxPerRequest < actions.length ? i + kMaxPerRequest : actions.length;
      try {
        await _api.recordWorkerActions(
          authToken: token,
          actions: actions.sublist(i, end),
        );
      } on ApiException catch (e) {
        // 401/403 → STOP, and stop for the WHOLE flush: consent is gone or the session
        // is dead, so every remaining chunk would fail the same way.
        if (e.statusCode == 401 || e.statusCode == 403) return;
        // Anything else (the hourly abuse cap, a 5xx) → drop this chunk and keep going.
      } catch (_) {
        // Transport failure — dropped, never surfaced.
      }
    }
  }

  /// One buffered event → the `.strict()` body the server accepts.
  ///
  /// Exposed so a test can assert the SHAPE without a mock HTTP server that would accept
  /// whatever it is handed — which is how `source_surface: 'voice_form'` passed a green
  /// suite while every real request 400'd.
  @visibleForTesting
  static Map<String, dynamic> toAction(BbAnalyticsEvent e) => <String, dynamic>{
        'action_type': e.name,
        'source_surface': kSourceSurface,
        // Ids/enums/counts only — the same PII bar analytics_pii_test holds. The screen
        // rides here because the surface enum is application-level.
        'context': <String, Object>{...e.parameters, 'screen': kScreen},
      };
}
