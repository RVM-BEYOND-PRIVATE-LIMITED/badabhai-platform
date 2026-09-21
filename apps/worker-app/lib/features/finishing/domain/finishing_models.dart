import 'package:equatable/equatable.dart';

/// One row of the worker's work history (#1296, `PUT /workers/me/employment`).
///
/// [employerName] and [roleLabel] are the only required fields — everything else
/// is an honest optional. [endYm] `null` means "still working here" (a real
/// answer, NOT a skipped one); a missing [startYm] is allowed and the résumé then
/// prints "duration not stated" rather than inventing a date, so the UI must
/// never force a date to submit.
///
/// PRIVACY: the employer name and the free-text [workDone] are the only
/// non-closed fields; both are encrypted at rest server-side and never logged
/// here.
class EmploymentEntry extends Equatable {
  const EmploymentEntry({
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

  /// "YYYY-MM" or null. Null = start not stated (allowed).
  final String? startYm;

  /// "YYYY-MM" or null. Null = CURRENT (still working here) — never "missing".
  final String? endYm;

  /// Free text, max 300 chars (enforced at the input edge).
  final String? workDone;

  /// The two fields the server requires are present and non-blank. A row that
  /// fails this is not submittable (the sheet drops a wholly-empty trailing card
  /// rather than sending a nameless employer).
  bool get isComplete =>
      employerName.trim().isNotEmpty && roleLabel.trim().isNotEmpty;

  /// True when the worker has typed nothing at all into this card — used to
  /// silently drop an empty trailing card instead of erroring on it.
  bool get isBlank =>
      employerName.trim().isEmpty &&
      roleLabel.trim().isEmpty &&
      (workDone == null || workDone!.trim().isEmpty) &&
      (employerCity == null || employerCity!.trim().isEmpty) &&
      (employerState == null || employerState!.trim().isEmpty) &&
      startYm == null &&
      endYm == null;

  EmploymentEntry copyWith({
    String? employerName,
    String? roleLabel,
    Object? employerCity = _sentinel,
    Object? employerState = _sentinel,
    Object? startYm = _sentinel,
    Object? endYm = _sentinel,
    Object? workDone = _sentinel,
  }) {
    return EmploymentEntry(
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

  /// Wire shape for `PUT /workers/me/employment`. Nullable fields are sent as
  /// `null` on purpose — `end_ym: null` is the "current" answer the server reads.
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

/// The structured `availability` attribute (Layer A (c), migration 0111).
///
/// One object, three optional parts — one submission, so a notice period
/// without the day it runs from says nothing. Every part is nullable so the
/// worker can clear one without clearing the answer; `available_from` is a
/// calendar-day STRING (`YYYY-MM-DD`), never a parsed Date — a Date would
/// round-trip through UTC and shift under IST.
class AvailabilityDraft extends Equatable {
  const AvailabilityDraft({
    this.status,
    this.availableFrom,
    this.noticePeriodDays,
  });

  final String? status;
  final String? availableFrom;
  final int? noticePeriodDays;

  bool get isEmpty =>
      status == null && availableFrom == null && noticePeriodDays == null;

  AvailabilityDraft copyWith({
    Object? status = _sentinel,
    Object? availableFrom = _sentinel,
    Object? noticePeriodDays = _sentinel,
  }) {
    return AvailabilityDraft(
      status: status == _sentinel ? this.status : status as String?,
      availableFrom: availableFrom == _sentinel
          ? this.availableFrom
          : availableFrom as String?,
      noticePeriodDays: noticePeriodDays == _sentinel
          ? this.noticePeriodDays
          : noticePeriodDays as int?,
    );
  }

  /// Wire shape — every key present, `null` where unset, so a re-save clears
  /// the parts the worker removed.
  Map<String, dynamic> toJson() => <String, dynamic>{
        'status': status,
        'available_from': availableFrom,
        'notice_period_days': noticePeriodDays,
      };

  factory AvailabilityDraft.fromJson(Map<String, dynamic> json) =>
      AvailabilityDraft(
        status: json['status'] as String?,
        availableFrom: json['available_from'] as String?,
        noticePeriodDays: (json['notice_period_days'] as num?)?.toInt(),
      );

  @override
  List<Object?> get props => <Object?>[status, availableFrom, noticePeriodDays];
}

/// The closed-set finishing selections (#1296, `PUT /workers/me/work-preferences`).
///
/// Held as the worker builds them across the chip pages; [toUpdateBody] shapes
/// them for the wire. Lists and toggles are sent only once [touched] (an empty
/// list is then the real answer "none of these"); the scalar chips are sent
/// only when chosen; so an untouched page leaves the stored value alone.
class WorkPreferences extends Equatable {
  const WorkPreferences({
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
    this.workTypes = const <String>{},
    this.salaryPeriod,
    this.commuteMaxKm,
    this.willingToTravel = false,
    this.availability,
    this.touched = const <String>{},
  });

  /// Wire keys of the list and yes/no fields the worker CHANGED, set by
  /// [copyWith] (every cubit edit goes through it). The finishing form opens
  /// blank every time (the endpoint has no read), so sending an untouched `[]`
  /// or `false` would erase what the worker saved on an earlier visit; the
  /// server leaves an absent key alone.
  final Set<String> touched;

  final Set<String> languages;
  final Set<String> documentsReady;
  final List<String> preferredCities;
  final String? jobType;
  final String? shift;
  final bool willingToRelocate;
  final bool accommodationNeeded;

  /// Upper end of the expected-salary BAND (#1298, R10 R-1). The interview
  /// captures the lower end; a max here turns a point figure into a band. Bounded
  /// 1000–500000 at the input edge (the server rejects out-of-range).
  final int? salaryExpectedMax;

  /// Which of the two credentials the worker's `iti_diploma` level names —
  /// `iti` or `diploma` (#1298).
  final String? educationCredential;

  /// Awarding council slug (ncvt / scvt / nsqf / …) (#1298).
  final String? educationCouncil;

  /// Year the credential was awarded, bounded 1950–2100 (#1298).
  final int? educationYear;

  /// Institute as the worker reads it off the certificate, max 120 (#1298).
  final String? educationInstitute;

  /// Layer A (c) — the MULTI beside [jobType] (`job_type` remains the valid
  /// fallback; a non-empty [workTypes] wins server-side). Empty list = the
  /// worker withdrew the multi answer.
  final Set<String> workTypes;

  /// Layer A (c) — the period every salary figure is quoted in. `null` = leave
  /// the stored value (the server defaults the meaning to monthly).
  final String? salaryPeriod;

  /// Layer A (c) — how far the worker will travel, 0–500 km. `null` = leave.
  final int? commuteMaxKm;

  /// Layer A (c) — willingness to travel. A plain bool with [touched]
  /// bookkeeping: only `true` prints, so `false` is the worker withdrawing a
  /// claim and must be sent to clear it.
  final bool willingToTravel;

  /// Layer A (c) — the structured availability object. `null` here means "leave
  /// the stored value alone"; a non-null draft is sent whenever touched.
  final AvailabilityDraft? availability;

  WorkPreferences copyWith({
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
    Set<String>? workTypes,
    Object? salaryPeriod = _sentinel,
    Object? commuteMaxKm = _sentinel,
    bool? willingToTravel,
    Object? availability = _sentinel,
  }) {
    return WorkPreferences(
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
      workTypes: workTypes ?? this.workTypes,
      salaryPeriod:
          salaryPeriod == _sentinel ? this.salaryPeriod : salaryPeriod as String?,
      commuteMaxKm:
          commuteMaxKm == _sentinel ? this.commuteMaxKm : commuteMaxKm as int?,
      willingToTravel: willingToTravel ?? this.willingToTravel,
      availability: availability == _sentinel
          ? this.availability
          : availability as AvailabilityDraft?,
      touched: <String>{
        ...touched,
        if (languages != null) _kLanguagesKey,
        if (documentsReady != null) _kDocumentsKey,
        if (preferredCities != null) _kCitiesKey,
        if (willingToRelocate != null) _kRelocateKey,
        if (accommodationNeeded != null) _kAccommodationKey,
        if (workTypes != null) _kWorkTypesKey,
        if (willingToTravel != null) _kTravelKey,
        if (availability != _sentinel) _kAvailabilityKey,
      },
    );
  }

  /// Wire body. Lists and toggles only when [touched] ([] = "none of these");
  /// `job_type`/`shift` only when chosen (absent = leave the stored value
  /// alone). The three-state contract lives here, deliberately, so the API
  /// client stays a dumb pass-through.
  Map<String, dynamic> toUpdateBody() {
    final Map<String, dynamic> body = <String, dynamic>{
      if (touched.contains(_kLanguagesKey)) _kLanguagesKey: languages.toList(),
      if (touched.contains(_kDocumentsKey))
        _kDocumentsKey: documentsReady.toList(),
      if (touched.contains(_kCitiesKey)) _kCitiesKey: preferredCities,
      if (touched.contains(_kRelocateKey)) _kRelocateKey: willingToRelocate,
      if (touched.contains(_kAccommodationKey))
        _kAccommodationKey: accommodationNeeded,
    };
    if (jobType != null) body['job_type'] = jobType;
    if (shift != null) body['shift'] = shift;
    // #1298 — the salary band max + the education credential group. Same
    // three-state rule: sent only when the worker gave a value (absent = leave
    // the stored value alone), so an untouched field never clears an interview
    // answer. All are `.nullable().optional()` on the server.
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
    // Layer A (c) — the extension fields. Same three-state discipline: a list
    // and a toggle only when [touched] ([] / false is a real withdrawal), the
    // scalars only when given, and the availability object only when touched
    // (its every key present, nulls included, so a part can be cleared).
    if (touched.contains(_kWorkTypesKey)) {
      body[_kWorkTypesKey] = workTypes.toList();
    }
    if (salaryPeriod != null) body['salary_period'] = salaryPeriod;
    if (commuteMaxKm != null) body['commute_max_km'] = commuteMaxKm;
    if (touched.contains(_kTravelKey)) {
      body[_kTravelKey] = willingToTravel;
    }
    if (touched.contains(_kAvailabilityKey)) {
      body[_kAvailabilityKey] = availability?.toJson();
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
        workTypes,
        salaryPeriod,
        commuteMaxKm,
        willingToTravel,
        availability,
        touched,
      ];
}

/// Server cap (`languages`'s `.max(6)` in `worker-preferences.dto.ts`) —
/// an editorial limit on how many print on the sheet, not the dictionary's
/// size (16). Deliberate duplicate of `kTradeFormMaxLanguages`
/// (`features/trade_form`, slated for retirement) — see that constant's doc.
const int kFinishingMaxLanguages = 6;

// `PUT /workers/me/work-preferences` wire keys for the fields
// [WorkPreferences.touched] tracks.
const String _kLanguagesKey = 'languages';
const String _kDocumentsKey = 'documents_ready';
const String _kCitiesKey = 'preferred_cities';
const String _kRelocateKey = 'willing_to_relocate';
const String _kAccommodationKey = 'accommodation_needed';
// Layer A (c) — the extension keys the finishing-form contract test watches for
// (`apps/api/src/profiles/finishing-form-contract.test.ts`).
const String _kWorkTypesKey = 'work_types';
const String _kTravelKey = 'willing_to_travel';
const String _kAvailabilityKey = 'availability';

/// copyWith sentinel so `null` can be passed to CLEAR a nullable field, distinct
/// from omitting the argument to keep it.
const Object _sentinel = Object();
