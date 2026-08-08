import '../../../core/api/api_models.dart';
import 'voice_models.dart';

/// Uploads a recorded clip to server-side storage and returns its `storage_path`
/// (the value `POST /voice/upload` expects).
///
/// REAL: mints a signed slot via `POST /voice/upload-url`, PUTs the clip bytes
/// to the signed url, deletes the on-device temp file, and returns the minted
/// `storage_path`. A 503 from upload-url (voice not enabled server-side)
/// surfaces as [VoiceUnavailableFailure]. MOCK: returns a canned path so the
/// pipeline is walkable offline — no audio ever leaves the device.
abstract interface class VoiceStorageUploader {
  Future<String> upload(RecordedClip clip, {required String authToken});
}

/// A recorded clip → a REGISTERED `voice_note_id` — upload-url → PUT → register,
/// as one step (#717).
///
/// ONE COMPOSITION, TWO CALLERS. The chat voice-note flow and the voice form both need
/// exactly this, and the second must not be a second implementation of it: everything that
/// makes the upload leg safe — the signed-url mint, the 503 → [VoiceUnavailableFailure]
/// before any audio leaves the device, the on-device temp file deleted in a `finally`
/// whether the attempt succeeded or not — lives in [VoiceStorageUploader] and is reused
/// rather than re-written. This adds only the registration call that turns the minted
/// `storage_path` into the id the engine answers at.
///
/// `sessionId` is the CHAT session the note is attached to. A profiling session IS a
/// `chat_sessions` row (there is no second session table), so the voice form passes the id
/// the engine handed it at `POST /profiling/session` and `voice.service.ts` resolves it
/// against the same table the chat flow uses.
abstract interface class VoiceNoteRegistrar {
  Future<String> register(
    RecordedClip clip, {
    required String authToken,
    required String sessionId,
  });
}

/// Resolves the transcript TEXT for a completed transcription [AiJob].
///
/// The `GET /workers/me/ai-jobs/:id` response for a transcription carries only
/// `{voice_note_id}` — the text comes from `GET /voice/:voiceNoteId`
/// (`transcript_text` preferred, `transcript_english` fallback). REAL fails
/// closed with [VoiceUnavailableFailure] when neither is ready; MOCK returns
/// canned text so the merge-into-chat step is walkable offline.
abstract interface class VoiceTranscriptResolver {
  Future<String> resolve(AiJob job, {required String authToken});
}
