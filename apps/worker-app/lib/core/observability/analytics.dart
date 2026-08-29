import 'dart:async';

import 'package:firebase_analytics/firebase_analytics.dart';
import 'package:flutter/foundation.dart';

/// One analytics event: a Firebase event [name] plus its PII-FREE [parameters].
///
/// Built as a value so the parameter maps can be ENUMERATED and asserted on in a
/// test ([BbAnalytics.debugAllFunnelEvents]) rather than being buried in call
/// sites where a stray worker id could slip in unnoticed.
@immutable
class BbAnalyticsEvent {
  const BbAnalyticsEvent(this.name, [this.parameters = const <String, Object>{}]);

  /// Firebase event name: `[a-z_]`, ≤40 chars, no `firebase_`/`google_`/`ga_`
  /// prefix (those are reserved and are silently dropped).
  final String name;

  /// Non-identifying dimensions only — counts, booleans and fixed enum-like
  /// tokens. Never a worker id, phone, name, free text, or transcript.
  final Map<String, Object> parameters;
}

/// B7 — Firebase Analytics: screen views + the funnel milestones that mirror the
/// server event spine.
///
/// ## Hard design rules (do not relax)
///
/// 1. **NO PII, ever (BadaBhai invariant #2).** No worker id, phone, name,
///    address, employer, resume text or chat content may appear in an event name
///    or parameter — not even hashed, and not even "just once for debugging".
///    The Firebase app-instance id is the ONLY identifier attached to an event,
///    and Firebase mints it itself. [setUserId] deliberately does not exist here.
/// 2. **Screen names are TEMPLATES, not paths.** `/jobs/detail/<jobId>` is
///    reported as `/jobs/detail/:id` — see [analyticsScreenName]. Ids in a screen
///    name are both an identifier leak and an unusable high-cardinality
///    dimension.
/// 3. **Fail-open, never fatal.** Analytics is telemetry. Every call swallows
///    sync throws and async rejections, so a device that cannot start Firebase
///    (non-GMS / AOSP / no Play Services) simply reports nothing.
/// 4. **Mirrors the spine, never replaces it.** The audit truth is the server
///    `events` table. These milestones exist to see funnel drop-off, so they are
///    deliberately coarse and carry no join key back to a worker.
class BbAnalytics {
  BbAnalytics._();

  static final BbAnalytics instance = BbAnalytics._();

  // ---- Funnel milestones (mirror the server event spine) ----

  /// DPDP consent captured — `consent.accepted` server-side. [purposeCount] is a
  /// COUNT, not the purposes themselves.
  static BbAnalyticsEvent consentDone({required int purposeCount}) =>
      BbAnalyticsEvent('bb_consent_done', <String, Object>{
        'purpose_count': purposeCount,
      });

  /// The interview engine called the profiling chat complete
  /// (`extraction_ready`). [turnCount] is how many turns it took — a number, so
  /// it says something about the funnel without saying anything about the
  /// worker.
  static BbAnalyticsEvent chatWrapUp({required int turnCount}) =>
      BbAnalyticsEvent('bb_chat_wrap_up', <String, Object>{
        'turn_count': turnCount,
      });

  /// A resume was generated and shown.
  static const BbAnalyticsEvent resumeReady =
      BbAnalyticsEvent('bb_resume_ready');

  /// An invite link was handed to the share sheet. NO free-form channel
  /// parameter: the OS does not tell us which app was picked, and inventing a
  /// string field here is exactly where a link (and its code) would eventually
  /// be passed.
  static const BbAnalyticsEvent inviteShared =
      BbAnalyticsEvent('bb_invite_shared');

  /// The worker tapped REPLAY on a voice-form question (#639) — a MANUAL replay
  /// only, NEVER autoplay. A deliberate replay is the cleanest signal the
  /// platform can collect that this worker cannot read the screen, which is
  /// directly actionable; autoplay noise would destroy that signal. [questionIndex]
  /// is a 1-based COUNT — never the question id, key, or text.
  static BbAnalyticsEvent questionAudioPlayed({required int questionIndex}) =>
      BbAnalyticsEvent('question_audio_played', <String, Object>{
        'question_index': questionIndex,
      });

  /// The worker answered a voice-form question BY SPEAKING (#639). [questionIndex]
  /// is a 1-based COUNT — never the transcript, the question, or any id.
  static BbAnalyticsEvent profilingAnswerSpoken({required int questionIndex}) =>
      BbAnalyticsEvent('profiling_answer_spoken', <String, Object>{
        'question_index': questionIndex,
      });

  // ---- Finishing-form funnel (#1315) ----
  //
  // §4.4 makes expected salary mandatory, so the finishing form's completion
  // RATE has to be measurable. Three coarse milestones bracket it — entered on
  // load, a per-page reach so drop-off across the pages is distinguishable, and
  // submitted when both writes land. Indices and counts only: no worker text, no
  // answer, and no id ever rides along.

  /// The finishing form opened (its options loaded). The funnel ENTRY that makes
  /// a completion rate computable against [finishingFormSubmitted].
  static const BbAnalyticsEvent finishingFormEntered =
      BbAnalyticsEvent('bb_finishing_entered');

  /// A finishing-form page came on screen. [pageIndex] is a 0-based COUNT of
  /// which page (languages 0 … history 5), so per-page drop-off (cities /
  /// salary+education / history) is distinguishable — never a page id, key, or
  /// any answer on it.
  static BbAnalyticsEvent finishingPageReached({required int pageIndex}) =>
      BbAnalyticsEvent('bb_finishing_page', <String, Object>{
        'page_index': pageIndex,
      });

  /// Both finishing writes landed — the funnel EXIT that closes the completion
  /// rate.
  static const BbAnalyticsEvent finishingFormSubmitted =
      BbAnalyticsEvent('bb_finishing_submitted');

  /// Every funnel event this app can emit, with representative parameters.
  /// Exists so `test/core/observability/analytics_pii_test.dart` can assert the
  /// no-PII rule over the WHOLE set instead of one example.
  @visibleForTesting
  static List<BbAnalyticsEvent> get debugAllFunnelEvents => <BbAnalyticsEvent>[
        consentDone(purposeCount: 3),
        chatWrapUp(turnCount: 11),
        resumeReady,
        inviteShared,
        questionAudioPlayed(questionIndex: 4),
        profilingAnswerSpoken(questionIndex: 4),
        finishingFormEntered,
        finishingPageReached(pageIndex: 4),
        finishingFormSubmitted,
      ];

  FirebaseAnalytics? _analytics;

  /// Resolve the plugin lazily. Returns null (and stays null-safe) wherever
  /// Firebase is unavailable — `flutter test`, a non-GMS device, a stripped
  /// build.
  FirebaseAnalytics? get _client {
    try {
      return _analytics ??= FirebaseAnalytics.instance;
    } catch (_) {
      return null;
    }
  }

  /// Record a funnel milestone. Never throws.
  Future<void> log(BbAnalyticsEvent event) async {
    _guard(() => _client?.logEvent(
          name: event.name,
          parameters: event.parameters,
        ));
  }

  /// Record a screen view. [location] is a router PATH; it is normalised to a
  /// template by [analyticsScreenName] before it leaves the device, so an id in
  /// the path is never reported.
  Future<void> setScreen(String location) async {
    final String name = analyticsScreenName(location);
    _guard(() => _client?.logScreenView(screenName: name));
  }

  /// Run a call, swallowing both a sync throw and an async rejection. An
  /// unhandled async rejection here would be caught by `CrashReporter`'s
  /// `PlatformDispatcher.onError` and re-reported — telemetry must not generate
  /// crash reports about itself.
  void _guard(Future<void>? Function() body) {
    try {
      final Future<void>? op = body();
      if (op != null) unawaited(op.catchError((Object _) {}));
    } catch (_) {
      // Rule 3 — fail open.
    }
  }
}

/// Path segments that are IDENTIFIERS rather than route names. Any segment that
/// looks like a uuid, a hex token, a number, or an opaque code is collapsed to
/// `:id` so a screen name can never carry one (rule 2).
final RegExp _kIdSegment = RegExp(
  r'^(?:[0-9]+|[0-9a-fA-F]{8,}|[0-9a-fA-F]{8}-[0-9a-fA-F-]+)$',
);

/// Normalises a router location to a stable, id-free screen name.
///
/// `/jobs/detail/9f1c…` → `/jobs/detail/:id`, `/i/abcdef012345` → `/i/:id`,
/// `/resume` → `/resume`, `''` → `/`. Query and fragment are dropped whole:
/// they are the most likely place for something identifying to ride along.
String analyticsScreenName(String location) {
  final String path = location.split('?').first.split('#').first;
  final List<String> segments =
      path.split('/').where((String s) => s.isNotEmpty).toList();
  if (segments.isEmpty) return '/';
  final Iterable<String> masked = segments
      .map((String s) => _kIdSegment.hasMatch(s) ? ':id' : s);
  return '/${masked.join('/')}';
}
