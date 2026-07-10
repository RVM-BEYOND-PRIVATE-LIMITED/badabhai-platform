/// The voice-note profiling boundary (A2).
///
/// One method drives the full post-capture pipeline so the presentation layer
/// stays thin. Implementations read the session token / session id from the
/// session (never a widget) and throw a [Failure] (mapped via failure_mapper) on
/// error. In REAL mode the record→`storage_path` leg is not available and throws
/// [VoiceUnavailableFailure] — an honest stop, never a crash.
abstract interface class VoiceNoteRepository {
  /// Whether the mic permission is granted / grantable.
  Future<bool> ensureMicPermission();

  /// Starts recording (≤120s). Throws a [Failure] on a recorder error.
  Future<void> startRecording();

  /// Stops recording, then runs: record→`storage_path` (BLOCKED in REAL) →
  /// POST /voice/upload → POST /voice/transcribe → poll GET /ai-jobs/:id until
  /// terminal → resolve transcript → merge into chat (ChatRepository.sendMessage).
  /// Returns bada bhai's reply text. Throws a [Failure].
  Future<String> stopRecordingAndTranscribe();

  /// Discards an in-progress recording.
  Future<void> cancelRecording();
}
