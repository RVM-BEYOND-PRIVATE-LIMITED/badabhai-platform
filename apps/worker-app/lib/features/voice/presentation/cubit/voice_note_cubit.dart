import 'dart:async';

import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
import '../../../../core/error/failure_mapper.dart';
import '../../domain/voice_models.dart';
import '../../domain/voice_note_repository.dart';

/// Shown when transcription returned nothing usable (silence, a mis-tap, a
/// recogniser miss). Honest and actionable — never an empty confirm bubble the
/// worker is asked to approve. Persona-checked copy: aap-form, no vocative, no
/// exclamation mark.
const String kVoiceEmptyTranscript =
    'Aapki awaaz saaf sunai nahi di. Dobara bolein ya type karke bhejein.';

// ---------------- States ----------------

sealed class VoiceNoteState extends Equatable {
  const VoiceNoteState();

  @override
  List<Object?> get props => <Object?>[];
}

/// Nothing recorded yet — the big mic invites a tap.
class VoiceNoteIdle extends VoiceNoteState {
  const VoiceNoteIdle();
}

/// Mic is live; [elapsedSeconds] drives the on-screen counter.
class VoiceNoteRecording extends VoiceNoteState {
  const VoiceNoteRecording(this.elapsedSeconds);

  final int elapsedSeconds;

  @override
  List<Object?> get props => <Object?>[elapsedSeconds];
}

/// Work is in flight. Two distinct legs share this state so the screen shows one
/// consistent spinner, and [sending] picks the honest caption for each:
///  - `sending == false` — clip captured, upload → transcribe is running.
///  - `sending == true`  — the CONFIRMED transcript is being merged into chat.
///
/// The default is the transcribe leg, so `const VoiceNoteProcessing()` still
/// means exactly what it always meant.
class VoiceNoteProcessing extends VoiceNoteState {
  const VoiceNoteProcessing({this.sending = false});

  /// True only on the post-confirmation leg (the answer is on its way to chat).
  final bool sending;

  @override
  List<Object?> get props => <Object?>[sending];
}

/// The transcript came back and is WAITING FOR THE WORKER'S CONFIRMATION
/// (Persona sheet, worked conversation #05: "the transcript is shown for
/// confirmation, never guessed at").
///
/// Nothing has been sent to the chat session in this state — the recogniser's
/// output is not yet the worker's answer of record. Three ways out:
/// [VoiceNoteCubit.confirm] (send it), [VoiceNoteCubit.edit] (fix the words
/// first), [VoiceNoteCubit.reRecord] (throw it away and speak again).
///
/// The mic is ALREADY RELEASED by the time this is emitted — the repository
/// stops the recorder on the first line of `stopAndTranscribe`.
class VoiceNoteTranscriptReady extends VoiceNoteState {
  const VoiceNoteTranscriptReady(this.transcript);

  /// What the worker is being shown and asked to approve. Worker-authored
  /// content — held transiently to display, never logged or persisted.
  final String transcript;

  @override
  List<Object?> get props => <Object?>[transcript];
}

/// Pipeline done: the screen pops back to chat with [outcome].
class VoiceNoteSuccess extends VoiceNoteState {
  const VoiceNoteSuccess(this.outcome);

  final VoiceNoteOutcome outcome;

  @override
  List<Object?> get props => <Object?>[outcome];
}

/// Something honest went wrong ([failure] carries the worker-safe copy).
class VoiceNoteError extends VoiceNoteState {
  const VoiceNoteError(this.failure);

  final Failure failure;

  @override
  List<Object?> get props => <Object?>[failure];
}

// ---------------- Cubit ----------------

/// Drives the voice-note capture screen: idle → recording (1s ticks, HARD stop
/// at [maxSeconds]) → processing → **transcriptReady (confirm turn)** →
/// processing(sending) → success | error.
///
/// The confirm turn is not optional and not skippable: the ONLY call that
/// reaches the chat session is [confirm], and it can only be made from
/// [VoiceNoteTranscriptReady]. The hard-cap auto-stop lands there too — running
/// out of time must never auto-publish words the worker has not seen.
///
/// [tick] and [maxSeconds] are test seams; production uses the defaults (1s /
/// 120s — the API contract's duration cap, doubly enforced by the recorder's
/// own auto-stop timer).
class VoiceNoteCubit extends Cubit<VoiceNoteState> {
  VoiceNoteCubit(
    this._repo, {
    Duration tick = const Duration(seconds: 1),
    this.maxSeconds = 120,
  })  : _tick = tick,
        super(const VoiceNoteIdle());

  final VoiceNoteRepository _repo;
  final Duration _tick;
  final int maxSeconds;

  Timer? _ticker;

  /// True from the FIRST synchronous line of [startRecording] until it
  /// settles. The state alone can't guard reentrancy — it stays
  /// [VoiceNoteIdle] across the permission/start awaits, so a double-tap
  /// would start the plugin twice and stack two tickers (elapsed counting 2x,
  /// auto-send at ~60s wall time).
  bool _starting = false;

  /// Checks the mic permission (OS prompt on first ask) and starts recording.
  /// A denied permission is an honest [MicPermissionFailure], never a crash.
  Future<void> startRecording() async {
    if (_starting ||
        state is VoiceNoteRecording ||
        state is VoiceNoteProcessing) {
      return;
    }
    _starting = true; // set BEFORE the first await — the double-tap guard.
    try {
      final bool granted = await _repo.ensureMicPermission();
      if (isClosed) return;
      if (!granted) {
        emit(const VoiceNoteError(MicPermissionFailure()));
        return;
      }
      await _repo.startRecording();
      if (isClosed) {
        // The screen died while the plugin was starting — a mic with no
        // owner. Release it (best-effort; close() also covers this window
        // and cancel is idempotent).
        await _repo.cancelRecording();
        return;
      }
      emit(const VoiceNoteRecording(0));
      _ticker = Timer.periodic(_tick, _onTick);
    } on Failure catch (failure) {
      if (!isClosed) emit(VoiceNoteError(failure));
    } catch (error) {
      if (!isClosed) emit(VoiceNoteError(mapError(error)));
    } finally {
      _starting = false;
    }
  }

  void _onTick(Timer timer) {
    final VoiceNoteState current = state;
    if (current is! VoiceNoteRecording) {
      timer.cancel();
      return;
    }
    final int next = current.elapsedSeconds + 1;
    if (next >= maxSeconds) {
      // Hard cap: show the full counter, then auto-stop and TRANSCRIBE. The
      // recorder has its own 120s auto-stop, so the clip itself can never run
      // longer. It deliberately does NOT auto-send: hitting the time limit is
      // not consent, so this lands on the confirm turn like every other stop.
      emit(VoiceNoteRecording(maxSeconds));
      unawaited(stopAndTranscribe());
    } else {
      emit(VoiceNoteRecording(next));
    }
  }

  /// Stops the mic and resolves the transcript (upload → transcribe). Lands on
  /// [VoiceNoteTranscriptReady] — NOT on success, and nothing has been sent.
  ///
  /// A blank transcript is treated as a failure rather than shown: there is
  /// nothing for the worker to confirm, and an empty chat message would read to
  /// the engine as a non-answer.
  Future<void> stopAndTranscribe() async {
    if (state is! VoiceNoteRecording) return;
    _stopTicker();
    emit(const VoiceNoteProcessing());
    try {
      final String transcript = await _repo.stopAndTranscribe();
      if (isClosed) return;
      if (transcript.trim().isEmpty) {
        emit(const VoiceNoteError(VoiceUnavailableFailure(kVoiceEmptyTranscript)));
        return;
      }
      emit(VoiceNoteTranscriptReady(transcript.trim()));
    } on Failure catch (failure) {
      if (!isClosed) emit(VoiceNoteError(failure));
    } catch (error) {
      if (!isClosed) emit(VoiceNoteError(mapError(error)));
    }
  }

  /// The worker answered "Haan" — send the transcript they approved.
  ///
  /// Reads the text off the CURRENT [VoiceNoteTranscriptReady], so an [edit]
  /// applied first is what actually goes to the server.
  Future<void> confirm() async {
    final VoiceNoteState current = state;
    if (current is! VoiceNoteTranscriptReady) return;
    final String text = current.transcript.trim();
    if (text.isEmpty) return;
    emit(const VoiceNoteProcessing(sending: true));
    try {
      final VoiceNoteOutcome outcome = await _repo.sendConfirmedTranscript(text);
      if (!isClosed) emit(VoiceNoteSuccess(outcome));
    } on Failure catch (failure) {
      if (!isClosed) emit(VoiceNoteError(failure));
    } catch (error) {
      if (!isClosed) emit(VoiceNoteError(mapError(error)));
    }
  }

  /// The worker chose to fix the words before sending. Stays on the confirm
  /// turn with the corrected [newText]; a blank edit is ignored rather than
  /// leaving them with an unsendable empty bubble.
  void edit(String newText) {
    if (state is! VoiceNoteTranscriptReady) return;
    final String trimmed = newText.trim();
    if (trimmed.isEmpty) return;
    emit(VoiceNoteTranscriptReady(trimmed));
  }

  /// The worker chose to say it again. Discards the transcript — it was never
  /// sent, so there is nothing server-side to undo — and returns to idle.
  void reRecord() {
    if (state is! VoiceNoteTranscriptReady) return;
    emit(const VoiceNoteIdle());
  }

  /// Discards the in-progress recording (best-effort) and returns to idle.
  Future<void> cancelRecording() async {
    _stopTicker();
    await _repo.cancelRecording();
    if (!isClosed) emit(const VoiceNoteIdle());
  }

  /// Back to idle from an error so the worker can retry.
  void reset() {
    if (state is VoiceNoteError) emit(const VoiceNoteIdle());
  }

  void _stopTicker() {
    _ticker?.cancel();
    _ticker = null;
  }

  @override
  Future<void> close() async {
    _stopTicker();
    // Screen disposed mid-recording OR mid-start → discard, never leave the
    // mic running. `_starting` covers the window where startRecording() is
    // still awaiting the plugin (state not yet Recording); the in-flight
    // start also self-cancels on isClosed, and cancel is idempotent.
    if (_starting || state is VoiceNoteRecording) {
      await _repo.cancelRecording();
    }
    return super.close();
  }
}
