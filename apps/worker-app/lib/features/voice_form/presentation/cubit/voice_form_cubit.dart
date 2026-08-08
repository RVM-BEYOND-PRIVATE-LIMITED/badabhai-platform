import 'dart:async';

import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
import '../../../../core/error/failure_mapper.dart';
import '../../../voice/data/session_voice_recorder.dart';
import '../../../voice/domain/voice_models.dart';
import '../../domain/question_audio_player.dart';
import '../../domain/silence_endpointer.dart';
import '../../domain/voice_form_gateway.dart';
import '../../domain/voice_form_models.dart';

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
  });

  final VoiceQuestion question;
  final int index;
  final int total;
  final MicPhase micPhase;

  VoiceFormAsking copyWith({MicPhase? micPhase}) => VoiceFormAsking(
        question: question,
        index: index,
        total: total,
        micPhase: micPhase ?? this.micPhase,
      );

  @override
  List<Object?> get props => <Object?>[question, index, total, micPhase];
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

/// Every question answered. The review screen (#632) shows [answers]; it is the
/// ONLY place the session is committed.
class VoiceFormReview extends VoiceFormState {
  const VoiceFormReview(this.answers);

  final List<VoiceAnswer> answers;

  @override
  List<Object?> get props => <Object?>[answers];
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
    Duration primeDelay = const Duration(milliseconds: 250),
    Duration levelInterval = const Duration(milliseconds: 100),
    Future<void> Function(Duration)? sleep,
  })  : _gateway = gateway,
        _recorder = recorder,
        _endpointer = endpointer,
        _tts = tts,
        _primeDelay = primeDelay,
        _levelInterval = levelInterval,
        _sleep = sleep ?? Future<void>.delayed,
        super(const VoiceFormIdle());

  final VoiceFormGateway _gateway;
  final SessionVoiceRecorder _recorder;
  final SilenceEndpointer _endpointer;
  final QuestionAudioPlayer _tts;
  final Duration _primeDelay;
  final Duration _levelInterval;
  final Future<void> Function(Duration) _sleep;

  final List<VoiceAnswer> _answers = <VoiceAnswer>[];

  StreamSubscription<MicLevel>? _levelsSub;

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

  /// True once permission was requested — asked exactly once per session.
  bool _permissionAsked = false;

  /// Opens the session. Requests mic permission exactly once, then presents Q1.
  Future<void> start() async {
    if (state is! VoiceFormIdle) return;
    emit(const VoiceFormPreparing());
    try {
      if (!_permissionAsked) {
        _permissionAsked = true;
        final bool granted = await _recorder.ensurePermission();
        if (isClosed) return;
        if (!granted) {
          emit(const VoiceFormError(MicPermissionFailure()));
          return;
        }
      }
      // One levels subscription for the whole session — feeds the endpointer for
      // auto-advance; never re-taken between questions (it survives stop/start).
      _levelsSub = _recorder.levels(_levelInterval).listen(_onLevel);

      final VoiceFormStep step = await _gateway.start();
      if (isClosed) return;
      await _route(step);
    } on Failure catch (failure) {
      if (!isClosed) emit(VoiceFormError(failure));
    } catch (error) {
      if (!isClosed) emit(VoiceFormError(mapError(error)));
    }
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
    try {
      final VoiceAnswer answer;
      String? retainPath;
      if (chosen == null) {
        final RecordedClip? clip = await _recorder.stop(); // stop
        if (clip == null) {
          // Nothing captured (a mis-trigger). Re-arm the same question rather
          // than submit an empty answer the engine would reject.
          if (!isClosed) await _rearm(current);
          return;
        }
        _recorder.retain(clip.path); // retain — protect the in-flight upload
        retainPath = clip.path;
        answer = VoiceAnswer.spoken(clip);
      } else {
        // A chip/boolean/text answer — discard the open clip (no STT call) and
        // submit the chosen answer.
        await _recorder.cancel();
        answer = chosen;
      }

      emit(current.copyWith(micPhase: MicPhase.uploading));
      final VoiceFormStep step = await _gateway.submit(answer); // queue upload
      if (retainPath != null) _recorder.release(retainPath);
      if (isClosed) return;
      _answers.add(answer);
      await _route(step);
    } on Failure catch (failure) {
      if (!isClosed) emit(VoiceFormError(failure));
    } catch (error) {
      if (!isClosed) emit(VoiceFormError(mapError(error)));
    } finally {
      _advancing = false;
    }
  }

  Future<void> _route(VoiceFormStep step) async {
    switch (step) {
      case NextQuestion():
        await _present(step);
      case VoiceFormDone():
        emit(VoiceFormReview(List<VoiceAnswer>.of(_answers)));
    }
  }

  /// Render Q(n+1) → TTS → start → 250ms prime → arm. Starting the clip only
  /// after the prompt is read keeps the prompt out of the answer; the prime lets
  /// the codec settle before the endpointer is armed, so the first syllable is
  /// captured but not mis-detected.
  Future<void> _present(NextQuestion next) async {
    emit(VoiceFormAsking(
      question: next.question,
      index: next.index,
      total: next.total,
      micPhase: MicPhase.priming,
    ));
    await _tts.play(next.question); // read aloud — mic not yet live
    if (isClosed) return;
    await _armFreshClip(next.question, next.index, next.total);
  }

  Future<void> _rearm(VoiceFormAsking current) =>
      _armFreshClip(current.question, current.index, current.total);

  /// start → 250ms prime → arm → emit listening/holding. Shared by first-render,
  /// re-arm-after-empty, and replay (#631). Releases the mic if [close] lands in
  /// the start() await window.
  Future<void> _armFreshClip(VoiceQuestion question, int index, int total) async {
    _startingMic = true;
    try {
      await _recorder.start(); // start THIS question's clip
    } finally {
      _startingMic = false;
    }
    if (isClosed) {
      await _recorder.cancel(); // closed during the start window — release it
      return;
    }
    await _sleep(_primeDelay); // 250ms prime
    if (isClosed) return;
    _endpointer.arm();
    emit(VoiceFormAsking(
      question: question,
      index: index,
      total: total,
      micPhase: _endpointer.manualOnly ? MicPhase.holding : MicPhase.listening,
    ));
  }

  /// Replay the current question aloud (the speaker button, #631). PROMPTING and
  /// LISTENING are mutually exclusive: the mic is stopped for the WHOLE of
  /// playback so the prompt is never captured as the answer, then a fresh clip
  /// is armed. Guarded by [_advancing] so a replay cannot race an advance.
  Future<void> replay() async {
    final VoiceFormState current = state;
    if (current is! VoiceFormAsking || _advancing) return;
    _advancing = true;
    try {
      await _recorder.cancel(); // mic OFF — discard any partial take
      emit(current.copyWith(micPhase: MicPhase.priming));
      await _tts.play(current.question); // read aloud while the mic is off
      if (isClosed) return;
      await _armFreshClip(current.question, current.index, current.total);
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
    try {
      await _recorder.cancel(); // throw away the partial take
      await _armFreshClip(current.question, current.index, current.total);
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
      if (!isClosed) emit(const VoiceFormComplete());
    } on Failure catch (failure) {
      if (!isClosed) emit(VoiceFormError(failure));
    } catch (error) {
      if (!isClosed) emit(VoiceFormError(mapError(error)));
    }
  }

  @override
  Future<void> close() async {
    await _levelsSub?.cancel();
    _levelsSub = null;
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
