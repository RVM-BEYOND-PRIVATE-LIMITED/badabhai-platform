import 'dart:async';

import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/api/api_client.dart' show WorkPrefOptionsDto;
import '../../../../core/error/failure.dart';
import '../../../../core/observability/analytics.dart';
import '../../domain/finishing_models.dart';
import '../../domain/finishing_repository.dart';

/// The ordered pages of the finishing form (#1296, extended #1298), roughly
/// ascending effort — chips first, the typing pages (salary/education, then work
/// history) last.
enum FinishingPage {
  languages,
  documents,
  shiftAndType,
  cities,
  salaryEducation,
  history,
}

enum FinishingStatus { loadingOptions, ready, submitting, done, loadError }

/// The whole finishing-form state: the loaded chip vocabulary, which page is on
/// screen, and the worker's growing selections. One immutable value so the view
/// is a pure function of it.
class FinishingState extends Equatable {
  const FinishingState({
    this.status = FinishingStatus.loadingOptions,
    this.options,
    this.pageIndex = 0,
    this.prefs = const WorkPreferences(),
    this.employments = const <EmploymentEntry>[],
    this.error,
    this.submitError,
  });

  final FinishingStatus status;
  final WorkPrefOptionsDto? options;
  final int pageIndex;
  final WorkPreferences prefs;
  final List<EmploymentEntry> employments;

  /// A blocking load error (the options fetch failed) — the screen shows a retry.
  final String? error;

  /// A transient submit error (a save failed, e.g. a 400 naming a bad city) —
  /// shown inline while the worker stays on the form and can fix + retry.
  final String? submitError;

  FinishingPage get page => FinishingPage.values[pageIndex];
  bool get isLastPage => pageIndex == FinishingPage.values.length - 1;
  bool get isFirstPage => pageIndex == 0;
  bool get isSubmitting => status == FinishingStatus.submitting;

  FinishingState copyWith({
    FinishingStatus? status,
    WorkPrefOptionsDto? options,
    int? pageIndex,
    WorkPreferences? prefs,
    List<EmploymentEntry>? employments,
    Object? error = _sentinel,
    Object? submitError = _sentinel,
  }) {
    return FinishingState(
      status: status ?? this.status,
      options: options ?? this.options,
      pageIndex: pageIndex ?? this.pageIndex,
      prefs: prefs ?? this.prefs,
      employments: employments ?? this.employments,
      error: error == _sentinel ? this.error : error as String?,
      submitError: submitError == _sentinel ? this.submitError : submitError as String?,
    );
  }

  @override
  List<Object?> get props => <Object?>[
        status,
        options,
        pageIndex,
        prefs,
        employments,
        error,
        submitError,
      ];
}

/// Drives the post-interview finishing form (#1296): loads the chip vocabulary,
/// carries the worker's selections across the five pages, and on the last page
/// persists both closed-set writes before the résumé is generated. Every field
/// is a closed-set answer — no model, no free parse — so this holds pure data.
class FinishingCubit extends Cubit<FinishingState> {
  FinishingCubit(this._repo) : super(const FinishingState());

  final FinishingRepository _repo;

  /// Copy shown when a partially-typed employer card is missing its two required
  /// fields. Persona-neutral (aap-form, safe verb, no `!`). Scanned by
  /// persona_neutrality_test.dart.
  static const String kIncompleteEmployerMessage =
      'Har naukri mein company ka naam aur aapka kaam dono likhein.';

  Future<void> load() async {
    emit(state.copyWith(status: FinishingStatus.loadingOptions, error: null));
    try {
      final WorkPrefOptionsDto options = await _repo.loadOptions();
      emit(state.copyWith(status: FinishingStatus.ready, options: options));
      // #1315 — funnel entry. Fire-and-forget, never fatal (BbAnalytics is
      // fail-open); it carries no worker data, only that the form opened.
      unawaited(BbAnalytics.instance.log(BbAnalytics.finishingFormEntered));
    } on Failure catch (f) {
      emit(state.copyWith(status: FinishingStatus.loadError, error: f.message));
    } catch (_) {
      emit(state.copyWith(
        status: FinishingStatus.loadError,
        error: 'Kuch gadbad ho gayi. Dobara koshish karein.',
      ));
    }
  }

  // --- Page navigation ---------------------------------------------------

  void nextPage() {
    if (state.isLastPage) return;
    final int next = state.pageIndex + 1;
    emit(state.copyWith(pageIndex: next, submitError: null));
    // #1315 — per-page reach, so drop-off across the pages is measurable. The
    // index is a page COUNT (0-based), never an answer on the page.
    unawaited(
        BbAnalytics.instance.log(BbAnalytics.finishingPageReached(pageIndex: next)));
  }

  void previousPage() {
    if (state.isFirstPage) return;
    emit(state.copyWith(pageIndex: state.pageIndex - 1, submitError: null));
  }

  // --- Chip / toggle edits ----------------------------------------------

  void toggleLanguage(String slug) => _emitPrefs(
      state.prefs.copyWith(languages: _toggled(state.prefs.languages, slug)));

  void toggleDocument(String slug) => _emitPrefs(state.prefs
      .copyWith(documentsReady: _toggled(state.prefs.documentsReady, slug)));

  /// Single-select: tapping the chosen chip again clears it (a real "skip").
  void selectJobType(String slug) => _emitPrefs(state.prefs
      .copyWith(jobType: state.prefs.jobType == slug ? null : slug));

  void selectShift(String slug) => _emitPrefs(
      state.prefs.copyWith(shift: state.prefs.shift == slug ? null : slug));

  void addCity(String city) {
    final String trimmed = city.trim();
    if (trimmed.isEmpty) return;
    // Case-insensitive de-dupe on the raw text; the server canonicalises the
    // spelling on save, so exact display casing is not load-bearing here.
    final bool exists = state.prefs.preferredCities
        .any((String c) => c.toLowerCase() == trimmed.toLowerCase());
    if (exists) return;
    _emitPrefs(state.prefs.copyWith(
        preferredCities: <String>[...state.prefs.preferredCities, trimmed]));
  }

  void removeCity(String city) => _emitPrefs(state.prefs.copyWith(
      preferredCities: state.prefs.preferredCities
          .where((String c) => c != city)
          .toList()));

  void setRelocate(bool value) =>
      _emitPrefs(state.prefs.copyWith(willingToRelocate: value));

  void setAccommodation(bool value) =>
      _emitPrefs(state.prefs.copyWith(accommodationNeeded: value));

  // --- Salary band + education credential (#1298) -----------------------

  /// The salary band max, already parsed + range-guarded by the input edge
  /// (null clears it / an out-of-range value is dropped before it reaches here).
  void setSalaryMax(int? value) =>
      _emitPrefs(state.prefs.copyWith(salaryExpectedMax: value));

  /// Single-select: re-tapping the chosen credential clears it.
  void selectCredential(String slug) => _emitPrefs(state.prefs.copyWith(
      educationCredential:
          state.prefs.educationCredential == slug ? null : slug));

  void selectCouncil(String slug) => _emitPrefs(state.prefs.copyWith(
      educationCouncil: state.prefs.educationCouncil == slug ? null : slug));

  void setEducationYear(int? value) =>
      _emitPrefs(state.prefs.copyWith(educationYear: value));

  void setInstitute(String value) {
    final String trimmed = value.trim();
    _emitPrefs(state.prefs
        .copyWith(educationInstitute: trimmed.isEmpty ? null : trimmed));
  }

  // --- Work history ------------------------------------------------------

  bool get _atEmployerCap =>
      state.employments.length >= kMaxEmployers;

  void addEmployer() {
    if (_atEmployerCap) return;
    emit(state.copyWith(
      employments: <EmploymentEntry>[
        ...state.employments,
        const EmploymentEntry(employerName: '', roleLabel: ''),
      ],
      submitError: null,
    ));
  }

  void updateEmployer(int index, EmploymentEntry entry) {
    if (index < 0 || index >= state.employments.length) return;
    final List<EmploymentEntry> next =
        List<EmploymentEntry>.of(state.employments);
    next[index] = entry;
    emit(state.copyWith(employments: next, submitError: null));
  }

  void removeEmployer(int index) {
    if (index < 0 || index >= state.employments.length) return;
    final List<EmploymentEntry> next =
        List<EmploymentEntry>.of(state.employments)..removeAt(index);
    emit(state.copyWith(employments: next, submitError: null));
  }

  // --- Submit ------------------------------------------------------------

  /// Persists both writes (work preferences, then the work history) and, on
  /// success, moves to [FinishingStatus.done] for the screen to route on. A
  /// wholly-blank trailing card is dropped; a partially-typed one that is still
  /// missing its two required fields blocks the submit with an inline hint. A
  /// failed save keeps the worker on the form with the reason, so a bad-city 400
  /// is fixable rather than fatal.
  Future<void> submit() async {
    if (state.isSubmitting) return;

    final List<EmploymentEntry> kept = state.employments
        .where((EmploymentEntry e) => !e.isBlank)
        .toList();
    if (kept.any((EmploymentEntry e) => !e.isComplete)) {
      emit(state.copyWith(submitError: kIncompleteEmployerMessage));
      return;
    }

    emit(state.copyWith(status: FinishingStatus.submitting, submitError: null));
    try {
      await _repo.saveWorkPreferences(state.prefs);
      await _repo.saveEmployment(kept);
      emit(state.copyWith(status: FinishingStatus.done));
      // #1315 — funnel exit: both writes landed, so completion is real.
      unawaited(BbAnalytics.instance.log(BbAnalytics.finishingFormSubmitted));
    } on Failure catch (f) {
      emit(state.copyWith(status: FinishingStatus.ready, submitError: f.message));
    } catch (_) {
      emit(state.copyWith(
        status: FinishingStatus.ready,
        submitError: 'Save nahi hua. Dobara koshish karein.',
      ));
    }
  }

  // --- helpers -----------------------------------------------------------

  void _emitPrefs(WorkPreferences prefs) =>
      emit(state.copyWith(prefs: prefs, submitError: null));

  Set<String> _toggled(Set<String> set, String slug) {
    final Set<String> next = Set<String>.of(set);
    if (!next.add(slug)) next.remove(slug);
    return next;
  }
}

/// Server render budget (#1296): a fifth employer is stored then silently dropped
/// by the sheet, so the client caps at four rather than send a rejected row.
const int kMaxEmployers = 4;

const Object _sentinel = Object();
