import 'voice_correction_outcome.dart';
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
  /// The engine's session id, learned on [start] and null before it. Null after a [start]
  /// that failed.
  ///
  /// EXPOSED, NOT USED INTERNALLY (#717). The cubit registers a spoken answer's clip against
  /// this session before submitting the id — a profiling session IS a `chat_sessions` row,
  /// so it is exactly what `POST /voice/upload` wants. A getter rather than an upload method
  /// here is the point of the ruling: this interface stays one HTTP call per method, and the
  /// upload seam lives where the clip does.
  String? get sessionId;

  /// Open the session; returns the first [NextQuestion] (or [VoiceFormDone] for
  /// an empty pack). Requests worker auth internally.
  Future<VoiceFormStep> start();

  /// Submit one [answer] and block until the engine serves the next step.
  ///
  /// [questionKey] is the stale-answer guard — the key of the question the worker is
  /// ANSWERING, null on the disambiguation turn (which belongs to no pack). It is a
  /// parameter rather than state the implementation keeps, because only the caller knows
  /// what is on screen: an implementation that inferred it from the last step it parsed
  /// would desync the moment the caller discarded a step, and the server's guard is a plain
  /// equality test that would then PASS against the wrong question.
  Future<VoiceFormStep> submit(VoiceAnswer answer, {required String? questionKey});

  /// Commit the reviewed session — the ONLY finalize path (#632), reached from
  /// the review screen after the engine has served [VoiceFormDone]. Idempotent:
  /// a retried finalize must not double-commit the profile.
  Future<void> finalize();

  /// Correct ONE already-settled answer from the review screen's ⟲ (#700).
  ///
  /// [questionKey] is the settled question being re-answered — non-null (unlike
  /// [submit], which allows null on the disambiguation turn: that turn belongs
  /// to no pack, so there is nothing to correct). [answer] is the same
  /// four-member union [submit] takes; a spoken correction carries a REGISTERED
  /// `voice_note_id`, uploaded by the caller exactly like a first answer.
  ///
  /// Returns the engine's redrawn row + whether a built profile is now stale.
  /// Fail-closed: a 409 (the question is still on screen, not settled), a 422
  /// (the words parsed to no value) or the correction cap surface as `Failure`.
  Future<VoiceCorrectionOutcome> correct(
    VoiceAnswer answer, {
    required String questionKey,
  });
}
