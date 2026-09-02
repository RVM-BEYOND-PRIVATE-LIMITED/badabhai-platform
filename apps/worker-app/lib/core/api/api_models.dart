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

/// THE INTERVIEW HANDED OVER TO A FORM (`form_offer`, #1339/#1340) — the card
/// the client draws instead of a composer, in place of the next question.
///
/// Set on exactly ONE turn per interview and `null` on every other, including
/// every degraded/blocked reply — see [ChatReply.formOffer] for the full
/// contract. [headline] and [ctaLabel] are SERVER-SUPPLIED copy (not
/// client-authored), so `persona_neutrality_test.dart`'s string-literal scan
/// does not apply to them; the server side owns their Ten Laws compliance.
class FormOffer extends Equatable {
  const FormOffer({
    required this.kind,
    required this.headline,
    required this.ctaLabel,
  });

  /// The closed `TRADE_FORM_KINDS` value (currently only `cnc_turner`). Kept as
  /// a raw string rather than a client enum — #371 discipline: a future kind
  /// this build does not know about must still render the card and route to
  /// the (today, single) trade form, never be silently dropped.
  final String kind;

  /// The headline text drawn on the card.
  final String headline;

  /// The label on the card's primary [BbButton] — the ONLY way forward from
  /// this turn (there are no chips and no question).
  final String ctaLabel;

  /// Parses one `{kind, headline, cta_label}` object. Returns null on a
  /// non-map, or when any of the three required strings is missing/blank — a
  /// malformed offer is dropped, never thrown (#371): the worker then sees the
  /// closing bubble with no card, degraded but coherent, exactly like a client
  /// that predates this field.
  static FormOffer? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final Object? kind = raw['kind'];
    final Object? headline = raw['headline'];
    final Object? ctaLabel = raw['cta_label'];
    if (kind is! String || kind.isEmpty) return null;
    if (headline is! String || headline.isEmpty) return null;
    if (ctaLabel is! String || ctaLabel.isEmpty) return null;
    return FormOffer(kind: kind, headline: headline, ctaLabel: ctaLabel);
  }

  @override
  List<Object?> get props => <Object?>[kind, headline, ctaLabel];
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
    this.formOffer,
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

  /// THE INTERVIEW HANDED OVER TO A FORM (`form_offer`, #1339/#1340), or `null`
  /// on every other turn — see [FormOffer] for the full contract.
  ///
  /// Set alongside [sessionEnded] = true and [extractionReady] = false ON
  /// PURPOSE: a worker choosing between a resume built from nothing and the
  /// form that fills it is the failure this avoids, so the client must render
  /// AT MOST ONE terminal CTA on this turn (see `_doneCta` in
  /// `ChatProfilingScreen`).
  ///
  /// ADDITIVE and defaulted null: an older API build, a malformed object, or
  /// any turn that never hands over all parse to null, and the client then
  /// shows exactly today's closing bubble — a degraded but coherent screen,
  /// never a broken one.
  final FormOffer? formOffer;

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
        // #1339/#1340 — null on a non-map / missing required string / every
        // ordinary turn (see [FormOffer.fromJson] and the field doc). Never
        // thrown (#371): a malformed offer degrades to no card, not a lost reply.
        formOffer: FormOffer.fromJson(json['form_offer']),
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
        formOffer,
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

// ─── GET /resume/document (#1343) — the resume AS STRUCTURED DATA ─────────────
//
// Mirrors apps/api/src/resume/resume-document.ts EXACTLY (read there before
// touching field names). The endpoint's OUTER wrapper is snake_case like every
// other DTO in this file (`resume_id`), but the nested `document` object is
// camelCase — it is written straight from the server's `ResumeDocument` TS
// type, unlike every other payload here which the NestJS layer re-cases. ONE
// exception inside that: [ResumeEmploymentDto]'s `location_suffix` /
// `role_inline` ride the wire in snake_case even inside the camelCase
// document, because `toResumeDocument` passes `ResumeEmployment` through
// verbatim rather than projecting it — see the field-level comment there.

/// One structured work-history line under `format: "generic"`
/// (`ResumeExperienceLine` in apps/api resume-renderer.service.ts) — the
/// LLM-led interview's own read of a job, never an employer name (the
/// contract refuses one at the boundary; there is no field for one here).
class ResumeExperienceLineDto extends Equatable {
  const ResumeExperienceLineDto({
    this.role = '',
    this.duration = '',
    this.work = '',
  });

  final String role;
  final String duration;
  final String work;

  factory ResumeExperienceLineDto.fromJson(Map<String, dynamic> json) =>
      ResumeExperienceLineDto(
        role: json['role'] as String? ?? '',
        duration: json['duration'] as String? ?? '',
        work: json['work'] as String? ?? '',
      );

  @override
  List<Object?> get props => <Object?>[role, duration, work];
}

/// The masthead both document formats share — name / phone / trust badge
/// (`ResumeDocumentHeader`). PII posture: this is the worker's OWN data,
/// mirrored back to them on their own resume tab on their own device — the
/// same self-read the existing [ResumeFieldsDto] name/photo already is.
class ResumeDocumentHeaderDto extends Equatable {
  const ResumeDocumentHeaderDto({this.name, this.phone, this.trustBadge});

  final String? name;
  final String? phone;

  /// The masthead's right-hand slot ("RVM-attested"); null when the worker
  /// has no attestation. NEVER a raw enum token — the server sends the
  /// already-humanised string or nothing at all.
  final String? trustBadge;

  factory ResumeDocumentHeaderDto.fromJson(Map<String, dynamic> json) =>
      ResumeDocumentHeaderDto(
        name: json['name'] as String?,
        phone: json['phone'] as String?,
        trustBadge: json['trustBadge'] as String?,
      );

  @override
  List<Object?> get props => <Object?>[name, phone, trustBadge];
}

/// A labelled list row on a `format: "trade_sheet"` section — pills
/// (`chipRows`) or ✓ items (`tickRows`) on the printed sheet
/// (`ResumeListRow` in apps/api resume-renderer.service.ts).
///
/// `key` / `rank` are server-side PROVENANCE the renderer itself never reads
/// (the backend's own comment: "the renderer never reads either" — they
/// exist only so the degradation ladder can order rows without re-deriving
/// the trade map) — deliberately not modelled here for the same reason.
class ResumeListRowDto extends Equatable {
  const ResumeListRowDto({this.label = '', this.values = const <String>[]});

  final String label;
  final List<String> values;

  factory ResumeListRowDto.fromJson(Map<String, dynamic> json) {
    final List<dynamic> raw =
        json['values'] as List<dynamic>? ?? const <dynamic>[];
    return ResumeListRowDto(
      label: json['label'] as String? ?? '',
      values: raw.whereType<String>().toList(growable: false),
    );
  }

  @override
  List<Object?> get props => <Object?>[label, values];
}

/// A labelled single-value row on a `format: "trade_sheet"` section — a
/// definition row on the printed sheet (`factRows`).
class ResumeFactRowDto extends Equatable {
  const ResumeFactRowDto({this.label = '', this.value = ''});

  final String label;
  final String value;

  factory ResumeFactRowDto.fromJson(Map<String, dynamic> json) =>
      ResumeFactRowDto(
        label: json['label'] as String? ?? '',
        value: json['value'] as String? ?? '',
      );

  @override
  List<Object?> get props => <Object?>[label, value];
}

/// One zoned section of a `format: "trade_sheet"` document — its own heading
/// plus the three row styles the printed sheet uses.
///
/// AN EMPTY SECTION (zero rows across all three arrays) IS A REAL, EXPECTED
/// SHAPE — the server keeps every zone rather than dropping one with nothing
/// in it (apps/api `toResumeDocument`'s own comment: "the client decides
/// whether an empty zone shows a heading"). [hasRows] IS that decision,
/// made once here so every render site agrees: an empty zone's heading is
/// HIDDEN — a worker whose sheet has nothing yet under "Availability & terms"
/// should not see a bare, content-less heading on their own resume.
class ResumeDocumentSectionDto extends Equatable {
  const ResumeDocumentSectionDto({
    this.id = '',
    this.title = '',
    this.chipRows = const <ResumeListRowDto>[],
    this.tickRows = const <ResumeListRowDto>[],
    this.factRows = const <ResumeFactRowDto>[],
  });

  final String id;
  final String title;
  final List<ResumeListRowDto> chipRows;
  final List<ResumeListRowDto> tickRows;
  final List<ResumeFactRowDto> factRows;

  bool get hasRows =>
      chipRows.isNotEmpty || tickRows.isNotEmpty || factRows.isNotEmpty;

  factory ResumeDocumentSectionDto.fromJson(Map<String, dynamic> json) {
    List<T> parseList<T>(String key, T Function(Map<String, dynamic>) parse) {
      final List<dynamic> raw =
          json[key] as List<dynamic>? ?? const <dynamic>[];
      return raw
          .whereType<Map<String, dynamic>>()
          .map(parse)
          .toList(growable: false);
    }

    return ResumeDocumentSectionDto(
      id: json['id'] as String? ?? '',
      title: json['title'] as String? ?? '',
      chipRows: parseList('chipRows', ResumeListRowDto.fromJson),
      tickRows: parseList('tickRows', ResumeListRowDto.fromJson),
      factRows: parseList('factRows', ResumeFactRowDto.fromJson),
    );
  }

  @override
  List<Object?> get props =>
      <Object?>[id, title, chipRows, tickRows, factRows];
}

/// One dated role stint inside a [ResumeEmploymentDto] — a worker who was
/// promoted at the same employer has one tenure and two titles
/// (`ResumeRoleStint` in apps/api resume-renderer.service.ts).
class ResumeEmploymentRoleStintDto extends Equatable {
  const ResumeEmploymentRoleStintDto({this.role = '', this.when = ''});

  final String role;
  final String when;

  factory ResumeEmploymentRoleStintDto.fromJson(Map<String, dynamic> json) =>
      ResumeEmploymentRoleStintDto(
        role: json['role'] as String? ?? '',
        when: json['when'] as String? ?? '',
      );

  @override
  List<Object?> get props => <Object?>[role, when];
}

/// One employer on a `format: "trade_sheet"` document's work history
/// (`ResumeEmployment` in apps/api resume-renderer.service.ts).
///
/// [locationSuffix] / [roleInline] / [workOwnWords] READ SNAKE_CASE KEYS
/// (`location_suffix` / `role_inline` / `work_own_words`) even though the
/// surrounding document is camelCase — see the file-level note above. The
/// first two are PRE-COMPOSED with their own leading separator
/// (" · Gurugram, Haryana" / " — CNC Turner") so an absent value leaves no
/// stray separator when appended to [employer].
class ResumeEmploymentDto extends Equatable {
  const ResumeEmploymentDto({
    this.id,
    this.employer = '',
    this.locationSuffix,
    this.roleInline,
    this.when = '',
    this.work = '',
    this.workOwnWords,
    this.roles = const <ResumeEmploymentRoleStintDto>[],
  });

  /// The employment row id (#1353/#1354) — the ONLY identifier
  /// `PUT /workers/me/employment/:employmentId/description-source` accepts.
  /// Present on every real record; absent only for pre-#1353 seeded fixtures
  /// server-side, which is why the reveal/choice affordance also requires it
  /// (see [ResumeDocumentView]'s `_EmploymentEntry`) rather than assuming it.
  final String? id;
  final String employer;
  final String? locationSuffix;
  final String? roleInline;

  /// The EMPLOYMENT's own span ("Jan 2023 – Present · 3 yrs 6 mo") — never
  /// the employer's, distinct from each [roles] stint's own `when`.
  final String when;
  final String work;

  /// The SAME line, composed through the same joiner but with the worker's
  /// OWN words only (#1354) — emitted UNCONDITIONALLY whenever the employment
  /// has any role text at all, not only when a rewrite happened. Equal to
  /// [work] whenever nothing was rewritten (or a rewrite was declined and the
  /// printed line already IS the worker's own words) — see
  /// [hasOwnWordsToReveal], which is the ONLY honest signal for whether there
  /// is anything to show: this DTO never guesses from an absent value.
  final String? workOwnWords;
  final List<ResumeEmploymentRoleStintDto> roles;

  /// #1353 — true only when there is a GENUINE rewrite to compare: [workOwnWords]
  /// is present AND differs from the printed [work]. Equal strings (or a null
  /// [workOwnWords]) mean nothing to reveal — an entry that was never rewritten
  /// and an entry whose rewrite the worker already declined are, by design,
  /// indistinguishable from the wire alone (the printed line already reads as
  /// the worker's own words either way), so both correctly show no affordance.
  bool get hasOwnWordsToReveal =>
      workOwnWords != null && workOwnWords != work;

  factory ResumeEmploymentDto.fromJson(Map<String, dynamic> json) {
    final List<dynamic> rawRoles =
        json['roles'] as List<dynamic>? ?? const <dynamic>[];
    return ResumeEmploymentDto(
      id: json['id'] as String?,
      employer: json['employer'] as String? ?? '',
      locationSuffix: json['location_suffix'] as String?,
      roleInline: json['role_inline'] as String?,
      when: json['when'] as String? ?? '',
      work: json['work'] as String? ?? '',
      workOwnWords: json['work_own_words'] as String?,
      roles: rawRoles
          .whereType<Map<String, dynamic>>()
          .map(ResumeEmploymentRoleStintDto.fromJson)
          .toList(growable: false),
    );
  }

  @override
  List<Object?> get props => <Object?>[
        id,
        employer,
        locationSuffix,
        roleInline,
        when,
        work,
        workOwnWords,
        roles,
      ];
}

/// The two-line verdict a `format: "trade_sheet"` document's masthead prints
/// — role · years · machines, then city · availability · salary.
class ResumeSheetHeadlineDto extends Equatable {
  const ResumeSheetHeadlineDto({this.line1, this.line2});

  final String? line1;
  final String? line2;

  factory ResumeSheetHeadlineDto.fromJson(Map<String, dynamic> json) =>
      ResumeSheetHeadlineDto(
        line1: json['line1'] as String?,
        line2: json['line2'] as String?,
      );

  @override
  List<Object?> get props => <Object?>[line1, line2];
}

/// THE RESUME AS STRUCTURED DATA (#1343) — what the resume tab draws instead
/// of parsing `resume_text` for `Label: value` lines. Mirrors apps/api
/// `ResumeDocument` (resume-document.ts) exactly: TWO shapes, discriminated
/// by [format].
///
/// SWITCH ON [format], NEVER ON `trade` (see [GenericResumeDocument.trade] /
/// [TradeSheetResumeDocument.trade]) — there are exactly two LAYOUTS, and
/// `trade` is open-ended: a welder's sheet is the same shape as a turner's
/// with different rows in it. A Dart branch keyed on trade would need a new
/// case for every future trade; a sealed switch on format never does.
sealed class ResumeDocument extends Equatable {
  const ResumeDocument({required this.header, this.footerMeta});

  final ResumeDocumentHeaderDto header;

  /// The masthead-matching footer line the sheet prints ("Generated 27 August
  /// 2026 · Ref RK8M2Q"). Null on a document with nothing to print there.
  final String? footerMeta;

  /// Parses either shape by [format]. An unrecognised/missing `format` value
  /// defaults to `generic` — the safe choice: a resume-document row this
  /// client build does not recognise renders as the plain layout rather than
  /// throwing the whole tab into a blank state.
  static ResumeDocument fromJson(Map<String, dynamic> json) {
    return switch (json['format'] as String?) {
      'trade_sheet' => TradeSheetResumeDocument.fromJson(json),
      _ => GenericResumeDocument.fromJson(json),
    };
  }

  static ResumeDocumentHeaderDto _headerFrom(Map<String, dynamic> json) {
    final Map<String, dynamic>? raw = json['header'] as Map<String, dynamic>?;
    return raw == null
        ? const ResumeDocumentHeaderDto()
        : ResumeDocumentHeaderDto.fromJson(raw);
  }

  @override
  List<Object?> get props => <Object?>[header, footerMeta];
}

/// `format: "generic"` — the flat, twelve-layout résumé every worker with no
/// trade sheet renders (`classic`/`modern`/`minimal`/`fallback`).
class GenericResumeDocument extends ResumeDocument {
  const GenericResumeDocument({
    required super.header,
    super.footerMeta,
    this.headline,
    this.summary,
    this.location,
    this.availability,
    this.experienceYears,
    this.expectedSalary,
    this.skills = const <String>[],
    this.machines = const <String>[],
    this.controllers = const <String>[],
    this.education = const <String>[],
    this.certifications = const <String>[],
    this.preferredLocations = const <String>[],
    this.experiences = const <ResumeExperienceLineDto>[],
  });

  /// Role title (`{{headline}}`, e.g. "VMC Operator"). ALWAYS `trade: null`
  /// on this format server-side (there is no `trade` field on this class at
  /// all — the generic format structurally cannot label one).
  final String? headline;
  final String? summary;
  final String? location;
  final String? availability;
  final int? experienceYears;

  /// Rupees per month, or null to omit the line — never shown to a payer,
  /// only ever the worker's own copy (server-side `audience` gate).
  final int? expectedSalary;
  final List<String> skills;
  final List<String> machines;
  final List<String> controllers;
  final List<String> education;
  final List<String> certifications;
  final List<String> preferredLocations;
  final List<ResumeExperienceLineDto> experiences;

  factory GenericResumeDocument.fromJson(Map<String, dynamic> json) {
    List<String> strings(String key) =>
        (json[key] as List<dynamic>? ?? const <dynamic>[])
            .whereType<String>()
            .toList(growable: false);
    final List<dynamic> rawExperiences =
        json['experiences'] as List<dynamic>? ?? const <dynamic>[];
    return GenericResumeDocument(
      header: ResumeDocument._headerFrom(json),
      footerMeta: json['footerMeta'] as String?,
      headline: json['headline'] as String?,
      summary: json['summary'] as String?,
      location: json['location'] as String?,
      availability: json['availability'] as String?,
      experienceYears: (json['experienceYears'] as num?)?.toInt(),
      expectedSalary: (json['expectedSalary'] as num?)?.toInt(),
      skills: strings('skills'),
      machines: strings('machines'),
      controllers: strings('controllers'),
      education: strings('education'),
      certifications: strings('certifications'),
      preferredLocations: strings('preferredLocations'),
      experiences: rawExperiences
          .whereType<Map<String, dynamic>>()
          .map(ResumeExperienceLineDto.fromJson)
          .toList(growable: false),
    );
  }

  @override
  List<Object?> get props => <Object?>[
        ...super.props,
        headline,
        summary,
        location,
        availability,
        experienceYears,
        expectedSalary,
        skills,
        machines,
        controllers,
        education,
        certifications,
        preferredLocations,
        experiences,
      ];
}

/// `format: "trade_sheet"` — the zoned-row layout a worker whose trade has an
/// authored resume map renders (`bb_trade`). `trade` labels WHICH trade
/// (e.g. "cnc_turner") but is a raw slug, never shown as-is on screen (the
/// no-raw-ids rule) — [headline] already carries the human-readable labels,
/// so the render layer has no need to display [trade] at all.
class TradeSheetResumeDocument extends ResumeDocument {
  const TradeSheetResumeDocument({
    required super.header,
    super.footerMeta,
    required this.trade,
    this.headline = const ResumeSheetHeadlineDto(),
    this.sections = const <ResumeDocumentSectionDto>[],
    this.employments = const <ResumeEmploymentDto>[],
    this.employmentsMore,
  });

  final String trade;
  final ResumeSheetHeadlineDto headline;

  /// THE SHEET'S OWN ZONES, in the order it prints them — see
  /// [ResumeDocumentSectionDto.hasRows] for the empty-zone display rule.
  final List<ResumeDocumentSectionDto> sections;
  final List<ResumeEmploymentDto> employments;

  /// "and 2 more" when the block budget truncated the printed history. Null
  /// when nothing was truncated.
  final String? employmentsMore;

  factory TradeSheetResumeDocument.fromJson(Map<String, dynamic> json) {
    final Map<String, dynamic>? rawHeadline =
        json['headline'] as Map<String, dynamic>?;
    final List<dynamic> rawSections =
        json['sections'] as List<dynamic>? ?? const <dynamic>[];
    final List<dynamic> rawEmployments =
        json['employments'] as List<dynamic>? ?? const <dynamic>[];
    return TradeSheetResumeDocument(
      header: ResumeDocument._headerFrom(json),
      footerMeta: json['footerMeta'] as String?,
      trade: json['trade'] as String? ?? '',
      headline: rawHeadline == null
          ? const ResumeSheetHeadlineDto()
          : ResumeSheetHeadlineDto.fromJson(rawHeadline),
      sections: rawSections
          .whereType<Map<String, dynamic>>()
          .map(ResumeDocumentSectionDto.fromJson)
          .toList(growable: false),
      employments: rawEmployments
          .whereType<Map<String, dynamic>>()
          .map(ResumeEmploymentDto.fromJson)
          .toList(growable: false),
      employmentsMore: json['employmentsMore'] as String?,
    );
  }

  @override
  List<Object?> get props => <Object?>[
        ...super.props,
        trade,
        headline,
        sections,
        employments,
        employmentsMore,
      ];
}

/// Response of GET /resume/document (apps/api resume.controller.ts
/// `myDocument`) — the worker's OWN latest resume as structured data.
///
/// [document] IS NULL FOR TWO ORDINARY, NON-ERROR REASONS documented
/// server-side (`ResumeService.myDocument`): every resume rendered before
/// this column shipped has none, and one still pending its FIRST render has
/// none either. Callers MUST fall back to the existing `resume_text` parsing
/// path on null rather than blanking the screen — null here is not "no
/// resume", it is "no structured projection of this resume yet".
class ResumeDocumentResponse extends Equatable {
  const ResumeDocumentResponse({
    required this.resumeId,
    required this.version,
    required this.document,
  });

  final String resumeId;
  final int version;
  final ResumeDocument? document;

  factory ResumeDocumentResponse.fromJson(Map<String, dynamic> json) {
    final Map<String, dynamic>? doc =
        json['document'] as Map<String, dynamic>?;
    return ResumeDocumentResponse(
      resumeId: json['resume_id'] as String? ?? '',
      version: (json['version'] as num?)?.toInt() ?? 1,
      document: doc == null ? null : ResumeDocument.fromJson(doc),
    );
  }

  @override
  List<Object?> get props => <Object?>[resumeId, version, document];
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

/// GET /workers/me/work-preferences/options (#1296) — the closed-set chip
/// vocabulary for the post-interview finishing form. Each map is `slug → English
/// label`; the label is what prints on the résumé, the Hinglish chip text the
/// worker reads is the client's. Rendering chips from THIS (never a hard-coded
/// list) is what keeps the client and the server enum from drifting into a chip
/// the server then rejects with nothing naming the cause.
class WorkPrefOptionsDto extends Equatable {
  const WorkPrefOptionsDto({
    required this.languages,
    required this.documentsReady,
    required this.jobType,
    required this.shift,
  });

  final Map<String, String> languages;
  final Map<String, String> documentsReady;
  final Map<String, String> jobType;
  final Map<String, String> shift;

  static Map<String, String> _labelMap(dynamic raw) {
    if (raw is! Map) return const <String, String>{};
    // Preserve insertion order (the server's intended chip order) and coerce
    // every value to a String, skipping any malformed non-string label.
    final Map<String, String> out = <String, String>{};
    raw.forEach((dynamic k, dynamic v) {
      if (k is String && v is String) out[k] = v;
    });
    return out;
  }

  factory WorkPrefOptionsDto.fromJson(Map<String, dynamic> json) =>
      WorkPrefOptionsDto(
        languages: _labelMap(json['languages']),
        documentsReady: _labelMap(json['documents_ready']),
        jobType: _labelMap(json['job_type']),
        shift: _labelMap(json['shift']),
      );

  @override
  List<Object?> get props =>
      <Object?>[languages, documentsReady, jobType, shift];
}

/// GET /workers/me/qualifications/options (#1384/#1385, migration 0098) — the
/// closed-set chip vocabulary for the `qualifications` marker's education
/// rows. Same shape and same reasoning as [WorkPrefOptionsDto]: each map is
/// `slug → English label`, and chips render from THIS rather than a
/// hard-coded copy that could drift from the server's zod enum
/// (`worker-preferences.vocabulary.ts`'s `EDUCATION_QUALIFICATIONS` /
/// `EDUCATION_COUNCILS`, served here verbatim).
///
/// Certificate names are deliberately ABSENT from this response — they are
/// free text, not a closed set, and ride the form schema's per-trade
/// `suggested_certificates` instead (see `TradeFormQualificationsStep`).
class QualificationOptionsDto extends Equatable {
  const QualificationOptionsDto({
    required this.educationCredential,
    required this.educationCouncil,
  });

  final Map<String, String> educationCredential;
  final Map<String, String> educationCouncil;

  static Map<String, String> _labelMap(dynamic raw) {
    if (raw is! Map) return const <String, String>{};
    // Preserve insertion order (the server's intended chip order — the
    // credential slugs are ordered lowest rung first) and coerce every value
    // to a String, skipping any malformed non-string label.
    final Map<String, String> out = <String, String>{};
    raw.forEach((dynamic k, dynamic v) {
      if (k is String && v is String) out[k] = v;
    });
    return out;
  }

  factory QualificationOptionsDto.fromJson(Map<String, dynamic> json) =>
      QualificationOptionsDto(
        educationCredential: _labelMap(json['education_credential']),
        educationCouncil: _labelMap(json['education_council']),
      );

  @override
  List<Object?> get props => <Object?>[educationCredential, educationCouncil];
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
    this.missingFields = const <String>[],
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

  /// The canonical keys of the 9 field-group slots the profile is still MISSING
  /// (`missing_fields`), ordered by the server largest-missing-weight FIRST — so
  /// `missing_fields.first` is the single most valuable thing to add next. Each
  /// entry is a short slug: `role` | `trade` | `skills` | `machines` |
  /// `experience` | `salary` | `location` | `availability` | `photo`. PII-free by
  /// construction (field NAMES, never values). Additive wire field — a malformed
  /// or absent array parses to `[]`, never a throw. Humanized to readable Hinglish
  /// at the display edge (never rendered as a raw slug).
  final List<String> missingFields;

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
      // Defensive: keep only real string slugs; a malformed/absent array ⇒ [].
      // Order is preserved (largest-missing-weight first) — the consumer relies
      // on `.first` being the single most valuable slot to add next.
      missingFields: (json['missing_fields'] as List<dynamic>?)
              ?.whereType<String>()
              .toList(growable: false) ??
          const <String>[],
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
        missingFields,
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
