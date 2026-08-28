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

/// The closed-set finishing selections (#1296, `PUT /workers/me/work-preferences`).
///
/// Held as the worker builds them across the chip pages; [toUpdateBody] shapes
/// them for the wire. Lists are always sent (an empty list is the real answer
/// "none of these"); the two scalar chips are sent only when chosen, so an
/// untouched page leaves the stored value alone; the toggles are always a real
/// yes/no.
class WorkPreferences extends Equatable {
  const WorkPreferences({
    this.languages = const <String>{},
    this.documentsReady = const <String>{},
    this.preferredCities = const <String>[],
    this.jobType,
    this.shift,
    this.willingToRelocate = false,
    this.accommodationNeeded = false,
  });

  final Set<String> languages;
  final Set<String> documentsReady;
  final List<String> preferredCities;
  final String? jobType;
  final String? shift;
  final bool willingToRelocate;
  final bool accommodationNeeded;

  WorkPreferences copyWith({
    Set<String>? languages,
    Set<String>? documentsReady,
    List<String>? preferredCities,
    Object? jobType = _sentinel,
    Object? shift = _sentinel,
    bool? willingToRelocate,
    bool? accommodationNeeded,
  }) {
    return WorkPreferences(
      languages: languages ?? this.languages,
      documentsReady: documentsReady ?? this.documentsReady,
      preferredCities: preferredCities ?? this.preferredCities,
      jobType: jobType == _sentinel ? this.jobType : jobType as String?,
      shift: shift == _sentinel ? this.shift : shift as String?,
      willingToRelocate: willingToRelocate ?? this.willingToRelocate,
      accommodationNeeded: accommodationNeeded ?? this.accommodationNeeded,
    );
  }

  /// Wire body. Lists always present ([] = "none of these"); `job_type`/`shift`
  /// only when chosen (absent = leave the stored value alone); toggles always a
  /// bool. The three-state contract lives here, deliberately, so the API client
  /// stays a dumb pass-through.
  Map<String, dynamic> toUpdateBody() {
    final Map<String, dynamic> body = <String, dynamic>{
      'languages': languages.toList(),
      'documents_ready': documentsReady.toList(),
      'preferred_cities': preferredCities,
      'willing_to_relocate': willingToRelocate,
      'accommodation_needed': accommodationNeeded,
    };
    if (jobType != null) body['job_type'] = jobType;
    if (shift != null) body['shift'] = shift;
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
      ];
}

/// copyWith sentinel so `null` can be passed to CLEAR a nullable field, distinct
/// from omitting the argument to keep it.
const Object _sentinel = Object();
