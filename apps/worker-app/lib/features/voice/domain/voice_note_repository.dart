import 'voice_models.dart';

/// The voice-note profiling boundary (A2).
///
/// One method drives the full post-capture pipeline so the presentation layer
/// stays thin. Implementations read the session token / session id from the
/// session (never a widget) and throw a [Failure] (mapped via failure_mapper) on
/// error. When voice uploads are not enabled server-side (503 on upload-url),
/// the pipeline throws [VoiceUnavailableFailure] — an honest stop, never a crash.
abstract interface class VoiceNoteRepository {
  /// Whether the mic permission is granted / grantable.
  Future<bool> ensureMicPermission();

  /// Starts recording (hard 120s cap). Throws a [Failure] on a recorder error.
  Future<void> startRecording();

  /// Stops recording, then runs: mint signed slot (POST /voice/upload-url) →
  /// PUT clip bytes → POST /voice/upload → POST /voice/transcribe → poll
  /// GET /ai-jobs/:id until terminal → resolve transcript (GET /voice/:id) →
  /// merge into chat (ChatRepository.sendMessage). Returns the transcript +
  /// bada bhai's reply. Throws a [Failure].
  Future<VoiceNoteOutcome> stopRecordingAndTranscribe();

  /// Discards an in-progress recording.
  Future<void> cancelRecording();
}
