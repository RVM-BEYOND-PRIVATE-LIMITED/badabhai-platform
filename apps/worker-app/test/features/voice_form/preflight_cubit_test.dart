import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:record/record.dart';

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/voice/data/session_voice_recorder.dart';
import 'package:badabhai_worker_app/features/voice_form/data/voice_preflight_probe.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/preflight_models.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/silence_endpointer.dart';
import 'package:badabhai_worker_app/features/voice_form/presentation/cubit/preflight_cubit.dart';

class MockAudioRecorder extends Mock implements AudioRecorder {}

class MockProbe extends Mock implements VoicePreflightProbe {}

/// 5 total samples at 100 ms, drop 1 warm-up ⇒ 4 usable — small + deterministic.
const PreflightThresholds _fast = PreflightThresholds(
  calibrateWindow: Duration(milliseconds: 500),
  warmupDrop: Duration(milliseconds: 100),
  sampleInterval: Duration(milliseconds: 100),
);

void main() {
  setUpAll(() {
    registerFallbackValue(const RecordConfig());
    registerFallbackValue(Duration.zero);
  });

  late MockAudioRecorder plugin;
  late StreamController<Amplitude> amp;
  late MockProbe probe;
  late SilenceEndpointer endpointer;

  setUp(() {
    plugin = MockAudioRecorder();
    // Broadcast: its close() completes even when a test never subscribes (the
    // pure verdict tests don't) — a single-sub controller's close() would hang
    // in tearDown waiting for a listener to receive the done event.
    amp = StreamController<Amplitude>.broadcast();
    probe = MockProbe();
    endpointer = SilenceEndpointer();
    when(() => plugin.hasPermission()).thenAnswer((_) async => true);
    when(() => plugin.start(any(), path: any(named: 'path')))
        .thenAnswer((_) async {});
    when(() => plugin.cancel()).thenAnswer((_) async {});
    when(() => plugin.stop()).thenAnswer((_) async => null);
    when(() => plugin.onAmplitudeChanged(any())).thenAnswer((_) => amp.stream);
    when(() => probe.probe()).thenAnswer((_) async {});
  });

  tearDown(() => amp.close());

  PreflightCubit build({Duration? listenTimeout}) => PreflightCubit(
        recorder: SessionVoiceRecorder(recorder: plugin),
        endpointer: endpointer,
        probe: probe,
        thresholds: _fast,
        listenTimeout: listenTimeout,
      );

  /// Runs the cubit, feeds [dbfs] once it reaches the calibration listen, and
  /// awaits the final state.
  Future<void> runWith(PreflightCubit cubit, List<double> dbfs) async {
    final Future<void> done = cubit.run();
    await pumpEventQueue(); // reach the levels() subscription + start()
    for (final double v in dbfs) {
      amp.add(Amplitude(current: v, max: v));
    }
    await done;
  }

  group('verdictFor (pure)', () {
    const PreflightThresholds t = PreflightThresholds();
    test('a quiet room (deep floor, big headroom) is quiet + auto-advance', () {
      expect(verdictFor(-45, t), PreflightVerdict.quiet);
      expect(autoAdvanceFor(PreflightVerdict.quiet), isTrue);
    });
    test('a moderately noisy floor is loud but keeps auto-advance', () {
      expect(verdictFor(-15, t), PreflightVerdict.loud);
      expect(autoAdvanceFor(PreflightVerdict.loud), isTrue);
    });
    test('headroom < 8 dB is very-loud and disables auto-advance', () {
      expect(verdictFor(-5, t), PreflightVerdict.veryLoud); // 5 dB headroom
      expect(autoAdvanceFor(PreflightVerdict.veryLoud), isFalse);
    });
    test('a floor at digital silence is a dead mic, not a quiet room', () {
      expect(verdictFor(-120, t), PreflightVerdict.micDead);
      expect(autoAdvanceFor(PreflightVerdict.micDead), isFalse);
    });
  });

  test('a quiet room → PreflightReady(quiet), floor handed to the endpointer',
      () async {
    final PreflightCubit cubit = build();
    addTearDown(cubit.close);
    await runWith(cubit, <double>[-9, -55, -54, -56, -53]); // 1 warm-up dropped

    final PreflightState s = cubit.state;
    expect(s, isA<PreflightReady>());
    final PreflightReady ready = s as PreflightReady;
    expect(ready.verdict, PreflightVerdict.quiet);
    expect(ready.autoAdvanceEnabled, isTrue);
    // The measured floor was calibrated INTO the shared endpointer — the same
    // instance the session will threshold on — not just returned.
    expect(endpointer.noiseFloorDb, ready.noiseFloorDb);
    expect(endpointer.noiseFloorDb, lessThan(-40));
    // Calibration must have started the mic with the session RecordConfig.
    verify(() => plugin.start(any(), path: any(named: 'path'))).called(1);
    verify(() => plugin.cancel()).called(1); // throwaway clip discarded
  });

  test('a very-loud room → veryLoud verdict, auto-advance OFF', () async {
    final PreflightCubit cubit = build();
    addTearDown(cubit.close);
    await runWith(cubit, <double>[-40, -5, -6, -4, -5]); // floor ~ -5 ⇒ <8 dB

    final PreflightReady ready = cubit.state as PreflightReady;
    expect(ready.verdict, PreflightVerdict.veryLoud);
    expect(ready.autoAdvanceEnabled, isFalse);
  });

  test(
      'a mic that delivers nothing → micDead (not a false "very quiet"); still '
      'probes so a live bucket offers a start', () async {
    final PreflightCubit cubit =
        build(listenTimeout: const Duration(milliseconds: 30));
    addTearDown(cubit.close);
    await runWith(cubit, const <double>[]); // no samples ⇒ listen times out

    final PreflightReady ready = cubit.state as PreflightReady;
    expect(ready.verdict, PreflightVerdict.micDead);
    expect(ready.autoAdvanceEnabled, isFalse);
    verify(() => probe.probe()).called(1);
  });

  test('a denied mic → PreflightPermissionDenied, no calibration', () async {
    when(() => plugin.hasPermission()).thenAnswer((_) async => false);
    final PreflightCubit cubit = build();
    addTearDown(cubit.close);
    await cubit.run();

    expect(cubit.state, isA<PreflightPermissionDenied>());
    verifyNever(() => plugin.start(any(), path: any(named: 'path')));
    verifyNever(() => probe.probe());
  });

  test('a 503 from the probe → PreflightUnavailable (a doomed session aborts)',
      () async {
    when(() => probe.probe()).thenThrow(const VoiceUnavailableFailure());
    final PreflightCubit cubit = build();
    addTearDown(cubit.close);
    await runWith(cubit, <double>[-9, -55, -54, -56, -53]);

    expect(cubit.state, isA<PreflightUnavailable>());
  });

  test('run() is re-entrant-safe — a second call is a no-op', () async {
    final PreflightCubit cubit = build();
    addTearDown(cubit.close);
    await runWith(cubit, <double>[-9, -55, -54, -56, -53]);
    await cubit.run(); // must not re-calibrate

    verify(() => plugin.start(any(), path: any(named: 'path'))).called(1);
  });
}
