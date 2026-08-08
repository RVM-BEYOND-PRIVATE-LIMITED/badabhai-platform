import 'voice_form_models.dart';

/// The seam between the [VoiceFormCubit] and the backend voice-form route.
///
/// The cubit orchestrates the mic, the endpointer and the UI; it must NOT know
/// the HTTP shape of the engine's next-question route. That shape is still being
/// frozen (backend B6), so the real implementation lands as a follow-up — but
/// the INTERACTION is already fixed by the epic and is all the cubit needs:
///
///  - [start] opens the session and returns the first step.
///  - [submit] sends ONE answer and BLOCKS until the engine has chosen the next
///    step. Blocking is deliberate: the engine needs answer n's text to pick
///    question n+1, so v1 never advances optimistically.
///
/// Implementations map transport errors to `Failure` (fail-closed). PRIVACY: an
/// answer clip crosses only as a signed-upload reference the impl mints — never
/// raw audio bytes through this interface, never a path in a log.
abstract interface class VoiceFormGateway {
  /// Open the session; returns the first [NextQuestion] (or [VoiceFormDone] for
  /// an empty pack). Requests worker auth internally.
  Future<VoiceFormStep> start();

  /// Submit one [answer] and block until the engine serves the next step.
  Future<VoiceFormStep> submit(VoiceAnswer answer);

  /// Commit the reviewed session — the ONLY finalize path (#632), reached from
  /// the review screen after the engine has served [VoiceFormDone]. Idempotent:
  /// a retried finalize must not double-commit the profile.
  Future<void> finalize();
}
