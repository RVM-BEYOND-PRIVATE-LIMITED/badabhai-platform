import 'dart:async';

import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/api/api_client.dart'
    show QualificationOptionsDto, WorkPrefOptionsDto;
import '../../../../core/error/failure.dart';
import '../../../../core/session/known_worker_facts_store.dart';
import '../../data/trade_form_marker_store.dart';
import '../../domain/form_fact_registry.dart';
import '../../domain/trade_form_models.dart';
import '../../domain/trade_form_repository.dart';
import '../trade_form_section_walk.dart';

enum TradeFormStatus {
  /// Fetching `GET /profiling/form`.
  loading,

  /// This worker was never handed a form (404) — a DIFFERENT thing from an
  /// empty one; the screen renders an honest "nothing to fill here" state.
  noForm,

  /// The fetch failed for a real reason (network/server) — retryable.
  loadError,

  /// The form is loaded and one step is on screen.
  ready,

  /// A question/preferences/employment write is in flight.
  submitting,

  /// The marker save on the LAST step landed (#1367) — there is no next
  /// step to walk to, the session is over, and the screen should be
  /// navigating away (to the résumé pipeline), not sitting on a spinner.
  done,
}

/// One entry of the flattened walk order, carrying the SECTION it belongs to
/// alongside the step itself — the header needs the section title, and the
/// step needs nothing about its neighbours.
class TradeFormFlatStep extends Equatable {
  const TradeFormFlatStep({
    required this.sectionTitle,
    required this.step,
  });

  final String sectionTitle;
  final TradeFormStep step;

  @override
  List<Object?> get props => <Object?>[sectionTitle, step];
}

class TradeFormState extends Equatable {
  const TradeFormState({
    this.status = TradeFormStatus.loading,
    this.flatSteps = const <TradeFormFlatStep>[],
    this.currentIndex = 0,
    this.answered = 0,
    this.total = 0,
    this.loadError,
    this.submitError,
    this.savedPreferences,
    this.savedEmployment,
    this.savedQualifications,
    this.sessionId,
    this.doneMarkers = const <TradeFormMarkerType>{},
    this.knownFacts = const <WorkerFact>{},
  });

  /// Marker pages the server already accepted a save for
  /// ([TradeFormMarkerStore]). A forward move skips them, so [isLastStep] and
  /// the step counter leave them out too.
  final Set<TradeFormMarkerType> doneMarkers;

  /// Facts the worker already gave on an earlier screen
  /// ([KnownWorkerFactsStore]). The preferences page skips its sub-pages for
  /// these.
  final Set<WorkerFact> knownFacts;

  /// The form's own profiling session (#1472), re-read from EVERY schema
  /// response so a spoken work description is filed under the conversation
  /// this form actually belongs to. Never cached, never the chat session.
  final String? sessionId;

  final TradeFormStatus status;
  final List<TradeFormFlatStep> flatSteps;
  final int currentIndex;

  /// Progress counters — seeded from the loaded form's own saved answers,
  /// then kept in lockstep with the server's authoritative count from every
  /// `POST /profiling/form/answer` response (never recomputed locally, so it
  /// can never drift from what the server actually holds).
  final int answered;
  final int total;

  /// A blocking load error (the form fetch failed) — the screen shows retry.
  final String? loadError;

  /// A transient submit error (e.g. a 400 naming an unknown option_key) —
  /// shown inline while the worker stays on the same question and can retry.
  final String? submitError;

  /// The LAST successfully-saved value for each marker screen (#1384 item 1)
  /// — markers carry no server-side "already filled" signal on this contract
  /// (see this class' own doc), so unlike a question's `step.answer`, this is
  /// the CUBIT's own memory of what a marker widget last sent, kept purely so
  /// a worker who `goBack()`s into an already-passed marker sees it filled
  /// in rather than reset to a blank constructor default. Set the moment a
  /// marker save succeeds (see `_advanceAfterMarkerSave`) — a worker can only
  /// `goBack()` into a marker that already saved successfully once, so "the
  /// last successful save" is always available by the time it would be read.
  /// Never sent anywhere; purely a local re-hydration seed for
  /// `trade_form_screen.dart`'s `_stepBody()`.
  final TradeFormPreferences? savedPreferences;
  final List<TradeFormEmploymentEntry>? savedEmployment;
  final TradeFormQualifications? savedQualifications;

  TradeFormStep? get currentStep =>
      currentIndex >= 0 && currentIndex < flatSteps.length
          ? flatSteps[currentIndex].step
          : null;

  String? get currentSectionTitle =>
      currentIndex >= 0 && currentIndex < flatSteps.length
          ? flatSteps[currentIndex].sectionTitle
          : null;

  bool get isFirstStep => currentIndex <= 0;
  bool get isSubmitting => status == TradeFormStatus.submitting;

  bool _isDoneMarker(TradeFormStep step) {
    final TradeFormMarkerType? type = tradeFormMarkerTypeOf(step);
    return type != null && doneMarkers.contains(type);
  }

  /// Whether step [i] counts toward "Step N of M": everything up to and
  /// including the current step (already walked, or where
  /// [TradeFormCubit.goBack] landed), and every step ahead except a saved
  /// marker page, which a forward move skips.
  bool _shows(int i) => i <= currentIndex || !_isDoneMarker(flatSteps[i].step);

  /// True when nothing the walk will show is left after the current step, so
  /// the next write finishes the form.
  bool get isLastStep {
    for (int i = currentIndex + 1; i < flatSteps.length; i++) {
      if (!_isDoneMarker(flatSteps[i].step)) return false;
    }
    return true;
  }

  /// "Step [visiblePosition] of [visibleStepCount]", counted over the steps the
  /// walk will actually show (see [_shows]), never over skipped marker pages.
  int get visibleStepCount => <int>[
        for (int i = 0; i < flatSteps.length; i++)
          if (_shows(i)) i,
      ].length;

  int get visiblePosition => <int>[
        for (int i = 0; i <= currentIndex && i < flatSteps.length; i++)
          if (_shows(i)) i,
      ].length;

  TradeFormState copyWith({
    TradeFormStatus? status,
    List<TradeFormFlatStep>? flatSteps,
    int? currentIndex,
    int? answered,
    int? total,
    Object? loadError = _sentinel,
    Object? submitError = _sentinel,
    Object? savedPreferences = _sentinel,
    Object? savedEmployment = _sentinel,
    Object? savedQualifications = _sentinel,
    Object? sessionId = _sentinel,
    Set<TradeFormMarkerType>? doneMarkers,
    Set<WorkerFact>? knownFacts,
  }) {
    return TradeFormState(
      doneMarkers: doneMarkers ?? this.doneMarkers,
      knownFacts: knownFacts ?? this.knownFacts,
      sessionId: sessionId == _sentinel ? this.sessionId : sessionId as String?,
      status: status ?? this.status,
      flatSteps: flatSteps ?? this.flatSteps,
      currentIndex: currentIndex ?? this.currentIndex,
      answered: answered ?? this.answered,
      total: total ?? this.total,
      loadError: loadError == _sentinel ? this.loadError : loadError as String?,
      submitError:
          submitError == _sentinel ? this.submitError : submitError as String?,
      savedPreferences: savedPreferences == _sentinel
          ? this.savedPreferences
          : savedPreferences as TradeFormPreferences?,
      savedEmployment: savedEmployment == _sentinel
          ? this.savedEmployment
          : savedEmployment as List<TradeFormEmploymentEntry>?,
      savedQualifications: savedQualifications == _sentinel
          ? this.savedQualifications
          : savedQualifications as TradeFormQualifications?,
    );
  }

  @override
  List<Object?> get props => <Object?>[
        sessionId,
        status,
        flatSteps,
        currentIndex,
        answered,
        total,
        loadError,
        submitError,
        savedPreferences,
        savedEmployment,
        savedQualifications,
        doneMarkers,
        knownFacts,
      ];
}

/// Drives the trade form (#1341): loads the whole sectioned form in one round
/// trip, walks `sections[].screens[]` in the SERVER'S order, and posts one
/// answer at a time — auto-advancing on success, exactly like the voice
/// form's blocking-submit model, but with no session id and no next-question
/// decision to make (every question is already known).
///
/// RESUMABILITY. On every [load], the resume position is the first step that
/// is either an unanswered question OR a marker screen (preferences /
/// employment / qualifications) not yet saved for this form. Marker screens
/// carry no "already filled" signal on this contract and their endpoints have
/// no read route, so the cubit records each marker in [TradeFormMarkerStore]
/// the moment the server ACKNOWLEDGED its PUT — a server fact, not a client
/// guess. Without that record a fresh cubit (back from step 1 then the chat
/// card, a cold start restoring /trade-form) re-showed every marker BLANK, and
/// a tap-through PUT empty lists over what the worker had saved.
///
/// A recorded marker is skipped on every FORWARD move (load, the schema_stale
/// resync, the advance after an answer or a marker save) and stays reachable
/// with [goBack]. Reopening one is SAFE but NOT PRE-FILLED: a fresh cubit has
/// no read of what was saved, so the page opens blank, and it writes only what
/// the worker changes on that visit (see [goBack]).
class TradeFormCubit extends Cubit<TradeFormState> {
  TradeFormCubit(
    this._repo, {
    TradeFormMarkerStore? markerStore,
    KnownWorkerFactsStore? knownFacts,
  })  : _markerStore = markerStore ?? InMemoryTradeFormMarkerStore(),
        _knownFacts = knownFacts ?? InMemoryKnownWorkerFactsStore(),
        super(const TradeFormState());

  final TradeFormRepository _repo;
  final TradeFormMarkerStore _markerStore;
  final KnownWorkerFactsStore _knownFacts;

  /// The résumé-section walk this cubit is running, if any
  /// (`trade_form_section_walk.dart` — the Technical Skills pilot). Null is
  /// the full walk, exactly today's behaviour. Set by [load] and KEPT across
  /// calls, so a retry (`load()` with no argument) and the `schema_stale`
  /// resync stay inside the same section rather than silently widening back
  /// to the whole form.
  String? _sectionKey;

  /// Marker types already saved for this worker.
  Set<TradeFormMarkerType> _doneMarkers = <TradeFormMarkerType>{};

  /// Re-reads the saved markers. What this cubit recorded itself is kept, so an
  /// in-flight store write can never make a marker saved seconds ago look
  /// unsaved on a schema_stale re-fetch.
  Future<void> _syncDoneMarkers() async {
    _doneMarkers = <TradeFormMarkerType>{
      ..._doneMarkers,
      ...await _markerStore.completedMarkers(),
    };
  }

  bool _isDoneMarker(TradeFormStep step) {
    final TradeFormMarkerType? type = tradeFormMarkerTypeOf(step);
    return type != null && _doneMarkers.contains(type);
  }

  /// A snapshot for [TradeFormState.doneMarkers], never the live set.
  Set<TradeFormMarkerType> get _doneSnapshot =>
      <TradeFormMarkerType>{..._doneMarkers};

  /// Records [marker] as saved, called only after the server accepted it.
  /// Fire-and-forget: the store never throws, and the advance must not wait on
  /// disk.
  void _recordMarkerDone(TradeFormMarkerType marker) {
    _doneMarkers.add(marker);
    unawaited(_markerStore.markCompleted(marker));
  }

  Future<void> load({String? sectionKey}) async {
    // A non-null argument (re)arms the section walk; null KEEPS whatever is
    // armed — the error-state retry calls `load()` bare and must not widen a
    // section walk back to the full form.
    if (sectionKey != null) _sectionKey = sectionKey;
    emit(state.copyWith(status: TradeFormStatus.loading, loadError: null));
    try {
      final TradeForm? form = await _repo.loadForm();
      if (form == null) {
        emit(state.copyWith(status: TradeFormStatus.noForm));
        return;
      }
      await _syncDoneMarkers();
      final Set<WorkerFact> known = await _knownFacts.knownFacts();
      final List<TradeFormFlatStep> flat = _applySection(_flatten(form));
      final int total = form.questionSteps.length;
      final int answeredCount =
          form.questionSteps.where((TradeFormQuestionStep q) => q.isAnswered).length;
      final int resumeIndex = _resumeIndex(flat);
      emit(state.copyWith(
        status: TradeFormStatus.ready,
        flatSteps: flat,
        currentIndex: resumeIndex,
        answered: answeredCount,
        total: total,
        doneMarkers: _doneSnapshot,
        knownFacts: known,
        // #1472 — carried from THIS response, every time. Never cached: the
        // form is resumable across a cold start, and a stale id would file a
        // spoken work description under the wrong conversation.
        sessionId: form.sessionId,
      ));
    } on Failure catch (f) {
      emit(state.copyWith(status: TradeFormStatus.loadError, loadError: f.message));
    } catch (_) {
      emit(state.copyWith(
        status: TradeFormStatus.loadError,
        loadError: 'Kuch gadbad ho gayi. Dobara koshish karein.',
      ));
    }
  }

  List<TradeFormFlatStep> _flatten(TradeForm form) => <TradeFormFlatStep>[
        for (final TradeFormSection section in form.sections)
          for (final TradeFormStep step in section.screens)
            TradeFormFlatStep(sectionTitle: section.title, step: step),
      ];

  /// Narrows a flattened walk to the armed résumé section, preserving server
  /// order. Null (no section) or a filter that would leave nothing to walk
  /// degrades to the FULL list — see `trade_form_section_walk.dart` for why
  /// an empty walk is never served.
  List<TradeFormFlatStep> _applySection(List<TradeFormFlatStep> flat) {
    final TradeFormStepFilter? filter = tradeFormSectionFilterFor(_sectionKey);
    if (filter == null) return flat;
    final List<TradeFormFlatStep> kept = <TradeFormFlatStep>[
      for (final TradeFormFlatStep f in flat)
        if (filter(f.step)) f,
    ];
    return kept.isEmpty ? flat : kept;
  }

  /// Where a fresh load opens: the first step still to ask or, when nothing
  /// is left, the last step that is NOT a saved marker — normally the last
  /// question, showing its stored answer. A saved marker page opens blank (no
  /// read route), so landing on one would ask it again.
  int _resumeIndex(List<TradeFormFlatStep> flat) {
    final int i = _nextStepIndex(flat, from: 0);
    if (i >= 0) return i;
    final int last =
        flat.lastIndexWhere((TradeFormFlatStep f) => !_isDoneMarker(f.step));
    if (last >= 0) return last;
    return flat.isEmpty ? 0 : flat.length - 1;
  }

  /// The first UNANSWERED question OR UNSAVED marker screen at/after [from] —
  /// the forward-scan half of resumability. [_resumeIndex] is the FRESH-LOAD
  /// concept (always scans from 0); this is the shared primitive it and the
  /// mid-walk `schema_stale` resync (`_resyncAfterStaleSchema`) both use —
  /// the latter scans from wherever the worker just was, never from the top.
  int _nextStepIndex(List<TradeFormFlatStep> flat, {required int from}) {
    for (int i = from; i < flat.length; i++) {
      final TradeFormStep s = flat[i].step;
      if (s is TradeFormQuestionStep) {
        if (!s.isAnswered) return i;
      } else if (!_isDoneMarker(s)) {
        return i; // a marker not saved yet — see class doc.
      }
    }
    return -1;
  }

  /// Where a one-step FORWARD move from the current step lands: [from], or
  /// past any already-saved marker screens that follow it. Unlike
  /// [_nextStepIndex] it does not skip answered questions, so walking forward
  /// after a [goBack] still shows them. Returns `flat.length` when nothing is
  /// left to show.
  int _forwardIndex(List<TradeFormFlatStep> flat, {required int from}) {
    int i = from;
    while (i < flat.length && _isDoneMarker(flat[i].step)) {
      i++;
    }
    return i;
  }

  // --- Navigation ----------------------------------------------------------

  /// One step back, onto a saved marker page too. That is safe even though the
  /// page opens blank on a fresh cubit: preferences sends only the keys touched
  /// on this visit ([TradeFormPreferences.toJson]), an untouched employment page
  /// skips its whole-history replace ([skipEmploymentAndAdvance]), and an
  /// untouched qualifications page skips its write. Passing through never
  /// erases what the server holds.
  void goBack() {
    if (state.isFirstStep) return;
    emit(state.copyWith(currentIndex: state.currentIndex - 1, submitError: null));
  }

  /// Advances past the just-saved marker screen — and, per #1384 item 1,
  /// banks whichever [savedPreferences]/[savedEmployment]/[savedQualifications]
  /// the caller passes as this cubit's own memory of "the last successful
  /// save" for that marker kind (see [TradeFormState]'s doc). Every caller
  /// passes exactly ONE of the three (the marker it just saved); the other
  /// two default to the shared [_sentinel], which `copyWith` reads as "leave
  /// this field exactly as it already is" — so advancing past, say, the
  /// employment marker never touches whatever preferences value is already
  /// banked.
  ///
  /// [marker] is recorded as saved first, so a later fresh cubit resumes past
  /// it (see the class doc).
  void _advanceAfterMarkerSave(
    TradeFormMarkerType marker, {
    Object? savedPreferences = _sentinel,
    Object? savedEmployment = _sentinel,
    Object? savedQualifications = _sentinel,
  }) {
    _recordMarkerDone(marker);
    final int next =
        _forwardIndex(state.flatSteps, from: state.currentIndex + 1);
    if (next >= state.flatSteps.length) {
      // #1367: the write already landed — there is no next step, so this
      // MUST still emit (leaving state at `submitting` forever is the bug),
      // just with nowhere further to walk to. The screen reacts to `done`
      // by navigating away.
      emit(state.copyWith(
        status: TradeFormStatus.done,
        submitError: null,
        doneMarkers: _doneSnapshot,
        savedPreferences: savedPreferences,
        savedEmployment: savedEmployment,
        savedQualifications: savedQualifications,
      ));
      return;
    }
    emit(state.copyWith(
      status: TradeFormStatus.ready,
      currentIndex: next,
      submitError: null,
      doneMarkers: _doneSnapshot,
      savedPreferences: savedPreferences,
      savedEmployment: savedEmployment,
      savedQualifications: savedQualifications,
    ));
  }

  // --- Question answers ------------------------------------------------

  /// Submits [answer] for [step] and, on success, banks the reply into the
  /// matching flat step (so a re-render shows it as answered even before the
  /// next [load]) and auto-advances. On a 400 (unknown option_key / bad
  /// shape) the worker stays on the SAME question with [TradeFormState.submitError]
  /// set — never swallowed, never silently advanced.
  Future<void> answerQuestion(
    TradeFormQuestionStep step,
    TradeFormAnswer answer,
  ) async {
    if (state.isSubmitting) return;
    emit(state.copyWith(status: TradeFormStatus.submitting, submitError: null));
    try {
      final TradeFormAnswerResult result = await _repo.submitAnswer(
        questionKey: step.question.id,
        answer: answer,
      );
      final TradeFormSavedAnswer saved = TradeFormSavedAnswer(
        status: result.status,
        optionKeys: answer.optionKeys,
        text: answer.text,
        boolValue: answer.boolValue,
      );
      final List<TradeFormFlatStep> banked =
          _bankAnswer(state.flatSteps, step, saved);

      if (result.schemaStale) {
        // #1382 — the just-answered question gates other questions, so the
        // schema `banked` was built against is now out of date. Re-fetch and
        // re-flatten the WHOLE form rather than patching one entry — see
        // `_resyncAfterStaleSchema`'s own doc for why. `banked` is passed as
        // the fallback so a re-fetch failure never loses the answer that
        // already landed server-side (the submit above succeeded).
        await _resyncAfterStaleSchema(result, fallback: banked);
        return;
      }

      final int next = _forwardIndex(banked, from: state.currentIndex + 1);
      if (next >= banked.length) {
        // #1375 — the last step is a question (not a marker screen), so
        // answerQuestion is the terminal write. Emit done so the screen
        // navigates to the résumé pipeline.
        emit(state.copyWith(
          status: TradeFormStatus.done,
          flatSteps: banked,
          answered: result.answered,
          total: result.total,
          submitError: null,
        ));
        return;
      }
      emit(state.copyWith(
        status: TradeFormStatus.ready,
        flatSteps: banked,
        currentIndex: next,
        answered: result.answered,
        total: result.total,
        submitError: null,
      ));
    } on Failure catch (f) {
      emit(state.copyWith(status: TradeFormStatus.ready, submitError: f.message));
    } catch (_) {
      emit(state.copyWith(
        status: TradeFormStatus.ready,
        submitError: 'Save nahi hua. Dobara koshish karein.',
      ));
    }
  }

  /// Replays [saved] into [flat] at [step]'s question, banking the reply so
  /// a re-render shows it as answered even before the next [load] — or,
  /// under `schema_stale`, before the re-fetch it is only a FALLBACK for.
  List<TradeFormFlatStep> _bankAnswer(
    List<TradeFormFlatStep> flat,
    TradeFormQuestionStep step,
    TradeFormSavedAnswer saved,
  ) {
    final List<TradeFormFlatStep> next = List<TradeFormFlatStep>.of(flat);
    // Matched by question_key, NOT list index or Equatable step-equality —
    // the worker's position may have moved (unlikely, but never assumed)
    // and two distinct questions could otherwise coincide on every other
    // field.
    final int idx = next.indexWhere((TradeFormFlatStep f) =>
        f.step is TradeFormQuestionStep &&
        (f.step as TradeFormQuestionStep).question.id == step.question.id);
    if (idx >= 0) {
      next[idx] = TradeFormFlatStep(
        sectionTitle: next[idx].sectionTitle,
        step: TradeFormQuestionStep(
          question: step.question,
          searchable: step.searchable,
          answer: saved,
        ),
      );
    }
    return next;
  }

  /// `schema_stale: true` on the answer response (#1382 — forward-compatible
  /// groundwork; see [TradeFormAnswerResult.schemaStale]'s doc) means the
  /// screen list this client is holding is out of date: the question just
  /// answered gates OTHER questions, which the server has already re-filtered
  /// on its own copy.
  ///
  /// PRESERVES POSITION rather than resetting to the first unanswered
  /// question overall ([_resumeIndex] is a fresh-LOAD concept — reusing it
  /// here could send the worker backward to something earlier in the walk
  /// that a re-order or a race could otherwise surface). Instead: re-fetch,
  /// re-flatten, find the just-answered question's id in the NEW list, and
  /// walk FORWARD from just after it with the exact same predicate
  /// `_resumeIndex` uses — never backward (never re-shows the question just
  /// settled) and never skipped past an unanswered one (the first match
  /// wins). A question gated OUT by the new schema is simply absent from
  /// the re-fetched list, so a plain forward scan is enough; nothing here
  /// re-derives the `ask_if` rule itself, which stays entirely server-side.
  Future<void> _resyncAfterStaleSchema(
    TradeFormAnswerResult result, {
    required List<TradeFormFlatStep> fallback,
  }) async {
    try {
      final TradeForm? form = await _repo.loadForm();
      if (form == null) {
        // The form vanished mid-walk — the same honest reading a 404 gets
        // on the very first load.
        emit(state.copyWith(status: TradeFormStatus.noForm));
        return;
      }
      await _syncDoneMarkers();
      // A section walk re-fetches the WHOLE form here by design (the
      // just-answered question may gate others server-side); the armed
      // section re-applies so the resync cannot widen the walk mid-stride.
      final List<TradeFormFlatStep> flat = _applySection(_flatten(form));
      final int answeredIdx = flat.indexWhere((TradeFormFlatStep f) =>
          f.step is TradeFormQuestionStep &&
          (f.step as TradeFormQuestionStep).question.id == result.questionKey);
      final int searchFrom = answeredIdx >= 0 ? answeredIdx + 1 : 0;
      final int nextIdx = _nextStepIndex(flat, from: searchFrom);
      if (nextIdx < 0) {
        // The just-answered question was the new schema's last step too.
        emit(state.copyWith(
          status: TradeFormStatus.done,
          flatSteps: flat,
          answered: result.answered,
          total: result.total,
          submitError: null,
          doneMarkers: _doneSnapshot,
          sessionId: form.sessionId, // re-read, never carried over (#1472)
        ));
        return;
      }
      emit(state.copyWith(
        status: TradeFormStatus.ready,
        flatSteps: flat,
        currentIndex: nextIdx,
        answered: result.answered,
        total: result.total,
        submitError: null,
        doneMarkers: _doneSnapshot,
        sessionId: form.sessionId, // re-read, never carried over (#1472)
      ));
    } on Failure catch (f) {
      emit(state.copyWith(
        status: TradeFormStatus.ready,
        flatSteps: fallback,
        submitError: f.message,
      ));
    } catch (_) {
      emit(state.copyWith(
        status: TradeFormStatus.ready,
        flatSteps: fallback,
        submitError: 'Save nahi hua. Dobara koshish karein.',
      ));
    }
  }

  /// The explicit decline affordance (#1341) — "nothing here applies" is a
  /// real, settled answer, sent as `{kind: declined}`, never a client-side
  /// skip that leaves the question looking unanswered.
  Future<void> declineQuestion(TradeFormQuestionStep step) =>
      answerQuestion(step, const TradeFormAnswer.declined());

  // --- Marker-screen writes ------------------------------------------------

  Future<WorkPrefOptionsDto> loadPreferenceOptions() =>
      _repo.loadPreferenceOptions();

  Future<void> savePreferencesAndAdvance(TradeFormPreferences prefs) async {
    if (state.isSubmitting) return;
    emit(state.copyWith(status: TradeFormStatus.submitting, submitError: null));
    try {
      await _repo.savePreferences(prefs);
      _advanceAfterMarkerSave(TradeFormMarkerType.preferences,
          savedPreferences: prefs);
    } on Failure catch (f) {
      emit(state.copyWith(status: TradeFormStatus.ready, submitError: f.message));
    } catch (_) {
      emit(state.copyWith(
        status: TradeFormStatus.ready,
        submitError: 'Save nahi hua. Dobara koshish karein.',
      ));
    }
  }

  Future<void> saveEmploymentAndAdvance(
    List<TradeFormEmploymentEntry> employments,
  ) async {
    if (state.isSubmitting) return;
    final List<TradeFormEmploymentEntry> kept =
        employments.where((TradeFormEmploymentEntry e) => !e.isBlank).toList();
    if (kept.any((TradeFormEmploymentEntry e) => !e.isComplete)) {
      emit(state.copyWith(submitError: kTradeFormIncompleteEmployerMessage));
      return;
    }
    emit(state.copyWith(status: TradeFormStatus.submitting, submitError: null));
    try {
      await _repo.saveEmployment(kept);
      _advanceAfterMarkerSave(TradeFormMarkerType.employment,
          savedEmployment: kept);
    } on Failure catch (f) {
      emit(state.copyWith(status: TradeFormStatus.ready, submitError: f.message));
    } catch (_) {
      emit(state.copyWith(
        status: TradeFormStatus.ready,
        submitError: 'Save nahi hua. Dobara koshish karein.',
      ));
    }
  }

  /// The employment page was passed with nothing added, edited or removed, and
  /// nothing banked for it in this cubit: advance WITHOUT the write.
  /// `PUT /workers/me/employment` replaces the whole history, so sending the
  /// blank list a fresh page starts with would delete what the worker saved
  /// earlier (in an old session, an old build, or on another phone). Counts as
  /// saved, exactly like an untouched qualifications page.
  void skipEmploymentAndAdvance() {
    if (state.isSubmitting) return;
    _advanceAfterMarkerSave(TradeFormMarkerType.employment);
  }

  Future<QualificationOptionsDto> loadQualificationOptions() =>
      _repo.loadQualificationOptions();

  /// Saves the `qualifications` marker and advances — same submitting/error
  /// shape as [savePreferencesAndAdvance]/[saveEmploymentAndAdvance], with
  /// two differences the tri-state contract and the certificate schema
  /// require:
  ///
  ///  1. Blank rows (mirrors [saveEmploymentAndAdvance]'s own `isBlank`
  ///     filter) are dropped from EACH list before anything else — a row the
  ///     worker added and then left empty is not a real answer. A remaining
  ///     certificate missing its one required field (`name`) blocks the save
  ///     with an inline message rather than reaching the server as a 400;
  ///     education has no equivalent case ([TradeFormEducationEntry.isBlank]
  ///     already IS the server's own completeness rule).
  ///  2. When [TradeFormQualifications.hasAnyTouch] is false (the worker
  ///     touched NEITHER sub-section this visit), the write is skipped
  ///     entirely rather than sent — `{}` is this endpoint's one deliberate
  ///     400, and "nothing touched" already means "leave both stored lists
  ///     exactly as they are", which skipping the call achieves for free.
  Future<void> saveQualificationsAndAdvance(
    TradeFormQualifications qualifications,
  ) async {
    if (state.isSubmitting) return;
    final List<TradeFormCertificateEntry> keptCertificates = qualifications
        .certificates
        .where((TradeFormCertificateEntry c) => !c.isBlank)
        .toList();
    if (keptCertificates.any((TradeFormCertificateEntry c) => !c.isComplete)) {
      emit(state.copyWith(submitError: kTradeFormIncompleteCertificateMessage));
      return;
    }
    final List<TradeFormEducationEntry> keptEducations = qualifications
        .educations
        .where((TradeFormEducationEntry e) => !e.isBlank)
        .toList();
    final TradeFormQualifications toSend = qualifications.copyWith(
      certificates: keptCertificates,
      educations: keptEducations,
    );

    if (!toSend.hasAnyTouch) {
      // Nothing to change IS the worker's answer to this page, and the stored
      // lists are exactly as the server holds them — so it counts as saved.
      _advanceAfterMarkerSave(TradeFormMarkerType.qualifications,
          savedQualifications: toSend);
      return;
    }
    emit(state.copyWith(status: TradeFormStatus.submitting, submitError: null));
    try {
      await _repo.saveQualifications(toSend);
      _advanceAfterMarkerSave(TradeFormMarkerType.qualifications,
          savedQualifications: toSend);
    } on Failure catch (f) {
      emit(state.copyWith(status: TradeFormStatus.ready, submitError: f.message));
    } catch (_) {
      emit(state.copyWith(
        status: TradeFormStatus.ready,
        submitError: 'Save nahi hua. Dobara koshish karein.',
      ));
    }
  }
}

/// Copy shown when a partially-typed employer card is missing its two
/// required fields. Persona-neutral (aap-form, safe verb, no `!`). Scanned by
/// persona_neutrality_test.dart.
const String kTradeFormIncompleteEmployerMessage =
    'Har naukri mein company ka naam aur aapka kaam dono likhein.';

/// Copy shown when a partially-typed certificate card is missing its one
/// required field (`name`). Persona-neutral, scanned by
/// persona_neutrality_test.dart.
const String kTradeFormIncompleteCertificateMessage =
    'Har certificate ka naam likhein.';

const Object _sentinel = Object();
