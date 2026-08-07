import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:record/record.dart';

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
      'retain() protects an in-flight clip from the sweep even though it is '
      'old; release() lets the next sweep reclaim it (#625)', () async {
    final String temp = Directory.systemTemp.path;
    final String sep = Platform.pathSeparator;
    // An OLD clip (timestamp 1 ⇒ 1970) that the sweep would normally delete —
    // it stands in for Q(n-1)'s clip whose upload is still in flight.
    final File inflight = File('$temp${sep}bb-voice-1.m4a');
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

    // Released → the next start()'s sweep reclaims it.
    recorder.release(inflight.path);
    await recorder.start();
    expect(await inflight.exists(), isFalse,
        reason: 'once released, the stale clip is swept again');
    await recorder.cancel();
  });

  test(
      'levels() maps plugin Amplitude to MicLevel; a single subscription taken '
      'once survives stop/start cycles (#625)', () async {
    final StreamController<Amplitude> amp =
        StreamController<Amplitude>.broadcast();
    when(() => plugin.onAmplitudeChanged(any())).thenAnswer((_) => amp.stream);
    when(() => plugin.stop())
        .thenAnswer((_) async => '${Directory.systemTemp.path}/bb-voice-9.m4a');
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

  test('this session\'s clips are never swept (cutoff), unlike a prior run\'s',
      () async {
    final String temp = Directory.systemTemp.path;
    final String sep = Platform.pathSeparator;
    final File prior = File('$temp${sep}bb-voice-2.m4a'); // 1970 — prior run
    await prior.writeAsBytes(<int>[1]);
    addTearDown(() async {
      if (await prior.exists()) await prior.delete();
    });

    final SessionVoiceRecorder recorder =
        SessionVoiceRecorder(recorder: plugin);
    await recorder.start(); // sweep runs
    expect(await prior.exists(), isFalse); // a previous run's clip IS swept
    await recorder.cancel();
  });
}
