import 'dart:async';
import 'dart:io';

import 'package:record/record.dart';

import '../domain/voice_models.dart';
import '../domain/voice_recorder.dart';

/// The mic recorder for the VOICE-FORM session (#625) — deliberately SEPARATE
/// from the single-shot [RecordPackageVoiceRecorder]. That one is a shared
/// LazySingleton with mutable per-take fields (`_startedAt`, `_autoStopTimer`,
/// `_activePath`); bolting a "session mode" onto it would leak state between the
/// two flows, so "the single-shot flow is unchanged" would be false by
/// construction. Hence a new type, registered under its own binding.
///
/// It implements [VoiceRecorder] (so it drops into the same seams) and adds the
/// session-only concerns:
///
///  - **retained-clip set** — [retain]/[release] protect an in-flight upload
///    from the stale-clip sweep. Each answer is its own clip and its upload can
///    take up to 30s on 2G; without this, starting Q(n) would delete Q(n-1)'s
///    clip out from under a live read stream.
///  - **[levels]** — a `Stream<MicLevel>` (amplitude) the silence endpointer
///    (#626) consumes to decide auto-advance.
///  - **[states]** — the plugin's record-state stream, surfaced WITH errors so a
///    Bluetooth SCO drop is observable rather than a silent stop.
///  - per-clip **recorded-time** accounting (each answer is its own clip, timed
///    from its own start — never a session-wide wall clock).
///
/// Same stale-clip discipline as #624: the sweep only reclaims clips older than
/// this instance (a previous crashed run), never this session's — and never a
/// [retain]ed one.
class SessionVoiceRecorder implements VoiceRecorder {
  /// [recorder] is a test seam (the real [AudioRecorder] touches the platform
  /// channel, which throws under `flutter test`). [maxDuration] is the hard cap
  /// seam; production uses [defaultMaxDuration].
  SessionVoiceRecorder({
    AudioRecorder? recorder,
    Duration maxDuration = profilingAnswerMaxDuration,
    DateTime Function()? clock,
  })  : _injected = recorder,
        _maxDuration = maxDuration,
        _clock = clock ?? DateTime.now;

  /// The API contract's absolute ceiling (`duration_seconds` ≤ 120), mirrored
  /// from the 120s constant in packages/types|validators — which #634 does NOT
  /// modify. Kept only as documentation of the backstop; the 30s profiling cap
  /// below always fires first, so this is never the bound on a profiling answer.
  static const Duration defaultMaxDuration = Duration(seconds: 120);

  /// Hard cap on a profiling ANSWER (#634) and this recorder's DEFAULT cap. At
  /// ≤30s Sarvam takes a single sync call (ai-service `stt.py`,
  /// `SARVAM_SYNC_MAX_SECONDS = 30`) and never enters the chunked path — which
  /// removes, in one move, the chunked-wave latency ceiling, the 5-chunk cost
  /// reservation, AND the Devanagari-danda chunk-seam privacy gap entirely,
  /// because no seams exist. The auto-stop timer arms at this value and the
  /// submitted `durationSeconds` is clamped to it, so a ≤30s clip is what
  /// reaches the server, always. The 120s guard sits behind it and never fires.
  static const Duration profilingAnswerMaxDuration = Duration(seconds: 30);

  final AudioRecorder? _injected;
  final Duration _maxDuration;

  /// Time source for per-answer duration accounting — a test seam so the 30s
  /// clamp is assertable without wall-clock waits. Clip file names and the
  /// stale-sweep cutoff deliberately stay on real time (uniqueness + hygiene).
  final DateTime Function() _clock;

  /// LAZY: constructing [AudioRecorder] performs a platform-channel call, so it
  /// must not run at DI-wiring time.
  AudioRecorder? _recorder;
  AudioRecorder get _rec => _recorder ??= _injected ?? AudioRecorder();

  /// The session-only capture config (#633). Deliberately distinct from the
  /// single-shot [RecordPackageVoiceRecorder]'s config, which stays untouched.
  ///
  ///  - **16 kHz / 24 kbps** — the right sample rate for speech ASR (saarika) and
  ///    ~5× fewer bytes than the 44.1 kHz default; a 45s clip is ~135 KB vs
  ///    ~700 KB, which matters a great deal on 2G.
  ///  - **noiseSuppress + echoCancel** — the mic stays warm across the whole
  ///    session while TTS plays the next question; AEC keeps that prompt out of
  ///    the answer, NS cleans factory-floor hum.
  ///  - **autoGain: false — load-bearing.** AGC compresses exactly the dynamic
  ///    range the silence endpointer (#626) thresholds on; with it on, the
  ///    pre-flight noise floor is no longer comparable to in-answer amplitudes
  ///    and auto-advance breaks quietly. Leave it OFF.
  ///  - **pauseResume** — auto-pause/resume around phone-call interruptions so a
  ///    mid-answer call doesn't strand the recorder stopped.
  ///  - **voiceRecognition** source — Android's speech-tuned capture path.
  static const RecordConfig sessionConfig = RecordConfig(
    encoder: AudioEncoder.aacLc,
    numChannels: 1,
    sampleRate: 16000,
    bitRate: 24000,
    noiseSuppress: true,
    echoCancel: true,
    autoGain: false,
    audioInterruption: AudioInterruptionMode.pauseResume,
    androidConfig: AndroidRecordConfig(
      audioSource: AndroidAudioSource.voiceRecognition,
    ),
  );

  static final RegExp _clipFileName = RegExp(r'^bb-voice-(\d+)\.m4a$');

  /// Only clips whose timestamp predates this instance are stale (a previous,
  /// crashed run). This session's clips are never swept.
  final int _sweepBeforeMs = DateTime.now().millisecondsSinceEpoch;

  /// Paths the caller has explicitly RETAINED because their upload is in flight.
  /// The sweep never deletes these, regardless of age — [release] once the
  /// upload has resolved. This is the load-bearing guard for a slow 2G upload.
  final Set<String> _retained = <String>{};

  String? _activePath;
  DateTime? _startedAt;
  Timer? _autoStopTimer;
  Future<RecordedClip?>? _autoStopped;

  /// Protect [path] from the stale-clip sweep while its upload is in flight.
  void retain(String path) => _retained.add(path);

  /// Drop [path]'s protection — call once its upload has resolved (success OR a
  /// terminal failure) so hygiene can reclaim it on a later sweep.
  void release(String path) => _retained.remove(path);

  /// Amplitude readings for the endpointer. A SINGLE subscription taken once per
  /// session survives every stop/start — the plugin's amplitude stream is not
  /// torn down between clips, so the endpointer keeps its calibration.
  Stream<MicLevel> levels(Duration interval) => _rec
      .onAmplitudeChanged(interval)
      .map((Amplitude a) => MicLevel(dbfs: a.current, peakDbfs: a.max));

  /// The plugin's record-state stream, errors preserved. A Bluetooth SCO drop
  /// arrives here as a stream error (not a silent stop), so the cubit can pause
  /// and recover rather than record silence.
  Stream<RecordState> states() => _rec.onStateChanged();

  @override
  Future<bool> ensurePermission() => _rec.hasPermission();

  @override
  Future<void> start() async {
    // A cap-finalised clip nobody collected would be orphaned by the reset
    // below — delete its file first (best-effort).
    final Future<RecordedClip?>? pending = _autoStopped;
    _autoStopped = null;
    if (pending != null) {
      await _deleteClipFileOf(pending);
    }
    await _sweepStaleClips();

    final String path =
        '${Directory.systemTemp.path}${Platform.pathSeparator}'
        'bb-voice-${DateTime.now().millisecondsSinceEpoch}.m4a';
    await _rec.start(sessionConfig, path: path);
    _activePath = path;
    _startedAt = _clock();
    _autoStopTimer = Timer(_maxDuration, () {
      _autoStopped = _finishStop(cappedAtMax: true);
    });
  }

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

  /// Best-effort sweep of stale `bb-voice-*.m4a` clips. Skips the live take, any
  /// [retain]ed (in-flight) clip, and every clip this session produced (a newer
  /// timestamp than [_sweepBeforeMs]).
  Future<void> _sweepStaleClips() async {
    try {
      await for (final FileSystemEntity entry
          in Directory.systemTemp.list(followLinks: false)) {
        if (entry is! File) continue;
        final String name = entry.uri.pathSegments.last;
        final Match? match = _clipFileName.firstMatch(name);
        if (match == null) continue;
        if (entry.path == _activePath) continue; // never the live take
        if (_retained.contains(entry.path)) continue; // in-flight upload
        final int? clipMs = int.tryParse(match.group(1) ?? '');
        if (clipMs == null || clipMs >= _sweepBeforeMs) continue;
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
    _activePath = null; // the take is finished — never protect it as "live"
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
        : _clock().difference(startedAt).inSeconds;
    if (seconds < 1) seconds = 1;
    if (seconds > maxSeconds && maxSeconds >= 1) seconds = maxSeconds;
    return RecordedClip(path: path, durationSeconds: seconds);
  }

  @override
  Future<void> cancel() async {
    _autoStopTimer?.cancel();
    _autoStopTimer = null;
    _activePath = null;
    _startedAt = null;
    final Future<RecordedClip?>? pending = _autoStopped;
    _autoStopped = null;
    if (pending != null) {
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
    await _rec.cancel();
  }

  @override
  Future<void> dispose() async {
    _autoStopTimer?.cancel();
    _autoStopTimer = null;
    _activePath = null;
    _retained.clear();
    await _recorder?.dispose();
    _recorder = null;
  }
}
