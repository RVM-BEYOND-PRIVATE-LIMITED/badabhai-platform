import 'dart:async';

import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/api/api_client.dart'
    show WorkPrefOptionsDto, SessionFillDto, SessionFillEntryDto;
import '../../../../core/error/failure.dart';
import '../../../../core/observability/analytics.dart';
import '../../../../core/session/known_worker_facts_store.dart';
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
  // #1471 — salary + education used to be ONE page carrying FIVE questions
  // (salary band, credential, council, year, institute). It did not fit any
  // handset, so the worker had to scroll a form they cannot read to find the
  // button. Split into three: the money question, the two education chip
  // questions, then the two education text fields.
  salary,
  education,
  educationDetail,
  history,
}

/// The pages this worker is shown: every [FinishingPage] except one whose fact
/// the chat already recorded ("ask once, skip if known", see
/// [KnownWorkerFactsStore]). The shift chips are hidden the same way, on the
/// screen, because they share their page with job type.
///
/// #1575 adds the second filter: facts the session settled (answered OR
/// declined, on either road) are skipped too — `/finishing` is the safety net,
/// never a second full collection pass. An empty [settled] set (no pinned
/// pack, form road, old server, failed read) shows the FULL list: empty means
/// "we cannot say", never "answered".
List<FinishingPage> finishingPagesFor(
  Set<WorkerFact> known, [
  Set<String> settled = const <String>{},
]) =>
    <FinishingPage>[
      for (final FinishingPage page in FinishingPage.values)
        if (!_askedInChat(page, known) && !_settledOut(page, settled)) page,
    ];

bool _askedInChat(FinishingPage page, Set<WorkerFact> known) => switch (page) {
      FinishingPage.cities => known.contains(WorkerFact.preferredCities),
      FinishingPage.salary => known.contains(WorkerFact.salary),
      _ => false,
    };

/// Fill facts each page answers, keyed by the server's fact ids
/// (`worker-fact.registry.ts`). A page is skipped only when ALL of its facts
/// are settled — a half-settled page still shows, so the unanswered half stays
/// collectable.
Set<String> _pageFacts(FinishingPage page) => switch (page) {
      FinishingPage.languages => const <String>{'languages'},
      FinishingPage.documents => const <String>{'documents_ready'},
      // The type half is covered by EITHER the multi or the legacy single —
      // the multi wins server-side, so a settled multi settles the question.
      // (`_settledOut` special-cases this page to OR the two; the set here is
      // for gap-note matching, where both spellings count.)
      FinishingPage.shiftAndType =>
        const <String>{'shift', 'work_types', 'job_type'},
      FinishingPage.cities => const <String>{'preferred_locations'},
      FinishingPage.salary => const <String>{'salary_expected'},
      FinishingPage.education => const <String>{'education'},
      FinishingPage.educationDetail => const <String>{'education'},
      // Work history has no fill fact: it always shows.
      FinishingPage.history => const <String>{},
    };

bool _settledOut(FinishingPage page, Set<String> settled) {
  if (page == FinishingPage.shiftAndType) {
    // `job_type` is the legacy single the page actually asks; the multi covers
    // it — either one settled alongside `shift` settles the page.
    if (!settled.contains('shift')) return false;
    return settled.contains('work_types') || settled.contains('job_type');
  }
  final Set<String> facts = _pageFacts(page);
  if (facts.isEmpty) return false;
  return facts.every(settled.contains);
}

/// Gap phrasing for a page the fill view says is NOT settled (#1575).
///
/// Returns null when the page needs no note: the question itself is the ask
/// for a never-asked (`missing`) fact. Two cases get explicit copy, exactly as
/// the issue phrases them:
/// - `dropped_by_projector`: an answer exists that the profile cannot carry —
///   "we couldn't use this — add it again", never "you didn't answer".
/// - `unanswered`: the question was served and skipped.
/// A declined fact never reaches here (declined ∈ settled ⇒ page hidden).
String? gapNoteForPage(
  FinishingPage page,
  List<SessionFillEntryDto> entries,
) {
  final Set<String> facts = _pageFacts(page);
  if (facts.isEmpty) return null;
  bool dropped = false;
  bool unanswered = false;
  for (final SessionFillEntryDto entry in entries) {
    if (!facts.contains(entry.fact)) continue;
    if (entry.droppedByProjector) {
      dropped = true;
    } else if (entry.status == 'unanswered') {
      unanswered = true;
    }
  }
  if (dropped) return 'Hum ye jawaab use nahi kar paaye — phir se jodein.';
  if (unanswered) return 'Ye sawaal pehle chhoot gaya tha — ab jawaab dein.';
  return null;
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
    this.knownFacts = const <WorkerFact>{},
    this.settledFacts = const <String>{},
    this.fillEntries = const <SessionFillEntryDto>[],
  });

  /// Facts the worker already gave in the chat — see [finishingPagesFor].
  final Set<WorkerFact> knownFacts;

  /// Facts the session settled on either road (#1575) — answered OR declined.
  /// Pages whose every fact is in here are skipped; empty means "we cannot
  /// say", so the full list shows.
  final Set<String> settledFacts;

  /// The fill view's per-fact detail, for gap phrasing only (see
  /// [gapNoteForPage]). Never drives hiding — [settledFacts] does that.
  final List<SessionFillEntryDto> fillEntries;

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

  /// The pages shown, in order; [pageIndex] indexes THIS list.
  List<FinishingPage> get pages => finishingPagesFor(knownFacts, settledFacts);
  FinishingPage get page => pages[pageIndex];
  bool get isLastPage => pageIndex == pages.length - 1;
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
    Set<WorkerFact>? knownFacts,
    Set<String>? settledFacts,
    List<SessionFillEntryDto>? fillEntries,
  }) {
    return FinishingState(
      knownFacts: knownFacts ?? this.knownFacts,
      settledFacts: settledFacts ?? this.settledFacts,
      fillEntries: fillEntries ?? this.fillEntries,
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
        knownFacts,
        settledFacts,
        fillEntries,
      ];
}

/// Drives the post-interview finishing form (#1296): loads the chip vocabulary,
/// carries the worker's selections across the five pages, and on the last page
/// persists both closed-set writes before the résumé is generated. Every field
/// is a closed-set answer — no model, no free parse — so this holds pure data.
class FinishingCubit extends Cubit<FinishingState> {
  FinishingCubit(this._repo, {KnownWorkerFactsStore? knownFacts})
      : _knownFacts = knownFacts ?? InMemoryKnownWorkerFactsStore(),
        super(const FinishingState());

  final FinishingRepository _repo;
  final KnownWorkerFactsStore _knownFacts;

  /// Set when the worker adds, edits or removes an employer card. The form
  /// opens with no cards every time, and `PUT /workers/me/employment` REPLACES
  /// the whole history, so an untouched empty list is never sent (it would wipe
  /// what an earlier visit saved).
  bool _employmentTouched = false;

  /// Copy shown when a partially-typed employer card is missing its two required
  /// fields. Persona-neutral (aap-form, safe verb, no `!`). Scanned by
  /// persona_neutrality_test.dart.
  static const String kIncompleteEmployerMessage =
      'Har naukri mein company ka naam aur aapka kaam dono likhein.';

  Future<void> load() async {
    emit(state.copyWith(status: FinishingStatus.loadingOptions, error: null));
    try {
      final WorkPrefOptionsDto options = await _repo.loadOptions();
      final Set<WorkerFact> known = await _knownFacts.knownFacts();
      // The fill read fails OPEN to the full list: it is informational, and a
      // throw here (a double that ignores the repo's null contract, a 2G blip
      // the impl did not swallow) must never strand the worker on an error
      // screen. Caught separately from the options read above, which DOES fail
      // the load — without the chip vocabulary there is no form at all.
      SessionFillDto? fill;
      try {
        fill = await _repo.loadSessionFill();
      } catch (_) {
        fill = null;
      }
      emit(state.copyWith(
        status: FinishingStatus.ready,
        options: options,
        knownFacts: known,
        settledFacts: <String>{...?fill?.settled},
        fillEntries: fill?.entries ?? const <SessionFillEntryDto>[],
      ));
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

  /// Toggles a language, enforcing [kFinishingMaxLanguages] at the input edge
  /// so a seventh tick can never become a 400 at submit. Removing an
  /// already-picked language always works; adding past the cap is ignored.
  void toggleLanguage(String slug) {
    if (!state.prefs.languages.contains(slug) &&
        state.prefs.languages.length >= kFinishingMaxLanguages) {
      return;
    }
    _emitPrefs(
        state.prefs.copyWith(languages: _toggled(state.prefs.languages, slug)));
  }

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
    _employmentTouched = true;
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
    _employmentTouched = true;
    final List<EmploymentEntry> next =
        List<EmploymentEntry>.of(state.employments);
    next[index] = entry;
    emit(state.copyWith(employments: next, submitError: null));
  }

  void removeEmployer(int index) {
    if (index < 0 || index >= state.employments.length) return;
    _employmentTouched = true;
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
      if (_employmentTouched || kept.isNotEmpty) {
        await _repo.saveEmployment(kept);
      }
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
