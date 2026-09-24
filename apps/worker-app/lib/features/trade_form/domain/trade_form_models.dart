import 'package:equatable/equatable.dart';

import '../../../core/util/title_case.dart';
import '../../voice_form/domain/voice_form_models.dart'
    show VoiceChoice, VoiceQuestion;

/// The trade form's domain shapes (#1341, backend `TradeFormController` /
/// `trade-form.dto.ts`).
///
/// `GET /profiling/form` returns the WHOLE form — every section, every
/// screen, every question, every already-given answer — in one round trip.
/// There is NO session id anywhere on this surface (unlike chat / the voice
/// form): a form belongs to the WORKER, not to an interview, so the server
/// keys saved answers `(worker_id, pack_id, question_key)` and this client
/// never invents or carries a session concept for it.
///
/// A QUESTION SCREEN REUSES [VoiceQuestion]/[VoiceChoice] ON PURPOSE. The
/// backend DTO (`FormQuestionSchema`) copies `ProfilingStepSchema.question`
/// field-for-field so the client's existing parser/renderer (`VoiceChoiceChips`,
/// the voice form's `answer_type` → kind mapping) works unchanged — a second,
/// parallel "question" shape here would be free to drift from the one voice
/// form already uses. `voice_form` is unwired dark code today (#1321); lifting
/// its domain types is expected, not a layering violation.

/// Whether the worker already settled a question, and how.
///
/// NULL on [TradeFormQuestionScreen.answer] means genuinely unanswered.
/// [TradeFormAnswerStatus.declined] is a REAL, SETTLED answer ("nothing here
/// applies to me" / "pata nahi") — it must never be re-derived from an empty
/// [optionKeys] list, because an answered multi-select with zero ticks is
/// ALSO represented as a declined save server-side. Reading [status] (not
/// list-emptiness) is what keeps that distinction honest on the client too.
enum TradeFormAnswerStatus { answered, declined }

/// What the worker already said for one question, replayed on load so a
/// half-finished form comes back filled in — the entire mechanism behind
/// "resumability is the point" (#1341).
class TradeFormSavedAnswer extends Equatable {
  const TradeFormSavedAnswer({
    required this.status,
    this.optionKeys = const <String>[],
    this.text,
    this.number,
    this.boolValue,
  });

  final TradeFormAnswerStatus status;
  final List<String> optionKeys;
  final String? text;
  final double? number;
  final bool? boolValue;

  bool get isDeclined => status == TradeFormAnswerStatus.declined;

  @override
  List<Object?> get props =>
      <Object?>[status, optionKeys, text, number, boolValue];
}

/// What the worker's UPLOADED RÉSUMÉ said about one question (#1499, ADR-0041
/// RI-4, `GET /profiling/form` → `screens[].suggestion`).
///
/// ── IT IS NOT AN ANSWER, AND IT IS SHAPED SO IT CANNOT BE MISTAKEN FOR ONE ──
///
/// [TradeFormSavedAnswer] carries a [TradeFormAnswerStatus]; this deliberately
/// does not, because a suggestion HAS no status — nobody has said anything yet.
/// The server's DTO makes the same omission for the same reason, and the whole
/// of ruling D2 turns on it. Never construct a [TradeFormSavedAnswer] from one
/// of these.
///
/// ── RULING D2, WHICH IS THE ONLY RULE THAT MATTERS HERE ─────────────────────
///
/// FACTS RENDER PREFILLED. CAPABILITY CHIPS RENDER HIGHLIGHTED BUT UNTICKED.
///
/// A name, a duration, a project description read off a résumé can be dropped
/// into a field: it is a transcription, and a wrong one is visibly wrong and
/// easily corrected. An option key cannot, because "a pre-ticked chip puts a
/// capability on a man's profile that he never claimed" — and he will submit
/// the screen without reading it, because it looks done. So [optionKeys] and
/// [boolValue] are POINTERS for the renderer, never selections. See
/// `TradeFormQuestionBody`, which is where the distinction is enforced.
///
/// ── A QUESTION MAY CARRY BOTH THIS AND AN ANSWER ────────────────────────────
///
/// Ruling D7: the stored answer always wins, and both are shown. Nothing here
/// overwrites anything; the suggestion simply sits beside the answer.
class TradeFormSuggestion extends Equatable {
  const TradeFormSuggestion({
    required this.confidence,
    this.optionKeys = const <String>[],
    this.text,
    this.number,
    this.boolValue,
  });

  /// Option keys the résumé pointed at. HIGHLIGHTED, NEVER TICKED.
  final List<String> optionKeys;

  /// A fact read off the document — safe to prefill.
  final String? text;

  /// A fact read off the document — safe to prefill.
  final double? number;

  /// HIGHLIGHTED, NEVER TICKED: a yes/no on this form is a capability claim
  /// ("kya aap drawing padh sakte hain"), not a transcribed fact.
  final bool? boolValue;

  /// The model's own number, carried through unaltered — never a floor and
  /// never a filter. The server does not threshold it and neither does this
  /// client: a low-confidence suggestion is still worth showing a worker, who
  /// is the one qualified to say whether it is right. Held for observability
  /// rather than for display; a percentage on screen would invite a worker to
  /// argue with a number instead of answering a question.
  final double confidence;

  /// True when there is a FACT to prefill. Chip/boolean pointers deliberately
  /// do not count — see ruling D2 in the class doc.
  bool get hasPrefillableFact =>
      (text != null && text!.trim().isNotEmpty) || number != null;

  bool get isEmpty =>
      optionKeys.isEmpty && text == null && number == null && boolValue == null;

  @override
  List<Object?> get props =>
      <Object?>[optionKeys, text, number, boolValue, confidence];
}

/// One entry of `sections[].screens[]`, in the SERVER'S ORDER — the client
/// walks this list verbatim and never re-sorts it (the order is the résumé's
/// own field order, read off the shipped trade map).
sealed class TradeFormStep extends Equatable {
  const TradeFormStep();
}

/// `type: "question"` — a single pack question the worker answers directly on
/// this screen.
class TradeFormQuestionStep extends TradeFormStep {
  const TradeFormQuestionStep({
    required this.question,
    required this.searchable,
    this.answer,
    this.suggestion,
  });

  final VoiceQuestion question;

  /// Server-computed presentation hint (`ui.searchable`): true when the
  /// option count crosses the pack's search threshold. NEVER re-derived from
  /// `options.length` on the client — the threshold has exactly one
  /// definition, and it is the server's.
  final bool searchable;

  /// The worker's already-saved answer, or null when this question has never
  /// been answered.
  final TradeFormSavedAnswer? answer;

  /// What an uploaded résumé said about this question (#1499), or null — which
  /// is what every question carries until a résumé has actually been parsed,
  /// and therefore what every question carries on every box today.
  ///
  /// ADDITIVE: a build that ignores this renders exactly the form it rendered
  /// before, which is the property that let the server land the field first.
  final TradeFormSuggestion? suggestion;

  bool get isAnswered => answer != null;

  /// True when the résumé has something to offer on this question AND it is
  /// worth rendering. An empty suggestion object is treated as none at all.
  bool get hasSuggestion => suggestion != null && !suggestion!.isEmpty;

  @override
  List<Object?> get props =>
      <Object?>[question, searchable, answer, suggestion];
}

/// `tier_scope` on a marker screen (#1698/#1710) — which of the page's own
/// fields this tier ASKS FOR.
///
/// ASK-ONLY, NEVER A FILTER ON WHAT IS STORED. Each marker page is a
/// whole-record PUT, so a field this scope hides is still round-tripped: the
/// page simply does not PROMPT for it. Reading `hidden_fields` as "drop these"
/// would make choosing Easy delete the answers a worker gave at Medium.
///
/// The names are wire names of the PUT body the page owns — `documents_ready`
/// for preferences, `work_done` / `additional_entries` for employment,
/// `certificates` / `trainings` for qualifications — never question ids.
/// The field names `tier_scope` uses, as the server spells them
/// (`profiling-tier.policy.ts`). They are WIRE NAMES OF THE PUT BODY each page
/// owns, not question ids, and are named here so the pages and the cubit
/// cannot drift from one another on a string literal.
const String kTierFieldDocumentsReady = 'documents_ready';
const String kTierFieldWorkDone = 'work_done';
const String kTierFieldAdditionalEntries = 'additional_entries';
const String kTierFieldCertificates = 'certificates';
const String kTierFieldTrainings = 'trainings';

class TradeFormTierScope extends Equatable {
  const TradeFormTierScope({
    this.hiddenFields = const <String>{},
    this.revealFields,
  });

  /// Fields this tier does NOT ask for. Empty at Hard, and empty on a server
  /// with tiers switched off — which is exactly today's page.
  final Set<String> hiddenFields;

  /// Present ONLY on `?view=upgrade`: the fields this upgrade ADDS to this
  /// page. The page then asks only these, and of these only the ones with no
  /// saved value; when none are left the page is skipped entirely.
  ///
  /// Null (the ordinary load) is a DIFFERENT thing from empty (an upgrade that
  /// adds nothing to this page): null means "ask this page normally", empty
  /// means "there is nothing left to ask here".
  final Set<String>? revealFields;

  /// The absent-`tier_scope` value: ask everything, reveal nothing special —
  /// byte-for-byte today's behaviour on a server that never heard of tiers.
  static const TradeFormTierScope unscoped = TradeFormTierScope();

  bool hides(String field) => hiddenFields.contains(field);

  /// Null for anything unusable, so a malformed `tier_scope` degrades to
  /// [unscoped] at the call site rather than hiding fields by accident —
  /// the fail-open direction here, because hiding a field the worker owes an
  /// answer to is the harm.
  static TradeFormTierScope? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final Map<String, dynamic> m = raw.cast<String, dynamic>();
    Set<String>? strings(Object? v) => v is List
        ? v.whereType<String>().toSet()
        : null;
    return TradeFormTierScope(
      hiddenFields: strings(m['hidden_fields']) ?? const <String>{},
      revealFields: strings(m['reveal_fields']),
    );
  }

  @override
  List<Object?> get props => <Object?>[hiddenFields, revealFields];
}

/// `type: "preferences"` — a MARKER naming where the closed-set preferences
/// page (`PUT /workers/me/work-preferences`) sits in the journey. Not a copy
/// of that contract; the endpoint owns its own vocabulary and validation.
class TradeFormPreferencesStep extends TradeFormStep {
  const TradeFormPreferencesStep({this.tierScope = TradeFormTierScope.unscoped});

  /// Which of this page's fields the chosen tier asks for (#1698). Defaults to
  /// [TradeFormTierScope.unscoped] — what a tier-less server serves.
  final TradeFormTierScope tierScope;

  @override
  List<Object?> get props => <Object?>[tierScope];
}

/// `type: "employment"` — a MARKER for the work-history page
/// (`PUT /workers/me/employment`). Same argument as [TradeFormPreferencesStep].
class TradeFormEmploymentStep extends TradeFormStep {
  const TradeFormEmploymentStep({this.tierScope = TradeFormTierScope.unscoped});

  final TradeFormTierScope tierScope;

  @override
  List<Object?> get props => <Object?>[tierScope];
}

/// `type: "qualifications"` — a MARKER for the credentials page
/// (`PUT /workers/me/qualifications`, migration 0098 / #1384). Same argument
/// as [TradeFormPreferencesStep]/[TradeFormEmploymentStep] — the endpoint
/// owns its own vocabulary, caps and tri-state contract, not this class.
///
/// UNLIKE the other two markers, this one carries [suggestedCertificates]:
/// the per-TRADE autocomplete list for the certificate-name field. It rides
/// THIS screen entry rather than the options endpoint because
/// `GET /profiling/form` is the only response that already knows the
/// worker's trade (`trade-form.service.ts`). NEVER a validation list — the
/// write endpoint accepts any name the worker types; there is no closed
/// register of Indian trade certificates to check against.
class TradeFormQualificationsStep extends TradeFormStep {
  const TradeFormQualificationsStep({
    this.suggestedCertificates = const <String>[],
    this.tierScope = TradeFormTierScope.unscoped,
  });

  final List<String> suggestedCertificates;

  final TradeFormTierScope tierScope;

  @override
  List<Object?> get props => <Object?>[suggestedCertificates, tierScope];
}

/// One zone of the form (`sections[]`) — a heading the sheet itself prints,
/// plus the screens that sit under it.
class TradeFormSection extends Equatable {
  const TradeFormSection({
    required this.id,
    required this.title,
    required this.screens,
  });

  final String id;
  final String title;
  final List<TradeFormStep> screens;

  @override
  List<Object?> get props => <Object?>[id, title, screens];
}

/// The whole form, as `GET /profiling/form` returned it.
class TradeForm extends Equatable {
  const TradeForm({
    required this.kind,
    required this.packId,
    required this.packVersion,
    required this.sections,
    this.sessionId,
  });

  final String kind;
  final String packId;

  /// The profiling session this form belongs to (`session_id`, #1472).
  ///
  /// SERVED BECAUSE THE MIC NEEDS IT: `POST /voice/upload` files a clip under a
  /// session, and a spoken work description has to land in the one this form is
  /// part of. NEVER cached and NEVER a chat session id — the form is resumable
  /// across a cold start, so a stale id files the clip under the wrong
  /// conversation. It is re-read from every schema response.
  ///
  /// Null on an older server that does not send it; the caller treats that as
  /// "no mic", exactly like a 503.
  final String? sessionId;

  /// Pinned so a client never replays an answer written against a different
  /// pack version — carried for parity with the wire contract even though
  /// this client does not (yet) act on it directly.
  final int packVersion;
  final List<TradeFormSection> sections;

  /// Every question-type screen across every section, in walk order.
  Iterable<TradeFormQuestionStep> get questionSteps => sections
      .expand((TradeFormSection s) => s.screens)
      .whereType<TradeFormQuestionStep>();

  @override
  List<Object?> get props =>
      <Object?>[kind, packId, packVersion, sections, sessionId];
}

/// One answer submitted via `POST /profiling/form/answer` — a discriminated
/// union matching `TradeFormAnswerSchema`. Deliberately WITHOUT a `spoken`
/// member (this form has no mic capture, unlike the voice form's `VoiceAnswer`)
/// and WITH a first-class `declined` member: "nothing ticked, submitted
/// anyway" is a real answer here, not silence, and the server records it as
/// one.
enum TradeFormAnswerKind { chips, text, boolean, declined }

class TradeFormAnswer extends Equatable {
  const TradeFormAnswer.chips(this.optionKeys)
      : kind = TradeFormAnswerKind.chips,
        text = null,
        boolValue = null;

  const TradeFormAnswer.text(String this.text)
      : kind = TradeFormAnswerKind.text,
        optionKeys = const <String>[],
        boolValue = null;

  const TradeFormAnswer.boolean(bool this.boolValue)
      : kind = TradeFormAnswerKind.boolean,
        optionKeys = const <String>[],
        text = null;

  const TradeFormAnswer.declined()
      : kind = TradeFormAnswerKind.declined,
        optionKeys = const <String>[],
        text = null,
        boolValue = null;

  final TradeFormAnswerKind kind;
  final List<String> optionKeys;
  final String? text;
  final bool? boolValue;

  /// Wire shape for the `answer` member of `POST /profiling/form/answer`.
  Map<String, dynamic> toJson() {
    switch (kind) {
      case TradeFormAnswerKind.chips:
        return <String, dynamic>{'kind': 'chips', 'option_keys': optionKeys};
      case TradeFormAnswerKind.text:
        return <String, dynamic>{'kind': 'text', 'text': text};
      case TradeFormAnswerKind.boolean:
        return <String, dynamic>{'kind': 'boolean', 'value': boolValue};
      case TradeFormAnswerKind.declined:
        return <String, dynamic>{'kind': 'declined'};
    }
  }

  @override
  List<Object?> get props => <Object?>[kind, optionKeys, text, boolValue];
}

/// `POST /profiling/form/answer`'s response — echoes the settled question plus
/// the form's own progress counters, which the client renders directly rather
/// than recomputing (the server's count is authoritative; a client recount
/// could drift the moment a pack version changes question count).
class TradeFormAnswerResult extends Equatable {
  const TradeFormAnswerResult({
    required this.questionKey,
    required this.status,
    required this.answered,
    required this.total,
    this.schemaStale = false,
  });

  final String questionKey;
  final TradeFormAnswerStatus status;
  final int answered;
  final int total;

  /// `schema_stale` (#1382) — true when the question just answered gates
  /// OTHER questions (`ask_if` filtering), meaning the screen list this
  /// client is holding may now include questions the server would no
  /// longer ask. FORWARD-COMPATIBLE GROUNDWORK: the key does not exist on
  /// `TradeFormAnswerResponse` yet (`apps/api/src/profiling/form/`, as of
  /// #1382 — the ask_if backend work is still in progress), so it is
  /// ABSENT on every real response today and this defaults to false —
  /// inert until the backend ships the key, then activates automatically.
  /// A client that never sees `true` behaves exactly as it does now.
  final bool schemaStale;

  @override
  List<Object?> get props =>
      <Object?>[questionKey, status, answered, total, schemaStale];
}

/// ---- The two marker-screen writes (#1296's endpoints, reused verbatim) ----
///
/// Both models below are DELIBERATE, SCOPED DUPLICATES of
/// `features/finishing`'s `WorkPreferences`/`EmploymentEntry` — same fields,
/// same wire shape, same three-state `copyWith` sentinel trick — rather than
/// an import. `features/finishing/` is explicitly out of scope for this
/// change (issue #1341) and is slated for retirement once #1340/#1344 land;
/// depending on it here would tie this new surface to code already scheduled
/// to disappear. #1341 also notes the employment write lacks multi-role
/// (`roles[]`) capture, matching the gap `finishing/` has today — a follow-up,
/// not a blocker.

/// Server cap (`preferredCities`'s `.max(5)` in `worker-preferences.dto.ts`)
/// — a plain client-side bound so the city-add row disappears before a
/// submit could ever be rejected, same convention as
/// `kTradeFormMaxCertificates`/`kTradeFormMaxEducations`.
const int kTradeFormMaxPreferredCities = 5;

/// Server cap (`languages`'s `.max(6)` in `worker-preferences.dto.ts`) —
/// an editorial limit on how many print on the sheet, not the dictionary's
/// size (16). A plain client-side bound so a seventh tick can never become
/// a 400 on the LAST internal page (`terms`), same convention as
/// [kTradeFormMaxPreferredCities].
const int kTradeFormMaxLanguages = 6;

/// The closed-set preferences a worker sets on a `preferences` marker screen.
///
/// Deliberately carries NO education/credential fields any more — this
/// marker's own "ITI ya Diploma?" + council + year/institute ask was a
/// duplicate of the SAME information the `qualifications` marker's
/// `educations[]` entries already capture (and the only one of the two the
/// résumé pipeline should read from — see `TradeFormEducationEntry`). Backend
/// cleanup of the now-dead `work_preferences.education_*` columns/vocabulary
/// (`EDUCATION_CREDENTIALS` in `worker-preferences.vocabulary.ts`, separate
/// from `EDUCATION_QUALIFICATIONS`) is tracked for Prakash.
class TradeFormPreferences extends Equatable {
  const TradeFormPreferences({
    this.languages = const <String>{},
    this.documentsReady = const <String>{},
    this.preferredCities = const <String>[],
    this.jobType,
    this.shift,
    this.willingToRelocate = false,
    this.accommodationNeeded = false,
    this.salaryExpectedMax,
    this.touched = const <String>{},
  });

  final Set<String> languages;
  final Set<String> documentsReady;
  final List<String> preferredCities;
  final String? jobType;
  final String? shift;
  final bool willingToRelocate;
  final bool accommodationNeeded;
  final int? salaryExpectedMax;

  /// Wire keys of the list and yes/no fields the worker CHANGED, set by
  /// [copyWith] (every page edit goes through it). [toJson] sends those fields
  /// only when touched — the same idea as [TradeFormQualifications]'s touched
  /// flags — so an untouched `[]` or `false` is never sent and the server
  /// leaves the stored value alone.
  ///
  /// Since #1710 the page also PREFILLS from `GET /workers/me/work-preferences`
  /// (see `TradeFormRepository.loadSavedPreferences`), so an untouched field
  /// now holds the worker's real stored answer rather than a blank default.
  /// That is what makes [toJson]'s `touched_only` signal honest.
  final Set<String> touched;

  TradeFormPreferences copyWith({
    Set<String>? languages,
    Set<String>? documentsReady,
    List<String>? preferredCities,
    Object? jobType = _sentinel,
    Object? shift = _sentinel,
    bool? willingToRelocate,
    bool? accommodationNeeded,
    Object? salaryExpectedMax = _sentinel,
  }) {
    return TradeFormPreferences(
      languages: languages ?? this.languages,
      documentsReady: documentsReady ?? this.documentsReady,
      preferredCities: preferredCities ?? this.preferredCities,
      jobType: jobType == _sentinel ? this.jobType : jobType as String?,
      shift: shift == _sentinel ? this.shift : shift as String?,
      willingToRelocate: willingToRelocate ?? this.willingToRelocate,
      accommodationNeeded: accommodationNeeded ?? this.accommodationNeeded,
      salaryExpectedMax: salaryExpectedMax == _sentinel
          ? this.salaryExpectedMax
          : salaryExpectedMax as int?,
      touched: <String>{
        ...touched,
        if (languages != null) _kPrefLanguagesKey,
        if (documentsReady != null) _kPrefDocumentsKey,
        if (preferredCities != null) _kPrefCitiesKey,
        if (willingToRelocate != null) _kPrefRelocateKey,
        if (accommodationNeeded != null) _kPrefAccommodationKey,
      },
    );
  }

  /// Wire body for `PUT /workers/me/work-preferences` — a list or yes/no key
  /// only when [touched] (`[]` then means "none of these"; absent = leave the
  /// stored value alone); scalars only when chosen (absent = leave the stored
  /// value alone). An untouched page therefore sends `{touched_only: true}`,
  /// which writes nothing.
  ///
  /// `touched_only: true` IS THE NEW-BUILD SIGNAL (#1504, sent since #1710).
  /// Its ABSENCE tells the server the client cannot say which keys the worker
  /// touched — true of every build that sent `languages`/`documents_ready`/
  /// `preferred_cities` as `[]` on every save — so the server ignores an empty
  /// list wherever a stored value exists, and the worker CANNOT clear one.
  /// This body has always sent touched keys only, and since #1710 it also
  /// prefills from the stored record, so the claim is now true in both
  /// directions: with the signal, an emptied list finally clears.
  ///
  /// A LITERAL `true` — the server 400s on `false`, which would be a second
  /// spelling of "old build".
  Map<String, dynamic> toJson() {
    final Map<String, dynamic> body = <String, dynamic>{
      'touched_only': true,
      if (touched.contains(_kPrefLanguagesKey))
        _kPrefLanguagesKey: languages.toList(),
      if (touched.contains(_kPrefDocumentsKey))
        _kPrefDocumentsKey: documentsReady.toList(),
      if (touched.contains(_kPrefCitiesKey)) _kPrefCitiesKey: preferredCities,
      if (touched.contains(_kPrefRelocateKey))
        _kPrefRelocateKey: willingToRelocate,
      if (touched.contains(_kPrefAccommodationKey))
        _kPrefAccommodationKey: accommodationNeeded,
    };
    if (jobType != null) body['job_type'] = jobType;
    if (shift != null) body['shift'] = shift;
    if (salaryExpectedMax != null) {
      body['salary_expected_max'] = salaryExpectedMax;
    }
    return body;
  }

  @override
  List<Object?> get props => <Object?>[
        languages,
        documentsReady,
        preferredCities,
        jobType,
        shift,
        willingToRelocate,
        accommodationNeeded,
        salaryExpectedMax,
        touched,
      ];
}

// `PUT /workers/me/work-preferences` wire keys for the fields
// [TradeFormPreferences.touched] tracks.
const String _kPrefLanguagesKey = 'languages';
const String _kPrefDocumentsKey = 'documents_ready';
const String _kPrefCitiesKey = 'preferred_cities';
const String _kPrefRelocateKey = 'willing_to_relocate';
const String _kPrefAccommodationKey = 'accommodation_needed';

/// One row of work history for the `employment` marker screen.
///
/// PRIVACY: [employerName] and [workDone] are free text — encrypted at rest
/// server-side and never logged here.
class TradeFormEmploymentEntry extends Equatable {
  const TradeFormEmploymentEntry({
    required this.employerName,
    required this.roleLabel,
    this.employerCity,
    this.employerState,
    this.startYm,
    this.endYm,
    this.workDone,
    this.workDoneVoiceNoteId,
    this.stillWorking = true,
    this.storedRoles = const <Map<String, dynamic>>[],
  });

  final String employerName;
  final String roleLabel;
  final String? employerCity;
  final String? employerState;

  /// "YYYY-MM" or null (start not stated — allowed).
  final String? startYm;

  /// "YYYY-MM" or null. Null = CURRENT (still working here) — never "missing".
  final String? endYm;

  /// Whether the worker has told us this is his CURRENT job (the "Abhi yahin
  /// kaam kar rahe hain" switch). [endYm] null ALONE cannot express this: the
  /// switch starts ON for a fresh card, and a worker who turns it OFF without
  /// picking an end date must be blocked rather than saved as "still working"
  /// (the résumé would otherwise print "Present" for a job he left). Defaults
  /// TRUE so a loaded entry with no end reads as current, never as missing.
  final bool stillWorking;

  final String? workDone;

  /// The clip [workDone] was SPOKEN into, when the worker used the mic (#1472).
  ///
  /// PROVENANCE ONLY — the text in [workDone] is still the answer of record and
  /// still what prints on the résumé; the transcript is a draft the worker
  /// edits. The server REFUSES an id without text
  /// (`work_done_voice_note_id requires work_done`), so clearing the
  /// description must clear this too — see [toJson].
  final String? workDoneVoiceNoteId;

  /// THIS EMPLOYER'S STORED STINTS, VERBATIM, when the card cannot express
  /// them (#1710). Empty for every entry the worker typed here, and for a
  /// stored row the server's own projection rule maps to the single-role
  /// shorthand — those round-trip through the flat fields above and this stays
  /// empty, so nothing about today's wire shape changes.
  ///
  /// WHY IT EXISTS. One employer can hold SEVERAL roles over time, each with
  /// its own dates (`GET /workers/me/employment` returns them as `roles[]`),
  /// and a résumé import or the chat interview can create exactly that. This
  /// page draws ONE role per employer, so prefilling a two-stint employer into
  /// a flat card and saving it back would delete the second stint — the very
  /// class of loss #1710 exists to stop. The stints therefore ride along
  /// untouched and [toJson] re-emits them.
  ///
  /// The FIRST element is the stint the card is showing: [toJson] overwrites
  /// its `role_label`/`work_done` with what the worker has in front of them,
  /// so their edit lands on the role they were actually editing, and every
  /// other stint is sent back exactly as it was read.
  ///
  /// Carried through [copyWith], so an ordinary field edit never drops it.
  final List<Map<String, dynamic>> storedRoles;

  bool get isComplete =>
      employerName.trim().isNotEmpty && roleLabel.trim().isNotEmpty;

  bool get isBlank =>
      employerName.trim().isEmpty &&
      roleLabel.trim().isEmpty &&
      (workDone == null || workDone!.trim().isEmpty) &&
      (employerCity == null || employerCity!.trim().isEmpty) &&
      (employerState == null || employerState!.trim().isEmpty) &&
      startYm == null &&
      endYm == null;

  TradeFormEmploymentEntry copyWith({
    String? employerName,
    String? roleLabel,
    Object? employerCity = _sentinel,
    Object? employerState = _sentinel,
    Object? startYm = _sentinel,
    Object? endYm = _sentinel,
    Object? workDone = _sentinel,
    Object? workDoneVoiceNoteId = _sentinel,
    bool? stillWorking,
    List<Map<String, dynamic>>? storedRoles,
  }) {
    return TradeFormEmploymentEntry(
      employerName: employerName ?? this.employerName,
      roleLabel: roleLabel ?? this.roleLabel,
      employerCity: employerCity == _sentinel
          ? this.employerCity
          : employerCity as String?,
      employerState: employerState == _sentinel
          ? this.employerState
          : employerState as String?,
      startYm: startYm == _sentinel ? this.startYm : startYm as String?,
      endYm: endYm == _sentinel ? this.endYm : endYm as String?,
      workDone: workDone == _sentinel ? this.workDone : workDone as String?,
      workDoneVoiceNoteId: workDoneVoiceNoteId == _sentinel
          ? this.workDoneVoiceNoteId
          : workDoneVoiceNoteId as String?,
      stillWorking: stillWorking ?? this.stillWorking,
      storedRoles: storedRoles ?? this.storedRoles,
    );
  }

  /// Wire shape for `PUT /workers/me/employment`.
  ///
  /// [employerName] and [roleLabel] go through [titleCaseName] here (never
  /// [workDone] — a free-text description a worker wrote in their own
  /// words, not a proper-noun-like label) so "recursive global infotech pvt
  /// ltd" reaches the resume tab / PDF as "Recursive Global Infotech Pvt
  /// Ltd", not verbatim-lowercase.
  Map<String, dynamic> toJson() {
    String? trimOrNull(String? v) {
      final String? t = v?.trim();
      return (t == null || t.isEmpty) ? null : t;
    }

    final String? work = trimOrNull(workDone);
    final Map<String, dynamic> employer = <String, dynamic>{
      'employer_name': titleCaseName(employerName.trim()),
      'employer_city': trimOrNull(employerCity),
      'employer_state': trimOrNull(employerState),
      'start_ym': startYm,
      'end_ym': endYm,
    };

    // A MULTI-STINT EMPLOYER GOES BACK AS `roles[]` (#1710). The entry schema
    // is `.strict()` and demands EXACTLY ONE of the shorthand or `roles[]`, so
    // the two shapes can never be mixed. The card's own text replaces the
    // stint it was showing; every other stint is re-sent verbatim.
    if (storedRoles.isNotEmpty) {
      final List<Map<String, dynamic>> roles = <Map<String, dynamic>>[
        for (final Map<String, dynamic> r in storedRoles)
          Map<String, dynamic>.of(r),
      ];
      roles[0]['role_label'] = titleCaseName(roleLabel.trim());
      roles[0]['work_done'] = work;
      roles[0]['work_done_voice_note_id'] =
          work == null ? null : workDoneVoiceNoteId;
      return <String, dynamic>{...employer, 'roles': roles};
    }

    return <String, dynamic>{
      ...employer,
      'role_label': titleCaseName(roleLabel.trim()),
      'work_done': work,
      // GATED ON THE TEXT, deliberately (#1472). The server refuses an id with
      // no description — "work_done_voice_note_id requires work_done" — and
      // refuses the WHOLE submission, so a worker who records a clip and then
      // clears the box would lose their entire work history to a 400. The clip
      // is provenance for a description; with no description it is provenance
      // for nothing, so it is dropped here rather than sent.
      'work_done_voice_note_id': work == null ? null : workDoneVoiceNoteId,
    };
  }

  @override
  List<Object?> get props => <Object?>[
        employerName,
        roleLabel,
        employerCity,
        employerState,
        startYm,
        endYm,
        stillWorking,
        workDone,
        workDoneVoiceNoteId,
        storedRoles,
      ];
}

/// Server render budget, mirrors `features/finishing`'s own cap.
const int kTradeFormMaxEmployers = 4;

/// What `GET /workers/me/employment` gave the `employment` marker page to
/// prefill from (#1710) — the stored rows AND the count the save must echo.
///
/// THE TWO TRAVEL TOGETHER ON PURPOSE. `expected_existing_count` is only
/// meaningful for the exact read [entries] came from: it is that read's
/// `employments.length + unreadable_count`, and the server 409s when the rows
/// it finds at write time disagree. Handing the page a list without its count —
/// or a count from a different read — is the stale-prefill overwrite the count
/// exists to prevent.
class TradeFormStoredEmployment extends Equatable {
  const TradeFormStoredEmployment({
    this.entries = const <TradeFormEmploymentEntry>[],
    this.expectedExistingCount = 0,
  });

  /// The stored history, already projected onto the page's own entry shape.
  /// Rows the server could not decrypt are NOT here — they are counted in
  /// [expectedExistingCount] and survive the replace untouched.
  final List<TradeFormEmploymentEntry> entries;

  /// What the following `PUT /workers/me/employment` must send as
  /// `expected_existing_count`. Includes the rows withheld from [entries].
  final int expectedExistingCount;

  /// Whether this worker has any stored history at all — the signal the page
  /// uses to tell "nothing saved yet" apart from "saved, and here it is".
  bool get isEmpty => entries.isEmpty && expectedExistingCount == 0;

  @override
  List<Object?> get props => <Object?>[entries, expectedExistingCount];
}

/// ---- The `qualifications` marker's write (#1384/#1385, migration 0098) ----
///
/// `PUT /workers/me/qualifications` is TRI-STATE per list, unlike
/// [TradeFormPreferences]/[TradeFormEmploymentEntry]'s scalars-and-one-list
/// shapes: a key ABSENT from the body leaves the stored rows for that half
/// alone, `[]` clears them ("I have none" — a real answer), and a populated
/// list REPLACES them in the worker's own order. See
/// `apps/api/src/profiles/worker-qualifications.dto.ts` for the authoritative
/// contract and why `{}` is a deliberate 400 rather than absorbed silently.

/// Server caps (`CERTIFICATES_MAX`/`EDUCATIONS_MAX` in
/// `worker-qualifications.dto.ts`) — a plain client-side bound so the "add
/// another" affordance disappears before a submit could ever be rejected.
const int kTradeFormMaxCertificates = 8;
const int kTradeFormMaxEducations = 4;

/// One entry of the `certificates` sub-section — `certificates[]` on the
/// wire. [name] is the only required field (the server's own
/// `CertificateEntrySchema` makes it non-nullable); [issuer]/[year] are
/// optional. PRIVACY: [name]/[issuer] are free text that prints on the
/// résumé — never logged here (the server screens them for phone/email
/// shapes; see the DTO).
class TradeFormCertificateEntry extends Equatable {
  const TradeFormCertificateEntry({
    required this.name,
    this.issuer,
    this.year,
  });

  final String name;
  final String? issuer;

  /// 1950–2100 (`wc_year_chk`) — enforced by the picker sheet that produces
  /// this value, never re-validated here.
  final int? year;

  bool get isBlank =>
      name.trim().isEmpty &&
      (issuer == null || issuer!.trim().isEmpty) &&
      year == null;

  /// The server's own requirement: `name` is the one non-nullable field on
  /// `CertificateEntrySchema`. Callers filter [isBlank] rows out first, then
  /// check this on what remains — a row with an issuer/year typed but no
  /// name is neither blank nor complete, and must block the save with an
  /// honest message rather than reach the server as a 400.
  bool get isComplete => name.trim().isNotEmpty;

  TradeFormCertificateEntry copyWith({
    String? name,
    Object? issuer = _sentinel,
    Object? year = _sentinel,
  }) {
    return TradeFormCertificateEntry(
      name: name ?? this.name,
      issuer: issuer == _sentinel ? this.issuer : issuer as String?,
      year: year == _sentinel ? this.year : year as int?,
    );
  }

  /// Wire shape for one `certificates[]` entry.
  Map<String, dynamic> toJson() {
    String? trimOrNull(String? v) {
      final String? t = v?.trim();
      return (t == null || t.isEmpty) ? null : t;
    }

    return <String, dynamic>{
      'name': name.trim(),
      'issuer': trimOrNull(issuer),
      'year': year,
    };
  }

  @override
  List<Object?> get props => <Object?>[name, issuer, year];
}

/// One entry of the `educations` sub-section — `educations[]` on the wire.
/// Every field is individually optional; the server's own refinement
/// rejects a row where all five are null ("an education entry must carry at
/// least one field") — [isBlank] mirrors that exact rule so the client
/// filters the same rows the server would 400 on.
class TradeFormEducationEntry extends Equatable {
  const TradeFormEducationEntry({
    this.credential,
    this.field,
    this.council,
    this.year,
    this.institute,
  });

  /// A slug from `education_credential`
  /// (`GET /workers/me/qualifications/options`) — never the printed label.
  final String? credential;

  /// The trade or stream, in the worker's own words: "Machinist".
  final String? field;

  /// NCVT, SCVT, a state board — a slug from `education_council`.
  final String? council;

  /// 1950–2100 (`wed_year_chk`).
  final int? year;

  /// The institute, as the worker reads it off the certificate. Free text —
  /// there is no national register of ITI names to validate against.
  final String? institute;

  bool get isBlank =>
      credential == null &&
      (field == null || field!.trim().isEmpty) &&
      council == null &&
      year == null &&
      (institute == null || institute!.trim().isEmpty);

  TradeFormEducationEntry copyWith({
    Object? credential = _sentinel,
    Object? field = _sentinel,
    Object? council = _sentinel,
    Object? year = _sentinel,
    Object? institute = _sentinel,
  }) {
    return TradeFormEducationEntry(
      credential:
          credential == _sentinel ? this.credential : credential as String?,
      field: field == _sentinel ? this.field : field as String?,
      council: council == _sentinel ? this.council : council as String?,
      year: year == _sentinel ? this.year : year as int?,
      institute:
          institute == _sentinel ? this.institute : institute as String?,
    );
  }

  /// Wire shape for one `educations[]` entry.
  Map<String, dynamic> toJson() {
    String? trimOrNull(String? v) {
      final String? t = v?.trim();
      return (t == null || t.isEmpty) ? null : t;
    }

    return <String, dynamic>{
      'credential': credential,
      'field': trimOrNull(field),
      'council': council,
      'year': year,
      'institute': trimOrNull(institute),
    };
  }

  @override
  List<Object?> get props =>
      <Object?>[credential, field, council, year, institute];
}

/// The `qualifications` marker's write model — certificates + education,
/// TRI-STATE per list (see the section doc above).
///
/// [certificatesTouched]/[educationsTouched] are the ENTIRE mechanism: a
/// section becomes touched the moment the worker adds, edits, or removes a
/// row in it (`TradeFormQualificationsPage` owns setting these), and STAYS
/// touched even if they end up back at zero rows — that is what lets
/// "add then remove everything" express a real "I have none" rather than
/// being indistinguishable from never opening the section. [toJson] omits a
/// key entirely when its section is untouched — NEVER defaults to sending
/// `[]` for an untouched section, which would silently wipe a previously-
/// saved list every time a worker passed through this page without
/// touching one half of it (the exact failure `worker-qualifications.dto.ts`
/// documents this shape exists to prevent).
class TradeFormQualifications extends Equatable {
  const TradeFormQualifications({
    this.certificates = const <TradeFormCertificateEntry>[],
    this.certificatesTouched = false,
    this.educations = const <TradeFormEducationEntry>[],
    this.educationsTouched = false,
  });

  final List<TradeFormCertificateEntry> certificates;
  final bool certificatesTouched;
  final List<TradeFormEducationEntry> educations;
  final bool educationsTouched;

  /// True once at least one half of the page has something to send.
  /// [TradeFormCubit.saveQualificationsAndAdvance] uses this to skip the PUT
  /// entirely rather than ever send `{}` — the one body this endpoint 400s
  /// by design (`{}` and `{"certificates": []}` must stay distinguishable).
  bool get hasAnyTouch => certificatesTouched || educationsTouched;

  TradeFormQualifications copyWith({
    List<TradeFormCertificateEntry>? certificates,
    bool? certificatesTouched,
    List<TradeFormEducationEntry>? educations,
    bool? educationsTouched,
  }) {
    return TradeFormQualifications(
      certificates: certificates ?? this.certificates,
      certificatesTouched: certificatesTouched ?? this.certificatesTouched,
      educations: educations ?? this.educations,
      educationsTouched: educationsTouched ?? this.educationsTouched,
    );
  }

  /// Wire body for `PUT /workers/me/qualifications` — a key is present ONLY
  /// when its section was touched. Callers must check [hasAnyTouch] before
  /// sending (an empty map here is the deliberate 400 above).
  Map<String, dynamic> toJson() {
    final Map<String, dynamic> body = <String, dynamic>{};
    if (certificatesTouched) {
      body['certificates'] = certificates
          .map((TradeFormCertificateEntry c) => c.toJson())
          .toList();
    }
    if (educationsTouched) {
      body['educations'] = educations
          .map((TradeFormEducationEntry e) => e.toJson())
          .toList();
    }
    return body;
  }

  @override
  List<Object?> get props => <Object?>[
        certificates,
        certificatesTouched,
        educations,
        educationsTouched,
      ];
}

/// copyWith sentinel so `null` can be passed to CLEAR a nullable field,
/// distinct from omitting the argument to keep it.
const Object _sentinel = Object();
