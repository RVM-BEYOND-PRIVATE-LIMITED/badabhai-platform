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
    this.description,
    this.benefits = const <String>[],
    this.requirements = const <String>[],
    this.neededBy,
    this.payType,
    this.postedAt,
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

  /// Worker-visible card content the feed ALREADY sends (#1561, migration 0116):
  /// the posting's own `description` / `benefits` / `requirements` /
  /// `needed_by`, verbatim. BOTH feed sources project them —
  /// `ApplicationsService.getFeed` for the legacy `jobs` read and
  /// `MatchFeedService` for the V1 `job_postings` read — so a card shows these
  /// real facts on its FIRST frame instead of waiting for a per-card
  /// `GET /jobs/:id` to land.
  ///
  /// Honest absence: a null [description] / an empty list means the poster left
  /// the field blank (or the row predates the migration). Nothing is invented
  /// and no placeholder chip is rendered.
  final String? description;
  final List<String> benefits;
  final List<String> requirements;

  /// Coarse timing enum as the RAW wire string ('immediate' | 'soon' |
  /// 'flexible'), or null when unstated. Display mapping lives in
  /// core/util/job_display.dart — never shown raw (#1027).
  final String? neededBy;

  /// What the pay band MEANS as the POSTER stated it — the raw wire enum
  /// ('in_hand' | 'gross' | 'ctc'), or null when they did not state it (#1648).
  /// Null is the common case and it must stay honest: the card then shows the
  /// band with no pay-type pill rather than calling it take-home pay.
  /// `payTypeLabel` in core/util/job_display.dart owns the display mapping.
  final String? payType;

  /// When the posting went live — `job_postings.published_at` on the V1 feed,
  /// `jobs.created_at` on the legacy one (#1649). Null is honest absence.
  ///
  /// The ONLY thing that can make a "naye jobs (aaj)" count true; before the
  /// server sent it the header was claiming a recency it had no field for.
  final DateTime? postedAt;

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
        // Card content (#1561). An absent key / explicit null reads as
        // null / empty, so an older server renders exactly what it did before.
        description: json['description'] as String?,
        benefits: _stringList(json['benefits']),
        requirements: _stringList(json['requirements']),
        neededBy: json['needed_by'] as String?,
        payType: json['pay_type'] as String?,
        postedAt: _utcDate(json['posted_at']),
      );

  /// One ISO-8601 wire timestamp → a local [DateTime], or null. A malformed or
  /// absent value reads as "unknown", never as "now" — a fabricated recency is
  /// exactly what the honest-count rule exists to prevent.
  static DateTime? _utcDate(dynamic raw) {
    if (raw is! String || raw.isEmpty) return null;
    return DateTime.tryParse(raw)?.toLocal();
  }

  /// One wire list → a clean `List<String>`: a non-list (or absent) value reads
  /// as empty, and blank entries are dropped rather than becoming empty chips.
  static List<String> _stringList(dynamic raw) {
    if (raw is! List<dynamic>) return const <String>[];
    return raw
        .whereType<String>()
        .map((String value) => value.trim())
        .where((String value) => value.isNotEmpty)
        .toList(growable: false);
  }

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
        description,
        benefits,
        requirements,
        neededBy,
        payType,
        postedAt,
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
  const ChatSessionStart({
    required this.sessionId,
    this.openingText,
    this.openingTtsText,
    this.resumePending = false,
    this.openingOptions = const <ChatOption>[],
  });

  final String sessionId;
  final String? openingText;

  /// The Devanagari read-aloud twin of [openingText] (`opening_tts_text`) — the
  /// SAME content in native script so the on-device hi-IN voice pronounces it
  /// correctly. Present iff the server-served opening has a twin; null when the
  /// opening is the client's canned fallback or an older API build.
  final String? openingTtsText;

  /// True when this session opened with a résumé-confirm as its FIRST turn
  /// (`resume_pending`, ADR-0042 D8). The server serves the confirm bubble
  /// ([openingText]) plus its Haan/Nahi chips ([openingOptions]); absent → null.
  final bool resumePending;

  /// The tap-to-answer chips for the session's first turn (`opening_options`),
  /// each `{option_key, label_text, ...}`. Empty on every ordinary opener.
  final List<ChatOption> openingOptions;

  factory ChatSessionStart.fromJson(Map<String, dynamic> json) {
    String? text(Object? raw) =>
        raw is String && raw.trim().isNotEmpty ? raw : null;
    final Object? rawOptions = json['opening_options'];
    final List<ChatOption> options = rawOptions is List
        ? rawOptions
            .map(ChatOption.fromJson)
            .whereType<ChatOption>()
            .toList(growable: false)
        : const <ChatOption>[];
    return ChatSessionStart(
      sessionId: json['session_id'] as String,
      openingText: text(json['opening_text']),
      openingTtsText: text(json['opening_tts_text']),
      // `is bool` not a cast (#371): a garbled value reads as "no confirm".
      resumePending:
          json['resume_pending'] is bool ? json['resume_pending'] as bool : false,
      openingOptions: options,
    );
  }

  @override
  List<Object?> get props =>
      <Object?>[sessionId, openingText, openingTtsText, resumePending, openingOptions];
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

/// ONE shape for every signed upload slot this app is handed — voice clips,
/// profile photos, feedback attachments and résumés all mint the same
/// `{storage_path, upload_url, expires_in}` triple, because they all go through
/// `StorageService.createSignedUploadUrl` server-side.
///
/// [storagePath] is the server-chosen object key and the exact value the
/// matching register/confirm route expects back. [uploadUrl] is where the bytes
/// are PUT.
///
/// PRIVACY: [uploadUrl] IS A BEARER CREDENTIAL. It embeds a signing token, so it
/// is never logged, never persisted, never put on an event and never shown —
/// use it immediately and re-mint on expiry. [storagePath] is PII-free (opaque
/// ids) and safe to carry.
class SignedUploadTicket extends Equatable {
  const SignedUploadTicket({
    required this.storagePath,
    required this.uploadUrl,
    required this.expiresInSeconds,
  });

  final String storagePath;
  final String uploadUrl;
  final int expiresInSeconds;

  factory SignedUploadTicket.fromJson(Map<String, dynamic> json) =>
      SignedUploadTicket(
        storagePath: json['storage_path'] as String? ?? '',
        uploadUrl: json['upload_url'] as String? ?? '',
        expiresInSeconds: (json['expires_in'] as num?)?.toInt() ?? 0,
      );

  @override
  List<Object?> get props => <Object?>[storagePath, uploadUrl, expiresInSeconds];
}

/// Result of POST /voice/upload-url (A2-storage) — `storagePath` is
/// `voice-notes/<workerId>/<uuid>.m4a`, the exact value POST /voice/upload
/// expects back. An ALIAS of [SignedUploadTicket], not a second shape: the two
/// were field-for-field identical and one of them had to be the other.
typedef VoiceUploadTicket = SignedUploadTicket;

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
    this.workOwnWords,
    this.ownWordsKey,
  });

  final String role;
  final String duration;
  final String work;

  /// The SAME line built from the worker's own words, when a rewrite is what
  /// [work] holds (#1476). Null when nothing was rewritten.
  ///
  /// A fresher's training block is the one place a model rewrites a sentence
  /// about a worker who has no employments to carry the #1354 reveal — so
  /// without this he could not see what his own sheet was rewritten from.
  ///
  /// WHOLE LINES, never a span. The block is a ` · `-joined composite of
  /// workshop machines, the trade-test clause and his project sentence, and
  /// the machines are joined with that same separator — so the client must
  /// not take it apart to find the segment that changed. The server composes
  /// both lines through the same joiner in the same pass; the only honest
  /// comparison is line against line.
  final String? workOwnWords;

  /// The answer this line's rewrite belongs to — the `:attributeKey` the
  /// refusal route takes (#1492). `"iti_project_work"` for the fresher today.
  ///
  /// PRESENT EXACTLY WHEN [workOwnWords] IS: together or not at all. A line
  /// nothing rewrote has nothing to refuse, so there is no state holding an
  /// address with no comparison to show, and none holding a comparison with no
  /// address. Read it from here rather than hardcoding the key — the server
  /// allow-lists which answers may be re-sourced, and a key it rejects is a 400.
  final String? ownWordsKey;

  /// True when the worker can actually ACT on the comparison — both the words
  /// to show and the address to send the refusal to.
  bool get canRefuseRewrite =>
      hasOwnWords && ownWordsKey != null && ownWordsKey!.isNotEmpty;

  /// True when [work] is a rewrite and there is something to show the worker.
  /// Server omits [workOwnWords] when the two are equal, so this is a null
  /// check, not a string compare.
  bool get hasOwnWords =>
      workOwnWords != null && workOwnWords!.trim().isNotEmpty;

  factory ResumeExperienceLineDto.fromJson(Map<String, dynamic> json) =>
      ResumeExperienceLineDto(
        role: json['role'] as String? ?? '',
        duration: json['duration'] as String? ?? '',
        work: json['work'] as String? ?? '',
        workOwnWords: json['work_own_words'] as String?,
        ownWordsKey: json['own_words_key'] as String?,
      );

  @override
  List<Object?> get props =>
      <Object?>[role, duration, work, workOwnWords, ownWordsKey];
}

/// The masthead both document formats share — name / phone / trust badge
/// (`ResumeDocumentHeader`). PII posture: this is the worker's OWN data,
/// mirrored back to them on their own resume tab on their own device — the
/// same self-read the existing [ResumeFieldsDto] name/photo already is.
class ResumeDocumentHeaderDto extends Equatable {
  const ResumeDocumentHeaderDto({this.name, this.phone, this.trustBadge});

  final String? name;
  final String? phone;

  /// The masthead's right-hand slot: the printable badge string
  /// ("BadaBhai Verified") when the server ATTESTS this worker, null for
  /// everything else (self-declared, employer-rated, unverified, unknown, or
  /// no rendered document yet). NEVER a raw tier id — the server sends the
  /// already-humanised label or nothing at all
  /// (`apps/api/src/resume/verification-tier.ts`).
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
/// [key] / [rank] ARE ON THE WIRE and are now parsed (additively, both
/// nullable). Server-side they are described as provenance the PDF renderer
/// never reads — they exist so the degradation ladder can order rows without
/// re-deriving the trade map — but the UI kit v3 resume tab needs a
/// TRADE-AGNOSTIC way to decide which card a row belongs in (machines vs
/// controllers vs materials vs operations). The alternative was matching the
/// English label text, which breaks the moment a welder's sheet calls its
/// chip row "Processes" instead of "Machines".
///
/// Read them as a HINT, never a requirement: an absent key (every `factRows`
/// entry on the terms/qualification zones has none) or an unknown key must
/// still render, under its own [label]. See `resume_card_slots.dart`, which
/// owns that mapping and its generic fallback. Formalizing the contract
/// server-side is backend gap B6.
class ResumeListRowDto extends Equatable {
  const ResumeListRowDto({
    this.label = '',
    this.values = const <String>[],
    this.key,
    this.rank,
  });

  final String label;
  final List<String> values;

  /// The attribute id behind this row (`turning_machine`, `controller_brand`,
  /// …). A RAW SLUG — never rendered; it only selects a card slot.
  final String? key;

  /// The server's own print order within its zone. Null when absent.
  final int? rank;

  factory ResumeListRowDto.fromJson(Map<String, dynamic> json) {
    final List<dynamic> raw =
        json['values'] as List<dynamic>? ?? const <dynamic>[];
    return ResumeListRowDto(
      label: json['label'] as String? ?? '',
      values: raw.whereType<String>().toList(growable: false),
      key: json['key'] as String?,
      rank: (json['rank'] as num?)?.toInt(),
    );
  }

  @override
  List<Object?> get props => <Object?>[label, values, key, rank];
}

/// A labelled single-value row on a `format: "trade_sheet"` section — a
/// definition row on the printed sheet (`factRows`).
///
/// [key] / [rank] are parsed on the same additive, nullable terms as
/// [ResumeListRowDto]'s. Note that the terms and qualification zones build
/// their fact rows through a plain `push(rows, label, value)` with NO key at
/// all (backend gap B7), so a null key here is the COMMON case, not an
/// anomaly — which is why the salary box still has to match on the label.
class ResumeFactRowDto extends Equatable {
  const ResumeFactRowDto({
    this.label = '',
    this.value = '',
    this.key,
    this.rank,
  });

  final String label;
  final String value;

  /// The attribute id behind this row (`drawing_reading`, `tolerance_band`,
  /// …). A RAW SLUG — never rendered.
  final String? key;
  final int? rank;

  factory ResumeFactRowDto.fromJson(Map<String, dynamic> json) =>
      ResumeFactRowDto(
        label: json['label'] as String? ?? '',
        value: json['value'] as String? ?? '',
        key: json['key'] as String?,
        rank: (json['rank'] as num?)?.toInt(),
      );

  @override
  List<Object?> get props => <Object?>[label, value, key, rank];
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
  const ResumeDocument({required this.header, this.footerMeta, this.source});

  final ResumeDocumentHeaderDto header;

  /// The masthead-matching footer line the sheet prints ("Generated 27 August
  /// 2026 · Ref RK8M2Q"). Null on a document with nothing to print there.
  final String? footerMeta;

  /// The profiling ROAD that produced this resume (`source`): `"form"` | `"chat"`
  /// | null. NOT the layout — [format] stays `trade_sheet`/`generic` for old
  /// consumers, and a chat-road résumé renders as its own type even when the
  /// trade has an authored sheet. Null = unknown (old server / pre-migration
  /// row) → the caller keeps today's layout-by-format behaviour, byte for byte.
  final String? source;

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

  /// Only the two known roads; anything else (or absent) is null = unknown.
  static String? sourceFrom(Map<String, dynamic> json) => switch (json['source']) {
        'form' => 'form',
        'chat' => 'chat',
        _ => null,
      };

  static ResumeDocumentHeaderDto _headerFrom(Map<String, dynamic> json) {
    final Map<String, dynamic>? raw = json['header'] as Map<String, dynamic>?;
    return raw == null
        ? const ResumeDocumentHeaderDto()
        : ResumeDocumentHeaderDto.fromJson(raw);
  }

  @override
  List<Object?> get props => <Object?>[header, footerMeta, source];
}

/// `format: "generic"` — the flat, twelve-layout résumé every worker with no
/// trade sheet renders (`classic`/`modern`/`minimal`/`fallback`).
class GenericResumeDocument extends ResumeDocument {
  const GenericResumeDocument({
    required super.header,
    super.footerMeta,
    super.source,
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
      source: ResumeDocument.sourceFrom(json),
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
    super.source,
    required this.trade,
    this.headline = const ResumeSheetHeadlineDto(),
    this.sections = const <ResumeDocumentSectionDto>[],
    this.employments = const <ResumeEmploymentDto>[],
    this.employmentsMore,
    this.experiences = const <ResumeExperienceLineDto>[],
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

  /// The TRAINING block a fresher has instead of a work history (#1476).
  ///
  /// The sheet did not carry this before, and the omission had a cost: the
  /// fresher's `iti_project_work` sentence printed on the PDF an employer
  /// reads while his own resume tab showed nothing of it — so the one person
  /// able to say whether a sentence about his training is true never saw it.
  ///
  /// Empty for a worker who has [employments]; the two are alternatives.
  final List<ResumeExperienceLineDto> experiences;

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
      source: ResumeDocument.sourceFrom(json),
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
      experiences: (json['experiences'] as List<dynamic>? ?? const <dynamic>[])
          .whereType<Map<String, dynamic>>()
          .map(ResumeExperienceLineDto.fromJson)
          .toList(growable: false),
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
        experiences,
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
    this.renderStatus,
    this.renderedAt,
  });

  final String resumeId;
  final int version;
  final ResumeDocument? document;

  /// THE PDF's REAL STATE: `'pending' | 'rendered' | 'failed'`, straight from
  /// `resumes.render_status` (apps/api resume.service.ts `myDocument`). Null
  /// when the server did not send it (an older build).
  ///
  /// It exists here so the resume tab can stop CLAIMING the PDF is ready.
  /// "Resume taiyaar ✓" was painted off the resume TEXT, which says nothing
  /// about whether a PDF exists — so a worker saw a green success mark and
  /// then got "PDF taiyaar ho rahi hai…" when they tapped Download. The READY
  /// pill is now gated on `'rendered'` and on nothing else (ruling R6).
  ///
  /// A raw enum token — NEVER rendered. The screen maps it to a pill or to
  /// no pill at all.
  final String? renderStatus;

  /// When that render finished. Null while pending, on a failure, or when the
  /// server omits it. Parsed leniently: an unparseable timestamp degrades to
  /// null rather than throwing away the whole document.
  final DateTime? renderedAt;

  /// True only when the server SAYS the PDF is rendered. Absent / pending /
  /// failed / an unrecognised value are all "not rendered" — this fails
  /// closed, because the cost of being wrong is telling a worker their resume
  /// is ready to send when it is not.
  bool get isRendered => renderStatus == 'rendered';

  factory ResumeDocumentResponse.fromJson(Map<String, dynamic> json) {
    final Map<String, dynamic>? doc =
        json['document'] as Map<String, dynamic>?;
    final String? renderedAtRaw = json['rendered_at'] as String?;
    return ResumeDocumentResponse(
      resumeId: json['resume_id'] as String? ?? '',
      version: (json['version'] as num?)?.toInt() ?? 1,
      document: doc == null ? null : ResumeDocument.fromJson(doc),
      renderStatus: json['render_status'] as String?,
      renderedAt:
          renderedAtRaw == null ? null : DateTime.tryParse(renderedAtRaw),
    );
  }

  @override
  List<Object?> get props =>
      <Object?>[resumeId, version, document, renderStatus, renderedAt];
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
/// One entry of `WorkPrefOptionsDto.cities` (#1406/#1410) — the preferred-city
/// gazetteer. Unlike the four label maps above, a city has no slug layer:
/// [value] is BOTH what the chip shows and what `preferred_cities` must send
/// (the server's `worker-cities.catalogue.ts` guarantees every [value]
/// round-trips through the same validator that rejects free text). [aliases]
/// are lowercase SEARCH KEYS ONLY ("dilli", "bombay", "banglore", "poona") —
/// never rendered, never submitted; they exist so a worker typing the name
/// they actually use still finds the city the résumé prints.
class CityOptionDto extends Equatable {
  const CityOptionDto({
    required this.value,
    required this.aliases,
    this.state = '',
  });

  final String value;
  final List<String> aliases;

  /// The state/UT this city is in (#1429) — a member of
  /// [WorkPrefOptionsDto.states], by exact string equality. PURELY a filter
  /// key for a state-then-city cascade; never part of the
  /// `preferred_cities` write contract, which still submits [value] alone.
  final String state;

  factory CityOptionDto.fromJson(Map<String, dynamic> json) => CityOptionDto(
        value: json['value'] as String? ?? '',
        aliases: (json['aliases'] as List<dynamic>?)
                ?.whereType<String>()
                .toList() ??
            const <String>[],
        state: json['state'] as String? ?? '',
      );

  @override
  List<Object?> get props => <Object?>[value, aliases, state];
}

/// One curated industrial HUB on `GET /workers/me/work-preferences/options`
/// (`city_hubs`) — BACKEND-PENDING, see issue #1634.
///
/// A hub groups one or more industrial areas under a single tappable place
/// (e.g. display `Pune`, areas `["Chakan", "Bhosari MIDC"]`). It is a PICK
/// SHORTCUT, not a second write contract: [cityValue] is the canonical city
/// submitted in `preferred_cities`, exactly like [CityOptionDto.value], so a
/// hub tap is the same write a city chip makes. [state] is a member of
/// [WorkPrefOptionsDto.states] (the cascade key), and [areas] is display-only
/// text the résumé never prints.
///
/// ABSENT UNTIL THE BACKEND SHIPS IT: the options response omits `city_hubs`,
/// [WorkPrefOptionsDto.cityHubs] stays empty, and the picker falls back to the
/// state→city cascade that exists today. Parsing is tolerant for the same
/// reason — an unknown/malformed hub is dropped, never thrown.
class CityHubDto extends Equatable {
  const CityHubDto({
    required this.cityValue,
    required this.display,
    this.state = '',
    this.areas = const <String>[],
    this.hubKey = '',
    this.popular = false,
  });

  /// The canonical city this hub submits (must round-trip the server's
  /// `canonicalCity`; never a raw label).
  final String cityValue;

  /// What the card shows (e.g. `Pune`, `Mumbai / Thane`).
  final String display;

  /// The state this hub belongs to — a member of the served `states`.
  final String state;

  /// Display-only industrial-area sub-label (e.g. `Chakan, Bhosari MIDC`).
  final List<String> areas;

  /// Stable slug for one-tap idempotency/analytics; may be empty on a
  /// partial contract.
  final String hubKey;

  /// Whether this hub belongs to the "POPULAR FACTORY HUBS" row.
  final bool popular;

  factory CityHubDto.fromJson(Map<String, dynamic> json) => CityHubDto(
        cityValue: (json['city_value'] as String?)?.trim() ?? '',
        display: (json['display'] as String?)?.trim() ?? '',
        state: (json['state'] as String?)?.trim() ?? '',
        areas: (json['areas'] as List<dynamic>?)
                ?.whereType<String>()
                .map((String a) => a.trim())
                .where((String a) => a.isNotEmpty)
                .toList() ??
            const <String>[],
        hubKey: (json['hub_key'] as String?)?.trim() ?? '',
        popular: json['popular'] == true,
      );

  @override
  List<Object?> get props =>
      <Object?>[cityValue, display, state, areas, hubKey, popular];
}

/// GET /workers/me/work-preferences (#1504) — the caller's STORED answers in
/// the PUT's own field names. `null` means no stored row; `[]` means a stored
/// "none of these" — kept apart because a client that coalesced them and saved
/// would clear every list the worker never answered.
///
/// Only the fields the profile/resume surface READS are parsed here; the write
/// path carries the full tri-state body separately.
class WorkPreferencesDto extends Equatable {
  const WorkPreferencesDto({
    this.languages,
    this.workTypes,
    this.jobType,
    this.commuteKm,
    this.willingToTravel,
    this.salaryPeriod,
    this.availability,
    this.partial = const <String>[],
  });

  /// Stored language slugs (chat-captured or form), or null when no row.
  final List<String>? languages;

  /// Stored multi work types (#1559), or null when no row. When non-empty it
  /// WINS over [jobType] server-side (see `worker-field-precedence.ts`).
  final List<String>? workTypes;

  /// The legacy single job type — the fallback for rows that predate
  /// `work_types`. Never shown alongside a non-empty [workTypes].
  final String? jobType;

  /// Stored commute distance in km (#1587, v4 elicitation), or null when no
  /// row. A number on the wire; the screen adds the unit.
  final int? commuteKm;

  /// Stored travel willingness (#1587). Only `true` ever prints (same rule as
  /// the sheet: `false` withdraws a claim); null when no row.
  final bool? willingToTravel;

  /// Stored salary-period slug (#1587: `month` | `day` | `year`), or null when
  /// no row. Labels come from [kSalaryPeriodLabels], mirroring the server's
  /// `SALARY_PERIODS` (the options endpoint does not serve this dictionary).
  final String? salaryPeriod;

  /// The stored structured availability object (#1587), or null when no row.
  /// `available_from` is the worker's stated day printed as stated (day
  /// precision, no timezone arithmetic — same rule as the server).
  final WorkAvailabilityDto? availability;

  /// Wire keys whose stored value was withheld; a client must not re-send.
  final List<String> partial;

  static List<String>? _slugList(Object? raw) {
    if (raw is! List) return null;
    return raw.whereType<String>().toList();
  }

  factory WorkPreferencesDto.fromJson(Map<String, dynamic> json) {
    final Map<String, dynamic> values =
        (json['values'] as Map<String, dynamic>?) ?? <String, dynamic>{};
    final Object? availabilityRaw = values['availability'];
    return WorkPreferencesDto(
      languages: _slugList(values['languages']),
      workTypes: _slugList(values['work_types']),
      jobType: values['job_type'] as String?,
      commuteKm: (values['commute_max_km'] as num?)?.toInt(),
      willingToTravel: values['willing_to_travel'] as bool?,
      salaryPeriod: values['salary_period'] as String?,
      availability: availabilityRaw is Map<String, dynamic>
          ? WorkAvailabilityDto.fromJson(availabilityRaw)
          : null,
      partial: (json['partial'] as List<dynamic>?)
              ?.whereType<String>()
              .toList() ??
          const <String>[],
    );
  }

  @override
  List<Object?> get props => <Object?>[
        languages,
        workTypes,
        jobType,
        commuteKm,
        willingToTravel,
        salaryPeriod,
        availability,
        partial,
      ];
}

/// One stored availability object (`availability` json attribute).
class WorkAvailabilityDto extends Equatable {
  const WorkAvailabilityDto({
    this.status,
    this.availableFrom,
    this.noticeDays,
  });

  /// Closed status slug (`immediate` | `within_week` | `within_month` |
  /// `serving_notice`), or null when unset. Labels come from
  /// [kAvailabilityStatusLabels], mirroring the server's
  /// `AVAILABILITY_STATUSES` (the options endpoint does not serve it).
  final String? status;

  /// The worker's stated day, `YYYY-MM-DD`, printed as stated.
  final String? availableFrom;

  /// Notice period in days (0–180 server-side), or null when unset.
  final int? noticeDays;

  factory WorkAvailabilityDto.fromJson(Map<String, dynamic> json) =>
      WorkAvailabilityDto(
        status: json['status'] as String?,
        availableFrom: json['available_from'] as String?,
        noticeDays: (json['notice_period_days'] as num?)?.toInt(),
      );

  @override
  List<Object?> get props => <Object?>[status, availableFrom, noticeDays];
}

/// Printable labels for the two tiny closed vocabularies the options endpoint
/// does NOT serve (#1587).
///
/// A deliberate, documented mirror of the server dictionaries
/// (`SALARY_PERIODS` / `AVAILABILITY_STATUSES` in
/// `apps/api/src/profiles/worker-preferences.vocabulary.ts`) — the same
/// precedent as `_kTradeLabels` in `trade_key_label.dart` for small stable
/// sets. Unknown slugs fall back to [_humanizeSlug]-style title-casing at the
/// call site, never a raw `snake_case` id.
const Map<String, String> kSalaryPeriodLabels = <String, String>{
  'month': 'Mahina',
  'day': 'Din',
  'year': 'Saal',
};

const Map<String, String> kAvailabilityStatusLabels = <String, String>{
  'immediate': 'Turant uplabdh',
  'within_week': 'Ek hafte mein',
  'within_month': 'Ek mahine mein',
  'serving_notice': 'Notice period mein',
};

class WorkPrefOptionsDto extends Equatable {
  const WorkPrefOptionsDto({
    required this.languages,
    required this.documentsReady,
    required this.jobType,
    required this.shift,
    this.cities = const <CityOptionDto>[],
    this.states = const <String>[],
    this.cityHubs = const <CityHubDto>[],
  });

  final Map<String, String> languages;
  final Map<String, String> documentsReady;
  final Map<String, String> jobType;
  final Map<String, String> shift;
  final List<CityOptionDto> cities;

  /// The state/UT picker list (#1429), in server order — the same strings
  /// [CityOptionDto.state] carries, so filtering a city list to one state is
  /// plain string equality with no lookup table of its own.
  final List<String> states;

  /// The curated industrial hubs (#1634), or empty until the backend serves
  /// `city_hubs`. ADDITIVE: a client that ignores it renders the state→city
  /// cascade exactly as before.
  final List<CityHubDto> cityHubs;

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

  static List<CityOptionDto> _cityList(dynamic raw) {
    if (raw is! List) return const <CityOptionDto>[];
    return raw
        .whereType<Map<String, dynamic>>()
        .map(CityOptionDto.fromJson)
        .where((CityOptionDto c) => c.value.isNotEmpty)
        .toList();
  }

  static List<CityHubDto> _hubList(dynamic raw) {
    if (raw is! List) return const <CityHubDto>[];
    return raw
        .whereType<Map<String, dynamic>>()
        .map(CityHubDto.fromJson)
        // A hub with no submittable city is unusable — drop it rather than
        // offer a card that would 400 on save.
        .where((CityHubDto h) => h.cityValue.isNotEmpty)
        .toList();
  }

  factory WorkPrefOptionsDto.fromJson(Map<String, dynamic> json) =>
      WorkPrefOptionsDto(
        languages: _labelMap(json['languages']),
        documentsReady: _labelMap(json['documents_ready']),
        jobType: _labelMap(json['job_type']),
        shift: _labelMap(json['shift']),
        cities: _cityList(json['cities']),
        states: (json['states'] as List<dynamic>?)
                ?.whereType<String>()
                .toList() ??
            const <String>[],
        cityHubs: _hubList(json['city_hubs']),
      );

  @override
  List<Object?> get props => <Object?>[
        languages,
        documentsReady,
        jobType,
        shift,
        cities,
        states,
        cityHubs,
      ];
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

/// Result of POST /workers/me/photo/upload-url (ADR-0032) — a signed slot for
/// the profile-photo bytes. An ALIAS of [SignedUploadTicket], same argument as
/// [VoiceUploadTicket].
typedef PhotoUploadTicket = SignedUploadTicket;

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
    this.source,
  });

  /// `"none"` when the worker has no profile row yet; else a ProfileStatus.
  final String profileStatus;

  /// The road that produced the profile (`source`): `"form"` | `"chat"` | null.
  /// Null = unknown (a pre-migration row / no profile) — NEVER guessed from the
  /// trade or a photo. Additive; older backends omit the key.
  final String? source;

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
      // Only the two known roads; anything else (or absent) is null = unknown.
      source: switch (json['source']) {
        'form' => 'form',
        'chat' => 'chat',
        _ => null,
      },
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
        source,
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

// ---- Résumé import (#1499 / ADR-0041) ------------------------------------
// The three flat wire shapes of `POST /profiling/resume-import/upload-url`,
// `POST /profiling/resume-import` and `GET /profiling/resume-import/:id`.
// Flat enough to parse here rather than in the feature (unlike the trade
// form's nested tree, which the feature owns).

/// Where an import has got to, server-side. `uploaded` → `parsing` →
/// `parsed` | `failed`, with `discarded` reserved for an import the worker's
/// erasure removed.
///
/// [unknown] exists because this list can grow server-side and a value this
/// build has never heard of must not crash a worker mid-onboarding — it reads
/// as "not a terminal state I can act on", which sends him to the chat.
enum ResumeImportStatus { uploaded, parsing, parsed, failed, discarded, unknown }

/// Which surface the server decided the worker should land on.
///
/// NULL UNTIL PARSING FINISHES, so this is nullable on [ResumeImportDto] and
/// must never be defaulted to one of the two values while the import is still
/// in flight — a default would send the worker somewhere before the decision
/// that picks it has been made.
enum ResumeImportRoute { form, chat }

/// `{import_id, status, route, form_kind, failure_reason}` — the single shape
/// both `POST /profiling/resume-import` and `GET /profiling/resume-import/:id`
/// return.
///
/// NOTE WHAT IS ABSENT, on purpose, mirroring the server's own docblock: no
/// storage key and no extracted content. The client already holds the key from
/// the mint, and a field that exists is a field that ends up in a log.
///
/// [failureReason] is a CLOSED server vocabulary (`no_text_layer`,
/// `ocr_below_floor`, …) and is NEVER rendered: it is machine cause, not worker
/// copy. The screen maps any failure to one honest line (ruling D9). It is
/// carried here only so a caller can tell "failed" from "still going".
class ResumeImportDto extends Equatable {
  const ResumeImportDto({
    required this.importId,
    required this.status,
    this.route,
    this.formKind,
    this.failureReason,
    this.yieldedNothing,
    this.fieldsExtracted,
  });

  final String importId;
  final ResumeImportStatus status;
  final ResumeImportRoute? route;

  /// The trade-form pack the résumé routed to, when [route] is
  /// [ResumeImportRoute.form]. Null otherwise — only 9 of 21 trades have a
  /// form at all, so null here is the ordinary case rather than an error.
  final String? formKind;
  final String? failureReason;

  /// #1660 — did this import extract ANYTHING?
  ///
  /// A `parsed` + `route: chat` + `failure_reason: null` row is a clean success
  /// by every other field on the wire, and is exactly what a spend cap, a
  /// citation-gated document or a résumé carrying none of the eight target
  /// fields also produces. Without this the client cannot tell a productive
  /// import from one that learned nothing, so the worker lands in the ordinary
  /// interview with NOTHING said — the silence ruling D9 forbids.
  ///
  /// TWO SHAPES ARE ACCEPTED because the read is still gaining the field
  /// (backend #1656): an explicit `yielded_nothing` boolean, or the
  /// `fields_extracted` count the `profile.resume_parsed` event already carries.
  /// BOTH ABSENT → null → today's behaviour exactly, so an older server (and
  /// the build in front of this one) is unaffected.
  final bool? yieldedNothing;
  final int? fieldsExtracted;

  /// True only when the server SAID so, one way or the other. Null-safe by
  /// design: an unknown extraction count is never read as "nothing", because
  /// telling a worker his résumé gave us nothing when it may have given us
  /// everything is its own lie.
  bool get learnedNothing =>
      yieldedNothing == true || (fieldsExtracted != null && fieldsExtracted == 0);

  /// True once the server will never change this row again — the only point at
  /// which polling may stop.
  bool get isTerminal =>
      status == ResumeImportStatus.parsed ||
      status == ResumeImportStatus.failed ||
      status == ResumeImportStatus.discarded;

  bool get hasFailed =>
      status == ResumeImportStatus.failed ||
      status == ResumeImportStatus.discarded;

  factory ResumeImportDto.fromJson(Map<String, dynamic> json) => ResumeImportDto(
        importId: json['import_id'] as String? ?? '',
        status: _resumeImportStatus(json['status'] as String?),
        route: _resumeImportRoute(json['route'] as String?),
        formKind: json['form_kind'] as String?,
        failureReason: json['failure_reason'] as String?,
        yieldedNothing: json['yielded_nothing'] as bool?,
        fieldsExtracted: (json['fields_extracted'] as num?)?.toInt(),
      );

  @override
  List<Object?> get props => <Object?>[
        importId,
        status,
        route,
        formKind,
        failureReason,
        yieldedNothing,
        fieldsExtracted,
      ];
}

ResumeImportStatus _resumeImportStatus(String? raw) => switch (raw) {
      'uploaded' => ResumeImportStatus.uploaded,
      'parsing' => ResumeImportStatus.parsing,
      'parsed' => ResumeImportStatus.parsed,
      'failed' => ResumeImportStatus.failed,
      'discarded' => ResumeImportStatus.discarded,
      _ => ResumeImportStatus.unknown,
    };

/// Anything that is not one of the two known routes — INCLUDING null, which is
/// what the server sends until a parse has actually run — is null here. Never
/// guessed at.
ResumeImportRoute? _resumeImportRoute(String? raw) => switch (raw) {
      'form' => ResumeImportRoute.form,
      'chat' => ResumeImportRoute.chat,
      _ => null,
    };

// ---- Layer A profile surfaces (ADR-0042 D9, issue #1545) ------------------
//
// The flat wire shapes of the additive Layer A endpoints the app gained after
// the universal-profile programme: WhatsApp, richer languages, secondary
// occupations, trainings + licence fields, and the portfolio. Each GET mirrors
// its PUT's own entry shapes so the body round-trips, and each is PII-aware:
// never logged, never held longer than the screen needs it.

/// `GET /workers/me/whatsapp` — the worker's OWN number, decrypted.
///
/// [whatsapp] is null when nothing is on file OR when the stored token cannot
/// be decrypted; [hasWhatsapp] tells the two apart so a client never offers to
/// replace a number that merely failed to read. PII — never logged.
class MyWhatsappDto extends Equatable {
  const MyWhatsappDto({this.whatsapp, this.hasWhatsapp = false});

  final String? whatsapp;
  final bool hasWhatsapp;

  factory MyWhatsappDto.fromJson(Map<String, dynamic> json) => MyWhatsappDto(
        whatsapp: json['whatsapp'] as String?,
        hasWhatsapp: json['has_whatsapp'] as bool? ?? false,
      );

  @override
  List<Object?> get props => <Object?>[whatsapp, hasWhatsapp];
}

/// One language and the three independent abilities (Layer A (b), migration
/// 0110). `can_speak` is NOT implied by the other two — a worker who reads
/// English manuals but does not speak it is a real case, so each tick is its
/// own boolean. [language] is a slug from the server's closed 16-language set.
class LanguageAbilityDto extends Equatable {
  const LanguageAbilityDto({
    required this.language,
    this.canSpeak = false,
    this.canRead = false,
    this.canWrite = false,
  });

  final String language;
  final bool canSpeak;
  final bool canRead;
  final bool canWrite;

  LanguageAbilityDto copyWith({
    String? language,
    bool? canSpeak,
    bool? canRead,
    bool? canWrite,
  }) {
    return LanguageAbilityDto(
      language: language ?? this.language,
      canSpeak: canSpeak ?? this.canSpeak,
      canRead: canRead ?? this.canRead,
      canWrite: canWrite ?? this.canWrite,
    );
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'language': language,
        'can_speak': canSpeak,
        'can_read': canRead,
        'can_write': canWrite,
      };

  factory LanguageAbilityDto.fromJson(Map<String, dynamic> json) =>
      LanguageAbilityDto(
        language: json['language'] as String? ?? '',
        canSpeak: json['can_speak'] as bool? ?? false,
        canRead: json['can_read'] as bool? ?? false,
        canWrite: json['can_write'] as bool? ?? false,
      );

  @override
  List<Object?> get props => <Object?>[language, canSpeak, canRead, canWrite];
}

/// `GET /workers/me/languages`.
///
/// [partial] is true when a stored row no longer parses and was WITHHELD — the
/// client must not PUT the list back unedited while this is set, or the PUT's
/// replace-all semantics would erase the withheld row. [droppedCount] is how
/// many rows were withheld.
class MyLanguagesDto extends Equatable {
  const MyLanguagesDto({
    this.languages = const <LanguageAbilityDto>[],
    this.partial = false,
    this.droppedCount = 0,
  });

  final List<LanguageAbilityDto> languages;
  final bool partial;
  final int droppedCount;

  factory MyLanguagesDto.fromJson(Map<String, dynamic> json) => MyLanguagesDto(
        languages: (json['languages'] as List<dynamic>?)
                ?.whereType<Map<String, dynamic>>()
                .map(LanguageAbilityDto.fromJson)
                .where((LanguageAbilityDto l) => l.language.isNotEmpty)
                .toList() ??
            const <LanguageAbilityDto>[],
        partial: json['partial'] as bool? ?? false,
        droppedCount: (json['dropped_count'] as num?)?.toInt() ?? 0,
      );

  @override
  List<Object?> get props => <Object?>[languages, partial, droppedCount];
}

/// One SECONDARY occupation (Layer A (f), migration 0114). [label] is
/// READ-ONLY decoration the server resolves from the taxonomy — the PUT schema
/// is `.strict()` on `role_id` only, so the label must never be echoed back.
class MyOccupationDto extends Equatable {
  const MyOccupationDto({required this.roleId, required this.label});

  final String roleId;
  final String label;

  factory MyOccupationDto.fromJson(Map<String, dynamic> json) => MyOccupationDto(
        roleId: json['role_id'] as String? ?? '',
        label: json['label'] as String? ?? '',
      );

  @override
  List<Object?> get props => <Object?>[roleId, label];
}

/// `GET /workers/me/occupations` — [partial]/[droppedCount] mirror the
/// languages read: a row whose id was retired from the taxonomy is withheld,
/// and re-sending the list unedited would erase it.
class MyOccupationsDto extends Equatable {
  const MyOccupationsDto({
    this.occupations = const <MyOccupationDto>[],
    this.partial = false,
    this.droppedCount = 0,
  });

  final List<MyOccupationDto> occupations;
  final bool partial;
  final int droppedCount;

  factory MyOccupationsDto.fromJson(Map<String, dynamic> json) =>
      MyOccupationsDto(
        occupations: (json['occupations'] as List<dynamic>?)
                ?.whereType<Map<String, dynamic>>()
                .map(MyOccupationDto.fromJson)
                .where((MyOccupationDto o) => o.roleId.isNotEmpty)
                .toList() ??
            const <MyOccupationDto>[],
        partial: json['partial'] as bool? ?? false,
        droppedCount: (json['dropped_count'] as num?)?.toInt() ?? 0,
      );

  @override
  List<Object?> get props => <Object?>[occupations, partial, droppedCount];
}

/// One course or training programme (Layer A (d), migration 0112). NOT a
/// certificate: a training is attendance ("3-month CNC operator course, Govt.
/// ITI, 2019") often with no document at all. Name is required; provider and
/// year are optional. [name]/[provider] are free text — never logged.
class TrainingEntryDto extends Equatable {
  const TrainingEntryDto({required this.name, this.provider, this.year});

  final String name;
  final String? provider;
  final int? year;

  static String? _trimOrNull(String? v) {
    final String? t = v?.trim();
    return (t == null || t.isEmpty) ? null : t;
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'name': name.trim(),
        'provider': _trimOrNull(provider),
        'year': year,
      };

  factory TrainingEntryDto.fromJson(Map<String, dynamic> json) => TrainingEntryDto(
        name: json['name'] as String? ?? '',
        provider: json['provider'] as String?,
        year: (json['year'] as num?)?.toInt(),
      );

  @override
  List<Object?> get props => <Object?>[name, provider, year];
}

/// One certificate row as the qualifications GET returns it (Layer A (d)). The
/// `licence_number`/`licence_expiry` fields are WORKER-SELF ONLY — never on the
/// résumé and never employer-visible — so the UI must keep them private in copy.
class CertificateEntryDto extends Equatable {
  const CertificateEntryDto({
    required this.name,
    this.issuer,
    this.year,
    this.licenceNumber,
    this.licenceExpiry,
  });

  final String name;
  final String? issuer;
  final int? year;

  /// PII (encrypted at rest server-side): letters/digits/`/`/`-`/space, ≤64.
  final String? licenceNumber;

  /// `YYYY-MM-DD`, worker-self only.
  final String? licenceExpiry;

  factory CertificateEntryDto.fromJson(Map<String, dynamic> json) =>
      CertificateEntryDto(
        name: json['name'] as String? ?? '',
        issuer: json['issuer'] as String?,
        year: (json['year'] as num?)?.toInt(),
        licenceNumber: json['licence_number'] as String?,
        licenceExpiry: json['licence_expiry'] as String?,
      );

  static String? _trimOrNull(String? v) {
    final String? t = v?.trim();
    return (t == null || t.isEmpty) ? null : t;
  }

  /// Wire shape for one `certificates[]` entry — the same keys the PUT and
  /// the corrections POST validate (`CertificateEntrySchema`). Licence
  /// fields round-trip verbatim: a corrections read-modify-write must never
  /// wipe worker-self PII the form never collects.
  Map<String, dynamic> toJson() => <String, dynamic>{
        'name': name.trim(),
        'issuer': _trimOrNull(issuer),
        'year': year,
        'licence_number': _trimOrNull(licenceNumber),
        'licence_expiry': _trimOrNull(licenceExpiry),
      };

  @override
  List<Object?> get props =>
      <Object?>[name, issuer, year, licenceNumber, licenceExpiry];
}

/// One schooling/trade credential row as the qualifications GET returns it.
class EducationEntryDto extends Equatable {
  const EducationEntryDto({
    this.credential,
    this.field,
    this.council,
    this.year,
    this.institute,
  });

  final String? credential;
  final String? field;
  final String? council;
  final int? year;
  final String? institute;

  factory EducationEntryDto.fromJson(Map<String, dynamic> json) =>
      EducationEntryDto(
        credential: json['credential'] as String?,
        field: json['field'] as String?,
        council: json['council'] as String?,
        year: (json['year'] as num?)?.toInt(),
        institute: json['institute'] as String?,
      );

  static String? _trimOrNull(String? v) {
    final String? t = v?.trim();
    return (t == null || t.isEmpty) ? null : t;
  }

  /// Wire shape for one `educations[]` entry — the PUT's own keys, which the
  /// corrections POST reuses verbatim (`EducationEntrySchema`).
  Map<String, dynamic> toJson() => <String, dynamic>{
        'credential': _trimOrNull(credential),
        'field': _trimOrNull(field),
        'council': _trimOrNull(council),
        'year': year,
        'institute': _trimOrNull(institute),
      };

  @override
  List<Object?> get props =>
      <Object?>[credential, field, council, year, institute];
}

/// `GET /workers/me/qualifications` — the PUT's own entry shapes so the body
/// round-trips. [partial] names the list(s) that lost a withheld row; a client
/// must not re-send such a list unedited.
class MyQualificationsDto extends Equatable {
  const MyQualificationsDto({
    this.certificates = const <CertificateEntryDto>[],
    this.educations = const <EducationEntryDto>[],
    this.trainings = const <TrainingEntryDto>[],
    this.partial = const <String>[],
    this.droppedCount = 0,
  });

  final List<CertificateEntryDto> certificates;
  final List<EducationEntryDto> educations;
  final List<TrainingEntryDto> trainings;
  final List<String> partial;
  final int droppedCount;

  factory MyQualificationsDto.fromJson(Map<String, dynamic> json) =>
      MyQualificationsDto(
        certificates: (json['certificates'] as List<dynamic>?)
                ?.whereType<Map<String, dynamic>>()
                .map(CertificateEntryDto.fromJson)
                .toList() ??
            const <CertificateEntryDto>[],
        educations: (json['educations'] as List<dynamic>?)
                ?.whereType<Map<String, dynamic>>()
                .map(EducationEntryDto.fromJson)
                .toList() ??
            const <EducationEntryDto>[],
        trainings: (json['trainings'] as List<dynamic>?)
                ?.whereType<Map<String, dynamic>>()
                .map(TrainingEntryDto.fromJson)
                .toList() ??
            const <TrainingEntryDto>[],
        partial: (json['partial'] as List<dynamic>?)
                ?.whereType<String>()
                .toList() ??
            const <String>[],
        droppedCount: (json['dropped_count'] as num?)?.toInt() ?? 0,
      );

  @override
  List<Object?> get props =>
      <Object?>[certificates, educations, trainings, partial, droppedCount];
}

/// POST /profile/corrections (#1595 — the client half of #1593): correct the
/// EXTRACTED profile (skills/machines/experience/education/certificates),
/// anchored to a pinned interview session.
///
/// §1.2 holds client-side by construction: the union carries structured
/// fields only — canonical id lists, a bounded integer, or full entry lists
/// in the PUT's own shapes. There is deliberately NO free-text member: a
/// rendered line can never be overridden, and ids are never invented or
/// humanized here (the closed vocabularies live server-side in
/// `@badabhai/taxonomy`).
///
/// Bounds mirror `extracted-corrections.contract.ts`: 1–5 corrections per
/// request (unique fields), skill lists ≤ 50, machine lists ≤ 32,
/// `total_years` 0–60, lifetime cap 20. The cubit validates before sending.
///
/// NOTE (skills/machines UI): the two id-list arms have no affordance yet —
/// the extracted labels carry no canonical ids and there is no
/// worker-facing catalogue read to select from (backend #1596 tracks the
/// additive catalogue endpoint). Until it ships, the review surface shows
/// those sections read-only rather than invent ids client-side.
sealed class ExtractedCorrection extends Equatable {
  const ExtractedCorrection();

  /// The `field` discriminator the DTO switches on.
  String get field;

  /// The correction body MINUS the discriminator (the caller adds `field`).
  Map<String, dynamic> toJson();
}

/// `{field: "skills", skill_ids: [...]}` — canonical `skill_*` ids only.
class SkillsCorrection extends ExtractedCorrection {
  const SkillsCorrection(this.skillIds);

  final List<String> skillIds;

  @override
  String get field => 'skills';

  @override
  Map<String, dynamic> toJson() => <String, dynamic>{
        'field': field,
        'skill_ids': List<String>.unmodifiable(skillIds),
      };

  @override
  List<Object?> get props => <Object?>[skillIds];
}

/// `{field: "machines", machine_ids: [...]}` — canonical `mach_*` ids only.
class MachinesCorrection extends ExtractedCorrection {
  const MachinesCorrection(this.machineIds);

  final List<String> machineIds;

  @override
  String get field => 'machines';

  @override
  Map<String, dynamic> toJson() => <String, dynamic>{
        'field': field,
        'machine_ids': List<String>.unmodifiable(machineIds),
      };

  @override
  List<Object?> get props => <Object?>[machineIds];
}

/// `{field: "experience", total_years: <int 0–60>}` — worker-stated total.
class ExperienceCorrection extends ExtractedCorrection {
  const ExperienceCorrection(this.totalYears);

  final int totalYears;

  @override
  String get field => 'experience';

  @override
  Map<String, dynamic> toJson() => <String, dynamic>{
        'field': field,
        'total_years': totalYears,
      };

  @override
  List<Object?> get props => <Object?>[totalYears];
}

/// `{field: "education", educations: [...]}` — the FULL corrected list
/// (replace semantics, like the finishing PUT).
class EducationCorrection extends ExtractedCorrection {
  const EducationCorrection(this.educations);

  final List<EducationEntryDto> educations;

  @override
  String get field => 'education';

  @override
  Map<String, dynamic> toJson() => <String, dynamic>{
        'field': field,
        'educations': educations.map((e) => e.toJson()).toList(),
      };

  @override
  List<Object?> get props => <Object?>[educations];
}

/// `{field: "certificates", certificates: [...]}` — same full-list rule.
class CertificatesCorrection extends ExtractedCorrection {
  const CertificatesCorrection(this.certificates);

  final List<CertificateEntryDto> certificates;

  @override
  String get field => 'certificates';

  @override
  Map<String, dynamic> toJson() => <String, dynamic>{
        'field': field,
        'certificates': certificates.map((c) => c.toJson()).toList(),
      };

  @override
  List<Object?> get props => <Object?>[certificates];
}

/// POST /profile/corrections response — counts only, never values (like
/// every sibling PUT response). The client re-reads the existing GETs to
/// show updated values.
class CorrectionsApplied extends Equatable {
  const CorrectionsApplied({
    required this.profileId,
    required this.correctionsApplied,
    required this.correctionCount,
  });

  final String profileId;
  final int correctionsApplied;

  /// Lifetime count AFTER this request — the cap meter.
  final int correctionCount;

  factory CorrectionsApplied.fromJson(Map<String, dynamic> json) =>
      CorrectionsApplied(
        profileId: json['profile_id'] as String? ?? '',
        correctionsApplied:
            (json['corrections_applied'] as num?)?.toInt() ?? 0,
        correctionCount: (json['correction_count'] as num?)?.toInt() ?? 0,
      );

  @override
  List<Object?> get props =>
      <Object?>[profileId, correctionsApplied, correctionCount];
}

/// Lifetime correction budget, mirroring `MAX_CORRECTIONS_PER_PROFILE`.
const int kMaxCorrectionsPerProfile = 20;

/// Stable 409 reason codes — the server embeds these verbatim in the
/// ConflictException message (see `extracted-corrections.service.ts`).
const String kCorrectionsUnpinnedRoadDeferred = 'unpinned_road_deferred';
const String kCorrectionsCapReached = 'correction_cap_reached';

/// Which stable reason a POST /profile/corrections 409 carries. Matches on
/// the embedded codes, never on prose (prose is human, codes are contract).
enum CorrectionRejected { unpinnedRoadDeferred, capReached, other }

CorrectionRejected correctionRejectedOf(ApiException error) {
  if (error.statusCode != 409) return CorrectionRejected.other;
  final Object? wire = error.body?['message'];
  final String hay = '${error.message} ${wire is String ? wire : ''}';
  if (hay.contains(kCorrectionsCapReached)) {
    return CorrectionRejected.capReached;
  }
  if (hay.contains(kCorrectionsUnpinnedRoadDeferred)) {
    return CorrectionRejected.unpinnedRoadDeferred;
  }
  return CorrectionRejected.other;
}

/// One portfolio sample as `GET /workers/me/portfolio` returns it (Layer A
/// (e), migration 0113). [url] is a SHORT-LIVED SIGNED url for photo/video and
/// the raw link for `link` — never logged or persisted. [storageKey] is the
/// server-minted key for media (absent on a GET; the client re-submits the key
/// it minted), [url] carries the link's own address on a link entry.
class PortfolioItemDto extends Equatable {
  const PortfolioItemDto({
    required this.kind,
    this.storageKey,
    this.url,
    this.caption,
  });

  /// `photo` | `video` | `link`.
  final String kind;
  final String? storageKey;
  final String? url;
  final String? caption;

  PortfolioItemDto copyWith({
    String? kind,
    Object? storageKey = _portfolioSentinel,
    Object? url = _portfolioSentinel,
    Object? caption = _portfolioSentinel,
  }) {
    return PortfolioItemDto(
      kind: kind ?? this.kind,
      storageKey: storageKey == _portfolioSentinel
          ? this.storageKey
          : storageKey as String?,
      url: url == _portfolioSentinel ? this.url : url as String?,
      caption: caption == _portfolioSentinel ? this.caption : caption as String?,
    );
  }

  /// Wire shape for one `items[]` entry. Media carries [storageKey]; a link
  /// carries [url] — the server refuses a row with both or neither.
  Map<String, dynamic> toJson() => <String, dynamic>{
        'kind': kind,
        if (kind == 'link') 'url': url,
        if (kind != 'link') 'storage_key': storageKey,
        'caption': (caption == null || caption!.trim().isEmpty)
            ? null
            : caption!.trim(),
      };

  factory PortfolioItemDto.fromJson(Map<String, dynamic> json) =>
      PortfolioItemDto(
        kind: json['kind'] as String? ?? '',
        storageKey: json['storage_key'] as String?,
        url: json['url'] as String?,
        caption: json['caption'] as String?,
      );

  @override
  List<Object?> get props => <Object?>[kind, storageKey, url, caption];
}

/// `GET /workers/me/portfolio`.
class MyPortfolioDto extends Equatable {
  const MyPortfolioDto({this.items = const <PortfolioItemDto>[]});

  final List<PortfolioItemDto> items;

  factory MyPortfolioDto.fromJson(Map<String, dynamic> json) => MyPortfolioDto(
        items: (json['items'] as List<dynamic>?)
                ?.whereType<Map<String, dynamic>>()
                .map(PortfolioItemDto.fromJson)
                .where((PortfolioItemDto i) => i.kind.isNotEmpty)
                .toList() ??
            const <PortfolioItemDto>[],
      );

  @override
  List<Object?> get props => <Object?>[items];
}

/// Result of `POST /workers/me/portfolio/upload-url` — an alias of
/// [SignedUploadTicket] (identical `upload_url` / `storage_key` / `expires_in`
/// shape). A 503 means the media bucket is dormant server-side (infra blocker);
/// only the `link` kind works in production until an operator configures it.
typedef PortfolioUploadTicket = SignedUploadTicket;

/// copyWith sentinel for [PortfolioItemDto] so `null` can CLEAR a caption.
const Object _portfolioSentinel = Object();

// ---- Session fill (fill-gap Phase 3, #1575) ---------------------------------
//
// The additive `fill` block on `GET /profiling/session/:id` — what THIS
// session's packs settled and what gaps remain. `/finishing` reads it to render
// net-new-only. Snake_case keys exactly as the server ships them
// (`apps/api/src/profiling/profiling.dto.ts` `ProfilingFillSchema`).

/// One fact in the session fill view.
class SessionFillEntryDto extends Equatable {
  const SessionFillEntryDto({
    required this.fact,
    required this.questionKey,
    required this.status,
    required this.source,
    required this.droppedByProjector,
    required this.isCore,
  });

  /// Worker-fact id (`languages`, `work_types`, `shift`, …).
  final String fact;

  /// Pack item this fact resolves through in this session.
  final String questionKey;

  /// `answered` | `declined` | `unanswered` | `missing`.
  final String status;

  /// `chat` | `other_road`.
  final String source;

  /// True only when a chat answer exists that the profile cannot carry. The
  /// surface must phrase it as unusable-and-re-collectable, never as
  /// "you didn't answer".
  final bool droppedByProjector;

  /// Whether the unresolved item is a CORE question (gap ranking).
  final bool isCore;

  factory SessionFillEntryDto.fromJson(Map<String, dynamic> json) =>
      SessionFillEntryDto(
        fact: json['fact'] as String? ?? '',
        questionKey: json['question_key'] as String? ?? '',
        status: json['status'] as String? ?? 'missing',
        source: json['source'] as String? ?? 'chat',
        droppedByProjector: json['dropped_by_projector'] as bool? ?? false,
        isCore: json['is_core'] as bool? ?? false,
      );

  @override
  List<Object?> get props =>
      <Object?>[fact, questionKey, status, source, droppedByProjector, isCore];
}

/// The session's settled-vs-missing view.
class SessionFillDto extends Equatable {
  const SessionFillDto({
    this.entries = const <SessionFillEntryDto>[],
    this.settled = const <String>[],
  });

  final List<SessionFillEntryDto> entries;

  /// Facts with a real answer or an explicit decline, from either road — never
  /// re-ask these. Empty (e.g. no pinned pack) means "we cannot say", not
  /// "answered": the surface must show the full list.
  final List<String> settled;

  /// Parses the review response's `fill` block (`{entries, settled}`).
  /// A missing/non-map `fill` is an empty view (full list downstream), never
  /// a throw — an older server without the block must keep working.
  factory SessionFillDto.fromJson(Map<String, dynamic> json) {
    final Object? fill = json['fill'];
    final Map<String, dynamic> block =
        fill is Map<String, dynamic> ? fill : const <String, dynamic>{};
    return SessionFillDto(
      entries: (block['entries'] as List<dynamic>?)
              ?.whereType<Map<String, dynamic>>()
              .map(SessionFillEntryDto.fromJson)
              .where((SessionFillEntryDto e) => e.fact.isNotEmpty)
              .toList() ??
          const <SessionFillEntryDto>[],
      settled: (block['settled'] as List<dynamic>?)
              ?.whereType<String>()
              .toList() ??
          const <String>[],
    );
  }

  @override
  List<Object?> get props => <Object?>[entries, settled];
}

// ─────────────────────────────────────────────────────────────────────────────
// E0 in-app relay (FE #1628) — worker-side only. FACELESS BY CONTRACT: no payer
// identity exists on this wire, so no field here can show one.
// ─────────────────────────────────────────────────────────────────────────────

/// One of the worker's relay threads (GET /workers/me/relay-threads).
///
/// The ONLY identifier is the opaque [unlockId] — the E0 decision doc defers
/// "what a payer may be identified as" to its own ruling, so no counterparty
/// field exists to render.
class RelayThreadDto extends Equatable {
  const RelayThreadDto({
    required this.unlockId,
    required this.lastMessageAt,
    required this.unreadCount,
  });

  final String unlockId;
  final DateTime lastMessageAt;
  final int unreadCount;

  factory RelayThreadDto.fromJson(Map<String, dynamic> json) => RelayThreadDto(
        unlockId: json['unlock_id'] as String? ?? '',
        lastMessageAt:
            DateTime.tryParse(json['last_message_at'] as String? ?? '') ??
                DateTime.fromMillisecondsSinceEpoch(0),
        unreadCount: (json['unread_count'] as num?)?.toInt() ?? 0,
      );

  @override
  List<Object?> get props => <Object?>[unlockId, lastMessageAt, unreadCount];
}

/// One message on a relay thread (wire shape mirrors the server's
/// `RelayMessageWire`). [text] is RENDERED server-side; the raw body column is
/// never exposed and no payer identity rides along.
class RelayMessageDto extends Equatable {
  const RelayMessageDto({
    required this.messageId,
    required this.direction,
    required this.text,
    required this.createdAt,
    this.readAt,
  });

  final String messageId;

  /// `payer_to_worker` | `worker_to_payer` — an open string on the wire.
  final String direction;
  final String text;
  final DateTime createdAt;
  final DateTime? readAt;

  /// True when the worker wrote it, false when a payer did.
  bool get fromWorker => direction == 'worker_to_payer';

  factory RelayMessageDto.fromJson(Map<String, dynamic> json) =>
      RelayMessageDto(
        messageId: json['message_id'] as String? ?? '',
        direction: json['direction'] as String? ?? '',
        text: json['text'] as String? ?? '',
        createdAt: DateTime.tryParse(json['created_at'] as String? ?? '') ??
            DateTime.fromMillisecondsSinceEpoch(0),
        readAt: DateTime.tryParse(json['read_at'] as String? ?? ''),
      );

  @override
  List<Object?> get props =>
      <Object?>[messageId, direction, text, createdAt, readAt];
}

// ─────────────────────────────────────────────────────────────────────────────
// E0 C-2 employer-contact consent (#1630). Server truth for the switch.
// ─────────────────────────────────────────────────────────────────────────────

/// The caller's LATEST consent row (GET /consent/me, #1637).
///
/// Purposes come back verbatim; `[]` when there is no row (a real answer — the
/// switch renders OFF, never an error). No ip/user-agent evidence is returned.
class ConsentStateDto extends Equatable {
  const ConsentStateDto({
    this.consentId,
    this.consentVersion,
    this.acceptedAt,
    this.revokedAt,
    this.purposes = const <String>[],
  });

  final String? consentId;
  final String? consentVersion;
  final String? acceptedAt;
  final String? revokedAt;
  final List<String> purposes;

  factory ConsentStateDto.fromJson(Map<String, dynamic> json) => ConsentStateDto(
        consentId: json['consent_id'] as String?,
        consentVersion: json['consent_version'] as String?,
        acceptedAt: json['accepted_at'] as String?,
        revokedAt: json['revoked_at'] as String?,
        purposes: (json['purposes'] as List<dynamic>?)
                ?.whereType<String>()
                .toList() ??
            const <String>[],
      );

  @override
  List<Object?> get props =>
      <Object?>[consentId, consentVersion, acceptedAt, revokedAt, purposes];
}

/// The outcome of POST /consent/employer-contact/withdraw (E0 C-2).
///
/// `consent_id` null + empty `withdrawn` = the latest row already omitted both
/// employer-contact purposes (an idempotent no-op).
class EmployerContactWithdrawDto extends Equatable {
  const EmployerContactWithdrawDto({
    required this.ok,
    this.consentId,
    this.withdrawn = const <String>[],
  });

  final bool ok;
  final String? consentId;
  final List<String> withdrawn;

  factory EmployerContactWithdrawDto.fromJson(Map<String, dynamic> json) =>
      EmployerContactWithdrawDto(
        ok: json['ok'] == true,
        consentId: json['consent_id'] as String?,
        withdrawn: (json['withdrawn'] as List<dynamic>?)
                ?.whereType<String>()
                .toList() ??
            const <String>[],
      );

  @override
  List<Object?> get props => <Object?>[ok, consentId, withdrawn];
}
