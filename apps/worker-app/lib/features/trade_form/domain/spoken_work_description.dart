import '../../voice/domain/voice_models.dart';

/// What the mic on the work-history "Aap kya kaam karte the?" field produces
/// (#1472): the words, AND the clip they were spoken into.
///
/// BOTH HALVES OR NEITHER. `PUT /workers/me/employment` refuses a
/// `work_done_voice_note_id` that has no `work_done` beside it — and refuses
/// the WHOLE submission, so a half-result would cost the worker their entire
/// work history. No existing seam returned the pair: the chat's
/// `VoiceNoteRepository.stopAndTranscribe()` returns only the transcript and
/// throws the id away, because chat has nothing to file it against.
///
/// PRIVACY: [transcript] is the worker's own words, held only long enough to
/// land in the text box they edit. Never logged, never evented.
class SpokenWorkDescription {
  const SpokenWorkDescription({
    required this.transcript,
    required this.voiceNoteId,
  });

  /// A DRAFT, not the answer. The worker edits it before saving; what they
  /// submit is what prints on the résumé.
  final String transcript;

  /// Provenance for [transcript] — the clip it came out of.
  final String voiceNoteId;
}

/// Records a spoken work description and returns the transcript with the id of
/// the clip it came from.
///
/// Deliberately its own seam rather than a method on the chat repository: this
/// one needs the id (chat discards it), and it files the clip under the TRADE
/// FORM's session, which is not the chat session — a form is resumable across a
/// cold start, so its session id is re-read from every schema response.
abstract interface class SpokenWorkDescriptionRecorder {
  /// True when the OS mic permission is held (prompting for it if needed).
  Future<bool> ensurePermission();

  /// Begin capturing. The recorder enforces its own hard cap.
  Future<void> start();

  /// Stop, upload, transcribe, and resolve the words.
  ///
  /// Throws [VoiceUnavailableFailure] when the voice stack is switched off
  /// server-side (a 503 — today's default), which callers must treat as "no
  /// mic" while leaving the text field completely usable.
  Future<SpokenWorkDescription> stopAndTranscribe({required String sessionId});

  /// Abandon a capture in progress and drop the audio.
  Future<void> cancel();
}

/// The clip a [SpokenWorkDescriptionRecorder] captured, re-exported so callers
/// do not have to reach into the voice feature for one type.
typedef SpokenClip = RecordedClip;
