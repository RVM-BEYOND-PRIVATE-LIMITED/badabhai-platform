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

/// Resolves the transcript TEXT for a completed transcription [AiJob].
///
/// The `GET /ai-jobs/:id` `output_ref` for a transcription carries only
/// `{voice_note_id}` — the text comes from `GET /voice/:voiceNoteId`
/// (`transcript_text` preferred, `transcript_english` fallback). REAL fails
/// closed with [VoiceUnavailableFailure] when neither is ready; MOCK returns
/// canned text so the merge-into-chat step is walkable offline.
abstract interface class VoiceTranscriptResolver {
  Future<String> resolve(AiJob job, {required String authToken});
}
