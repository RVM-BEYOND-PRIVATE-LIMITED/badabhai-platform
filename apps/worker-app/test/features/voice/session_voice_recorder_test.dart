import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:record/record.dart';

import 'package:badabhai_worker_app/features/voice/data/record_package_voice_recorder.dart';
import 'package:badabhai_worker_app/features/voice/data/session_voice_recorder.dart';
import 'package:badabhai_worker_app/features/voice/domain/voice_models.dart';
import 'package:badabhai_worker_app/features/voice/domain/voice_recorder.dart';

class MockAudioRecorder extends Mock implements AudioRecorder {}

void main() {
  setUpAll(() {
    registerFallbackValue(const RecordConfig());
    registerFallbackValue(Duration.zero);
  });

  late MockAudioRecorder plugin;

  setUp(() {
    plugin = MockAudioRecorder();
    when(() => plugin.hasPermission()).thenAnswer((_) async => true);
    when(() => plugin.start(any(), path: any(named: 'path')))
        .thenAnswer((_) async {});
    when(() => plugin.cancel()).thenAnswer((_) async {});
    when(() => plugin.dispose()).thenAnswer((_) async {});
  });

  test('is a VoiceRecorder', () {
    expect(SessionVoiceRecorder(recorder: plugin), isA<VoiceRecorder>());
  });

  test(
      'the auto-stop TIMER fires at the cap: it stops the plugin and hands back '
      'a cap-length clip (#680.6 / #664)', () async {
    when(() => plugin.stop()).thenAnswer((_) async => 'capped.m4a');
    final SessionVoiceRecorder recorder = SessionVoiceRecorder(
      recorder: plugin,
      // A short cap so the REAL timer fires in-test. fakeAsync can't be used
      // here: start()'s temp-dir sweep is real IO fakeAsync cannot pump.
      maxDuration: const Duration(seconds: 1),
    );
    await recorder.start(); // arms Timer(1s)

    await Future<void>.delayed(const Duration(milliseconds: 1200));
    // The TIMER — not a manual stop() — finalised the clip: the plugin was
    // stopped exactly once by the cap firing.
    verify(() => plugin.stop()).called(1);

    // The next stop() hands back that already-finalised clip; its DECLARED
    // length is the cap (the #664 divergence the auto-stop exists to bound),
    // and it does not double-stop the plugin.
    final RecordedClip? clip = await recorder.stop();
    expect(clip, isNotNull);
    expect(clip!.durationSeconds, 1);
    verifyNever(() => plugin.stop());
  });

  test(
      'retain() protects an in-flight SAME-SESSION clip from the sweep; '
      'release() lets the very next start() reclaim it (#625, #654 fix)',
      () async {
    final String temp = Directory.systemTemp.path;
    final String sep = Platform.pathSeparator;
    // A clip timestamped NOW — this is the realistic case: Q(n-1)'s answer,
    // produced by this very recorder instance moments ago, upload still in
    // flight. A construction-time cutoff would never treat this as sweepable
    // regardless of retain/release; the fix must not depend on age at all.
    final File inflight = File(
        '$temp${sep}bb-voice-session-${DateTime.now().millisecondsSinceEpoch}.m4a');
    await inflight.writeAsBytes(<int>[1]);
    addTearDown(() async {
      if (await inflight.exists()) await inflight.delete();
    });

    final SessionVoiceRecorder recorder =
        SessionVoiceRecorder(recorder: plugin);

    // Retained → survives the sweep that runs on start().
    recorder.retain(inflight.path);
    await recorder.start();
    expect(await inflight.exists(), isTrue,
        reason: 'a retained in-flight clip must not be swept');
    await recorder.cancel();

    // Released → the very NEXT start()'s sweep reclaims it, in this same
    // process — proving the fix does not wait for a future app run.
    recorder.release(inflight.path);
    await recorder.start();
    expect(await inflight.exists(), isFalse,
        reason: 'once released, a same-session clip is swept on the next '
            'start() — not just a previous run\'s leftover');
    await recorder.cancel();
  });

  test(
      'levels() maps plugin Amplitude to MicLevel; a single subscription taken '
      'once survives stop/start cycles (#625)', () async {
    final StreamController<Amplitude> amp =
        StreamController<Amplitude>.broadcast();
    when(() => plugin.onAmplitudeChanged(any())).thenAnswer((_) => amp.stream);
    when(() => plugin.stop()).thenAnswer(
        (_) async => '${Directory.systemTemp.path}/bb-voice-session-9.m4a');
    addTearDown(amp.close);

    final SessionVoiceRecorder recorder =
        SessionVoiceRecorder(recorder: plugin);

    final List<MicLevel> seen = <MicLevel>[];
    final StreamSubscription<MicLevel> sub =
        recorder.levels(const Duration(milliseconds: 50)).listen(seen.add);
    addTearDown(sub.cancel);

    amp.add(Amplitude(current: -20, max: -8));
    await pumpEventQueue();
    // stop/start cycles must NOT tear the amplitude stream down.
    await recorder.start();
    await recorder.stop();
    await recorder.start();
    await recorder.stop();
    amp.add(Amplitude(current: -35, max: -8));
    await pumpEventQueue();

    expect(seen, hasLength(2));
    expect(seen.first.dbfs, -20);
    expect(seen.first.peakDbfs, -8);
    expect(seen.last.dbfs, -35);
  });

  test('states() surfaces the plugin state stream', () async {
    final StreamController<RecordState> states =
        StreamController<RecordState>.broadcast();
    when(() => plugin.onStateChanged()).thenAnswer((_) => states.stream);
    addTearDown(states.close);

    final SessionVoiceRecorder recorder =
        SessionVoiceRecorder(recorder: plugin);
    final List<RecordState> seen = <RecordState>[];
    final StreamSubscription<RecordState> sub =
        recorder.states().listen(seen.add);
    addTearDown(sub.cancel);

    states.add(RecordState.record);
    states.add(RecordState.stop);
    await pumpEventQueue();
    expect(seen, <RecordState>[RecordState.record, RecordState.stop]);
  });

  test(
      'start() captures the 16kHz/24kbps NS+AEC session config, autoGain OFF '
      '(#633)', () async {
    final SessionVoiceRecorder recorder =
        SessionVoiceRecorder(recorder: plugin);
    await recorder.start();

    final RecordConfig cfg = verify(
      () => plugin.start(captureAny(), path: any(named: 'path')),
    ).captured.single as RecordConfig;

    expect(cfg.encoder, AudioEncoder.aacLc);
    expect(cfg.numChannels, 1);
    expect(cfg.sampleRate, 16000);
    expect(cfg.bitRate, 24000);
    expect(cfg.noiseSuppress, isTrue);
    expect(cfg.echoCancel, isTrue);
    // Load-bearing: AGC would compress the range the endpointer thresholds on.
    expect(cfg.autoGain, isFalse);
    expect(cfg.audioInterruption, AudioInterruptionMode.pauseResume);
    expect(cfg.androidConfig.audioSource, AndroidAudioSource.voiceRecognition);

    await recorder.cancel();
  });

  test(
      'the SINGLE-SHOT recorder does not inherit the session config — its own '
      'start() still passes 44.1kHz-default, NS/AEC off (#633)', () async {
    // Asserted against the REAL RecordPackageVoiceRecorder, not a hand-rolled
    // literal: a test that re-declares `RecordConfig(...)` locally and checks
    // the package's defaults would pass unchanged even if the single-shot
    // recorder were mutated to use the session settings — which is the exact
    // bleed this test exists to catch.
    final MockAudioRecorder singleShotPlugin = MockAudioRecorder();
    when(() => singleShotPlugin.start(any(), path: any(named: 'path')))
        .thenAnswer((_) async {});
    when(() => singleShotPlugin.cancel()).thenAnswer((_) async {});

    final RecordPackageVoiceRecorder singleShot =
        RecordPackageVoiceRecorder(recorder: singleShotPlugin);
    await singleShot.start();

    final RecordConfig cfg = verify(
      () => singleShotPlugin.start(captureAny(), path: any(named: 'path')),
    ).captured.single as RecordConfig;

    expect(cfg.sampleRate, 44100);
    expect(cfg.noiseSuppress, isFalse);
    expect(cfg.echoCancel, isFalse);
    expect(SessionVoiceRecorder.sessionConfig.sampleRate, 16000); // and differs

    await singleShot.cancel();
  });

  test(
      'a profiling answer that runs long is clamped to 30s on submit — the '
      '120s contract cap is never the bound (#634)', () async {
    DateTime now = DateTime(2026, 8, 7, 10, 0, 0);
    when(() => plugin.stop()).thenAnswer(
        (_) async => '${Directory.systemTemp.path}/bb-voice-session-777.m4a');

    final SessionVoiceRecorder recorder =
        SessionVoiceRecorder(recorder: plugin, clock: () => now);
    await recorder.start();
    now = now.add(const Duration(seconds: 40)); // worker rambled past the cap
    final RecordedClip? clip = await recorder.stop();

    expect(clip, isNotNull);
    expect(clip!.durationSeconds, 30,
        reason: 'submit must be ≤30s — never the 40s recorded, never 120s');
  });

  test('the 30s profiling cap sits under the untouched 120s contract cap (#634)',
      () {
    expect(SessionVoiceRecorder.profilingAnswerMaxDuration,
        const Duration(seconds: 30));
    // The API-contract mirror is preserved; #634 does not modify the 120s
    // constant in packages/types|validators.
    expect(SessionVoiceRecorder.defaultMaxDuration,
        const Duration(seconds: 120));
    expect(SessionVoiceRecorder.profilingAnswerMaxDuration.inSeconds,
        lessThan(SessionVoiceRecorder.defaultMaxDuration.inSeconds),
        reason: 'the 30s cap must always fire before the 120s guard');
  });

  test(
      'a prior run\'s leftover session clip IS swept — age plays no part, '
      'only active/retained does (#654 fix)', () async {
    final String temp = Directory.systemTemp.path;
    final String sep = Platform.pathSeparator;
    final File prior = File('$temp${sep}bb-voice-session-2.m4a'); // 1970
    await prior.writeAsBytes(<int>[1]);
    addTearDown(() async {
      if (await prior.exists()) await prior.delete();
    });

    final SessionVoiceRecorder recorder =
        SessionVoiceRecorder(recorder: plugin);
    await recorder.start(); // sweep runs
    expect(await prior.exists(), isFalse); // untouched, unretained ⇒ swept
    await recorder.cancel();
  });

  test(
      'never touches a bb-voice-*.m4a clip belonging to the OTHER recorder '
      '(RecordPackageVoiceRecorder\'s disjoint namespace) (#654 fix)',
      () async {
    final String temp = Directory.systemTemp.path;
    final String sep = Platform.pathSeparator;
    // No "session-" — this is what RecordPackageVoiceRecorder writes, and
    // what its OWN sweep matches. SessionVoiceRecorder must never delete it,
    // retained or not, or an in-flight chat voice-note upload could vanish
    // out from under a concurrently-running profiling interview.
    final File other = File('$temp${sep}bb-voice-1.m4a');
    await other.writeAsBytes(<int>[1]);
    addTearDown(() async {
      if (await other.exists()) await other.delete();
    });

    final SessionVoiceRecorder recorder =
        SessionVoiceRecorder(recorder: plugin);
    await recorder.start(); // sweep runs
    expect(await other.exists(), isTrue,
        reason: 'a clip outside this recorder\'s bb-voice-session- namespace '
            'must never be swept by it');
    await recorder.cancel();
  });
}
