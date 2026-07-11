import 'dart:async';

import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
import '../../../../core/error/failure_mapper.dart';
import '../../domain/voice_models.dart';
import '../../domain/voice_note_repository.dart';

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

/// Clip captured — upload → transcribe → merge is running.
class VoiceNoteProcessing extends VoiceNoteState {
  const VoiceNoteProcessing();
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
/// at [maxSeconds]) → processing → success | error.
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
      // Hard cap: show the full counter, then auto-stop & send. The recorder
      // has its own 120s auto-stop, so the clip itself can never run longer.
      emit(VoiceNoteRecording(maxSeconds));
      unawaited(stopAndSend());
    } else {
      emit(VoiceNoteRecording(next));
    }
  }

  /// Stops the mic and runs the full pipeline (upload → transcribe → merge).
  Future<void> stopAndSend() async {
    if (state is! VoiceNoteRecording) return;
    _stopTicker();
    emit(const VoiceNoteProcessing());
    try {
      final VoiceNoteOutcome outcome = await _repo.stopRecordingAndTranscribe();
      if (!isClosed) emit(VoiceNoteSuccess(outcome));
    } on Failure catch (failure) {
      if (!isClosed) emit(VoiceNoteError(failure));
    } catch (error) {
      if (!isClosed) emit(VoiceNoteError(mapError(error)));
    }
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
