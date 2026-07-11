import 'voice_models.dart';

/// Mic-capture seam for the voice-note pipeline. Abstracted so the orchestration
/// (VoiceNoteRepository) is unit-testable without the platform recorder plugin
/// (which throws under `flutter test`). The wired impl is
/// [RecordPackageVoiceRecorder] (the `record` package, temp .m4a AAC-LC, hard
/// 120s cap); tests inject a fake.
abstract interface class VoiceRecorder {
  /// Requests / checks the microphone permission. Returns true when recording is
  /// allowed. The caller shows an honest "mic permission chahiye" note on false.
  Future<bool> ensurePermission();

  /// Starts recording (hard-capped at 120s — the impl auto-stops at the cap).
  Future<void> start();

  /// Stops recording and returns the captured clip, or null if nothing was
  /// recorded (e.g. permission was revoked mid-way).
  Future<RecordedClip?> stop();

  /// Discards an in-progress recording without producing a clip.
  Future<void> cancel();

  /// Releases native recorder resources.
  Future<void> dispose();
}
