import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:record/record.dart';

import 'package:badabhai_worker_app/features/voice/data/session_voice_recorder.dart';
import 'package:badabhai_worker_app/features/voice_form/data/tts_asset_resolver.dart';

class MockAudioRecorder extends Mock implements AudioRecorder {}

void main() {
  setUpAll(() => registerFallbackValue(const RecordConfig()));

  group('resolver chain', () {
    test('a bundled asset wins first', () async {
      final TtsAssetResolver resolver =
          TtsAssetResolver(assetExists: (_) async => true);
      final TtsSource source = await resolver.resolve('q1');
      expect(source, isA<TtsBundledAsset>());
      expect((source as TtsBundledAsset).assetPath, 'assets/bb-tts/q1.mp3');
    });

    test('falls back to a cached file when no bundled asset exists', () async {
      final Directory tmp =
          await Directory.systemTemp.createTemp('bb-tts-test');
      addTearDown(() => tmp.delete(recursive: true));
      final File cached = File('${tmp.path}/bb-tts/q2.mp3');
      await cached.create(recursive: true);

      final TtsAssetResolver resolver = TtsAssetResolver(
        assetExists: (_) async => false,
        cacheParent: tmp,
      );
      final TtsSource source = await resolver.resolve('q2');
      expect(source, isA<TtsCachedFile>());
      expect((source as TtsCachedFile).filePath, cached.path);
    });

    test('degrades to TtsNone (never Android TTS) when nothing resolves',
        () async {
      final Directory tmp =
          await Directory.systemTemp.createTemp('bb-tts-test');
      addTearDown(() => tmp.delete(recursive: true));
      final TtsAssetResolver resolver = TtsAssetResolver(
        assetExists: (_) async => false,
        cacheParent: tmp,
      );
      expect(await resolver.resolve('missing'), isA<TtsNone>());
    });

    test('a null / empty key is TtsNone', () async {
      final TtsAssetResolver resolver =
          TtsAssetResolver(assetExists: (_) async => true);
      expect(await resolver.resolve(null), isA<TtsNone>());
      expect(await resolver.resolve(''), isA<TtsNone>());
    });
  });

  test(
      'a cached TTS clip in bb-tts/ survives the recorder stale-clip sweep '
      '(#631 lives beside #624, not under it)', () async {
    // A TTS asset cached in the temp-root subdir bb-tts/.
    final File tts = File(
        '${Directory.systemTemp.path}${Platform.pathSeparator}bb-tts'
        '${Platform.pathSeparator}keep-me.mp3');
    await tts.create(recursive: true);
    addTearDown(() async {
      if (await tts.exists()) await tts.delete();
    });

    // A stale voice clip in the temp ROOT that the sweep SHOULD reclaim.
    final File stale = File(
        '${Directory.systemTemp.path}${Platform.pathSeparator}bb-voice-3.m4a');
    await stale.writeAsBytes(<int>[1]);
    addTearDown(() async {
      if (await stale.exists()) await stale.delete();
    });

    final MockAudioRecorder plugin = MockAudioRecorder();
    when(() => plugin.start(any(), path: any(named: 'path')))
        .thenAnswer((_) async {});
    when(() => plugin.cancel()).thenAnswer((_) async {});
    final SessionVoiceRecorder recorder =
        SessionVoiceRecorder(recorder: plugin);

    await recorder.start(); // runs the sweep
    await recorder.cancel();

    expect(await tts.exists(), isTrue,
        reason: 'the sweep is non-recursive and skips directories');
    expect(await stale.exists(), isFalse,
        reason: 'a stale bb-voice-*.m4a in the temp root is still reclaimed');
  });
}
