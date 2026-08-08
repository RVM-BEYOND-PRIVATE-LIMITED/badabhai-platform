/// Plays back the worker's OWN recorded clip on the review screen (#632) — a
/// LOCAL file, never a synthesized read-back, so no worker data ever crosses the
/// TTS boundary.
///
/// Distinct from [QuestionAudioPlayer] (which reads engine PROMPTS aloud): this
/// plays worker AUDIO from disk. The real file-backed player is the same
/// audioplayers integration deferred with #631 (gated on an on-device
/// audio-focus prototype); [SilentClipPlayer] is the ship-now default.
abstract interface class ClipPlayer {
  /// Play the local audio file at [path] to completion (or return immediately
  /// when playback is unavailable). Must not throw for a missing file.
  Future<void> playFile(String path);

  /// Stop any in-flight playback.
  Future<void> stop();
}

/// The ship-now default: plays nothing. Replay is an enhancement on the review
/// screen — the normalized value is always shown as text — never a gate on
/// submitting.
class SilentClipPlayer implements ClipPlayer {
  const SilentClipPlayer();

  @override
  Future<void> playFile(String path) async {}

  @override
  Future<void> stop() async {}
}
