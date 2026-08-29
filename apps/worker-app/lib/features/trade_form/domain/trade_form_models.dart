import 'package:equatable/equatable.dart';

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

  bool get isAnswered => answer != null;

  @override
  List<Object?> get props => <Object?>[question, searchable, answer];
}

/// `type: "preferences"` — a MARKER naming where the closed-set preferences
/// page (`PUT /workers/me/work-preferences`) sits in the journey. Not a copy
/// of that contract; the endpoint owns its own vocabulary and validation.
class TradeFormPreferencesStep extends TradeFormStep {
  const TradeFormPreferencesStep();

  @override
  List<Object?> get props => const <Object?>[];
}

/// `type: "employment"` — a MARKER for the work-history page
/// (`PUT /workers/me/employment`). Same argument as [TradeFormPreferencesStep].
class TradeFormEmploymentStep extends TradeFormStep {
  const TradeFormEmploymentStep();

  @override
  List<Object?> get props => const <Object?>[];
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
  });

  final String kind;
  final String packId;

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
  List<Object?> get props => <Object?>[kind, packId, packVersion, sections];
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
  });

  final String questionKey;
  final TradeFormAnswerStatus status;
  final int answered;
  final int total;

  @override
  List<Object?> get props => <Object?>[questionKey, status, answered, total];
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

/// The closed-set preferences a worker sets on a `preferences` marker screen.
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
    this.educationCredential,
    this.educationCouncil,
    this.educationYear,
    this.educationInstitute,
  });

  final Set<String> languages;
  final Set<String> documentsReady;
  final List<String> preferredCities;
  final String? jobType;
  final String? shift;
  final bool willingToRelocate;
  final bool accommodationNeeded;
  final int? salaryExpectedMax;
  final String? educationCredential;
  final String? educationCouncil;
  final int? educationYear;
  final String? educationInstitute;

  TradeFormPreferences copyWith({
    Set<String>? languages,
    Set<String>? documentsReady,
    List<String>? preferredCities,
    Object? jobType = _sentinel,
    Object? shift = _sentinel,
    bool? willingToRelocate,
    bool? accommodationNeeded,
    Object? salaryExpectedMax = _sentinel,
    Object? educationCredential = _sentinel,
    Object? educationCouncil = _sentinel,
    Object? educationYear = _sentinel,
    Object? educationInstitute = _sentinel,
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
      educationCredential: educationCredential == _sentinel
          ? this.educationCredential
          : educationCredential as String?,
      educationCouncil: educationCouncil == _sentinel
          ? this.educationCouncil
          : educationCouncil as String?,
      educationYear: educationYear == _sentinel
          ? this.educationYear
          : educationYear as int?,
      educationInstitute: educationInstitute == _sentinel
          ? this.educationInstitute
          : educationInstitute as String?,
    );
  }

  /// Wire body for `PUT /workers/me/work-preferences` — lists always present
  /// (`[]` = "none of these"); scalars only when chosen (absent = leave the
  /// stored value alone).
  Map<String, dynamic> toJson() {
    final Map<String, dynamic> body = <String, dynamic>{
      'languages': languages.toList(),
      'documents_ready': documentsReady.toList(),
      'preferred_cities': preferredCities,
      'willing_to_relocate': willingToRelocate,
      'accommodation_needed': accommodationNeeded,
    };
    if (jobType != null) body['job_type'] = jobType;
    if (shift != null) body['shift'] = shift;
    if (salaryExpectedMax != null) {
      body['salary_expected_max'] = salaryExpectedMax;
    }
    if (educationCredential != null) {
      body['education_credential'] = educationCredential;
    }
    if (educationCouncil != null) body['education_council'] = educationCouncil;
    if (educationYear != null) body['education_year'] = educationYear;
    if (educationInstitute != null) {
      body['education_institute'] = educationInstitute;
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
        educationCredential,
        educationCouncil,
        educationYear,
        educationInstitute,
      ];
}

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
  });

  final String employerName;
  final String roleLabel;
  final String? employerCity;
  final String? employerState;

  /// "YYYY-MM" or null (start not stated — allowed).
  final String? startYm;

  /// "YYYY-MM" or null. Null = CURRENT (still working here) — never "missing".
  final String? endYm;
  final String? workDone;

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
    );
  }

  /// Wire shape for `PUT /workers/me/employment`.
  Map<String, dynamic> toJson() {
    String? trimOrNull(String? v) {
      final String? t = v?.trim();
      return (t == null || t.isEmpty) ? null : t;
    }

    return <String, dynamic>{
      'employer_name': employerName.trim(),
      'employer_city': trimOrNull(employerCity),
      'employer_state': trimOrNull(employerState),
      'start_ym': startYm,
      'end_ym': endYm,
      'role_label': roleLabel.trim(),
      'work_done': trimOrNull(workDone),
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
        workDone,
      ];
}

/// Server render budget, mirrors `features/finishing`'s own cap.
const int kTradeFormMaxEmployers = 4;

/// copyWith sentinel so `null` can be passed to CLEAR a nullable field,
/// distinct from omitting the argument to keep it.
const Object _sentinel = Object();
