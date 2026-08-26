/// Typed response models for the BadaBhai API.
///
/// These mirror the JSON shapes returned by the NestJS API (see apps/api).
/// JSON is snake_case; Dart fields are camelCase. Parsing is defensive so a
/// missing optional field can't crash the worker flow.
///
/// The value models are immutable [Equatable] (const ctors + value equality) so
/// they compose into BLoC states without breaking emit de-duplication. The two
/// exception types stay plain (they're thrown, not held in state).
library;

import 'package:equatable/equatable.dart';

import 'occupation_label.dart';

/// Thrown when the API returns a non-2xx response.
class ApiException implements Exception {
  ApiException(this.statusCode, this.message, {this.body});

  final int statusCode;
  final String message;

  /// The DECODED JSON body of the error response, or null when the body was
  /// empty / not a JSON object. ADDITIVE and optional — every existing
  /// `ApiException(status, message)` call keeps compiling and reads `null` here.
  ///
  /// Carries structured error detail the [message] alone would flatten — e.g.
  /// the profiling stale-answer 409's `stale_reason` (#806), read to decide
  /// whether a re-attach's spoken signal actually landed, without a second GET.
  /// Never log it: an error body may echo request fields.
  final Map<String, dynamic>? body;

  @override
  String toString() => 'ApiException($statusCode): $message';
}

/// Thrown when an async profile-extraction job does not finish within the
/// client's bounded poll budget. The job may still complete server-side; the
/// caller can offer a retry.
class ProfileExtractionTimeout implements Exception {
  ProfileExtractionTimeout(this.aiJobId);

  final String aiJobId;

  @override
  String toString() =>
      'ProfileExtractionTimeout: job $aiJobId did not complete in time';
}

/// One job card the worker swipes on. Result item of GET /feed.
///
/// PII-free by contract: coarse [tradeKey] / [title] / [city] / [area], the
/// job's experience window in YEAR COUNTS, and — per the ADR-0024 addendum
/// (2026-07-16) — the ADDITIVE nullable [payMin] / [payMax] / [shift]. The API
/// still returns NO employer name (employer names are PII, CLAUDE.md §2), so
/// this model carries nothing employer-shaped. Pay bands / year counts / the
/// coarse shift enum are PII-free by the schema's own rule
/// (`packages/db/src/schema.ts` jobs: "PII-FREE: pay bands / year counts / a
/// coarse timing enum" — never an employer, never a worker identity). The old
/// wire shape (no pay/shift keys) still parses — the three keys are additive
/// and land on null. [rank] is the 1-based seed display position (not a
/// relevance rank).
class FeedItem extends Equatable {
  const FeedItem({
    required this.jobId,
    required this.tradeKey,
    required this.title,
    required this.city,
    required this.area,
    required this.rank,
    this.minExperienceYears,
    this.maxExperienceYears,
    this.payMin,
    this.payMax,
    this.shift,
    this.viaRelated = false,
    this.matchedSkillLabel,
  });

  final String jobId;
  final String tradeKey;
  final String title;
  final String city;

  /// Coarse area/locality bucket. Nullable — not every job has one.
  final String? area;

  /// Experience window the job targets, in years — passed through HONESTLY by
  /// the API, nulls included: a null [minExperienceYears] means "no floor" and a
  /// null [maxExperienceYears] means "open-ended". Read the window as
  /// [min ?? 0, max ?? infinity]; do NOT coerce either null to 0 (that would
  /// invent a floor the employer never set). See `jobMatchesExperience` in
  /// features/swipe/domain/job_filter.dart for the matching rule.
  final int? minExperienceYears;
  final int? maxExperienceYears;

  /// Monthly pay band in ₹ (ADR-0024 addendum, 2026-07-16) — nullable ints,
  /// passed through honestly: a null bound means the employer never stated it,
  /// and the card then hides that part rather than inventing a wage.
  final int? payMin;
  final int? payMax;

  /// Coarse shift enum as the RAW wire string ('day' | 'night' | 'rotational'),
  /// or null when unstated. Display mapping (and the hide-on-unknown rule)
  /// lives in core/util/job_display.dart.
  final String? shift;

  /// 1-based seed display position the card was shown at. Sent back on apply so
  /// the server can record the position the decision was taken from.
  final int rank;

  /// Matching V1 / E18 (ADR-0036): this job reached the worker through a
  /// CURATED RELATED skill, not one he actually listed.
  ///
  /// ADDITIVE and defaulted false — the legacy feed does not send it, and the
  /// V1 card is a strict superset of the legacy one, so an older build ignores
  /// it and a newer build reading a legacy response simply sees `false`.
  final bool viaRelated;

  /// Matching V1 / E18: the skill that actually earned the match, for the
  /// card's "aapke `<skill>` ke kaam se milta-julta hai" line. A closed-set
  /// label, never free text. Null on the legacy feed and whenever the server
  /// could not name it — the card then hides the line rather than inventing a
  /// reason for why the job is being shown.
  final String? matchedSkillLabel;

  factory FeedItem.fromJson(Map<String, dynamic> json) => FeedItem(
        jobId: json['job_id'] as String,
        tradeKey: json['trade_key'] as String? ?? '',
        title: json['title'] as String? ?? '',
        city: json['city'] as String? ?? '',
        area: json['area'] as String?,
        // Absent key and explicit null both land on null — "no bound stated".
        minExperienceYears: (json['min_experience_years'] as num?)?.toInt(),
        maxExperienceYears: (json['max_experience_years'] as num?)?.toInt(),
        payMin: (json['pay_min'] as num?)?.toInt(),
        payMax: (json['pay_max'] as num?)?.toInt(),
        shift: json['shift'] as String?,
        rank: (json['rank'] as num?)?.toInt() ?? 0,
        // Absent (legacy feed) reads as false / null — never as "related".
        viaRelated: json['via_related'] as bool? ?? false,
        matchedSkillLabel: json['matched_skill_label'] as String?,
      );

  @override
  List<Object?> get props => <Object?>[
        jobId,
        tradeKey,
        title,
        city,
        area,
        minExperienceYears,
        maxExperienceYears,
        payMin,
        payMax,
        shift,
        rank,
        viaRelated,
        matchedSkillLabel,
      ];
}

/// A worker's apply/skip decision row from `GET /workers/me/applications` (the
/// "Applied jobs" screen filters to `action == 'applied'`). Coarse, PII-free
/// fields only — exactly the projection the ops service already returns. Parsing
/// is defensive: missing optionals → null; a missing/bad date → epoch (never
/// crashes).
class AppliedJob extends Equatable {
  const AppliedJob({
    required this.jobId,
    required this.tradeKey,
    required this.title,
    required this.city,
    required this.area,
    required this.action,
    required this.reason,
    required this.sourceSurface,
    required this.rank,
    required this.createdAt,
    required this.updatedAt,
    this.matchedSkillLabel,
  });

  final String jobId;

  /// One of the 15 alpha trades — kept as a plain String (no enum). INTERNAL key
  /// by contract; under MATCH_V1 it is a raw `mskill_*` id, so it must NEVER be
  /// shown to a worker — render [matchedSkillLabel] instead (#1027).
  final String tradeKey;

  /// Human, display-safe matched-skill name ("MIG Welder") when the feed carries
  /// one; null otherwise. The one field the subtitle may show.
  final String? matchedSkillLabel;
  final String title;
  final String city;

  /// Coarse locality bucket. Nullable — not every job has one.
  final String? area;

  /// 'applied' | 'skipped' — the list mixes both; the screen shows only
  /// 'applied' (matches the `ApplicationAction` enum on the API).
  final String action;

  /// Coarse skip reason enum, or null for an apply. Nullable.
  final String? reason;

  /// Where the decision was taken: 'feed' | 'search' | 'share' | 'other'.
  final String sourceSurface;

  /// 1-based feed position the decision was taken from. Nullable.
  final int? rank;

  final DateTime createdAt;
  final DateTime updatedAt;

  static DateTime _date(Object? v) =>
      DateTime.tryParse(v as String? ?? '') ??
      DateTime.fromMillisecondsSinceEpoch(0);

  factory AppliedJob.fromJson(Map<String, dynamic> json) => AppliedJob(
        jobId: json['job_id'] as String? ?? '',
        tradeKey: json['trade_key'] as String? ?? '',
        title: json['title'] as String? ?? '',
        city: json['city'] as String? ?? '',
        area: json['area'] as String?,
        action: json['action'] as String? ?? '',
        reason: json['reason'] as String?,
        sourceSurface: json['source_surface'] as String? ?? 'other',
        rank: (json['rank'] as num?)?.toInt(),
        createdAt: _date(json['created_at']),
        updatedAt: _date(json['updated_at']),
        matchedSkillLabel: json['matched_skill_label'] as String?,
      );

  @override
  List<Object?> get props => <Object?>[
        jobId,
        tradeKey,
        title,
        city,
        area,
        action,
        reason,
        sourceSurface,
        rank,
        createdAt,
        updatedAt,
        matchedSkillLabel,
      ];
}

/// One worker Alerts row (GET /workers/me/notifications). PII-FREE by contract:
/// only an opaque event id, a coarse [type], faceless server copy, and a timestamp
/// — never an employer, pay, name, or phone. [type] is one of `resume_ready`,
/// `resume_updated`, `profile_ready`, `voice_processed`, `security`.
class WorkerNotification extends Equatable {
  const WorkerNotification({
    required this.id,
    required this.type,
    required this.title,
    required this.body,
    required this.createdAt,
    this.read = false,
  });

  final String id;
  final String type;
  final String title;
  final String body;
  final DateTime createdAt;

  /// Server-computed read flag (cross-device: derived from the worker's read
  /// watermark on the events spine). ABSENT on an older API build → defaults
  /// false, so the client falls back to its local optimistic read set — additive,
  /// never a regression. See [markNotificationsRead].
  final bool read;

  factory WorkerNotification.fromJson(Map<String, dynamic> json) =>
      WorkerNotification(
        id: json['id'] as String? ?? '',
        type: json['type'] as String? ?? '',
        title: json['title'] as String? ?? '',
        body: json['body'] as String? ?? '',
        createdAt: DateTime.tryParse(json['created_at'] as String? ?? '') ??
            DateTime.fromMillisecondsSinceEpoch(0),
        read: json['read'] as bool? ?? false,
      );

  @override
  List<Object?> get props => <Object?>[id, type, title, body, createdAt, read];
}

/// Result of POST /applications/:jobId/apply.
class ApplyResult extends Equatable {
  const ApplyResult({
    required this.ok,
    required this.applicationId,
    required this.action,
  });

  final bool ok;
  final String applicationId;
  final String action;

  factory ApplyResult.fromJson(Map<String, dynamic> json) => ApplyResult(
        ok: json['ok'] as bool? ?? false,
        applicationId: json['application_id'] as String? ?? '',
        action: json['action'] as String? ?? 'applied',
      );

  @override
  List<Object?> get props => <Object?>[ok, applicationId, action];
}

/// Result of POST /applications/:jobId/skip.
class SkipResult extends Equatable {
  const SkipResult({
    required this.ok,
    required this.applicationId,
    required this.action,
  });

  final bool ok;
  final String applicationId;
  final String action;

  factory SkipResult.fromJson(Map<String, dynamic> json) => SkipResult(
        ok: json['ok'] as bool? ?? false,
        applicationId: json['application_id'] as String? ?? '',
        action: json['action'] as String? ?? 'skipped',
      );

  @override
  List<Object?> get props => <Object?>[ok, applicationId, action];
}

/// Result of POST /chat/session.
///
/// [openingText] is the SERVER-SERVED one-shot opener — the engine's own copy,
/// inviting the worker to answer every topic in one message. It is null whenever
/// the API omits the key, which is the normal case in three situations:
/// CHAT_ONE_SHOT_OPENER_ENABLED is off, the AI service was unreachable, or the
/// API build predates the field. Null means "render the client's own
/// `kChatOpeningText`", so an older API and a newer app still agree.
///
/// BLANK IS NULL. An empty or whitespace-only string is normalised away rather
/// than carried through: it would otherwise replace the client's opener with an
/// empty first bubble — a chat that greets the worker with nothing at all.
class ChatSessionStart extends Equatable {
  const ChatSessionStart({required this.sessionId, this.openingText});

  final String sessionId;
  final String? openingText;

  factory ChatSessionStart.fromJson(Map<String, dynamic> json) {
    final Object? raw = json['opening_text'];
    final String? text = raw is String && raw.trim().isNotEmpty ? raw : null;
    return ChatSessionStart(
      sessionId: json['session_id'] as String,
      openingText: text,
    );
  }

  @override
  List<Object?> get props => <Object?>[sessionId, openingText];
}

/// How far through the pinned question pack the worker is (`progress`, OIE
/// Phase 8 / #649). This became knowable only with the deterministic interview:
/// the old model invented each question as it went, so nothing knew how many
/// were left. A visible finish line is the single strongest completion-rate lever
/// for low-literacy users.
class ChatProgress extends Equatable {
  const ChatProgress({required this.answered, required this.total});

  final int answered;
  final int total;

  /// 0..1, clamped and guarded against a zero/absurd total.
  double get fraction =>
      total <= 0 ? 0 : (answered / total).clamp(0.0, 1.0).toDouble();

  /// Parses `{ answered, total }`. Returns null unless BOTH are sane ints and
  /// `total > 0` — a malformed or empty progress object must hide the bar, never
  /// throw the whole reply away (#371 discipline).
  static ChatProgress? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final Object? a = raw['answered'];
    final Object? t = raw['total'];
    if (a is! int || t is! int || t <= 0 || a < 0) return null;
    return ChatProgress(answered: a, total: t);
  }

  @override
  List<Object?> get props => <Object?>[answered, total];
}

/// What KIND of turn this is (`question_kind`, OIE Phase 8 / #649). Only
/// [disambiguate] changes the UI — it renders a vertical single-select instead
/// of the horizontal chip scroller. Unknown/absent → [ask] (today's behaviour).
enum ChatQuestionKind {
  ask,
  disambiguate,
  clarify,
  close;

  static ChatQuestionKind parse(Object? raw) {
    switch (raw) {
      case 'disambiguate':
        return ChatQuestionKind.disambiguate;
      case 'clarify':
        return ChatQuestionKind.clarify;
      case 'close':
        return ChatQuestionKind.close;
      default:
        return ChatQuestionKind.ask;
    }
  }
}

/// Whether the worker may TYPE this turn, or must answer from the offered
/// options (`input_mode`, default [ChatInputMode.text]).
///
/// [optionsOnly] turns — the LLM interview's experience Yes/No gate and the
/// closed-set model turns, both behind `CHAT_LLM_INTERVIEW_ENABLED` — mean the
/// chips are the ONLY answer path, so the composer is suppressed: a two-tap loop
/// should not be a free-text answer a parser has to interpret (#770).
///
/// Unknown/absent -> [text], and that is the safe direction. A parse miss can
/// only RESTORE the keyboard, never hide it — the worker is never trapped behind
/// a composer that a garbled field turned off. The server also still ACCEPTS
/// typed text on an `options_only` turn, so an un-updated build that ignores this
/// field keeps working; the field is a client instruction, not a wire contract.
enum ChatInputMode {
  text,
  optionsOnly;

  static ChatInputMode parse(Object? raw) =>
      raw == 'options_only' ? ChatInputMode.optionsOnly : ChatInputMode.text;
}

/// The server's ADVISORY prediction of the NEXT chat turn for one option tap
/// (`lookahead` entry, #761). Rendered OPTIMISTICALLY the instant a chip is
/// tapped so a 2G worker sees the next prompt + chips + progress without waiting
/// the round trip — but it is NEVER an answer of record: the submit still
/// happens byte-identically and the real [ChatReply] reconciles/overrides this.
///
/// Parsed DEFENSIVELY (the #371 discipline): [fromJson] returns null on anything
/// that is not a Map with a usable [promptText], and drops garbage options — a
/// malformed prediction must yield "no prediction" (fall back to the round trip),
/// never throw the whole reply away.
class PredictedQuestion extends Equatable {
  const PredictedQuestion({
    this.questionKey,
    this.questionKind = ChatQuestionKind.ask,
    required this.promptText,
    this.whyText,
    this.answerType,
    this.options = const <String>[],
    this.progress,
  });

  /// The Resume Field Set id the predicted turn is asking about, or null on a
  /// `close` prediction (`question_kind:"close"` — [promptText] is then the
  /// closing line and there is no next question).
  final String? questionKey;

  /// The predicted turn's kind. `close` marks the interview ending on this tap.
  final ChatQuestionKind questionKind;

  /// The predicted prompt (or the closing line on a `close` prediction).
  final String promptText;

  /// Predicted "why are we asking" copy. No chat sink today — parsed, unused.
  final String? whyText;

  /// The predicted answer_type. No chat sink today — parsed, unused.
  final String? answerType;

  /// Predicted tap-to-answer chips as LABEL strings (chat chips submit the
  /// label, which on chat is the answer of record). Each wire option is an
  /// object `{option_key,label_text,is_none_of_above}`; only its `label_text`
  /// survives, garbage entries are dropped.
  final List<String> options;

  /// Predicted pack progress so the completion bar moves on the tap too, or null.
  final ChatProgress? progress;

  static PredictedQuestion? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final Object? prompt = raw['prompt_text'];
    // No usable prompt ⇒ no prediction. An empty/whitespace line would render an
    // empty bubble, which is worse than falling back to the round trip.
    if (prompt is! String || prompt.trim().isEmpty) return null;
    final Object? rawOptions = raw['options'];
    final List<String> options = rawOptions is List
        ? rawOptions
            .whereType<Map>()
            .map((Map<dynamic, dynamic> o) => o['label_text'])
            .whereType<String>()
            .toList(growable: false)
        : const <String>[];
    return PredictedQuestion(
      // `is String` not a cast (#371) — a non-string key from a future contract
      // change must not throw; it just reads as a `close`-shaped null key.
      questionKey: raw['question_key'] is String ? raw['question_key'] as String : null,
      questionKind: ChatQuestionKind.parse(raw['question_kind']),
      promptText: prompt,
      whyText: raw['why_text'] is String ? raw['why_text'] as String : null,
      answerType: raw['answer_type'] is String ? raw['answer_type'] as String : null,
      options: options,
      progress: ChatProgress.fromJson(raw['progress']),
    );
  }

  @override
  List<Object?> get props => <Object?>[
        questionKey,
        questionKind,
        promptText,
        whyText,
        answerType,
        options,
        progress,
      ];
}

/// One tap-to-answer option for a chat turn (`suggested_options` entry, #761's
/// lookahead-key companion).
///
/// Served ALONGSIDE — never instead of — `suggested_followups`: the followups
/// (label strings) stay authoritative for what a chip DISPLAYS and SUBMITS, and
/// this object only adds the STABLE [optionKey] the reply's `lookahead` map is
/// keyed by. On the LLM chat the display [labelText] is NOT the lookahead key
/// (e.g. "Salad bar attendant" vs a stable id), so a chip tapped by label missed
/// its prediction and the optimistic render silently never fired; carrying the
/// key lets the client index `lookahead` correctly WHILE still submitting the
/// label byte-identically.
///
/// PII-FREE by contract: a closed-set key + a display label + a flag. Parsed
/// DEFENSIVELY (#371): [fromJson] returns null on a non-map or a garbage entry —
/// a bad option is dropped by the caller, never thrown out of the whole reply.
class ChatOption extends Equatable {
  const ChatOption({
    required this.optionKey,
    required this.labelText,
    this.isNoneOfAbove = false,
  });

  /// The stable key the turn's `lookahead` map is keyed by. Used ONLY to index
  /// the optimistic prediction — it is NEVER submitted (the submit stays
  /// [labelText]).
  final String optionKey;

  /// What the chip DISPLAYS and what the worker SUBMITS as the answer of record
  /// — byte-identical to a `suggested_followups` entry.
  final String labelText;

  /// The disambiguation/decline "none of these" escape. Its prediction is keyed
  /// `'__declined'` in the `lookahead` map, not by [optionKey].
  final bool isNoneOfAbove;

  /// Parses one `{option_key, label_text, is_none_of_above}` object. Returns null
  /// on a non-map, or when either string field is missing/blank — a malformed
  /// option is dropped (the caller keeps the usable ones), never thrown (#371).
  static ChatOption? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final Object? key = raw['option_key'];
    final Object? label = raw['label_text'];
    if (key is! String || key.isEmpty) return null;
    if (label is! String || label.isEmpty) return null;
    return ChatOption(
      optionKey: key,
      labelText: label,
      // `is bool` not a cast (#371): a 0/1 or a string from a future contract
      // change must not throw the option — it just reads as "not the escape".
      isNoneOfAbove:
          raw['is_none_of_above'] is bool ? raw['is_none_of_above'] as bool : false,
    );
  }

  @override
  List<Object?> get props => <Object?>[optionKey, labelText, isNoneOfAbove];
}

/// Result of POST /chat/message.
class ChatReply extends Equatable {
  const ChatReply({
    required this.reply,
    required this.blocked,
    required this.isMock,
    required this.suggestedFollowups,
    this.suggestedOptions = const <ChatOption>[],
    this.extractionReady = false,
    this.askedQuestionId,
    this.unansweredEssentials = const <String>[],
    this.sessionEnded = false,
    this.progress,
    this.questionKind = ChatQuestionKind.ask,
    this.inputMode = ChatInputMode.text,
    this.occupationLabel,
    this.ttsText,
    this.lookahead = const <String, PredictedQuestion?>{},
  });

  final String reply;
  final bool blocked;
  final bool isMock;
  final List<String> suggestedFollowups;

  /// The tap-to-answer options for THIS turn (`suggested_options`, #761), served
  /// ALONGSIDE [suggestedFollowups]. Each carries the stable `option_key` the
  /// [lookahead] map is keyed by, so a tapped chip can be indexed against its
  /// prediction even when the display label differs from that key (the LLM chat).
  ///
  /// ADDITIVE and defaulted `[]`: a deterministic turn or an older API build sends
  /// none, and the client falls back to the label-keyed [suggestedFollowups] path
  /// (where label == key), so nothing changes for those turns.
  final List<ChatOption> suggestedOptions;

  /// The interview engine's completeness decision for THIS turn (#421): true
  /// once it has enough answers to extract a profile.
  ///
  /// DEFAULT `false` when the field is absent/null (an older API build, a
  /// truncated body, a future contract change). Rationale: `true` would make a
  /// parse miss silently REMOVE the gate and restore the exact bug this fixes —
  /// an unnoticeable failure. `false` only makes the client show its
  /// keep-talking nudge; the "build my profile" CTA stays TAPPABLE either way
  /// (see [ChatProfilingScreen]), so a false negative costs the worker one
  /// extra confirmation tap and can never trap them in the chat.
  final bool extractionReady;

  /// The Resume Field Set id this turn is asking about (`asked_question_id`, e.g.
  /// 'trade', 'skills', 'salary_expected') — `null` on the wrap-up turn. The
  /// `suggested_followups` chips are the tap-to-answer options for exactly this
  /// question. Additive/optional: absent on an older API build. The client does
  /// NOT echo it back (the POST body stays `{session_id, text}`); it is a
  /// question-attribution signal only, and nothing in the app matches on its value.
  ///
  /// These used to be question-bank ids ('q_role', 'q_machines') chosen by a
  /// deterministic engine. That engine is gone — the model asks its own questions and
  /// reports which field it was after — so the VALUES changed while the field did not.
  final String? askedQuestionId;

  /// REQUIRED Resume Field Set ids the worker has NOT answered yet
  /// (`unanswered_essentials`) — field ids only, never PII.
  ///
  /// TRUST ONLY WHEN [blocked] IS FALSE. A blocked turn (pseudonymize
  /// fail-closed) carries no interview state and the server degrades this to
  /// `[]`, which means "unknown", NOT "complete" — reading it on a blocked turn
  /// would falsely claim the profile is done. Empty on a non-blocked turn means
  /// genuinely complete. Distinct from [extractionReady]: this is the
  /// completeness detail, [extractionReady] is the CTA gate.
  final List<String> unansweredEssentials;

  /// This session is FINISHED and will accept no further messages (`session_ended`).
  ///
  /// The server flushes the whole interview in one transaction at completion and marks
  /// the session `ended`; every later POST gets a closing line instead of a turn. The
  /// app caches its session id in memory, so without this signal it would keep posting
  /// into a dead session for the rest of the process — silently breaking the "start a
  /// fresh chat" button on the Resume and Profile tabs, and the "Chat pe wapas jaayein"
  /// the profile preview offers when a profile comes out thin. The worker would be told
  /// to go say more, and be unable to.
  ///
  /// DEFAULT `false` when absent, and that is the safe direction: a parse miss leaves
  /// the session cached, which is exactly today's behaviour. `true` on a miss would
  /// throw away a live session mid-interview.
  final bool sessionEnded;

  /// How far through the pinned pack the worker is (`progress`), or null when no
  /// pack has resolved yet / no turn happened. Drives the progress bar (#649).
  final ChatProgress? progress;

  /// What kind of turn this is (`question_kind`, default [ChatQuestionKind.ask]).
  /// Only [ChatQuestionKind.disambiguate] changes the UI (#649).
  final ChatQuestionKind questionKind;

  /// Whether the composer is offered this turn (`input_mode`, default
  /// [ChatInputMode.text]). [ChatInputMode.optionsOnly] hides it and leaves the
  /// chips as the only answer path (#770).
  final ChatInputMode inputMode;

  /// The worker's trade in THEIR OWN vernacular once retrieval pins it
  /// (`occupation_label`, e.g. "darzi", never the English catalogue title), or
  /// null before it pins. The trust moment of the interview (#649).
  final String? occupationLabel;

  /// The Devanagari rendering of [reply] for read-aloud (`tts_text`, #896) — the
  /// SAME content as the shown, romanized [reply], written in the native script
  /// so the on-device hi-IN voice pronounces the Hindi correctly (romanized
  /// Hindi is read as gibberish by every TTS voice). It is NEVER displayed and
  /// NEVER echoed back (the POST body is unchanged); only the SPOKEN string uses it.
  ///
  /// ADDITIVE / optional: null when absent, null or blank (an older API build).
  /// Read-aloud then falls back to speaking [reply], exactly as before this field
  /// existed — so an old server is unchanged behaviour.
  final String? ttsText;

  /// ADVISORY next-turn predictions keyed by the tapped option (#761), plus the
  /// decline/escape chip under `'__declined'`. Each value is what THIS turn's
  /// chips are predicted to lead to, so the client can render it optimistically
  /// on the tap and reconcile when the real reply lands.
  ///
  /// ABSENT / EMPTY is the normal case and NOT an error: the server omits it on
  /// close, disambiguation, clarify, free-text and multi_select turns, and any
  /// build that predates the field. A missing key means "no prediction for that
  /// tap — wait for the round trip", which is exactly today's behaviour.
  final Map<String, PredictedQuestion?> lookahead;

  /// Parses the `lookahead` map defensively: a non-map, a non-string key, or a
  /// malformed entry is dropped (never thrown), so a bad prediction can never
  /// take down the whole reply (#371). Absent ⇒ empty map.
  static Map<String, PredictedQuestion?> _parseLookahead(Object? raw) {
    if (raw is! Map) return const <String, PredictedQuestion?>{};
    final Map<String, PredictedQuestion?> out = <String, PredictedQuestion?>{};
    raw.forEach((Object? key, Object? value) {
      if (key is! String) return;
      final PredictedQuestion? predicted = PredictedQuestion.fromJson(value);
      if (predicted != null) out[key] = predicted;
    });
    return out;
  }

  factory ChatReply.fromJson(Map<String, dynamic> json) => ChatReply(
        reply: json['reply'] as String? ?? '',
        blocked: json['blocked'] as bool? ?? false,
        isMock: json['is_mock'] as bool? ?? false,
        // Absent / null / NON-BOOL -> false. `is bool` rather than a cast for
        // the #371 reason: a cast on an unexpected type (a 0/1, a string)
        // throws out of parsing and loses bada bhai's whole reply over one
        // progress flag.
        extractionReady:
            json['extraction_ready'] is bool ? json['extraction_ready'] as bool : false,
        // Absent / null / non-string -> null (older API build / truncated body).
        askedQuestionId:
            json['asked_question_id'] is String ? json['asked_question_id'] as String : null,
        // #371: whereType, not `map((e) => e as String)` — a single non-string
        // entry (a null, a number, an object from a future contract change) used
        // to throw a raw TypeError out of parsing and take down the whole reply,
        // losing bada bhai's answer over a cosmetic chip. Keep the usable
        // suggestions and drop the rest.
        suggestedFollowups:
            (json['suggested_followups'] as List<dynamic>?)?.whereType<String>().toList() ??
                <String>[],
        // #761 — served ALONGSIDE the followups above, not instead of them. Same
        // #371 discipline: a non-list, or a garbage entry, is dropped and the
        // reply survives — a bad option must never lose bada bhai's message.
        suggestedOptions: json['suggested_options'] is List
            ? (json['suggested_options'] as List<dynamic>)
                .map<ChatOption?>(ChatOption.fromJson)
                .whereType<ChatOption>()
                .toList(growable: false)
            : const <ChatOption>[],
        // Same defensive parse as the chips: a malformed entry is dropped, never
        // thrown out of the whole reply. Absent -> [] ("unknown"; only meaningful
        // when `blocked` is false — see the field doc).
        unansweredEssentials:
            (json['unanswered_essentials'] as List<dynamic>?)?.whereType<String>().toList() ??
                const <String>[],
        // `is bool` not a cast, for the same #371 reason as extractionReady: a 0/1 or a
        // string from a future contract change must not throw the whole reply away.
        sessionEnded: json['session_ended'] is bool ? json['session_ended'] as bool : false,
        // Absent / malformed -> null (hides the bar), never thrown (#371).
        progress: ChatProgress.fromJson(json['progress']),
        // Absent / unknown -> ask (today's behaviour).
        questionKind: ChatQuestionKind.parse(json['question_kind']),
        // Absent / unknown -> text (composer stays; never trap the worker).
        inputMode: ChatInputMode.parse(json['input_mode']),
        // Absent / null / non-string -> null (not yet pinned). ALSO null for the
        // universal-fallback family label ("सामान्य" / "General"): it is not a
        // real trade, so the trust pill must not show it (see occupation_label.dart).
        occupationLabel: displayableOccupationLabel(
          json['occupation_label'] is String
              ? json['occupation_label'] as String
              : null,
        ),
        // #896 — the Devanagari read-aloud string. Absent / null / non-string /
        // BLANK -> null (an older API build), and read-aloud then speaks the
        // romanized `reply` unchanged. Never thrown (#371): a bad value must not
        // lose bada bhai's whole reply over a cosmetic pronunciation aid.
        ttsText: json['tts_text'] is String &&
                (json['tts_text'] as String).trim().isNotEmpty
            ? json['tts_text'] as String
            : null,
        // Absent / malformed -> empty map ("no predictions"), never thrown (#371).
        lookahead: _parseLookahead(json['lookahead']),
      );

  @override
  List<Object?> get props => <Object?>[
        reply,
        blocked,
        isMock,
        suggestedFollowups,
        suggestedOptions,
        extractionReady,
        askedQuestionId,
        unansweredEssentials,
        sessionEnded,
        progress,
        questionKind,
        inputMode,
        occupationLabel,
        ttsText,
        lookahead,
      ];
}

/// One row of GET /chat/sessions/:sessionId/messages (#502 transcript
/// hydration). The persisted transcript, oldest-first, so a worker whose
/// in-memory chat was lost — a >5min background re-lock rebuilds [ChatBloc] with
/// only its opener bubble — can have their earlier turns REDRAWN from the server.
///
/// Narrow by contract: three fields, nothing else (the API deliberately omits
/// ids / worker_id / message_type / metadata). PII posture: [bodyText] is worker
/// content (an inbound answer) or bada-bhai copy — the SAME data already on
/// screen live — never logged.
class SessionMessage extends Equatable {
  const SessionMessage({
    required this.direction,
    required this.bodyText,
    required this.createdAt,
    this.ttsText,
  });

  /// 'inbound' (the worker) | 'outbound' (bada bhai). Kept as the RAW wire
  /// string and decoded tolerantly ([fromWorker]) so an unexpected value never
  /// crashes hydration.
  final String direction;

  /// The message text. NULLABLE by construction: a voice row exists before its
  /// transcript lands (`body_text` still null). An OUTBOUND row carries the
  /// literal `{{worker_name}}` placeholder — interpolation happens only in the
  /// live POST /chat/message reply — so the client strips it at render time.
  final String? bodyText;

  final String createdAt;

  /// The Devanagari read-aloud rendering of [bodyText] for an OUTBOUND (bada
  /// bhai) row (`tts_text`, #896), or null — absent on an inbound row, an older
  /// API build, or a voice row before its transcript lands. Rides only the
  /// hydrated bot bubble; read-aloud falls back to [bodyText] when null.
  final String? ttsText;

  /// True for the worker's own (inbound) messages. Anything that is not
  /// explicitly 'inbound' is treated as a bada-bhai bubble — the tolerant
  /// default the contract's enum note asks for.
  bool get fromWorker => direction == 'inbound';

  factory SessionMessage.fromJson(Map<String, dynamic> json) => SessionMessage(
        direction: json['direction'] as String? ?? 'outbound',
        bodyText: json['body_text'] as String?,
        createdAt: json['created_at'] as String? ?? '',
        // #896 — additive: absent / null / blank -> null (read-aloud falls back
        // to the romanized body_text).
        ttsText: json['tts_text'] is String &&
                (json['tts_text'] as String).trim().isNotEmpty
            ? json['tts_text'] as String
            : null,
      );

  @override
  List<Object?> get props => <Object?>[direction, bodyText, createdAt, ttsText];
}

/// Result of POST /profile/extract.
///
/// Profile extraction is now asynchronous: the API enqueues a background job
/// (BullMQ) and returns 202 with the job id. The client polls
/// GET /workers/me/ai-jobs/{id}
/// (see [AiJob]) until the job completes and yields a profile id.
class EnqueueResult extends Equatable {
  const EnqueueResult({
    required this.aiJobId,
    required this.status,
  });

  final String aiJobId;
  final String status;

  factory EnqueueResult.fromJson(Map<String, dynamic> json) => EnqueueResult(
        aiJobId: json['ai_job_id'] as String,
        status: json['status'] as String? ?? 'queued',
      );

  @override
  List<Object?> get props => <Object?>[aiJobId, status];
}

/// One async AI job. Result of `GET /workers/me/ai-jobs/{id}` — worker-scoped,
/// bearer-authenticated (WorkerAuthGuard + ConsentGuard), and scoped to the OWNER
/// server-side, so a job belonging to another worker answers 404.
///
/// The wire shape is deliberately three flat keys — `status`, `profile_id`,
/// `voice_note_id`. The ops route `GET /ai-jobs/{id}` returns much more (model
/// name, `real_call`, token counts, `cost_inr`, the raw `error_message`); none of
/// that is a worker's business and none of it is sent here. Do not re-add fields
/// to this model without a server change: parsing something the server never
/// sends is how the previous "NO auth" claim on this doc survived for months.
///
/// [status] moves queued -> running -> completed | failed. On a completed
/// PROFILE-extraction job [profileId] is non-null; on a completed TRANSCRIPTION
/// job [voiceNoteId] is non-null. Transcription returns only the voice-note id —
/// NOT the transcript text (there is no route that returns the transcript body;
/// see the A2-storage blocker), so this model exposes the reference only.
///
/// There is no `errorMessage`: the server withholds it (on an outage it can carry
/// an infrastructure host:port), and the app never rendered it anyway —
/// `failure_mapper.dart` maps on status code alone. A failure is [isFailed].
class AiJob extends Equatable {
  const AiJob({
    required this.status,
    required this.profileId,
    this.voiceNoteId,
  });

  final String status;
  final String? profileId;

  /// Set from `voice_note_id` when this is a completed transcription job. Null
  /// for profile-extraction jobs.
  final String? voiceNoteId;

  bool get isCompleted => status == 'completed';
  bool get isFailed => status == 'failed';

  /// True once the job has reached a terminal state (completed OR failed) — the
  /// poll loop stops here.
  bool get isTerminal => isCompleted || isFailed;

  factory AiJob.fromJson(Map<String, dynamic> json) => AiJob(
        status: json['status'] as String? ?? 'queued',
        profileId: json['profile_id'] as String?,
        voiceNoteId: json['voice_note_id'] as String?,
      );

  @override
  List<Object?> get props => <Object?>[status, profileId, voiceNoteId];
}

/// Result of POST /voice/upload (A2a). Registers an already-stored audio clip so
/// it can be transcribed. PII-FREE: the clip is referenced by an opaque
/// [voiceNoteId] and a server-side [storagePath] — no audio bytes, transcript, or
/// worker identity live here.
class VoiceUploadResult extends Equatable {
  const VoiceUploadResult({
    required this.voiceNoteId,
    required this.durationSeconds,
  });

  final String voiceNoteId;
  final int durationSeconds;

  factory VoiceUploadResult.fromJson(Map<String, dynamic> json) =>
      VoiceUploadResult(
        voiceNoteId: json['voice_note_id'] as String? ?? '',
        durationSeconds: (json['duration_seconds'] as num?)?.toInt() ?? 0,
      );

  @override
  List<Object?> get props => <Object?>[voiceNoteId, durationSeconds];
}

/// Result of POST /voice/upload-url (A2-storage). The server mints a
/// worker-scoped storage slot: [storagePath] (`voice-notes/<workerId>/<uuid>.m4a`
/// — the exact value POST /voice/upload expects back) plus a short-lived signed
/// [uploadUrl] the clip bytes are PUT to.
///
/// PRIVACY: [uploadUrl] embeds a signing token — never log or persist it; use it
/// immediately and re-mint on expiry. [storagePath] is PII-free (opaque ids).
class VoiceUploadTicket extends Equatable {
  const VoiceUploadTicket({
    required this.storagePath,
    required this.uploadUrl,
    required this.expiresInSeconds,
  });

  final String storagePath;
  final String uploadUrl;
  final int expiresInSeconds;

  factory VoiceUploadTicket.fromJson(Map<String, dynamic> json) =>
      VoiceUploadTicket(
        storagePath: json['storage_path'] as String? ?? '',
        uploadUrl: json['upload_url'] as String? ?? '',
        expiresInSeconds: (json['expires_in'] as num?)?.toInt() ?? 0,
      );

  @override
  List<Object?> get props => <Object?>[storagePath, uploadUrl, expiresInSeconds];
}

/// Result of GET /voice/:voiceNoteId — the registered clip + its transcript once
/// the STT job has landed. [transcriptText] (source language) is preferred over
/// [transcriptEnglish]; both are null while transcription is pending.
///
/// PII NOTE: the transcript is worker-authored content (may carry personal
/// detail). It is held transiently to merge into the chat — NEVER logged.
class VoiceNoteDetail extends Equatable {
  const VoiceNoteDetail({
    required this.voiceNoteId,
    required this.durationSeconds,
    required this.transcriptText,
    required this.transcriptEnglish,
    required this.transcriptConfidence,
  });

  final String voiceNoteId;
  final int durationSeconds;
  final String? transcriptText;
  final String? transcriptEnglish;
  final double? transcriptConfidence;

  factory VoiceNoteDetail.fromJson(Map<String, dynamic> json) =>
      VoiceNoteDetail(
        voiceNoteId: json['voice_note_id'] as String? ?? '',
        durationSeconds: (json['duration_seconds'] as num?)?.toInt() ?? 0,
        transcriptText: json['transcript_text'] as String?,
        transcriptEnglish: json['transcript_english'] as String?,
        transcriptConfidence: (json['transcript_confidence'] as num?)?.toDouble(),
      );

  @override
  List<Object?> get props => <Object?>[
        voiceNoteId,
        durationSeconds,
        transcriptText,
        transcriptEnglish,
        transcriptConfidence,
      ];
}

/// Result of POST /voice/transcribe (A2b). Enqueues an STT job for a registered
/// voice note; poll GET /workers/me/ai-jobs/{id} on [aiJobId] until terminal.
class TranscribeResult extends Equatable {
  const TranscribeResult({required this.aiJobId, required this.status});

  final String aiJobId;
  final String status;

  factory TranscribeResult.fromJson(Map<String, dynamic> json) =>
      TranscribeResult(
        aiJobId: json['ai_job_id'] as String? ?? '',
        status: json['status'] as String? ?? 'queued',
      );

  @override
  List<Object?> get props => <Object?>[aiJobId, status];
}

/// Result of POST /invites (A3). The server mints a referral [code] (12 hex) and
/// a relative [link] (`/i/<code>`); the share sheet composes the absolute URL.
/// PII-FREE: no worker phone/name — only the opaque invite id + code.
class InviteResult extends Equatable {
  const InviteResult({
    required this.inviteId,
    required this.code,
    required this.link,
  });

  final String inviteId;
  final String code;

  /// Server-relative path, e.g. `/i/ab12cd34ef56`. The invite cubit composes the
  /// absolute share URL by prefixing the configured invite-link base.
  final String link;

  factory InviteResult.fromJson(Map<String, dynamic> json) => InviteResult(
        inviteId: json['invite_id'] as String? ?? '',
        code: json['code'] as String? ?? '',
        link: json['link'] as String? ?? '',
      );

  @override
  List<Object?> get props => <Object?>[inviteId, code, link];
}

/// Result of POST /auth/account/delete/request (A4). Starts the DPDP delete OTP
/// flow. [resendInSeconds] is the cooldown before another request is allowed.
class AccountDeleteRequestResult extends Equatable {
  const AccountDeleteRequestResult({
    required this.success,
    required this.resendInSeconds,
  });

  final bool success;
  final int resendInSeconds;

  factory AccountDeleteRequestResult.fromJson(Map<String, dynamic> json) =>
      AccountDeleteRequestResult(
        success: json['success'] as bool? ?? false,
        resendInSeconds: (json['resend_in_seconds'] as num?)?.toInt() ?? 0,
      );

  @override
  List<Object?> get props => <Object?>[success, resendInSeconds];
}

/// Result of POST /auth/account/delete/confirm (ADR-0031 grace window). The
/// delete is SCHEDULED, never executed inline: [scheduledFor] is when the 7-day
/// grace ends and the account is actually erased — until then the worker keeps
/// their session and can cancel. Defensive: a missing/bad `scheduled_for`
/// parses to null (the UI falls back to the generic "7 din" copy), never
/// crashes. PII-FREE: a timestamp only.
class AccountDeleteConfirmResult extends Equatable {
  const AccountDeleteConfirmResult({
    required this.success,
    required this.scheduledFor,
  });

  final bool success;
  final DateTime? scheduledFor;

  factory AccountDeleteConfirmResult.fromJson(Map<String, dynamic> json) =>
      AccountDeleteConfirmResult(
        success: json['success'] as bool? ?? false,
        scheduledFor: DateTime.tryParse(json['scheduled_for'] as String? ?? ''),
      );

  @override
  List<Object?> get props => <Object?>[success, scheduledFor];
}

/// Result of GET /resume/:id/download (ADR-0009 Stream C / G1c).
///
/// A short-lived, server-minted SIGNED url to the worker's resume PDF, plus its
/// TTL in seconds. PRIVACY: [url] embeds a single-use token — it must NEVER be
/// logged, persisted, or held in a BLoC state; launch it immediately and
/// re-fetch when it expires.
class ResumeDownload extends Equatable {
  const ResumeDownload({required this.url, required this.expiresInSeconds});

  final String url;
  final int expiresInSeconds;

  factory ResumeDownload.fromJson(Map<String, dynamic> json) => ResumeDownload(
        url: json['url'] as String? ?? '',
        expiresInSeconds: (json['expires_in'] as num?)?.toInt() ?? 0,
      );

  @override
  List<Object?> get props => <Object?>[url, expiresInSeconds];
}

/// Result of GET /interview-kit/:tradeKey/download.
///
/// A short-lived SIGNED url to the trade's interview-kit PDF (PII-free, static
/// curated content — the route is public). Same privacy rule as
/// [ResumeDownload]: [url] embeds a token; never log it, re-fetch on expiry.
class InterviewKitDownload extends Equatable {
  const InterviewKitDownload({required this.url, required this.expiresInSeconds});

  final String url;
  final int expiresInSeconds;

  factory InterviewKitDownload.fromJson(Map<String, dynamic> json) =>
      InterviewKitDownload(
        url: json['url'] as String? ?? '',
        expiresInSeconds: (json['expires_in'] as num?)?.toInt() ?? 0,
      );

  @override
  List<Object?> get props => <Object?>[url, expiresInSeconds];
}

/// Result of POST /resume/generate.
class ResumeResult extends Equatable {
  const ResumeResult({
    required this.resumeId,
    required this.version,
    required this.resumeText,
    required this.isMock,
  });

  final String resumeId;
  final int version;
  final String resumeText;
  final bool isMock;

  factory ResumeResult.fromJson(Map<String, dynamic> json) => ResumeResult(
        resumeId: json['resume_id'] as String,
        version: (json['version'] as num?)?.toInt() ?? 1,
        resumeText: json['resume_text'] as String? ?? '',
        isMock: json['is_mock'] as bool? ?? false,
      );

  @override
  List<Object?> get props => <Object?>[resumeId, version, resumeText, isMock];
}

/// The worker-editable resume "safe fields" (GET /workers/me/resume-fields) — the
/// worker's OWN name spelling + the two display prefs. `fullName` is null until a
/// name is set; the edit screen renders it as an empty spelling to fill in.
class ResumeFieldsDto extends Equatable {
  const ResumeFieldsDto({
    required this.fullName,
    required this.showPhoto,
    required this.nightShiftReady,
    this.hasPhoto = false,
  });

  final String? fullName;
  final bool showPhoto;
  final bool nightShiftReady;

  /// ADR-0032 — whether a profile photo exists server-side. Defaults FALSE when
  /// absent (the OPPOSITE of show_photo's default: a true here would make the
  /// UI try to render a nonexistent photo).
  final bool hasPhoto;

  factory ResumeFieldsDto.fromJson(Map<String, dynamic> json) => ResumeFieldsDto(
        fullName: json['full_name'] as String?,
        showPhoto: json['show_photo'] as bool? ?? true,
        nightShiftReady: json['night_shift_ready'] as bool? ?? false,
        hasPhoto: json['has_photo'] as bool? ?? false,
      );

  @override
  List<Object?> get props => <Object?>[fullName, showPhoto, nightShiftReady, hasPhoto];
}

/// Result of POST /workers/me/photo/upload-url (ADR-0032) — a signed slot for the
/// profile-photo bytes. Mirrors [VoiceUploadTicket].
///
/// PRIVACY: [uploadUrl] embeds a signing token — never log or persist it; use it
/// immediately and re-mint on expiry. [storagePath] is PII-free (opaque ids).
class PhotoUploadTicket extends Equatable {
  const PhotoUploadTicket({
    required this.storagePath,
    required this.uploadUrl,
    required this.expiresInSeconds,
  });

  final String storagePath;
  final String uploadUrl;
  final int expiresInSeconds;

  factory PhotoUploadTicket.fromJson(Map<String, dynamic> json) =>
      PhotoUploadTicket(
        storagePath: json['storage_path'] as String? ?? '',
        uploadUrl: json['upload_url'] as String? ?? '',
        expiresInSeconds: (json['expires_in'] as num?)?.toInt() ?? 0,
      );

  @override
  List<Object?> get props => <Object?>[storagePath, uploadUrl, expiresInSeconds];
}

/// Worker's current profile + latest resume (GET /workers/:id/profile). Used to
/// restore the session's profileId (and reuse an already-generated resume) for a
/// worker who logged in without re-running profiling this session. Any field is
/// null when the worker has no profile / no resume yet. Parses both snake_case
/// and camelCase since this endpoint returns raw rows.
class WorkerProfileBundle extends Equatable {
  const WorkerProfileBundle({this.profileId, this.resumeId, this.resumeText});

  final String? profileId;
  final String? resumeId;
  final String? resumeText;

  bool get hasProfile => profileId != null && profileId!.isNotEmpty;
  bool get hasResume =>
      resumeId != null && resumeText != null && resumeText!.isNotEmpty;

  factory WorkerProfileBundle.fromJson(Map<String, dynamic> json) {
    final Map<String, dynamic>? profile =
        json['profile'] as Map<String, dynamic>?;
    final Map<String, dynamic>? resume =
        json['resume'] as Map<String, dynamic>?;
    return WorkerProfileBundle(
      profileId: profile?['id'] as String?,
      resumeId: resume?['id'] as String?,
      resumeText: (resume?['resume_text'] ?? resume?['resumeText']) as String?,
    );
  }

  @override
  List<Object?> get props => <Object?>[profileId, resumeId, resumeText];
}

/// Response of GET /workers/me/profile-summary (WorkerProfileSummary,
/// apps/api workers.dto.ts). Mirrors the wire shape EXACTLY: a flat object with
/// a nested `trade` block.
///
/// PII posture (CLAUDE.md §2): there is NO name field — the `Namaste, <name>`
/// line is an OPEN §2 escalation and is deliberately omitted server-side, so the
/// client never receives (and never fabricates) a name. `city` is the only
/// sensitive field here and must NEVER be logged. `strength` is an integer
/// SIGNAL COUNT (countFields-equivalent), 0 when no profile — not a fraction.
class ProfileSummaryDto extends Equatable {
  const ProfileSummaryDto({
    required this.profileStatus,
    required this.confirmedAt,
    required this.tradeDisplayName,
    required this.canonicalTradeId,
    required this.canonicalRoleId,
    required this.city,
    required this.strength,
    this.strengthMax,
    this.skills = const <String>[],
    this.machines = const <String>[],
    this.experienceYears,
    this.educationLevel,
    this.educationField,
  });

  /// `"none"` when the worker has no profile row yet; else a ProfileStatus.
  final String profileStatus;

  /// ISO-8601, `null` until the profile is confirmed.
  final String? confirmedAt;

  /// `trade.display_name` — `null` until the trade is canonicalized.
  final String? tradeDisplayName;
  final String? canonicalTradeId;
  final String? canonicalRoleId;

  /// First of `location_preference.preferred_cities`; `null` when absent. PII.
  final String? city;

  /// Recomputed-on-read signal COUNT; `0` when no profile. NOT a 0..1 fraction.
  final int strength;

  /// The count's denominator (`strength_max`) — NOT sent by the API today, so
  /// this is null on the live wire. Parsed defensively now so a real N/max
  /// meter lights up the day the backend ships it (WA-4 seam); the UI never
  /// fabricates a denominator while it is null.
  final int? strengthMax;

  /// Canonical skill labels from the latest profile (PII-free taxonomy strings);
  /// `[]` when none. Additive wire field — absent on older backends.
  final List<String> skills;

  /// Canonical machine labels (PII-free); `[]` when none.
  final List<String> machines;

  /// `experience.total_years` — a NUMBER only. The backend deliberately omits the
  /// free-text `experience.summary` (possible §2 employer PII), so this is the
  /// only experience signal on the wire. `null` when unknown/no profile.
  final double? experienceYears;

  /// Highest education level (`education_level`) — a short PII-free label
  /// ('10th' / '12th' / 'ITI' / 'Diploma' / 'B.Tech'). Additive wire field —
  /// absent on older backends ⇒ null. Distinct from the `education` list.
  final String? educationLevel;

  /// Stream/branch of study (`education_field`) — a short PII-free label
  /// ('Electronics' / 'Mechanical' / 'Computer Science'). Additive ⇒ null when
  /// absent.
  final String? educationField;

  factory ProfileSummaryDto.fromJson(Map<String, dynamic> json) {
    final Map<String, dynamic> trade =
        (json['trade'] as Map<String, dynamic>?) ?? const <String, dynamic>{};
    return ProfileSummaryDto(
      profileStatus: json['profile_status'] as String? ?? 'none',
      confirmedAt: json['confirmed_at'] as String?,
      tradeDisplayName: trade['display_name'] as String?,
      canonicalTradeId: trade['canonical_trade_id'] as String?,
      canonicalRoleId: trade['canonical_role_id'] as String?,
      city: json['city'] as String?,
      strength: (json['strength'] as num?)?.toInt() ?? 0,
      strengthMax: (json['strength_max'] as num?)?.toInt(),
      // Defensive: keep only real strings; a malformed/absent array ⇒ [].
      skills: (json['skills'] as List<dynamic>?)
              ?.whereType<String>()
              .toList(growable: false) ??
          const <String>[],
      machines: (json['machines'] as List<dynamic>?)
              ?.whereType<String>()
              .toList(growable: false) ??
          const <String>[],
      experienceYears: (json['experience_years'] as num?)?.toDouble(),
      educationLevel: json['education_level'] as String?,
      educationField: json['education_field'] as String?,
    );
  }

  @override
  List<Object?> get props => <Object?>[
        profileStatus,
        confirmedAt,
        tradeDisplayName,
        canonicalTradeId,
        canonicalRoleId,
        city,
        strength,
        strengthMax,
        skills,
        machines,
        experienceYears,
        educationLevel,
        educationField,
      ];
}

/// One row of GET /interview-kits (InterviewKitListItem, apps/api
/// interview-kit.dto.ts). PII-FREE by construction (per-trade, never per-worker).
class InterviewKitListItem extends Equatable {
  const InterviewKitListItem({
    required this.tradeKey,
    required this.displayName,
  });

  final String tradeKey;
  final String displayName;

  factory InterviewKitListItem.fromJson(Map<String, dynamic> json) =>
      InterviewKitListItem(
        tradeKey: json['trade_key'] as String? ?? '',
        displayName: json['display_name'] as String? ?? '',
      );

  @override
  List<Object?> get props => <Object?>[tradeKey, displayName];
}

/// Response of GET /interview-kits/:tradeKey (InterviewKitContent, apps/api
/// interview-kit-content.ts). A per-trade PREP PACK — an overview, four question
/// LISTS (there are NO model answers on the wire — this is not a Q&A-with-answers
/// set), a skill checklist, revise-before / documents-to-carry / common-mistakes
/// lists, and a Hinglish note. PII-FREE by construction. Mirrors the DTO exactly.
class InterviewKitContentDto extends Equatable {
  const InterviewKitContentDto({
    required this.tradeKey,
    required this.displayName,
    required this.overview,
    required this.commonQuestions,
    required this.practicalQuestions,
    required this.safetyQuestions,
    required this.drawingMeasurementQuestions,
    required this.skillChecklist,
    required this.reviseBefore,
    required this.documentsToCarry,
    required this.commonMistakes,
    required this.hinglishNote,
  });

  final String tradeKey;
  final String displayName;
  final String overview;
  final List<String> commonQuestions;
  final List<String> practicalQuestions;
  final List<String> safetyQuestions;
  final List<String> drawingMeasurementQuestions;
  final List<String> skillChecklist;
  final List<String> reviseBefore;
  final List<String> documentsToCarry;
  final List<String> commonMistakes;
  final String hinglishNote;

  static List<String> _strList(Object? value) => value is List
      ? value.whereType<String>().toList(growable: false)
      : const <String>[];

  factory InterviewKitContentDto.fromJson(Map<String, dynamic> json) =>
      InterviewKitContentDto(
        tradeKey: json['trade_key'] as String? ?? '',
        displayName: json['display_name'] as String? ?? '',
        overview: json['overview'] as String? ?? '',
        commonQuestions: _strList(json['common_questions']),
        practicalQuestions: _strList(json['practical_questions']),
        safetyQuestions: _strList(json['safety_questions']),
        drawingMeasurementQuestions:
            _strList(json['drawing_measurement_questions']),
        skillChecklist: _strList(json['skill_checklist']),
        reviseBefore: _strList(json['revise_before']),
        documentsToCarry: _strList(json['documents_to_carry']),
        commonMistakes: _strList(json['common_mistakes']),
        hinglishNote: json['hinglish_note'] as String? ?? '',
      );

  @override
  List<Object?> get props => <Object?>[
        tradeKey,
        displayName,
        overview,
        commonQuestions,
        practicalQuestions,
        safetyQuestions,
        drawingMeasurementQuestions,
        skillChecklist,
        reviseBefore,
        documentsToCarry,
        commonMistakes,
        hinglishNote,
      ];
}
