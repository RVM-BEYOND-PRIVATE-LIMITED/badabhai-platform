import 'voice_models.dart';

/// The voice-note profiling boundary (A2).
///
/// SPLIT IN TWO ON PURPOSE (Persona sheet, worked conversation #05). The
/// transcript must be SHOWN AND CONFIRMED before it becomes the worker's answer
/// of record — "the transcript is shown for confirmation, never guessed at".
/// A single method that transcribed AND sent could not offer that turn: by the
/// time the screen had any text to show, the server had already parsed it.
///
/// So the pipeline stops at the transcript ([stopAndTranscribe], which sends
/// NOTHING) and the worker's explicit confirmation drives the second leg
/// ([sendConfirmedTranscript], which takes the TEXT — that parameter is what
/// makes the "Sudhaarna hai" edit path possible at all).
///
/// Implementations read the session token / session id from the session (never a
/// widget) and throw a [Failure] (mapped via failure_mapper) on error. When voice
/// uploads are not enabled server-side (503 on upload-url), the pipeline throws
/// [VoiceUnavailableFailure] — an honest stop, never a crash.
abstract interface class VoiceNoteRepository {
  /// Whether the mic permission is granted / grantable.
  Future<bool> ensureMicPermission();

  /// Starts recording (hard 120s cap). Throws a [Failure] on a recorder error.
  Future<void> startRecording();

  /// Stops recording and resolves the TRANSCRIPT — nothing more.
  ///
  /// Runs: release the mic → mint signed slot (POST /voice/upload-url) → PUT clip
  /// bytes → POST /voice/upload → POST /voice/transcribe → poll GET /workers/me/ai-jobs/:id
  /// until terminal → resolve transcript (GET /voice/:id). Returns that text.
  ///
  /// DOES NOT SEND IT TO CHAT. Nothing the worker has not seen may become their
  /// answer — [sendConfirmedTranscript] is the only path to the chat session.
  ///
  /// The mic is released FIRST, so the confirm UI never appears over a live mic.
  /// The on-device temp clip is deleted whether this succeeds or fails.
  ///
  /// Throws a [Failure].
  Future<String> stopAndTranscribe();

  /// Sends a CONFIRMED transcript into the profiling chat, exactly like a typed
  /// message, and returns the transcript + bada bhai's reply.
  ///
  /// [text] is passed in rather than read from a field precisely so the worker
  /// can have EDITED it ("Sudhaarna hai") — what is sent is what they approved,
  /// not what the recogniser guessed.
  ///
  /// Throws a [Failure].
  Future<VoiceNoteOutcome> sendConfirmedTranscript(String text);

  /// Discards an in-progress recording.
  Future<void> cancelRecording();
}
