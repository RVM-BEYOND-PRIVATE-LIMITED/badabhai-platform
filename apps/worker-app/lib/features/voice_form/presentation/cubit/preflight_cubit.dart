import 'dart:async';

import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
import '../../../../core/error/failure_mapper.dart';
import '../../../voice/data/session_voice_recorder.dart';
import '../../../voice/domain/voice_models.dart';
import '../../data/voice_preflight_probe.dart';
import '../../domain/silence_endpointer.dart';
import '../../domain/preflight_models.dart';

// ---------------- States ----------------

sealed class PreflightState extends Equatable {
  const PreflightState();

  @override
  List<Object?> get props => <Object?>[];
}

/// Asking the OS for mic permission — the one and only time in the whole flow.
class PreflightRequestingPermission extends PreflightState {
  const PreflightRequestingPermission();
}

/// The worker (or the OS) denied the mic. A hard stop for the VOICE path, but
/// the copy points at settings, not at the feature.
class PreflightPermissionDenied extends PreflightState {
  const PreflightPermissionDenied();

  /// Shipped, persona-clean copy pointing the worker at phone settings.
  Failure get failure => const MicPermissionFailure();
}

/// Listening to the room to measure the noise floor.
class PreflightCalibrating extends PreflightState {
  const PreflightCalibrating();
}

/// Probing the upload bucket after a clean calibration.
class PreflightProbing extends PreflightState {
  const PreflightProbing();
}

/// Calibration + probe both done. The session may start. [verdict] carries the
/// honest tier; [autoAdvanceEnabled] is already resolved (off for
/// [PreflightVerdict.veryLoud] and [PreflightVerdict.micDead]). A loud / very-loud
/// / mic-dead verdict never TRAPS the worker — the screen still offers a start.
class PreflightReady extends PreflightState {
  const PreflightReady({
    required this.verdict,
    required this.noiseFloorDb,
    required this.headroomDb,
    required this.autoAdvanceEnabled,
  });

  final PreflightVerdict verdict;
  final double noiseFloorDb;
  final double headroomDb;
  final bool autoAdvanceEnabled;

  @override
  List<Object?> get props =>
      <Object?>[verdict, noiseFloorDb, headroomDb, autoAdvanceEnabled];
}

/// The bucket is dormant (503). The ONLY hard block with no start button — there
/// is no point beginning a session whose every answer would fail to upload.
class PreflightUnavailable extends PreflightState {
  const PreflightUnavailable();

  Failure get failure => const VoiceUnavailableFailure();
}

/// An unexpected error before the session could start (network, auth). Retryable.
class PreflightFailed extends PreflightState {
  const PreflightFailed(this.failure);

  final Failure failure;

  @override
  List<Object?> get props => <Object?>[failure];
}

// ---------------- Cubit ----------------

/// Drives the quiet-place pre-flight (#627): permission → calibrate → probe →
/// ready | unavailable | denied | failed.
///
/// Calibration records through [SessionVoiceRecorder] so the floor is measured
/// with the IDENTICAL session `RecordConfig` (#633) the answers use — a floor
/// taken at a different sample rate or with AGC on is not comparable to in-answer
/// amplitudes. The measured floor is handed to the SHARED [SilenceEndpointer]
/// singleton, which the session then thresholds on: same instance, same floor.
class PreflightCubit extends Cubit<PreflightState> {
  PreflightCubit({
    required SessionVoiceRecorder recorder,
    required SilenceEndpointer endpointer,
    required VoicePreflightProbe probe,
    PreflightThresholds thresholds = const PreflightThresholds(),
    Duration? listenTimeout,
  })  : _recorder = recorder,
        _endpointer = endpointer,
        _probe = probe,
        _t = thresholds,
        _listenTimeout = listenTimeout ??
            (thresholds.calibrateWindow + const Duration(seconds: 2)),
        super(const PreflightRequestingPermission());

  final SessionVoiceRecorder _recorder;
  final SilenceEndpointer _endpointer;
  final VoicePreflightProbe _probe;
  final PreflightThresholds _t;
  final Duration _listenTimeout;

  bool _started = false;

  /// Runs the whole pre-flight once. Re-entrant-safe: a second call is a no-op.
  Future<void> run() async {
    if (_started) return;
    _started = true;

    try {
      final bool granted = await _recorder.ensurePermission();
      if (isClosed) return;
      if (!granted) {
        emit(const PreflightPermissionDenied());
        return;
      }

      emit(const PreflightCalibrating());
      final List<double> samples = await _collectSamples();
      if (isClosed) return;

      // Drop the warm-up transient; hand the rest to the shared endpointer.
      final List<double> usable = samples.length > _t.warmupSamples
          ? samples.sublist(_t.warmupSamples)
          : const <double>[];

      final double floorDb;
      if (usable.isEmpty) {
        // The mic delivered nothing — a dead/muted device. Nothing to hand to
        // the endpointer; the sentinel floor drives a micDead verdict below.
        floorDb = _t.micDeadFloorDb;
      } else {
        _endpointer.calibrate(usable); // the floor is handed to the endpointer
        floorDb = _endpointer.noiseFloorDb; // the exact value the session uses
      }

      final PreflightVerdict verdict = verdictFor(floorDb, _t);
      final bool autoAdvance = autoAdvanceFor(verdict);

      emit(const PreflightProbing());
      try {
        await _probe.probe();
      } on VoiceUnavailableFailure {
        if (!isClosed) emit(const PreflightUnavailable());
        return;
      } on Failure catch (failure) {
        if (!isClosed) emit(PreflightFailed(failure));
        return;
      } catch (error) {
        if (!isClosed) emit(PreflightFailed(mapError(error)));
        return;
      }
      if (isClosed) return;

      emit(PreflightReady(
        verdict: verdict,
        noiseFloorDb: floorDb,
        headroomDb: -floorDb,
        autoAdvanceEnabled: autoAdvance,
      ));
    } on Failure catch (failure) {
      if (!isClosed) emit(PreflightFailed(failure));
    } catch (error) {
      if (!isClosed) emit(PreflightFailed(mapError(error)));
    }
  }

  /// Warms the mic and collects amplitude samples for one [calibrateWindow].
  /// Returns whatever arrived — a dead mic that never fills the buffer resolves
  /// on the [_listenTimeout] with an empty (or near-empty) list. The throwaway
  /// calibration clip is always cancelled, never uploaded.
  Future<List<double>> _collectSamples() async {
    final List<double> samples = <double>[];
    final Completer<void> enough = Completer<void>();
    final StreamSubscription<MicLevel> sub =
        _recorder.levels(_t.sampleInterval).listen((MicLevel level) {
      samples.add(level.dbfs);
      if (samples.length >= _t.totalSamples && !enough.isCompleted) {
        enough.complete();
      }
    });

    try {
      await _recorder.start(); // mic warm; identical session RecordConfig (#633)
    } catch (_) {
      // start() itself failed (mic busy, platform exception) — the recorder
      // never armed, so there is nothing for _recorder.cancel() to discard;
      // only the amplitude subscription needs releasing before this
      // propagates to run()'s catch and surfaces as PreflightFailed.
      await sub.cancel();
      rethrow;
    }
    try {
      await enough.future.timeout(_listenTimeout);
    } on TimeoutException {
      // A dead/muted mic never fills the buffer — proceed with what arrived.
    } finally {
      await sub.cancel();
      await _recorder.cancel(); // discard the calibration clip
    }
    return samples;
  }
}
