import 'dart:io';
import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:record/record.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:badabhai_worker_app/features/voice/data/session_voice_recorder.dart';
import 'package:badabhai_worker_app/features/voice_form/data/voice_clip_queue.dart';

class MockAudioRecorder extends Mock implements AudioRecorder {}

/// Keys/values that would leak an identifier or PII into the persisted manifest
/// (#637 — the same net as analytics_pii_test, applied to SharedPreferences).
final RegExp _piiKey = RegExp(
  r'(^|_)(worker|payer|user|phone|mobile|name|email|transcript|message|text|otp|token)($|_)',
  caseSensitive: false,
);
final RegExp _piiValue = RegExp(
  r'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
  r'|\+?\d[\d\s\-]{8,}'
  r'|[^@\s]+@[^@\s]+\.[^@\s]+)',
  caseSensitive: false,
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late List<String> deleted;
  late DateTime now;
  late VoiceClipQueue queue;

  VoiceClipQueueItem item(String path,
          {String key = 'occupation', int size = 1000, int? queuedAt}) =>
      VoiceClipQueueItem(
        clipPath: path,
        questionKey: key,
        sizeBytes: size,
        firstQueuedAtMs: queuedAt ?? now.millisecondsSinceEpoch,
      );

  setUp(() {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    deleted = <String>[];
    now = DateTime(2026, 8, 8, 12, 0, 0);
    queue = VoiceClipQueue(
      deleteClip: (String p) async => deleted.add(p),
      clock: () => now,
    );
  });

  test('FIFO — head is the oldest; markUploaded removes it', () async {
    await queue.enqueue(item('a.m4a'));
    await queue.enqueue(item('b.m4a'));
    await queue.enqueue(item('c.m4a'));

    expect((await queue.head())!.clipPath, 'a.m4a');
    await queue.markUploaded('a.m4a');
    expect((await queue.head())!.clipPath, 'b.m4a');
    expect((await queue.all()).length, 2);
  });

  test('persists across a fresh queue instance (survives an app kill)',
      () async {
    await queue.enqueue(item('a.m4a', key: 'shift'));
    await queue.saveCursor(const VoiceFormCursor(questionIndex: 4, total: 8));

    // A brand-new instance reads the same SharedPreferences store.
    final VoiceClipQueue reloaded = VoiceClipQueue(clock: () => now);
    expect((await reloaded.all()).single.questionKey, 'shift');
    final VoiceFormCursor? cursor = await reloaded.loadCursor();
    expect(cursor!.questionIndex, 4);
    expect(cursor.total, 8);
  });

  test('a dead clip after 6 failures is dropped and its file deleted', () async {
    await queue.enqueue(item('a.m4a'));
    VoiceClipOutcome outcome = VoiceClipOutcome.retry;
    for (int i = 0; i < 6; i++) {
      outcome = await queue.markFailed('a.m4a');
    }
    expect(outcome, VoiceClipOutcome.dead);
    expect(await queue.all(), isEmpty);
    expect(deleted, contains('a.m4a'));
  });

  test('a clip older than 24h is dead on the next failure', () async {
    final int oldMs =
        now.subtract(const Duration(hours: 25)).millisecondsSinceEpoch;
    await queue.enqueue(item('old.m4a', queuedAt: oldMs));
    expect(await queue.markFailed('old.m4a'), VoiceClipOutcome.dead);
    expect(deleted, contains('old.m4a'));
  });

  test('caps at 12 clips — the oldest is evicted and its file deleted',
      () async {
    for (int i = 0; i < 13; i++) {
      await queue.enqueue(item('clip$i.m4a', size: 1000));
    }
    final List<VoiceClipQueueItem> items = await queue.all();
    expect(items.length, 12);
    expect(items.first.clipPath, 'clip1.m4a'); // clip0 evicted
    expect(deleted, contains('clip0.m4a'));
  });

  test('caps at 20 MB — oversized backlog sheds the oldest', () async {
    // Two 12 MB clips exceed 20 MB together → the first is dropped.
    await queue.enqueue(item('big1.m4a', size: 12 * 1024 * 1024));
    await queue.enqueue(item('big2.m4a', size: 12 * 1024 * 1024));
    final List<VoiceClipQueueItem> items = await queue.all();
    expect(items.single.clipPath, 'big2.m4a');
    expect(deleted, contains('big1.m4a'));
  });

  test('backoff ladder: 5s → 15s → 45s → 2m → 5m, then flat', () {
    expect(voiceQueueBackoff(0), const Duration(seconds: 5));
    expect(voiceQueueBackoff(1), const Duration(seconds: 15));
    expect(voiceQueueBackoff(2), const Duration(seconds: 45));
    expect(voiceQueueBackoff(3), const Duration(minutes: 2));
    expect(voiceQueueBackoff(4), const Duration(minutes: 5));
    expect(voiceQueueBackoff(9), const Duration(minutes: 5)); // clamps
  });

  test('backoff jitter stays within ±25%', () {
    final math.Random rnd = math.Random(1);
    for (int seed = 0; seed < 50; seed++) {
      final Duration d = voiceQueueBackoff(1, random: rnd); // base 15s
      expect(d.inMilliseconds, greaterThanOrEqualTo((15000 * 0.75).round()));
      expect(d.inMilliseconds, lessThanOrEqualTo((15000 * 1.25).round()));
    }
  });

  group('the persisted manifest carries NO transcript or identifier (#637)', () {
    test('the serialized queue + cursor pass the PII scan', () async {
      await queue.enqueue(item('/tmp/bb-voice-123.m4a', key: 'occupation'));
      await queue.saveCursor(const VoiceFormCursor(questionIndex: 3, total: 8));

      final SharedPreferences p = await SharedPreferences.getInstance();
      final String manifest = p.getString(VoiceClipQueue.kQueueKey) ?? '';
      final String cursor = p.getString(VoiceClipQueue.kCursorKey) ?? '';

      for (final String blob in <String>[manifest, cursor]) {
        // Scan only STRING values (quoted) — a bare number is a count, never
        // PII, and a 13-digit epoch-ms timestamp must not read as a phone.
        for (final Match m in RegExp(r':\s*"([^"]*)"').allMatches(blob)) {
          expect(_piiValue.hasMatch(m.group(1)!), isFalse,
              reason: 'a persisted value looks like PII: ${m.group(1)}');
        }
        // Scan every JSON key.
        for (final Match m in RegExp(r'"([a-z_]+)"\s*:').allMatches(blob)) {
          final String key = m.group(1)!;
          expect(_piiKey.hasMatch(key), isFalse,
              reason: 'key "$key" names an identifier or PII');
        }
      }
    });

    test('the detector itself bites — a transcript field would be caught', () {
      // A net that cannot fail is not a net (mirrors analytics_pii's meta-test).
      const String leaked =
          '[{"transcript":"main welder hoon","phone":"+919812345678"}]';
      expect(_piiKey.hasMatch('transcript'), isTrue);
      expect(_piiKey.hasMatch('phone'), isTrue);
      expect(_piiValue.hasMatch(leaked), isTrue); // the phone-number shape
      // …and the legitimate keys pass.
      expect(_piiKey.hasMatch('clip_path'), isFalse);
      expect(_piiKey.hasMatch('question_key'), isFalse);
      expect(_piiKey.hasMatch('question_index'), isFalse);
    });
  });

  group('#692 blockers', () {
    test('clearAll() deletes every clip file AND removes both keys (H1)',
        () async {
      await queue.enqueue(item('a.m4a'));
      await queue.enqueue(item('b.m4a'));
      await queue.saveCursor(const VoiceFormCursor(questionIndex: 3, total: 8));

      await queue.clearAll();

      expect(await queue.all(), isEmpty);
      expect(await queue.loadCursor(), isNull);
      expect(deleted, containsAll(<String>['a.m4a', 'b.m4a']));
      final SharedPreferences p = await SharedPreferences.getInstance();
      expect(p.getString(VoiceClipQueue.kQueueKey), isNull);
      expect(p.getString(VoiceClipQueue.kCursorKey), isNull);
    });

    test('markUploaded deletes the clip file, not just the manifest entry (H2)',
        () async {
      await queue.enqueue(item('a.m4a'));
      await queue.markUploaded('a.m4a');

      expect(await queue.all(), isEmpty);
      expect(deleted, contains('a.m4a'),
          reason: 'success must reclaim the PII file too');
    });

    test(
        'an enqueued clip is MOVED out of the recorder namespace and survives a '
        'fresh recorder sweep (H3)', () async {
      final String temp = Directory.systemTemp.path;
      final String sep = Platform.pathSeparator;
      // A real clip in the recorder's OWN namespace (temp root).
      // DIGIT-SUFFIXED ON PURPOSE. The recorder sweep matches
      // ^bb-voice-session-\d+\.m4a$ — a name like 'h3test' matches neither
      // that nor its predecessor, so the fixture was immune BY NAME and the
      // assertion below passed with the relocation removed. It has to be a name
      // the sweep would really delete for this test to prove anything.
      final File src = File('$temp${sep}bb-voice-session-1754640000000.m4a');
      await src.writeAsBytes(<int>[1]);
      addTearDown(() async {
        if (await src.exists()) await src.delete();
      });

      // Default move (rename) — no deleteClip spy so the real file is moved.
      final VoiceClipQueue realQueue = VoiceClipQueue(clock: () => now);
      await realQueue.enqueue(item(src.path));
      final String stored = (await realQueue.all()).single.clipPath;
      addTearDown(() async {
        final File f = File(stored);
        if (await f.exists()) await f.delete();
      });

      expect(stored.contains(VoiceClipQueue.queueSubdir), isTrue,
          reason: 'the clip is relocated into the queue-owned directory');
      expect(await File(stored).exists(), isTrue);
      expect(await src.exists(), isFalse, reason: 'moved, not copied');

      // A fresh recorder instance sweeps on start() — it must NOT touch the
      // queue subdir (that is exactly the resume-after-kill data-loss bug).
      registerFallbackValue(const RecordConfig());
      final MockAudioRecorder plugin = MockAudioRecorder();
      when(() => plugin.start(any(), path: any(named: 'path')))
          .thenAnswer((_) async {});
      when(() => plugin.cancel()).thenAnswer((_) async {});
      final SessionVoiceRecorder recorder =
          SessionVoiceRecorder(recorder: plugin);
      await recorder.start(); // runs the stale-clip sweep
      await recorder.cancel();

      expect(await File(stored).exists(), isTrue,
          reason: 'the offline backlog must survive the resume recalibration');
    });
  });
}
