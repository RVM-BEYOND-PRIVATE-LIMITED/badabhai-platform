import 'dart:async';

import 'package:equatable/equatable.dart';
import 'package:flutter/widgets.dart' show AppLifecycleState;
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:record/record.dart' show RecordState;

import '../../../../core/error/failure.dart';
import '../../../../core/error/failure_mapper.dart';
import '../../../../core/session/session_repository.dart';
import '../../../voice/data/session_voice_recorder.dart';
import '../../../voice/domain/voice_models.dart';
import '../../../voice/domain/voice_pipeline.dart';
import '../../data/voice_form_action_log.dart';
import '../../domain/question_audio_player.dart';
import '../../domain/silence_endpointer.dart';
import '../../domain/voice_correction_outcome.dart';
import '../../domain/voice_form_gateway.dart';
import '../../domain/voice_form_models.dart';
import '../../domain/voice_review_row.dart';

/// Shown when two consecutive questions came back silent — a dead/muted mic
/// (#636). Persona-clean; points at settings, does not blame the worker.
const String kVoiceMicSilentMessage =
    'Mic se awaaz nahi aa rahi. Settings mein mic check karein.';

// ---------------- States ----------------

sealed class VoiceFormState extends Equatable {
  const VoiceFormState();

  @override
  List<Object?> get props => <Object?>[];
}

/// Nothing started yet.
class VoiceFormIdle extends VoiceFormState {
  const VoiceFormIdle();
}

/// Opening the session / fetching the first question.
class VoiceFormPreparing extends VoiceFormState {
  const VoiceFormPreparing();
}

/// A question is on screen. [micPhase] carries where the mic is in the answer
/// cycle (priming → listening → holding → uploading) without a state explosion.
class VoiceFormAsking extends VoiceFormState {
  const VoiceFormAsking({
    required this.question,
    required this.index,
    required this.total,
    required this.micPhase,
    this.lookahead = const <String, PredictedNext>{},
  });

  final VoiceQuestion question;
  final int index;
  final int total;
  final MicPhase micPhase;

  /// The server's advisory next-step predictions for THIS question (#761), keyed
  /// by `option_key` / `'__declined'`. Read on a chip/boolean tap to render the
  /// predicted question optimistically. Empty when the server sent none.
  final Map<String, PredictedNext> lookahead;

  VoiceFormAsking copyWith({MicPhase? micPhase}) => VoiceFormAsking(
        question: question,
        index: index,
        total: total,
        micPhase: micPhase ?? this.micPhase,
        lookahead: lookahead,
      );

  @override
  List<Object?> get props =>
      <Object?>[question, index, total, micPhase, lookahead];
}

/// A hard interruption (incoming call, backgrounding — #636). The current
/// [question] is preserved so the worker resumes exactly where they left off.
class VoiceFormInterrupted extends VoiceFormState {
  const VoiceFormInterrupted({
    required this.question,
    required this.index,
    required this.total,
  });

  final VoiceQuestion question;
  final int index;
  final int total;

  @override
  List<Object?> get props => <Object?>[question, index, total];
}

/// Every question answered. The review screen (#632) shows [rows]; it is the
/// ONLY place the session is committed.
class VoiceFormReview extends VoiceFormState {
  const VoiceFormReview({
    required this.answers,
    this.rows = const <VoiceReviewRow>[],
    this.correctionError,
    this.profileRebuildRequired = false,
  });

  /// The local echo of the answers as they were given (#717). KEPT alongside
  /// [rows] because the analytics/interruption suites read it; the screen renders
  /// [rows] (server truth), which a correction can redraw one row at a time.
  final List<VoiceAnswer> answers;

  /// The review rows, read from `GET /profiling/session` server truth (#700). A
  /// successful correction redraws exactly the one row it addressed. Empty when
  /// the rows fetch failed — the worker degrades to a bare submit rather than
  /// dead-ending.
  final List<VoiceReviewRow> rows;

  /// The worker-safe message from the LAST correction that failed (a 409/422/cap
  /// — #700). Non-null keeps the worker ON review (never [VoiceFormError]) and is
  /// cleared the moment the next correction is attempted.
  final String? correctionError;

  /// The last correction rebuilt an already-built profile (#700's fourth
  /// trigger) — surfaced as a calm notice, never a block.
  final bool profileRebuildRequired;

  VoiceFormReview copyWith({
    List<VoiceReviewRow>? rows,
    String? correctionError,
    bool profileRebuildRequired = false,
  }) =>
      VoiceFormReview(
        answers: answers,
        rows: rows ?? this.rows,
        correctionError: correctionError,
        profileRebuildRequired: profileRebuildRequired,
      );

  @override
  List<Object?> get props =>
      <Object?>[answers, rows, correctionError, profileRebuildRequired];
}

/// Committing the reviewed session.
class VoiceFormSubmitting extends VoiceFormState {
  const VoiceFormSubmitting();
}

/// Committed — the profile is in.
class VoiceFormComplete extends VoiceFormState {
  const VoiceFormComplete();
}

/// Something honest went wrong ([failure] carries worker-safe copy).
class VoiceFormError extends VoiceFormState {
  const VoiceFormError(this.failure);

  final Failure failure;

  @override
  List<Object?> get props => <Object?>[failure];
}

// ---------------- Cubit ----------------

/// The voice-form session state machine (#628): permission (once) → preparing →
/// asking (one clip per question) → review → submitting → complete.
///
/// The advance ordering is load-bearing:
///
///   stop → retain → queue upload → render Q(n+1) → TTS → start → 250ms prime →
///   arm endpointer
///
/// Each answer is its own clip; the just-stopped clip is [retain]ed so the
/// stale-clip sweep can never eat it while its upload is in flight, and the mic
/// is warmed for Q(n+1) only AFTER the prompt is read, so the prompt is never
/// captured. Answers submit BLOCKING, one at a time — the engine needs answer n
/// to choose question n+1, so there is no optimistic advance.
class VoiceFormCubit extends Cubit<VoiceFormState> {
  VoiceFormCubit({
    required VoiceFormGateway gateway,
    required SessionVoiceRecorder recorder,
    required SilenceEndpointer endpointer,
    required QuestionAudioPlayer tts,
    required VoiceNoteRegistrar registrar,
    required SessionRepository session,
    Duration primeDelay = const Duration(milliseconds: 250),
    Duration levelInterval = const Duration(milliseconds: 100),
    Future<void> Function(Duration)? sleep,
    VoiceFormActionLog? actionLog,
  })  : _gateway = gateway,
        _recorder = recorder,
        _endpointer = endpointer,
        _tts = tts,
        _registrar = registrar,
        _session = session,
        _primeDelay = primeDelay,
        _levelInterval = levelInterval,
        _sleep = sleep ?? Future<void>.delayed,
        _actions = actionLog ?? VoiceFormActionLog(),
        super(const VoiceFormIdle());

  final VoiceFormGateway _gateway;
  final SessionVoiceRecorder _recorder;
  final SilenceEndpointer _endpointer;
  final QuestionAudioPlayer _tts;

  /// Clip → registered `voice_note_id` (#717). THE UPLOAD IS THE CUBIT'S JOB, not the
  /// gateway's: the gateway is a wire adapter with one HTTP call per method, and the clip
  /// lives here. Shares the chat voice-note flow's uploader — signed-url mint, PUT, and the
  /// on-device temp file deleted whether the attempt succeeded or not.
  final VoiceNoteRegistrar _registrar;
  final SessionRepository _session;
  final Duration _primeDelay;
  final Duration _levelInterval;
  final Future<void> Function(Duration) _sleep;
  final VoiceFormActionLog _actions;

  final List<VoiceAnswer> _answers = <VoiceAnswer>[];

  StreamSubscription<MicLevel>? _levelsSub;

  /// The recorder record-state subscription (#636). Taken WITH `onError` so a
  /// Bluetooth SCO drop surfaces here instead of as an unhandled zone error that
  /// would kill the session.
  StreamSubscription<RecordState>? _statesSub;

  /// Consecutive questions the worker left completely silent (#636). Two in a
  /// row stops the session with a settings hint — a dead/muted mic should not
  /// trap the worker re-asking the same question forever.
  int _consecutiveSilent = 0;

  /// Re-broadcast of the live mic amplitude for the UI level meter (#629). Fed
  /// from the same single [_levelsSub] the endpointer reads, so the screen never
  /// takes a second subscription on the recorder.
  final StreamController<MicLevel> _meter =
      StreamController<MicLevel>.broadcast();

  /// Live amplitude while the mic is listening — drives the on-screen meter, so
  /// covering the mic visibly drops the bars.
  Stream<MicLevel> get micLevels => _meter.stream;

  /// True from the first synchronous line of an advance until it settles — the
  /// idempotency guard. A double endpoint-signal or a tap-during-silence-advance
  /// must NOT fire two submits or capture two clips.
  bool _advancing = false;

  /// True while `_recorder.start()` is awaiting, so [close] during that window
  /// still releases the mic.
  bool _startingMic = false;

  /// TEARDOWN HAS BEGUN — set on the FIRST line of [close].
  ///
  /// `isClosed` is not usable for this: bloc only flips it inside
  /// `super.close()`, which is the LAST statement of our override, so for the
  /// whole of `close()`'s body — the mic cancel AND the recorder dispose —
  /// `isClosed` is still false. A method suspended on an await inside that
  /// window therefore sails past an `isClosed` check and re-arms a recorder
  /// that has already been disposed, leaving the mic hot after the screen is
  /// gone. Guard on [_torndown], never on `isClosed` alone.
  bool _closing = false;

  /// Whether teardown has started or finished — the only safe "stop now" test
  /// for a continuation resuming after an await.
  bool get _torndown => _closing || isClosed;

  /// True once permission was requested — asked exactly once per session.
  bool _permissionAsked = false;

  /// The HARD gate (#691): false whenever the app is backgrounded. `_armFreshClip`
  /// refuses to call `_recorder.start()` while this is false, so the mic can NEVER
  /// be armed off-screen — outside the worker's moment of consent — no matter
  /// which in-flight continuation reaches it. Set SYNCHRONOUSLY from the lifecycle
  /// handler, before any await.
  bool _foreground = true;

  /// Interruption generation (#691), bumped SYNCHRONOUSLY in [_interrupt]. Every
  /// async arm chain captures it at entry and aborts if it moved — so a long
  /// `submit`/`tts` await that resolves AFTER a `paused` cannot walk on to arm a
  /// fresh clip and silently overwrite [VoiceFormInterrupted].
  int _interruptGen = 0;

  /// Opens the session. Requests mic permission exactly once, then presents Q1.
  Future<void> start() async {
    if (state is! VoiceFormIdle) return;
    emit(const VoiceFormPreparing());
    // CAPTURED BEFORE THE FIRST AWAIT. Taken after `ensurePermission()` it
    // reads a generation the interruption has ALREADY bumped: backgrounding
    // during `Preparing` bumps the gen but `_interrupt()` no-ops (there is no
    // Asking state to preserve), so every later check compares equal and the
    // whole start path proceeds as if nothing happened.
    final int gen = _interruptGen;
    try {
      if (!_permissionAsked) {
        _permissionAsked = true;
        final bool granted = await _recorder.ensurePermission();
        if (_torndown) return;
        if (!granted) {
          emit(const VoiceFormError(MicPermissionFailure()));
          return;
        }
      }
      // One levels + one record-state subscription for the whole session — never
      // re-taken between questions (they survive stop/start), and GUARDED so a
      // reset()->start() retry (#680.5) can't leak a second pair. Levels feeds
      // the endpointer for auto-advance; states carries a Bluetooth SCO drop as
      // a stream error (#636) rather than a silent stop.
      if (_levelsSub == null) {
        _levelsSub = _recorder.levels(_levelInterval).listen(_onLevel);
        _statesSub =
            _recorder.states().listen((_) {}, onError: _onRecordStateError);
      }

      final VoiceFormStep step = await _gateway.start();
      if (_torndown || !_foreground || gen != _interruptGen) return;
      await _route(step, gen);
    } on Failure catch (failure) {
      if (!_torndown) emit(VoiceFormError(failure));
    } catch (error) {
      if (!_torndown) emit(VoiceFormError(mapError(error)));
    }
  }

  /// Recover from a terminal [VoiceFormError] (#680.5): return to Idle so the UI
  /// can call [start] again, rather than stranding the worker on any transient
  /// failure — a likely path on a 2G factory floor, not an edge case. Mirrors
  /// `VoiceNoteCubit.reset`. The mic subscriptions are guarded in [start], so a
  /// re-start never leaks a second pair.
  ///
  /// NOTE: [start] re-runs [VoiceFormGateway.start], which resumes the worker's
  /// server-side session off their auth. A resume that lands on the RIGHT
  /// question (not the first) is the gateway's responsibility (backend B6);
  /// until then a restart may re-ask from the top.
  void reset() {
    if (state is VoiceFormError) emit(const VoiceFormIdle());
  }

  /// The worker finished speaking (silence endpoint / cap-out / manual "next").
  /// Stops the clip, retains it, submits it, and advances. Idempotent.
  Future<void> answerBySpeaking() => _advance(null);

  /// The worker tapped select chips (#630) — submits [optionKeys], never label
  /// text, and makes no STT call. Idempotent.
  Future<void> answerByChips(List<String> optionKeys) =>
      _advance(VoiceAnswer.chips(optionKeys));

  /// The worker tapped Haan / Nahi on a boolean question (#630). Idempotent.
  Future<void> answerByBoolean(bool value) =>
      _advance(VoiceAnswer.boolean(value));

  /// A literal text answer — e.g. "Nahi pata" (#629), which the engine maps to
  /// `declined`. There is no client-side skip. Idempotent.
  Future<void> answerByText(String text) => _advance(VoiceAnswer.text(text));

  /// Advance the session with [chosen] (chip/boolean/text) or, when null, by
  /// stopping the mic and using the recorded clip. The single guarded path both
  /// silence-advance and every manual advance funnel through — the source of the
  /// idempotency guarantee.
  Future<void> _advance(VoiceAnswer? chosen) async {
    if (_advancing) return; // idempotency: one advance per question
    final VoiceFormState current = state;
    if (current is! VoiceFormAsking) return;
    _advancing = true;
    final int gen = _interruptGen; // #691 — abort if an interruption lands
    // HOISTED OUT OF THE TRY so ONE `finally` owns the release (#717). The retain used to be
    // dropped in two places — the interruption check and a `finally` around `submit` — which
    // covered every path that existed at the time. The upload now happens BEFORE submit, and
    // an upload that throws (a 503 with voice disabled, a stalled PUT) reached neither, so
    // the clip stayed retained for the life of the shared recorder and the stale-clip sweep
    // could never reclaim it. One exit, one release.
    String? retainPath;
    try {
      final VoiceAnswer answer;
      if (chosen == null) {
        final RecordedClip? clip = await _recorder.stop(); // stop
        if (clip == null) {
          // An interruption cancelled the recorder out from under this advance —
          // that is a CLIENT-induced null, not the worker being silent (#691).
          // Do not count it toward the dead-mic gate; the interruption owns the
          // state now.
          if (_torndown || gen != _interruptGen) return;
          // Nothing captured. One miss re-arms the same question; a SECOND
          // consecutive silent question is a dead/muted mic (#636) — stop with a
          // settings hint rather than trap the worker re-asking forever.
          _consecutiveSilent++;
          if (_consecutiveSilent >= 2) {
            emit(const VoiceFormError(
                VoiceUnavailableFailure(kVoiceMicSilentMessage)));
          } else {
            await _rearm(current, gen);
          }
          return;
        }
        // BEFORE ANY EMIT, and that ordering is #691's whole fix. A `paused` landing during
        // `await _recorder.stop()` leaves the handler's `VoiceFormInterrupted` on screen;
        // emitting `Asking(uploading)` over it puts the session back into Asking, and
        // `resumeSession()` no-ops on Asking — so the mid-session permission re-check is
        // skipped in exactly the case the pause was long enough for permission to be
        // revoked. Nothing is retained yet either: an abandoned take is left for the sweep.
        if (_torndown || gen != _interruptGen) return;

        _recorder.retain(clip.path); // retain — protect the in-flight upload
        retainPath = clip.path;
        // UPLOAD HERE, NOT IN THE GATEWAY (#717). The engine answers at a `voice_note_id`,
        // so the clip becomes one before an answer object exists: mint a signed slot, PUT
        // the bytes, register the path. The uploader deletes the on-device copy in its own
        // `finally`, success or failure, so raw audio never outlives the attempt.
        //
        // Shown as `uploading` FIRST, because this is the leg that actually takes the time
        // on a 2G uplink — up to 30s. Leaving the mic phase on `listening` through it would
        // read to the worker as "still listening" while nothing is being recorded.
        emit(current.copyWith(micPhase: MicPhase.uploading));
        answer = VoiceAnswer.spoken(await _registerClip(clip));
      } else {
        // A chip/boolean/text answer — discard the open clip (no STT call) and
        // submit the chosen answer.
        await _recorder.cancel();
        answer = chosen;
      }
      // AGAIN, because the upload above is the long await (up to 30s on a 2G uplink) and an
      // interruption is far more likely to land inside it than inside `stop()`. The check on
      // the spoken branch covers the window before it; this one covers the window during it,
      // and the chip/boolean/text branch's `cancel()` as well.
      if (_torndown || gen != _interruptGen) {
        // close() raced an await above — it already fired _recorder.cancel() for us (see
        // close()), but that does not drop a retained path from OUR set. The outer `finally`
        // does that on every exit from here, this one included.
        return;
      }

      // #761 — OPTIMISTIC LOOKAHEAD. For a single-select chip or a boolean tap
      // whose key the server predicted a next question for, render THAT predicted
      // question (prompt + moved dot-rail) NOW, in a non-listening phase, so a 2G
      // worker does not stare at a frozen screen through the blocking submit.
      // ADVISORY ONLY and mic-SAFE: the mic is NOT armed here (#691 — no
      // `_armFreshClip`), nothing is banked, and `current` (captured at the top
      // of this advance) — never the prediction — still drives the submit key
      // below, so the wire body is byte-identical. The real `step` reconciles via
      // `_route`, replacing this render (and OVERRIDING it entirely on a
      // Retry/Reattach/Done). Open/multi-select/spoken get no prediction and fall
      // back to today's `current.copyWith(uploading)`.
      final PredictedNext? predicted = _optimisticPrediction(current, chosen);
      if (predicted != null) {
        emit(VoiceFormAsking(
          question: predicted.question!,
          index: predicted.index,
          total: predicted.total,
          micPhase: MicPhase.uploading,
        ));
      } else {
        emit(current.copyWith(micPhase: MicPhase.uploading));
      }
      // THE QUESTION ON SCREEN, asserted by the thing that knows it. `current` was captured
      // at the top of this advance, so it is the question the worker actually answered even
      // if the engine has since moved on. An empty id is the disambiguation turn, which
      // belongs to no pack and whose key the server expects to be null.
      final VoiceFormStep step = await _gateway.submit(
        answer,
        questionKey: current.question.id.isEmpty ? null : current.question.id,
      );
      // #691 — a `paused` during the (up to 30s) submit MUST NOT be walked over:
      // if the interruption generation moved, this advance is stale — the mic is
      // cancelled and the state is VoiceFormInterrupted; do not present or arm.
      if (_torndown || gen != _interruptGen) return;
      // ONLY BANK AN ANSWER THE ENGINE ACTUALLY TOOK. `RetryCurrentQuestion` means the
      // server wrote nothing — appending here would put a second entry in `_answers` for one
      // question the moment the worker re-answers, publish a `voice_note_id` for a turn that
      // was discarded, and over-count `profiling_answer_spoken` on exactly the flaky-2G path
      // the retryable step exists for. The silence gate stays reset either way: the worker
      // DID speak, which is what that counter is about.
      _consecutiveSilent = 0;
      // NOT on a re-attach either (#727). A `ReattachedTo` means the server REJECTED
      // this answer as stale (a 409) and the gateway re-read the current step —
      // banking here would append an answer the engine never took (and, for a spoken
      // answer, a `voice_note_id`) against the wrong question, plus over-count
      // `profiling_answer_spoken` on the flaky-2G path. Present it without banking.
      //
      // A RE-ATTACH IS NOT THE SAME SHAPE AS A RETRY, and the difference is worth
      // stating because both land in this one guard. On `RetryCurrentQuestion` the
      // server wrote NOTHING, so skipping both is simply accurate. On `ReattachedTo`
      // the server DID take an answer to this question — the earlier attempt that
      // timed out client-side (`profiling-session.service.ts` names exactly that case
      // in its stale-answer guard) — just not THIS clip. So the local echo and the
      // spoken counter both end up one short for a question the worker really did
      // answer, and by voice.
      //
      // ACCEPTED, NOT OVERLOOKED. The alternative is banking a `voice_note_id` the
      // engine discarded, which is worse than a gap: `_answers` only ever feeds the
      // review screen's local echo, and #700's remaining work replaces that with rows
      // read from `GET /profiling/session` — server truth, where the accepted answer
      // already is. The counter stays consistent with the rule the line above states
      // ("only an answer the engine actually took"); it is not silently different for
      // this variant.
      if (step is! RetryCurrentQuestion && step is! ReattachedTo) {
        _answers.add(answer);
        if (answer.isSpoken) _actions.recordAnswerSpoken(current.index); // #639
      }
      // #761 — a RetryCurrentQuestion re-asks the question the worker ANSWERED,
      // and `_retry` reads it from `state`. If we optimistically rendered the
      // predicted NEXT question, restore the real `current` first so the re-ask
      // is of the right question, not the prediction. (A forward NextQuestion is
      // re-presented by `_route` regardless; a ReattachedTo/Done does not read
      // `state.question`, so only the Retry case needs this.)
      if (predicted != null && step is RetryCurrentQuestion) {
        emit(VoiceFormAsking(
          question: current.question,
          index: current.index,
          total: current.total,
          micPhase: MicPhase.uploading,
          lookahead: current.lookahead,
        ));
      }
      await _route(step, gen);
    } on Failure catch (failure) {
      if (!_torndown) emit(VoiceFormError(failure));
      unawaited(_actions.flush()); // a dead-ended session still owes its signals
    } catch (error) {
      if (!_torndown) emit(VoiceFormError(mapError(error)));
      unawaited(_actions.flush());
    } finally {
      _advancing = false;
      // EVERY exit — success, interruption, teardown, a throw from the upload or the submit.
      // The stale-clip sweep can only ever reclaim a path that has been released, and the
      // recorder outlives this cubit.
      if (retainPath != null) _recorder.release(retainPath);
      // THE DEFERRED RESUME. A `resumed` that arrived while this advance was parked on the
      // upload was refused above rather than allowed to re-arm over it; now that the guard is
      // clear, honour it. `resumeSession` no-ops unless the state is still Interrupted, so a
      // call that races the lifecycle one is harmless.
      if (!_torndown && _foreground && state is VoiceFormInterrupted) {
        unawaited(resumeSession());
      }
    }
  }

  /// The advisory prediction to render for [chosen] on [current]'s question, or
  /// null when there is none to render (#761).
  ///
  /// Rendered only for a SINGLE-select chip or a boolean tap whose `option_key`
  /// the server predicted a NEXT QUESTION for (a predicted DONE has a null
  /// question — nothing to show, and the mic must not arm on an unconfirmed end).
  /// Spoken/text/multi-select get none — they fall back to today's blocking
  /// submit, exactly as the invariants require. Guards the dot-rail invariant
  /// (`total >= index >= 0`) so an out-of-range prediction is dropped rather than
  /// asserting in [VoiceDotRail].
  ///
  /// The boolean lookup is keyed `'true'`/`'false'` (best-effort — a server that
  /// keys it otherwise simply yields no prediction, i.e. today's behaviour).
  PredictedNext? _optimisticPrediction(
      VoiceFormAsking current, VoiceAnswer? chosen) {
    if (chosen == null) return null; // spoken → no prediction
    final Map<String, PredictedNext> lookahead = current.lookahead;
    if (lookahead.isEmpty) return null;
    final PredictedNext? predicted;
    switch (chosen.kind) {
      case VoiceAnswerKind.chips:
        // multi-select must NOT render optimistically (#761).
        if (chosen.optionKeys.length != 1) return null;
        predicted = lookahead[chosen.optionKeys.first];
      case VoiceAnswerKind.boolean:
        predicted = lookahead[chosen.boolValue! ? 'true' : 'false'];
      case VoiceAnswerKind.text:
      case VoiceAnswerKind.spoken:
        return null;
    }
    if (predicted == null || predicted.question == null) return null;
    if (predicted.index < 0 || predicted.total < predicted.index) return null;
    return predicted;
  }

  /// The recorded clip → a registered `voice_note_id`, against the engine's session (#717).
  ///
  /// A missing session id is [UnauthorizedFailure] rather than a silent skip: it means
  /// `start()` never completed, so there is no interview to answer and no row to attach the
  /// note to. Failing here is also what keeps the raw audio from being uploaded with nowhere
  /// to belong.
  Future<String> _registerClip(RecordedClip clip) async {
    final String? token = _session.sessionToken;
    final String? sessionId = _gateway.sessionId;
    if (token == null || sessionId == null) throw const UnauthorizedFailure();
    return _registrar.register(clip, authToken: token, sessionId: sessionId);
  }

  Future<void> _route(VoiceFormStep step, int gen) async {
    switch (step) {
      case NextQuestion():
        await _present(step, gen);
      case VoiceFormDone():
        unawaited(_actions.flush()); // best-effort, off the critical path (#639)
        // Rows come from SERVER TRUTH (#700), not `_answers`. A failed fetch must
        // NOT dead-end into VoiceFormError (whose only action is onExit) — the
        // worker must still be able to submit, so review is entered either way,
        // with a degraded empty list when the fetch throws.
        List<VoiceReviewRow> rows = const <VoiceReviewRow>[];
        try {
          rows = await _gateway.reviewRows();
        } catch (_) {
          rows = const <VoiceReviewRow>[];
        }
        if (_torndown) return;
        emit(VoiceFormReview(
          answers: List<VoiceAnswer>.of(_answers),
          rows: rows,
        ));
      case RetryCurrentQuestion():
        await _retry(step, gen);
      case ReattachedTo():
        // The answer was already NOT banked by the caller (#727); just present
        // whatever the engine is on now (a NextQuestion, or rarely done).
        await _route(step.step, gen);
    }
  }

  /// Nothing was written — RE-ASK the same question rather than ending the interview (#717).
  ///
  /// NOT AN ERROR, and that is the whole point of the step existing. A lost CAS or a failed
  /// transcription used to arrive as `VoiceFormError`, whose only action on screen is
  /// `onExit`, so the interview ended on the one outcome the server explicitly marked
  /// retryable — on a flaky uplink, which is where this happens.
  ///
  /// RE-PRESENTED, NOT SILENTLY RE-ARMED. `_rearm` (the empty-take path) reopens the mic
  /// without speaking, which is right when the worker just said nothing and knows it. Here
  /// they DID speak and the turn evaporated, so hearing the question again is the only
  /// signal they get that it needs saying once more — and on this surface it has to be
  /// audible, not a line of text. `_present` speaks then arms, so the retry is exactly a
  /// re-ask of the question already on screen.
  ///
  /// A `start()` that lands here has no question yet — there is nothing to re-ask, so that
  /// stays a failure, carrying the engine's own line.
  Future<void> _retry(RetryCurrentQuestion step, int gen) async {
    final VoiceFormState current = state;
    if (current is! VoiceFormAsking) {
      emit(VoiceFormError(VoiceUnavailableFailure(step.reply)));
      return;
    }
    // The answer never landed, so it is NOT appended to `_answers` and the question stands.
    await _present(
      NextQuestion(current.question, index: current.index, total: current.total),
      gen,
    );
  }

  /// Render Q(n+1) → TTS → start → 250ms prime → arm. Starting the clip only
  /// after the prompt is read keeps the prompt out of the answer; the prime lets
  /// the codec settle before the endpointer is armed, so the first syllable is
  /// captured but not mis-detected. [gen] aborts the whole chain if an
  /// interruption lands mid-way (#691) — e.g. after the TTS await.
  Future<void> _present(NextQuestion next, int gen) async {
    if (_torndown || gen != _interruptGen) return;
    emit(VoiceFormAsking(
      question: next.question,
      index: next.index,
      total: next.total,
      micPhase: MicPhase.priming,
      lookahead: next.lookahead, // #761 — carried for the next tap's prediction
    ));
    await _tts.play(next.question); // read aloud — mic not yet live
    if (_torndown || gen != _interruptGen) return;
    await _armFreshClip(next.question, next.index, next.total, gen,
        lookahead: next.lookahead);
  }

  Future<void> _rearm(VoiceFormAsking current, int gen) => _armFreshClip(
      current.question, current.index, current.total, gen,
      lookahead: current.lookahead);

  /// start → 250ms prime → arm → emit listening/holding. Shared by first-render,
  /// re-arm-after-empty, replay (#631), and resume (#636).
  ///
  /// #691 — this is the choke point that must NEVER start the mic off-screen: it
  /// refuses to call `_recorder.start()` unless the app is [_foreground] AND this
  /// chain's interruption [gen] is still current. Both are re-checked after every
  /// await, and the mic is released if the app backgrounded during the start
  /// window.
  Future<void> _armFreshClip(
      VoiceQuestion question, int index, int total, int gen,
      {Map<String, PredictedNext> lookahead =
          const <String, PredictedNext>{}}) async {
    if (_torndown || !_foreground || gen != _interruptGen) return;
    _startingMic = true;
    try {
      await _recorder.start(); // start THIS question's clip
    } finally {
      _startingMic = false;
    }
    if (_torndown || !_foreground || gen != _interruptGen) {
      await _recorder.cancel(); // backgrounded / interrupted during start — release
      return;
    }
    await _sleep(_primeDelay); // 250ms prime
    if (_torndown || !_foreground || gen != _interruptGen) {
      await _recorder.cancel();
      return;
    }
    _endpointer.arm();
    emit(VoiceFormAsking(
      question: question,
      index: index,
      total: total,
      micPhase: _endpointer.manualOnly ? MicPhase.holding : MicPhase.listening,
      lookahead: lookahead, // #761 — preserved when the mic goes live
    ));
  }

  /// Replay the current question aloud (the speaker button, #631). PROMPTING and
  /// LISTENING are mutually exclusive: the mic is stopped for the WHOLE of
  /// playback so the prompt is never captured as the answer, then a fresh clip
  /// is armed. Guarded by [_advancing] so a replay cannot race an advance.
  Future<void> replay() async {
    final VoiceFormState current = state;
    if (current is! VoiceFormAsking || _advancing) return;
    // MANUAL replay only (#639) — buffered synchronously so analytics is never
    // on the critical path of this accessibility affordance.
    _actions.recordQuestionAudioPlayed(current.index);
    _advancing = true;
    final int gen = _interruptGen; // #691 — abort if backgrounded mid-replay
    try {
      await _recorder.cancel(); // mic OFF — discard any partial take
      // The epoch belongs here too: an interruption during the cancel() await
      // would otherwise be overwritten by the priming emit below, leaving an
      // Asking state with a dead mic that resumeSession() cannot recover
      // (it only recovers from VoiceFormInterrupted).
      if (_torndown || !_foreground || gen != _interruptGen) return;
      emit(current.copyWith(micPhase: MicPhase.priming));
      await _tts.play(current.question); // read aloud while the mic is off
      if (_torndown || gen != _interruptGen) return;
      await _armFreshClip(current.question, current.index, current.total, gen,
          lookahead: current.lookahead);
    } finally {
      _advancing = false;
    }
  }

  /// Amplitude tap: feed the endpointer while listening; a returned signal
  /// (clean endpoint OR cap-out) advances. The [_advancing] guard makes repeated
  /// signals idempotent.
  void _onLevel(MicLevel level) {
    final VoiceFormState current = state;
    if (current is! VoiceFormAsking) return;
    if (current.micPhase != MicPhase.listening) return;
    if (!_meter.isClosed) _meter.add(level); // feed the UI meter
    final EndpointerSignal signal = _endpointer.add(level.dbfs);
    if (signal == EndpointerSignal.none) return;
    unawaited(answerBySpeaking());
  }

  /// Discard the current take and record the SAME question again ("Phir se
  /// bolein", #629) — no new prompt, just a fresh clip. Guarded like an advance.
  Future<void> reRecord() async {
    final VoiceFormState current = state;
    if (current is! VoiceFormAsking || _advancing) return;
    _advancing = true;
    final int gen = _interruptGen;
    try {
      await _recorder.cancel(); // throw away the partial take
      await _armFreshClip(current.question, current.index, current.total, gen);
    } finally {
      _advancing = false;
    }
  }

  /// Commit the reviewed session — the only submit path (#632).
  Future<void> submitReviewed() async {
    if (state is! VoiceFormReview) return;
    emit(const VoiceFormSubmitting());
    try {
      await _gateway.finalize();
      if (!_torndown) emit(const VoiceFormComplete());
    } on Failure catch (failure) {
      if (!_torndown) emit(VoiceFormError(failure));
    } catch (error) {
      if (!_torndown) emit(VoiceFormError(mapError(error)));
    }
  }

  /// Correct ONE already-settled answer from the review screen's ⟲ (#700).
  ///
  /// FAIL-CLOSED, ON REVIEW. A 409 (still on screen), a 422 (parsed to no value)
  /// or the correction cap must NOT become [VoiceFormError] — that state's only
  /// action is onExit, which would throw away a completed interview over one
  /// mistyped fix. They land in [VoiceFormReview.correctionError] instead, and
  /// the worker stays on review with every other row intact.
  ///
  /// On success the one addressed row is redrawn from the engine's echo (no
  /// whole-session re-fetch on a 2G link), and any prior [correctionError] is
  /// cleared.
  Future<void> correctAnswer(
    VoiceAnswer answer, {
    required String questionKey,
  }) async {
    final VoiceFormState captured = state;
    if (captured is! VoiceFormReview) return;
    final VoiceFormReview current = captured;
    try {
      final VoiceCorrectionOutcome outcome =
          await _gateway.correct(answer, questionKey: questionKey);
      if (_torndown) return;
      final List<VoiceReviewRow> updated = <VoiceReviewRow>[
        for (final VoiceReviewRow row in current.rows)
          if (row.questionId == outcome.questionId)
            row.copyWith(
              displayValue: outcome.displayValue ?? '',
              declined: outcome.declined,
            )
          else
            row,
      ];
      emit(current.copyWith(
        rows: updated,
        correctionError: null,
        profileRebuildRequired: outcome.profileRebuildRequired,
      ));
    } on Failure catch (f) {
      if (!_torndown) emit(current.copyWith(correctionError: f.message));
    } catch (e) {
      if (!_torndown) emit(current.copyWith(correctionError: mapError(e).message));
    }
  }

  /// Register a correction's recorded clip through the EXACT first-answer upload
  /// path (#700) — token + engine session + registrar, temp file deleted in the
  /// uploader's own `finally`. The host hands the resulting `voice_note_id` to
  /// [correctAnswer] as `VoiceAnswer.spoken`.
  Future<String> registerCorrectionClip(RecordedClip clip) =>
      _registerClip(clip);

  /// Open the mic for a one-shot voice CORRECTION (#700). The interview is done
  /// by the review screen, so the shared recorder is idle — reuse it rather than
  /// stand up a second. This is NOT part of the answer cycle: it does not touch
  /// the endpointer, the meter or `_advancing`; the host drives start → stop.
  Future<void> startCorrectionCapture() async {
    if (_torndown || !_foreground) return;
    await _recorder.start();
  }

  /// Stop the one-shot correction capture and hand back the clip (or null if
  /// nothing was captured / teardown raced). The host uploads it via
  /// [registerCorrectionClip].
  Future<RecordedClip?> stopCorrectionCapture() async {
    if (_torndown) return null;
    return _recorder.stop();
  }

  /// App lifecycle transitions (#636), forwarded by the screen's observer. The
  /// handler is IDEMPOTENT per transition, so iOS observer stacking (N observers
  /// over N clips) collapses to a single effect: repeated `paused` events do not
  /// stack, and a resume that finds nothing interrupted is a no-op.
  void handleLifecycle(AppLifecycleState lifecycle) {
    switch (lifecycle) {
      case AppLifecycleState.paused:
      case AppLifecycleState.detached:
      case AppLifecycleState.hidden:
        // Set the hard gate SYNCHRONOUSLY, before any await, so no in-flight
        // continuation can start the mic while backgrounded (#691) — even in the
        // window where [_interrupt] no-ops because the state is already
        // Interrupted (e.g. a second pause during a resume).
        _foreground = false;
        unawaited(_interrupt());
      case AppLifecycleState.resumed:
        _foreground = true;
        unawaited(resumeSession());
      case AppLifecycleState.inactive:
        break; // transient (e.g. the call sheet animating in) — ignore
    }
  }

  /// Backgrounded / interrupted mid-question: STOP the clip (never rely on the
  /// plugin's auto-pause, which would let a 30s call inflate `durationSeconds`)
  /// and enter [VoiceFormInterrupted]. Idempotent — a second `paused` while
  /// already interrupted does nothing.
  Future<void> _interrupt() async {
    // Bump the generation SYNCHRONOUSLY (#691): any async arm chain that captured
    // the old value now aborts instead of overwriting VoiceFormInterrupted.
    _interruptGen++;
    final VoiceFormState current = state;
    if (current is! VoiceFormAsking) return; // already interrupted / not asking
    final VoiceFormAsking asking = current;
    emit(VoiceFormInterrupted(
      question: asking.question,
      index: asking.index,
      total: asking.total,
    ));
    await _recorder.cancel(); // discard the partial take — recorded time only
  }

  /// Resume after an interruption (#636). Re-checks permission (it can be revoked
  /// from the notification shade mid-session), then re-arms the SAME question
  /// with a fresh clip and a reset endpointer — the trailing-silence timer is
  /// never continued across the gap. Idempotent — a resume with nothing
  /// interrupted is a no-op.
  Future<void> resumeSession() async {
    final VoiceFormState current = state;
    if (current is! VoiceFormInterrupted) return;
    // NOT WHILE AN ADVANCE IS STILL UNWINDING (#717). Every other entry point respects
    // `_advancing`; this one did not, and it did not matter while the only long await inside
    // that window was `submit`. The upload now sits in front of it — a 30s PUT plus the
    // register call — so a call that arrives mid-upload and ends quickly lands here with the
    // old advance still parked.
    //
    // Re-arming then puts "Sun rahe hain" and a live meter on screen while `_advancing` is
    // still true, so the endpointer fires, `answerBySpeaking()` returns immediately at the
    // idempotency guard, and the endpointer has already latched `done` — the worker is left
    // talking to a mic that will never advance, with no affordance that responds.
    //
    // `_advance`'s `finally` calls back here once it has unwound, so the resume is deferred
    // rather than dropped.
    if (_advancing) return;
    final bool granted = await _recorder.ensurePermission();
    // Re-paused during the permission check → do NOT arm (#691).
    if (_torndown || !_foreground) return;
    if (!granted) {
      emit(const VoiceFormError(MicPermissionFailure()));
      return;
    }
    // Leave Interrupted first, so a pause during the re-arm is catchable again;
    // capture the current generation for this fresh arm chain.
    final int gen = _interruptGen;
    emit(VoiceFormAsking(
      question: current.question,
      index: current.index,
      total: current.total,
      micPhase: MicPhase.priming,
    ));
    await _armFreshClip(current.question, current.index, current.total, gen);
  }

  /// A recorder state-stream error (#636), typically a Bluetooth SCO drop. Discard
  /// the clip and re-ask the SAME question rather than let it become an unhandled
  /// zone error. Idempotent via [_advancing].
  void _onRecordStateError(Object error) {
    final VoiceFormState current = state;
    if (current is! VoiceFormAsking || _advancing) return;
    _advancing = true;
    final int gen = _interruptGen;
    unawaited(() async {
      try {
        await _recorder.cancel(); // the interrupted clip is unusable
        if (!_torndown && gen == _interruptGen) {
          await _armFreshClip(current.question, current.index, current.total, gen,
              lookahead: current.lookahead);
        }
      } finally {
        _advancing = false;
      }
    }());
  }

  @override
  Future<void> close() async {
    unawaited(_actions.flush()); // drain any un-flushed action signals (#639)
    // FIRST LINE, before any await: everything below is teardown, and a method
    // suspended on an await must see that immediately. `isClosed` only flips in
    // super.close() at the very bottom, which is far too late to stop a
    // continuation re-arming the recorder we are about to dispose.
    _closing = true;
    await _levelsSub?.cancel();
    _levelsSub = null;
    await _statesSub?.cancel();
    _statesSub = null;
    await _meter.close();
    await _tts.stop();
    // Release the mic — covers a live recording AND the start() await window
    // (_startingMic). cancel() is idempotent and best-effort.
    if (_startingMic || state is VoiceFormAsking) {
      await _recorder.cancel();
    }
    await _recorder.dispose(); // disposed exactly once, only here
    return super.close();
  }
}
