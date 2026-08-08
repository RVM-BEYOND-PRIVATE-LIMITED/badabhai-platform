import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:shared_preferences/shared_preferences.dart';

/// One queued clip awaiting upload (#637).
///
/// PRIVACY: this is what lands in `SharedPreferences`, so it carries **file
/// paths and question keys only** — never a transcript, a worker id, or a phone.
/// The fields are a local file path, an engine question KEY (a slug, not worker
/// data), and counts. `voice_clip_queue_test.dart` scans the serialized form to
/// keep it that way.
class VoiceClipQueueItem {
  const VoiceClipQueueItem({
    required this.clipPath,
    required this.questionKey,
    required this.sizeBytes,
    required this.firstQueuedAtMs,
    this.attempts = 0,
  });

  final String clipPath;
  final String questionKey;
  final int sizeBytes;
  final int firstQueuedAtMs;
  final int attempts;

  VoiceClipQueueItem copyWith({int? attempts}) => VoiceClipQueueItem(
        clipPath: clipPath,
        questionKey: questionKey,
        sizeBytes: sizeBytes,
        firstQueuedAtMs: firstQueuedAtMs,
        attempts: attempts ?? this.attempts,
      );

  Map<String, Object> toJson() => <String, Object>{
        'clip_path': clipPath,
        'question_key': questionKey,
        'size_bytes': sizeBytes,
        'first_queued_at_ms': firstQueuedAtMs,
        'attempts': attempts,
      };

  static VoiceClipQueueItem fromJson(Map<String, dynamic> json) =>
      VoiceClipQueueItem(
        clipPath: json['clip_path'] as String,
        questionKey: json['question_key'] as String,
        sizeBytes: json['size_bytes'] as int,
        firstQueuedAtMs: json['first_queued_at_ms'] as int,
        attempts: json['attempts'] as int? ?? 0,
      );
}

/// Where the worker was when the app died (#637) — COUNTS only, no ids. Enough
/// to offer "resume from question 4 of 8"; the engine session itself resumes
/// server-side off the worker's auth, so the client stores no session id.
class VoiceFormCursor {
  const VoiceFormCursor({required this.questionIndex, required this.total});

  final int questionIndex;
  final int total;

  Map<String, Object> toJson() =>
      <String, Object>{'question_index': questionIndex, 'total': total};

  static VoiceFormCursor fromJson(Map<String, dynamic> json) => VoiceFormCursor(
        questionIndex: json['question_index'] as int,
        total: json['total'] as int,
      );
}

/// Outcome of a failed upload attempt.
enum VoiceClipOutcome { retry, dead }

/// The FIFO backoff ladder (#637): 5s → 15s → 45s → 2m → 5m, then flat.
const List<Duration> kVoiceQueueBackoffLadder = <Duration>[
  Duration(seconds: 5),
  Duration(seconds: 15),
  Duration(seconds: 45),
  Duration(minutes: 2),
  Duration(minutes: 5),
];

/// Backoff for retry [attempt] (0-based), jittered ±25% when [random] is given.
Duration voiceQueueBackoff(int attempt, {math.Random? random}) {
  final Duration base =
      kVoiceQueueBackoffLadder[attempt.clamp(0, kVoiceQueueBackoffLadder.length - 1)];
  if (random == null) return base;
  final double factor = 0.75 + random.nextDouble() * 0.5; // [0.75, 1.25)
  return Duration(milliseconds: (base.inMilliseconds * factor).round());
}

/// A **single-worker FIFO** upload queue for voice-form answer clips (#637).
/// Never parallel — on 2G, concurrent PUTs make every one of them slower — so
/// callers upload the [head] one at a time.
///
/// Persistence is a JSON array under `bb_voice_form_queue` plus a session cursor
/// under `bb_voice_form_cursor`, so walking out of coverage mid-session does not
/// end the session and an app kill can offer resume.
class VoiceClipQueue {
  VoiceClipQueue({
    Future<SharedPreferences> Function()? prefs,
    Future<void> Function(String path)? deleteClip,
    Future<void> Function(String from, String to)? moveClip,
    Directory? queueParent,
    DateTime Function()? clock,
  })  : _prefs = prefs ?? SharedPreferences.getInstance,
        _deleteClip = deleteClip ?? _deleteFile,
        _moveClip = moveClip ?? _renameFile,
        _queueParent = queueParent ?? Directory.systemTemp,
        _clock = clock ?? DateTime.now;

  final Future<SharedPreferences> Function() _prefs;
  final Future<void> Function(String path) _deleteClip;
  final Future<void> Function(String from, String to) _moveClip;
  final Directory _queueParent;
  final DateTime Function() _clock;

  static const String kQueueKey = 'bb_voice_form_queue';
  static const String kCursorKey = 'bb_voice_form_cursor';

  /// Queue-OWNED clip directory (#692 H3). On enqueue, a clip is MOVED here out of
  /// the recorder's swept namespace, so a fresh [SessionVoiceRecorder]'s
  /// stale-clip sweep on the next `start()` — which runs BEFORE the worker
  /// answers, via the resume recalibration — can never delete the offline
  /// backlog it exists to preserve. Removes the recorder↔queue coupling entirely.
  static const String queueSubdir = 'bb-voice-queue';

  String get _queueDirPath =>
      '${_queueParent.path}${Platform.pathSeparator}$queueSubdir';

  /// Cap: at most 12 clips / 20 MB retained; the oldest are dropped past that.
  static const int kMaxClips = 12;
  static const int kMaxBytes = 20 * 1024 * 1024;

  /// A clip is DEAD after 6 failed attempts or 24h in the queue — then dropped
  /// and its file deleted.
  static const int kMaxAttempts = 6;
  static const Duration kDeadAfter = Duration(hours: 24);

  int get _nowMs => _clock().millisecondsSinceEpoch;

  Future<List<VoiceClipQueueItem>> all() async {
    final SharedPreferences p = await _prefs();
    final String? raw = p.getString(kQueueKey);
    if (raw == null || raw.isEmpty) return <VoiceClipQueueItem>[];
    final List<dynamic> list = jsonDecode(raw) as List<dynamic>;
    return list
        .map((dynamic e) =>
            VoiceClipQueueItem.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  /// The next clip to upload (FIFO head), or null when the queue is empty.
  Future<VoiceClipQueueItem?> head() async {
    final List<VoiceClipQueueItem> items = await all();
    return items.isEmpty ? null : items.first;
  }

  /// Append [item] (FIFO) and enforce the 12-clip / 20-MB caps by dropping the
  /// OLDEST clips (and deleting their files) until within budget.
  ///
  /// The clip is first MOVED into the queue-owned directory (#692 H3) so the
  /// recorder's sweep can never reclaim it; the stored path points at the new
  /// location.
  Future<void> enqueue(VoiceClipQueueItem item) async {
    final String owned = await _relocateIntoQueueDir(item.clipPath);
    final VoiceClipQueueItem stored = VoiceClipQueueItem(
      clipPath: owned,
      questionKey: item.questionKey,
      sizeBytes: item.sizeBytes,
      firstQueuedAtMs: item.firstQueuedAtMs,
      attempts: item.attempts,
    );
    final List<VoiceClipQueueItem> items = await all()..add(stored);
    int total =
        items.fold<int>(0, (int s, VoiceClipQueueItem i) => s + i.sizeBytes);
    while (items.length > kMaxClips ||
        (total > kMaxBytes && items.length > 1)) {
      final VoiceClipQueueItem dropped = items.removeAt(0);
      total -= dropped.sizeBytes;
      await _deleteClip(dropped.clipPath);
    }
    await _persist(items);
  }

  /// Remove a successfully-uploaded clip from the queue AND delete its file
  /// (#692 H2). Success used to only drop the manifest entry, orphaning the
  /// `.m4a` on disk with nothing tracking it — and the recorder's namespaced
  /// sweep never sees a queue-owned file, so uploaded PII audio survived forever.
  Future<void> markUploaded(String clipPath) async {
    final List<VoiceClipQueueItem> items = await all()
      ..removeWhere((VoiceClipQueueItem i) => i.clipPath == clipPath);
    // DELETE FIRST, PERSIST SECOND. The queue directory is deliberately outside
    // the recorder's swept namespace (H3), so NOTHING else reaps it: the sweep
    // cannot see it and clearAll() is manifest-driven. A death between these two
    // lines in the other order leaves a file no reaper will ever visit —
    // permanently unreclaimable worker audio. This order can only ever leave a
    // manifest entry whose file is already gone, which the drain loop treats as
    // a failed attempt and retires.
    await _deleteClip(clipPath);
    await _persist(items);
  }

  /// Record a failed attempt. Increments the retry count; if the clip has hit
  /// [kMaxAttempts] or aged past [kDeadAfter] it is DEAD — dropped and its file
  /// deleted. Returns whether the caller should retry (with [voiceQueueBackoff])
  /// or give up.
  Future<VoiceClipOutcome> markFailed(String clipPath) async {
    final List<VoiceClipQueueItem> items = await all();
    final int idx =
        items.indexWhere((VoiceClipQueueItem i) => i.clipPath == clipPath);
    if (idx < 0) return VoiceClipOutcome.retry;
    final VoiceClipQueueItem item = items[idx];
    final int attempts = item.attempts + 1;
    final bool aged = _nowMs - item.firstQueuedAtMs >= kDeadAfter.inMilliseconds;
    if (attempts >= kMaxAttempts || aged) {
      items.removeAt(idx);
      await _deleteClip(clipPath); // before the manifest, for the reason above
      await _persist(items);
      return VoiceClipOutcome.dead;
    }
    items[idx] = item.copyWith(attempts: attempts);
    await _persist(items);
    return VoiceClipOutcome.retry;
  }

  Future<void> saveCursor(VoiceFormCursor cursor) async {
    final SharedPreferences p = await _prefs();
    await p.setString(kCursorKey, jsonEncode(cursor.toJson()));
  }

  Future<VoiceFormCursor?> loadCursor() async {
    final SharedPreferences p = await _prefs();
    final String? raw = p.getString(kCursorKey);
    if (raw == null || raw.isEmpty) return null;
    return VoiceFormCursor.fromJson(jsonDecode(raw) as Map<String, dynamic>);
  }

  Future<void> clearCursor() async {
    final SharedPreferences p = await _prefs();
    await p.remove(kCursorKey);
  }

  /// Purge EVERYTHING (#692 H1): every queued clip file plus both durable prefs
  /// keys. Registered in `_clearSessionScopedCaches()` and called on logout /
  /// worker switch, because these keys and the on-disk audio outlive the session
  /// and are NOT worker-bound — on a shared handset the drain loop would
  /// otherwise PUT worker A's audio under worker B's authenticated session and
  /// attribute it to B's profile, and B's resume would show A's "question 4 of 8".
  Future<void> clearAll() async {
    // THE KEYS GO FIRST, and that ordering is the whole guarantee.
    //
    // The manifest is what the drain loop reads, so it must be invalidated
    // BEFORE the slow work, not after. Deleting N files first and removing the
    // key last leaves a window — this runs unawaited during the logout screen
    // transition — in which the process can die (the worker swipes the app away,
    // Android kills it, _prefs() throws) with the manifest still listing worker
    // A's remaining clips. B logs in on the same handset and the drain loop
    // uploads them under B's session. Removing the keys first makes the worst
    // case an orphaned FILE rather than an attributed UPLOAD.
    final SharedPreferences p = await _prefs();
    await p.remove(kQueueKey);
    await p.remove(kCursorKey);

    // Directory-driven, not manifest-driven: a clip that was relocated but whose
    // manifest write never landed has no entry to enumerate, and nothing else
    // reaps this directory.
    try {
      final Directory dir = Directory(_queueDirPath);
      if (await dir.exists()) await dir.delete(recursive: true);
    } catch (_) {
      // Best-effort: a purge must never fail a logout.
    }
  }

  /// Move [fromPath] into the queue-owned directory; returns the new path. On any
  /// failure (a cross-device link, a missing source) it falls back to the
  /// original path — a clip that stays queued in the swept namespace is worse
  /// than a lost answer, but never a crash.
  Future<String> _relocateIntoQueueDir(String fromPath) async {
    try {
      final String fileName = fromPath.split(Platform.pathSeparator).last;
      await Directory(_queueDirPath).create(recursive: true);
      final String to =
          '$_queueDirPath${Platform.pathSeparator}$fileName';
      if (to == fromPath) return fromPath; // already owned
      await _moveClip(fromPath, to);
      return to;
    } catch (_) {
      return fromPath;
    }
  }

  Future<void> _persist(List<VoiceClipQueueItem> items) async {
    final SharedPreferences p = await _prefs();
    await p.setString(
      kQueueKey,
      jsonEncode(
          items.map((VoiceClipQueueItem i) => i.toJson()).toList()),
    );
  }

  static Future<void> _deleteFile(String path) async {
    try {
      await File(path).delete();
    } catch (_) {
      // Best-effort — an already-gone clip is fine.
    }
  }

  static Future<void> _renameFile(String from, String to) async {
    await File(from).rename(to);
  }
}
