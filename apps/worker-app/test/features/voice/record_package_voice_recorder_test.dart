import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:record/record.dart';

import 'package:badabhai_worker_app/features/voice/data/record_package_voice_recorder.dart';
import 'package:badabhai_worker_app/features/voice/domain/voice_models.dart';

class MockAudioRecorder extends Mock implements AudioRecorder {}

void main() {
  setUpAll(() {
    registerFallbackValue(const RecordConfig());
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

  test('hard cap default is 120s (the API duration_seconds contract)', () {
    expect(RecordPackageVoiceRecorder.defaultMaxDuration,
        const Duration(seconds: 120));
  });

  test('ensurePermission delegates to the plugin prompt', () async {
    final RecordPackageVoiceRecorder recorder =
        RecordPackageVoiceRecorder(recorder: plugin);
    expect(await recorder.ensurePermission(), isTrue);
    verify(() => plugin.hasPermission()).called(1);
  });

  test(
      'start records AAC-LC to a temp .m4a (systemTemp, timestamp-only name); '
      'stop returns the clip with duration clamped ≥ 1', () async {
    String? startedPath;
    when(() => plugin.start(any(), path: any(named: 'path')))
        .thenAnswer((Invocation inv) async {
      startedPath = inv.namedArguments[#path] as String;
    });
    when(() => plugin.stop()).thenAnswer((_) async => startedPath);

    final RecordPackageVoiceRecorder recorder =
        RecordPackageVoiceRecorder(recorder: plugin);
    await recorder.start();

    expect(startedPath, isNotNull);
    expect(startedPath, startsWith(Directory.systemTemp.path));
    expect(startedPath, endsWith('.m4a'));
    // Nothing identifying in the file name — only the bb-voice prefix + epoch.
    final String name = startedPath!.split(Platform.pathSeparator).last;
    expect(RegExp(r'^bb-voice-\d+\.m4a$').hasMatch(name), isTrue);
    final RecordConfig config = verify(
      () => plugin.start(captureAny(), path: any(named: 'path')),
    ).captured.single as RecordConfig;
    expect(config.encoder, AudioEncoder.aacLc);

    final RecordedClip? clip = await recorder.stop();
    expect(clip, isNotNull);
    expect(clip!.path, startedPath);
    // An instant stop still yields a contract-valid duration (> 0).
    expect(clip.durationSeconds, greaterThanOrEqualTo(1));
    expect(clip.durationSeconds, lessThanOrEqualTo(120));
  });

  test(
      'the cap timer auto-stops the plugin; a later stop() returns that clip '
      'WITHOUT double-stopping', () async {
    when(() => plugin.stop()).thenAnswer((_) async => '/tmp/bb-voice-1.m4a');

    final RecordPackageVoiceRecorder recorder = RecordPackageVoiceRecorder(
      recorder: plugin,
      maxDuration: const Duration(milliseconds: 50),
    );
    await recorder.start();

    // Let the auto-stop timer fire.
    await Future<void>.delayed(const Duration(milliseconds: 200));
    verify(() => plugin.stop()).called(1);

    final RecordedClip? clip = await recorder.stop();
    expect(clip, isNotNull);
    expect(clip!.durationSeconds, greaterThanOrEqualTo(1));
    // No second plugin stop for the same recording.
    verifyNever(() => plugin.stop());
  });

  test('cancel discards: plugin.cancel (stops + deletes), no clip', () async {
    final RecordPackageVoiceRecorder recorder =
        RecordPackageVoiceRecorder(recorder: plugin);
    await recorder.start();
    await recorder.cancel();

    verify(() => plugin.cancel()).called(1);
    verifyNever(() => plugin.stop());
  });

  test('cancel AFTER the cap fired deletes the finalised temp file', () async {
    final File orphan = File(
        '${Directory.systemTemp.path}${Platform.pathSeparator}bb-test-orphan-'
        '${DateTime.now().microsecondsSinceEpoch}.m4a');
    await orphan.writeAsBytes(<int>[1]);
    when(() => plugin.stop()).thenAnswer((_) async => orphan.path);

    final RecordPackageVoiceRecorder recorder = RecordPackageVoiceRecorder(
      recorder: plugin,
      maxDuration: const Duration(milliseconds: 50),
    );
    await recorder.start();
    await Future<void>.delayed(const Duration(milliseconds: 200));

    await recorder.cancel();
    expect(await orphan.exists(), isFalse);
    // The plugin was stopped by the timer, not cancelled a second time.
    verifyNever(() => plugin.cancel());
  });

  test(
      'REGRESSION (orphans): start() after the cap fired deletes the '
      'uncollected pending clip file instead of orphaning it', () async {
    // Simulate the plugin having finalised a cap-stopped clip on disk.
    final File pendingClip = File(
        '${Directory.systemTemp.path}${Platform.pathSeparator}bb-test-pending-'
        '${DateTime.now().microsecondsSinceEpoch}.m4a');
    when(() => plugin.stop()).thenAnswer((_) async {
      await pendingClip.writeAsBytes(<int>[1]);
      return pendingClip.path;
    });

    final RecordPackageVoiceRecorder recorder = RecordPackageVoiceRecorder(
      recorder: plugin,
      maxDuration: const Duration(milliseconds: 50),
    );
    await recorder.start();
    // Cap fires, finalising the clip — and NOBODY collects it (no stop, no
    // cancel: the buggy flow).
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(await pendingClip.exists(), isTrue);

    // A fresh start() must clean the orphan up, not silently drop it.
    await recorder.start();
    expect(await pendingClip.exists(), isFalse);
    verify(() => plugin.start(any(), path: any(named: 'path'))).called(2);

    await recorder.cancel();
  });

  test(
      'start() sweeps stale bb-voice-* clips from crashed flows but leaves '
      'other files alone', () async {
    final String temp = Directory.systemTemp.path;
    final String sep = Platform.pathSeparator;
    // A stale clip matching the recorder's own naming — MUST be swept.
    final File stale = File('$temp${sep}bb-voice-11111.m4a');
    await stale.writeAsBytes(<int>[1]);
    // A neighbour that does NOT match — must be untouched.
    final File other = File('$temp${sep}bb-keep-me-11111.m4a');
    await other.writeAsBytes(<int>[1]);
    addTearDown(() async {
      if (await stale.exists()) await stale.delete();
      if (await other.exists()) await other.delete();
    });

    final RecordPackageVoiceRecorder recorder =
        RecordPackageVoiceRecorder(recorder: plugin);
    await recorder.start();

    expect(await stale.exists(), isFalse);
    expect(await other.exists(), isTrue);

    await recorder.cancel();
  });

  test('dispose releases the plugin', () async {
    final RecordPackageVoiceRecorder recorder =
        RecordPackageVoiceRecorder(recorder: plugin);
    await recorder.ensurePermission(); // forces lazy construction
    await recorder.dispose();
    verify(() => plugin.dispose()).called(1);
  });
}
