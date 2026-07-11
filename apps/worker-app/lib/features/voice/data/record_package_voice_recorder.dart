import 'dart:async';
import 'dart:io';

import 'package:record/record.dart';

import '../domain/voice_models.dart';
import '../domain/voice_recorder.dart';

/// The REAL mic recorder — the `record` package capturing a temp `.m4a`
/// (AAC-LC, mono) with a HARD cap of [defaultMaxDuration] (120s): a timer
/// auto-stops the plugin at the cap even if the UI's own counter fails, so no
/// clip can exceed the API contract (`duration_seconds` ≤ 120).
///
/// Storage: clips land in [Directory.systemTemp] — the app-PRIVATE cache dir on
/// Android — so no path_provider dependency and nothing world-readable. File
/// names carry only a timestamp (no worker identity), and the uploader deletes
/// the file after a successful upload; [cancel] deletes it immediately.
///
/// Permission: the package's own `hasPermission()` triggers the OS mic prompt —
/// no permission_handler needed.
///
/// PRIVACY: the on-device path is never logged and never leaves the device;
/// only the clip BYTES are PUT to the signed upload url.
class RecordPackageVoiceRecorder implements VoiceRecorder {
  /// [recorder] is a test seam (inject a mock — the real [AudioRecorder]
  /// constructor touches the platform channel, which throws under
  /// `flutter test`). [maxDuration] is a test seam for the auto-stop timer;
  /// production always uses [defaultMaxDuration].
  RecordPackageVoiceRecorder({
    AudioRecorder? recorder,
    Duration maxDuration = defaultMaxDuration,
  })  : _injected = recorder,
        _maxDuration = maxDuration;

  /// The hard cap — mirrors the API contract's `duration_seconds` ≤ 120.
  static const Duration defaultMaxDuration = Duration(seconds: 120);

  final AudioRecorder? _injected;
  final Duration _maxDuration;

  /// LAZY: constructing [AudioRecorder] performs a platform-channel call, so
  /// it must not run at DI-wiring time (locator tests have no platform).
  AudioRecorder? _recorder;
  AudioRecorder get _rec => _recorder ??= _injected ?? AudioRecorder();

  /// Recorder temp-clip file names: `bb-voice-<epochMs>.m4a` — timestamp only,
  /// nothing identifying. Also what the stale-clip sweep matches.
  static final RegExp _clipFileName = RegExp(r'^bb-voice-\d+\.m4a$');

  DateTime? _startedAt;
  Timer? _autoStopTimer;

  /// Path of the recording currently being captured — excluded from the
  /// stale-clip sweep so hygiene can never eat a live take.
  String? _activePath;

  /// Set when the hard-cap timer fired first: the already-finalised clip the
  /// next [stop] call hands back (instead of double-stopping the plugin).
  Future<RecordedClip?>? _autoStopped;

  @override
  Future<bool> ensurePermission() => _rec.hasPermission();

  @override
  Future<void> start() async {
    // A cap-finalised clip nobody collected (start-after-cap with no
    // stop/cancel in between) would be orphaned by the reset below — delete
    // its file first (best-effort).
    final Future<RecordedClip?>? pending = _autoStopped;
    _autoStopped = null;
    if (pending != null) {
      await _deleteClipFileOf(pending);
    }
    // Hygiene: crashed/killed flows can leave stale clips behind. Swept
    // BEFORE the plugin starts (no live file yet), so nothing active is hit.
    await _sweepStaleClips();

    final String path =
        '${Directory.systemTemp.path}${Platform.pathSeparator}'
        'bb-voice-${DateTime.now().millisecondsSinceEpoch}.m4a';
    await _rec.start(
      // AAC-LC in an .m4a container (Content-Type audio/mp4 on upload). Mono —
      // speech-only, half the bytes for low-bandwidth workers.
      const RecordConfig(encoder: AudioEncoder.aacLc, numChannels: 1),
      path: path,
    );
    _activePath = path;
    _startedAt = DateTime.now();
    _autoStopTimer = Timer(_maxDuration, () {
      _autoStopped = _finishStop(cappedAtMax: true);
    });
  }

  /// Best-effort delete of the file a finalised [pending] clip points at.
  /// Silent by design: cleanup never fails a flow, and the path is never
  /// logged (PII hygiene).
  static Future<void> _deleteClipFileOf(Future<RecordedClip?> pending) async {
    try {
      final RecordedClip? clip = await pending;
      if (clip != null) {
        await File(clip.path).delete();
      }
    } catch (_) {
      // Best-effort cleanup only.
    }
  }

  /// Best-effort sweep of stale `bb-voice-*.m4a` clips (crashed/killed flows)
  /// from the app-private temp dir. Skips the live recording; silent on any
  /// error — hygiene must never block or fail a new recording.
  Future<void> _sweepStaleClips() async {
    try {
      await for (final FileSystemEntity entry
          in Directory.systemTemp.list(followLinks: false)) {
        if (entry is! File) continue;
        final String name = entry.uri.pathSegments.last;
        if (!_clipFileName.hasMatch(name)) continue;
        if (entry.path == _activePath) continue; // never the live take
        try {
          await entry.delete();
        } catch (_) {
          // Best-effort per file.
        }
      }
    } catch (_) {
      // Listing failed — skip the sweep entirely.
    }
  }

  @override
  Future<RecordedClip?> stop() async {
    _autoStopTimer?.cancel();
    _autoStopTimer = null;
    final Future<RecordedClip?>? pending = _autoStopped;
    if (pending != null) {
      _autoStopped = null;
      return pending;
    }
    return _finishStop(cappedAtMax: false);
  }

  Future<RecordedClip?> _finishStop({required bool cappedAtMax}) async {
    final DateTime? startedAt = _startedAt;
    _startedAt = null;
    final String? path = await _rec.stop();
    if (path == null || startedAt == null) return null;
    final int maxSeconds = _maxDuration.inSeconds;
    int seconds = cappedAtMax
        ? maxSeconds
        : DateTime.now().difference(startedAt).inSeconds;
    // Clamp to the API contract: > 0 and ≤ the hard cap.
    if (seconds < 1) seconds = 1;
    if (seconds > maxSeconds && maxSeconds >= 1) seconds = maxSeconds;
    return RecordedClip(path: path, durationSeconds: seconds);
  }

  @override
  Future<void> cancel() async {
    _autoStopTimer?.cancel();
    _autoStopTimer = null;
    _startedAt = null;
    final Future<RecordedClip?>? pending = _autoStopped;
    _autoStopped = null;
    if (pending != null) {
      // The cap timer already finalised the file — delete it (best-effort;
      // never surface an error for a discard).
      final RecordedClip? clip = await pending;
      if (clip != null) {
        try {
          await File(clip.path).delete();
        } catch (_) {
          // Best-effort cleanup only.
        }
      }
      return;
    }
    // The package's cancel() stops AND deletes the in-progress file.
    await _rec.cancel();
  }

  @override
  Future<void> dispose() async {
    _autoStopTimer?.cancel();
    _autoStopTimer = null;
    // Only touch the plugin if it was ever created.
    await _recorder?.dispose();
    _recorder = null;
  }
}
