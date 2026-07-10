import 'voice_models.dart';

/// Mic-capture seam for the voice-note pipeline. Abstracted so the orchestration
/// (VoiceNoteRepository) is unit-testable without the platform recorder plugin
/// (which throws under `flutter test`). Voice capture is backend-blocked today,
/// so the wired impl is [UnavailableVoiceRecorder] (fail-closed); tests inject a
/// fake. Swap in a real recorder once the storage-upload route lands.
abstract interface class VoiceRecorder {
  /// Requests / checks the microphone permission. Returns true when recording is
  /// allowed. The caller shows an honest "mic permission chahiye" note on false.
  Future<bool> ensurePermission();

  /// Starts recording (bounded to ≤120s by the caller / platform).
  Future<void> start();

  /// Stops recording and returns the captured clip, or null if nothing was
  /// recorded (e.g. permission was revoked mid-way).
  Future<RecordedClip?> stop();

  /// Discards an in-progress recording without producing a clip.
  Future<void> cancel();

  /// Releases native recorder resources.
  Future<void> dispose();
}
