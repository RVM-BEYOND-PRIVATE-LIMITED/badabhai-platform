import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/api/api_client.dart'
    show QualificationOptionsDto, WorkPrefOptionsDto;
import '../../../../core/error/failure.dart';
import '../../domain/trade_form_models.dart';
import '../../domain/trade_form_repository.dart';

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
  });

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

  TradeFormStep? get currentStep =>
      currentIndex >= 0 && currentIndex < flatSteps.length
          ? flatSteps[currentIndex].step
          : null;

  String? get currentSectionTitle =>
      currentIndex >= 0 && currentIndex < flatSteps.length
          ? flatSteps[currentIndex].sectionTitle
          : null;

  bool get isFirstStep => currentIndex <= 0;
  bool get isLastStep => currentIndex >= flatSteps.length - 1;
  bool get isSubmitting => status == TradeFormStatus.submitting;

  TradeFormState copyWith({
    TradeFormStatus? status,
    List<TradeFormFlatStep>? flatSteps,
    int? currentIndex,
    int? answered,
    int? total,
    Object? loadError = _sentinel,
    Object? submitError = _sentinel,
  }) {
    return TradeFormState(
      status: status ?? this.status,
      flatSteps: flatSteps ?? this.flatSteps,
      currentIndex: currentIndex ?? this.currentIndex,
      answered: answered ?? this.answered,
      total: total ?? this.total,
      loadError: loadError == _sentinel ? this.loadError : loadError as String?,
      submitError:
          submitError == _sentinel ? this.submitError : submitError as String?,
    );
  }

  @override
  List<Object?> get props => <Object?>[
        status,
        flatSteps,
        currentIndex,
        answered,
        total,
        loadError,
        submitError,
      ];
}

/// Drives the trade form (#1341): loads the whole sectioned form in one round
/// trip, walks `sections[].screens[]` in the SERVER'S order, and posts one
/// answer at a time — auto-advancing on success, exactly like the voice
/// form's blocking-submit model, but with no session id and no next-question
/// decision to make (every question is already known).
///
/// RESUMABILITY. On every [load], the resume position is the first step that
/// is either an unanswered question OR a preferences/employment MARKER
/// screen. Marker screens carry no "already filled" signal on this contract
/// (their own writes live behind `PUT /workers/me/work-preferences` and
/// `PUT /workers/me/employment`, which this endpoint only points at) — so a
/// worker who has already filled one, then progressed further, then killed
/// the app, is shown that marker again on the next load. That re-fill is
/// harmless (both writes are idempotent full-replaces) and NEVER loses a
/// question answer, which is the guarantee this issue actually requires;
/// widening it to remember marker completion would need state this contract
/// does not expose and would be a client guess, not a server fact.
class TradeFormCubit extends Cubit<TradeFormState> {
  TradeFormCubit(this._repo) : super(const TradeFormState());

  final TradeFormRepository _repo;

  Future<void> load() async {
    emit(state.copyWith(status: TradeFormStatus.loading, loadError: null));
    try {
      final TradeForm? form = await _repo.loadForm();
      if (form == null) {
        emit(state.copyWith(status: TradeFormStatus.noForm));
        return;
      }
      final List<TradeFormFlatStep> flat = _flatten(form);
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

  int _resumeIndex(List<TradeFormFlatStep> flat) {
    final int i = _nextStepIndex(flat, from: 0);
    if (i >= 0) return i;
    return flat.isEmpty ? 0 : flat.length - 1;
  }

  /// The first UNANSWERED question OR marker screen at/after [from] — the
  /// forward-scan half of resumability. [_resumeIndex] is the FRESH-LOAD
  /// concept (always scans from 0); this is the shared primitive it and the
  /// mid-walk `schema_stale` resync (`_resyncAfterStaleSchema`) both use —
  /// the latter scans from wherever the worker just was, never from the top.
  int _nextStepIndex(List<TradeFormFlatStep> flat, {required int from}) {
    for (int i = from; i < flat.length; i++) {
      final TradeFormStep s = flat[i].step;
      if (s is TradeFormQuestionStep) {
        if (!s.isAnswered) return i;
      } else {
        return i; // any marker screen — see class doc for why.
      }
    }
    return -1;
  }

  // --- Navigation ----------------------------------------------------------

  void goBack() {
    if (state.isFirstStep) return;
    emit(state.copyWith(currentIndex: state.currentIndex - 1, submitError: null));
  }

  void _advanceAfterMarkerSave() {
    if (state.isLastStep) {
      // #1367: the write already landed — there is no next step, so this
      // MUST still emit (leaving state at `submitting` forever is the bug),
      // just with nowhere further to walk to. The screen reacts to `done`
      // by navigating away.
      emit(state.copyWith(status: TradeFormStatus.done, submitError: null));
      return;
    }
    emit(state.copyWith(
      status: TradeFormStatus.ready,
      currentIndex: state.currentIndex + 1,
      submitError: null,
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

      final bool last = state.currentIndex >= banked.length - 1;
      if (last) {
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
        currentIndex: state.currentIndex + 1,
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
      final List<TradeFormFlatStep> flat = _flatten(form);
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
      _advanceAfterMarkerSave();
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
      _advanceAfterMarkerSave();
    } on Failure catch (f) {
      emit(state.copyWith(status: TradeFormStatus.ready, submitError: f.message));
    } catch (_) {
      emit(state.copyWith(
        status: TradeFormStatus.ready,
        submitError: 'Save nahi hua. Dobara koshish karein.',
      ));
    }
  }

  Future<QualificationOptionsDto> loadQualificationOptions() =>
      _repo.loadQualificationOptions();

  /// Saves the `qualifications` marker and advances — same submitting/error
  /// shape as [savePreferencesAndAdvance]/[saveEmploymentAndAdvance], with
  /// one difference the tri-state contract requires: when
  /// [TradeFormQualifications.hasAnyTouch] is false (the worker touched
  /// NEITHER sub-section this visit), the write is skipped entirely rather
  /// than sent — `{}` is this endpoint's one deliberate 400, and "nothing
  /// touched" already means "leave both stored lists exactly as they are",
  /// which skipping the call achieves for free.
  Future<void> saveQualificationsAndAdvance(
    TradeFormQualifications qualifications,
  ) async {
    if (state.isSubmitting) return;
    if (!qualifications.hasAnyTouch) {
      _advanceAfterMarkerSave();
      return;
    }
    emit(state.copyWith(status: TradeFormStatus.submitting, submitError: null));
    try {
      await _repo.saveQualifications(qualifications);
      _advanceAfterMarkerSave();
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

const Object _sentinel = Object();
