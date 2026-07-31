/// Wire DTOs for the AI job-posting chat (ADR-0035).
///
/// The five endpoints all ride the existing `PayerAuthGuard`; the `payer_id` is
/// ALWAYS derived from the bearer server-side and is NEVER sent in a body from
/// here (the never-trust-body-IDs rule this repo enforces).
///
/// KEPT IN LOCKSTEP WITH THE SIBLING WEB CLIENT. The same frozen contract is
/// read by `apps/payer-web/src/lib/contracts.ts`
/// (`jobPostingChatTurnWireSchema` / `…SessionWireSchema` / `…TranscriptWireSchema`
/// / `…PublishWireSchema`); the field names below are that contract's, verbatim.
/// Cross-device resume only works if BOTH clients read the same rows the same
/// way, so a change here without a change there is a bug.
///
/// TWO CONTRACT RULES THIS FILE ENCODES STRUCTURALLY (ADR-0035 §Decision 3/4):
///
///  1. **There is no `org_label` on [JobPostingDraft].** The payer's own
///     company/org name is never asked for in the chat and never sent to the
///     LLM — it is auto-filled server-side from `payers.orgNameEnc` at publish
///     time. Adding the field here would recreate the exact hole the ADR closed
///     structurally, so it is absent by construction (asserted in tests).
///  2. **Vacancy is BANDED, never a raw integer** ([kVacancyBands], ADR-0012).
///     The chat is a new INPUT SURFACE onto the same banded representation the
///     manual form already uses; nothing here carries a headcount int.
///
/// Every parser is DEFENSIVE about key casing/aliases the same way
/// `HttpPayerApiClient._jobFromRow` already is — a client that reads only one
/// spelling silently renders an empty draft rather than failing loudly.
library;

import 'package:equatable/equatable.dart';

/// The `vacancy_band` enum, verbatim (ADR-0012 / `bandForCount`). NOT the
/// pricing package's frontend quota bands — those are a display concept and must
/// never be conflated with this one.
const List<String> kVacancyBands = <String>['1', '2-5', '6-10', '11-25', '25+'];

/// Chat-session lifecycle — mirrors the migration-0050 enum.
const List<String> kJobPostingChatStatuses = <String>[
  'active',
  'draft_ready',
  'published',
  'abandoned',
];

/// The in-progress job posting the interview engine has assembled so far.
///
/// Maps 1:1 onto `PayerCreateJobPostingSchema` (ADR-0035 §Decision 4) — publish
/// is a server-side validation of THIS against that existing schema, not a new
/// shape. Every field is optional: a draft is legitimately partial until the
/// engine says [JobPostingChatTurn.draftReady].
class JobPostingDraft extends Equatable {
  const JobPostingDraft({
    this.roleTitle,
    this.tradeKey,
    this.skillPhrases = const <String>[],
    this.locationLabel,
    this.vacancyBand,
    this.payMin,
    this.payMax,
    this.shift,
    this.benefits = const <String>[],
    this.requirements = const <String>[],
    this.description,
    this.confidence,
    this.missingFields = const <String>[],
    this.clarificationQuestions = const <String>[],
  });

  final String? roleTitle;
  final String? tradeKey;
  final List<String> skillPhrases;
  final String? locationLabel;

  /// One of [kVacancyBands] — NEVER a headcount integer (ADR-0012).
  final String? vacancyBand;

  final int? payMin;
  final int? payMax;
  final String? shift;
  final List<String> benefits;
  final List<String> requirements;
  final String? description;

  /// The engine's DETERMINISTIC coverage ratio (0..1) — topics answered over
  /// topics in the bank. Not a model score, and never rendered as a bare number
  /// the payer has to interpret.
  final double? confidence;

  /// Topic/field KEYS still without a value — never values, never PII.
  final List<String> missingFields;

  /// Follow-up questions the engine wants answered to fill [missingFields].
  final List<String> clarificationQuestions;

  /// True when the draft carries the two fields the create route requires
  /// (`role_title` + a valid `vacancy_band`). A CLIENT-side sanity check only —
  /// the server re-validates against `PayerCreateJobPostingSchema` and remains
  /// the authority. It exists so the Publish button is honest, not so the client
  /// decides.
  bool get hasRequiredFields =>
      (roleTitle != null && roleTitle!.trim().isNotEmpty) &&
      (vacancyBand != null && kVacancyBands.contains(vacancyBand));

  /// True when there is nothing at all to show yet.
  bool get isEmpty =>
      roleTitle == null &&
      tradeKey == null &&
      skillPhrases.isEmpty &&
      locationLabel == null &&
      vacancyBand == null &&
      payMin == null &&
      payMax == null &&
      shift == null &&
      benefits.isEmpty &&
      requirements.isEmpty &&
      description == null;

  static JobPostingDraft fromJson(Map<String, dynamic> json) {
    return JobPostingDraft(
      roleTitle: _str(json, 'role_title', 'roleTitle'),
      tradeKey: _str(json, 'trade_key', 'tradeKey'),
      skillPhrases: _strList(json, 'skill_phrases', 'skillPhrases', 'skills'),
      locationLabel: _str(json, 'location_label', 'locationLabel'),
      vacancyBand: _str(json, 'vacancy_band', 'vacancyBand'),
      payMin: _int(json, 'pay_min', 'payMin'),
      payMax: _int(json, 'pay_max', 'payMax'),
      shift: _str(json, 'shift', 'shift'),
      benefits: _strList(json, 'benefits', 'benefits', 'benefits'),
      requirements:
          _strList(json, 'requirements', 'requirements', 'requirements'),
      description: _str(json, 'description', 'description'),
      confidence: _double(json, 'confidence', 'confidence'),
      missingFields: _strList(json, 'missing_fields', 'missingFields', 'missing'),
      clarificationQuestions: _strList(
        json,
        'clarification_questions',
        'clarificationQuestions',
        'clarifications',
      ),
    );
  }

  @override
  List<Object?> get props => <Object?>[
        roleTitle,
        tradeKey,
        skillPhrases,
        locationLabel,
        vacancyBand,
        payMin,
        payMax,
        shift,
        benefits,
        requirements,
        description,
        confidence,
        missingFields,
        clarificationQuestions,
      ];
}

/// ONE ENGINE TURN — returned by BOTH `POST …/session` (the opener) and
/// `POST …/message`. That is the frozen contract's own shape, so starting a chat
/// and answering in it decode identically.
///
/// Two HONESTY cues surface server behaviour the payer would otherwise misread:
///  - [blocked]: pseudonymization failed closed, so the payer's last answer was
///    NOT processed (invariant #3). [reply] is a safe fallback and [draft] is
///    null — the caller KEEPS whatever draft it had rather than blanking it.
///  - [isMock]: the reply came from the local/AI-down fallback.
class JobPostingChatTurn extends Equatable {
  const JobPostingChatTurn({
    required this.sessionId,
    required this.reply,
    this.status = 'active',
    this.draft,
    this.draftReady = false,
    this.suggestedReplies = const <String>[],
    this.messageId,
    this.blocked = false,
    this.isMock = false,
  });

  final String sessionId;

  /// `reply_text` on the wire.
  final String reply;

  /// One of [kJobPostingChatStatuses].
  final String status;

  /// The draft AFTER this turn, or null when the server sent none.
  final JobPostingDraft? draft;

  /// The DETERMINISTIC engine's readiness signal — never inferred from the draft
  /// fields (invariant #4: the engine decides, the client reports).
  final bool draftReady;

  /// Tap-to-answer chips (`suggested_replies`). These are ANSWERS to the
  /// question just asked, never questions: a tapped chip is sent verbatim as the
  /// payer's message. Empty on a blocked/degraded turn.
  final List<String> suggestedReplies;

  final String? messageId;
  final bool blocked;
  final bool isMock;

  static JobPostingChatTurn fromJson(Map<String, dynamic> json) {
    return JobPostingChatTurn(
      sessionId: _str(json, 'session_id', 'sessionId') ?? '',
      // `reply_text` is the frozen key; `reply` is tolerated so a drifted build
      // degrades to a rendered answer rather than an empty bubble.
      reply: _str(json, 'reply_text', 'replyText') ??
          _str(json, 'reply', 'reply') ??
          '',
      status: _str(json, 'status', 'status') ?? 'active',
      draft: _draft(json),
      draftReady: _bool(json, 'draft_ready', 'draftReady'),
      suggestedReplies: _chips(json),
      messageId: _str(json, 'message_id', 'messageId'),
      blocked: _bool(json, 'blocked', 'blocked'),
      isMock: _bool(json, 'is_mock', 'isMock'),
    );
  }

  @override
  List<Object?> get props => <Object?>[
        sessionId,
        reply,
        status,
        draft,
        draftReady,
        suggestedReplies,
        messageId,
        blocked,
        isMock,
      ];
}

/// One row of `GET /payer/job-posting-chat/sessions` — the CROSS-DEVICE
/// "continue where you left off" list. Ownership is the payer ACCOUNT, never a
/// device or browser session, so a chat started in the web portal appears here
/// and vice-versa (ADR-0035 §Decision 5).
class JobPostingChatSessionSummary extends Equatable {
  const JobPostingChatSessionSummary({
    required this.id,
    required this.status,
    this.startedAt,
    this.lastMessageAt,
    this.draftReady = false,
    this.roleTitle,
    this.publishedJobPostingId,
  });

  /// `session_id` on the wire.
  final String id;

  /// One of [kJobPostingChatStatuses].
  final String status;

  final String? startedAt;
  final String? lastMessageAt;
  final bool draftReady;

  /// The draft's role title when the chat got that far — a resume-card label
  /// only.
  final String? roleTitle;

  final String? publishedJobPostingId;

  /// A session the payer can still pick up. `published`/`abandoned` are done.
  bool get isResumable => status == 'active' || status == 'draft_ready';

  /// Newest-activity key, for the same ordering the web client applies.
  String get activityKey => lastMessageAt ?? startedAt ?? '';

  static JobPostingChatSessionSummary fromJson(Map<String, dynamic> json) {
    final Map<String, dynamic>? draft = _draftJson(json);
    final String status = _str(json, 'status', 'status') ?? 'active';
    return JobPostingChatSessionSummary(
      id: _str(json, 'session_id', 'sessionId') ?? _str(json, 'id', 'id') ?? '',
      status: status,
      startedAt: _str(json, 'started_at', 'startedAt'),
      lastMessageAt: _str(json, 'last_message_at', 'lastMessageAt'),
      draftReady:
          _bool(json, 'draft_ready', 'draftReady') || status == 'draft_ready',
      roleTitle: _str(json, 'role_title', 'roleTitle') ??
          (draft == null ? null : _str(draft, 'role_title', 'roleTitle')),
      publishedJobPostingId:
          _str(json, 'published_job_posting_id', 'publishedJobPostingId'),
    );
  }

  @override
  List<Object?> get props => <Object?>[
        id,
        status,
        startedAt,
        lastMessageAt,
        draftReady,
        roleTitle,
        publishedJobPostingId,
      ];
}

/// One persisted transcript row.
///
/// `direction` reuses the shipped shared union: `inbound` = the payer's turn,
/// `outbound` = the assistant's.
class JobPostingChatMessageRow extends Equatable {
  const JobPostingChatMessageRow({
    required this.fromPayer,
    this.id,
    this.messageType,
    this.bodyText,
    this.createdAt,
  });

  final bool fromPayer;
  final String? id;
  final String? messageType;
  final String? bodyText;
  final String? createdAt;

  static JobPostingChatMessageRow fromJson(Map<String, dynamic> json) {
    final String direction =
        (_str(json, 'direction', 'direction') ?? '').toLowerCase();
    return JobPostingChatMessageRow(
      // `inbound` is the frozen value; `payer`/`user` are tolerated so a drifted
      // build cannot silently render every bubble on the wrong side.
      fromPayer: direction == 'inbound' ||
          direction == 'payer' ||
          direction == 'in' ||
          direction == 'user',
      id: _str(json, 'id', 'id'),
      messageType: _str(json, 'message_type', 'messageType'),
      bodyText: _str(json, 'body_text', 'bodyText'),
      createdAt: _str(json, 'created_at', 'createdAt'),
    );
  }

  @override
  List<Object?> get props =>
      <Object?>[fromPayer, id, messageType, bodyText, createdAt];
}

/// `GET /payer/job-posting-chat/sessions/:id/messages` — full hydration.
///
/// It carries MORE than the transcript: the current [draft], the engine's
/// [draftReady] decision, and the live chips. That is what makes cross-device
/// resume complete — a payer picking a web-started chat up on the phone sees the
/// draft they already built WITHOUT having to send another message first.
class JobPostingChatTranscript extends Equatable {
  const JobPostingChatTranscript({
    required this.sessionId,
    this.status = 'active',
    this.draft,
    this.draftReady = false,
    this.suggestedReplies = const <String>[],
    this.messages = const <JobPostingChatMessageRow>[],
  });

  final String sessionId;
  final String status;
  final JobPostingDraft? draft;
  final bool draftReady;
  final List<String> suggestedReplies;
  final List<JobPostingChatMessageRow> messages;

  static JobPostingChatTranscript fromJson(Map<String, dynamic> json) {
    final Object? rows = json['messages'] ?? json['items'];
    return JobPostingChatTranscript(
      sessionId: _str(json, 'session_id', 'sessionId') ?? '',
      status: _str(json, 'status', 'status') ?? 'active',
      draft: _draft(json),
      draftReady: _bool(json, 'draft_ready', 'draftReady'),
      suggestedReplies: _chips(json),
      messages: rows is! List<dynamic>
          ? const <JobPostingChatMessageRow>[]
          : rows
              .whereType<Map<String, dynamic>>()
              .map(JobPostingChatMessageRow.fromJson)
              .toList(growable: false),
    );
  }

  @override
  List<Object?> get props =>
      <Object?>[sessionId, status, draft, draftReady, suggestedReplies, messages];
}

// ---------------------------------------------------------------------------
// Shared defensive readers — snake_case OR camelCase, wrong types ignored.
// ---------------------------------------------------------------------------

String? _str(Map<String, dynamic> json, String snake, String camel) {
  final Object? v = json[snake] ?? json[camel];
  if (v is! String) return null;
  final String trimmed = v.trim();
  return trimmed.isEmpty ? null : trimmed;
}

int? _int(Map<String, dynamic> json, String snake, String camel) {
  final Object? v = json[snake] ?? json[camel];
  return v is num ? v.toInt() : null;
}

double? _double(Map<String, dynamic> json, String snake, String camel) {
  final Object? v = json[snake] ?? json[camel];
  return v is num ? v.toDouble() : null;
}

bool _bool(Map<String, dynamic> json, String snake, String camel) {
  final Object? v = json[snake] ?? json[camel];
  return v is bool ? v : false;
}

List<String> _strList(
  Map<String, dynamic> json,
  String snake,
  String camel,
  String alt,
) {
  final Object? v = json[snake] ?? json[camel] ?? json[alt];
  if (v is! List<dynamic>) return const <String>[];
  return v
      .whereType<String>()
      .map((String s) => s.trim())
      .where((String s) => s.isNotEmpty)
      .toList(growable: false);
}

/// Tap-to-answer chips. `suggested_replies` is the frozen key;
/// `suggested_followups` (the worker chat's name for the same thing) and
/// `suggested_answers` (the AI-service contract's name) are tolerated.
List<String> _chips(Map<String, dynamic> json) {
  for (final String key in <String>[
    'suggested_replies',
    'suggestedReplies',
    'suggested_answers',
    'suggested_followups',
  ]) {
    final Object? v = json[key];
    if (v is List<dynamic>) {
      return v
          .whereType<String>()
          .map((String s) => s.trim())
          .where((String s) => s.isNotEmpty)
          .toList(growable: false);
    }
  }
  return const <String>[];
}

Map<String, dynamic>? _draftJson(Map<String, dynamic> json) {
  final Object? v = json['draft'] ?? json['job_posting_draft'];
  return v is Map<String, dynamic> ? v : null;
}

JobPostingDraft? _draft(Map<String, dynamic> json) {
  final Map<String, dynamic>? raw = _draftJson(json);
  return raw == null ? null : JobPostingDraft.fromJson(raw);
}
