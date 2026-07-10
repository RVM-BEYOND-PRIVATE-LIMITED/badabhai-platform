import '../../../core/api/api_models.dart';
import 'voice_models.dart';

/// Uploads a recorded clip to server-side storage and returns its `storage_path`
/// (the value `POST /voice/upload` expects).
///
/// A2-STORAGE MISSING: there is NO backend route that turns a recorded audio file
/// into a `storage_path` — no signed-upload / presign / multipart. So the REAL
/// implementation fails closed (throws [VoiceUnavailableFailure]); only the MOCK
/// implementation returns a canned path so the pipeline is walkable offline.
abstract interface class VoiceStorageUploader {
  Future<String> upload(RecordedClip clip);
}

/// Resolves the transcript TEXT for a completed transcription [AiJob].
///
/// The `GET /ai-jobs/:id` `output_ref` for a transcription carries only
/// `{voice_note_id}` — NOT the transcript body — and there is no route that
/// returns the text. So the REAL implementation fails closed; only the MOCK
/// implementation returns canned text so the merge-into-chat step is walkable.
abstract interface class VoiceTranscriptResolver {
  Future<String> resolve(AiJob job);
}
