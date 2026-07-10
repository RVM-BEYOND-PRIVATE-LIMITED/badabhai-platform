import '../../../core/api/api_models.dart';
import '../../../core/error/failure.dart';
import '../domain/voice_models.dart';
import '../domain/voice_pipeline.dart';

/// REAL storage uploader — fails closed. There is NO backend route that turns a
/// recorded audio file into a `storage_path` (A2-storage MISSING), so uploading
/// cannot complete. Throwing here keeps raw audio ON the device and surfaces the
/// honest [VoiceUnavailableFailure] instead of fabricating a path the API rejects.
class RealVoiceStorageUploader implements VoiceStorageUploader {
  const RealVoiceStorageUploader();

  @override
  Future<String> upload(RecordedClip clip) async {
    // TODO(storage): no backend upload route yet — see A2-storage MISSING.
    throw const VoiceUnavailableFailure();
  }
}

/// REAL transcript resolver — fails closed. `GET /ai-jobs/:id` returns only the
/// `voice_note_id` for a completed transcription (no transcript body, no route to
/// fetch it), so the text cannot be resolved. Unreachable in practice because the
/// uploader above throws first; kept honest for when the storage route lands.
class RealVoiceTranscriptResolver implements VoiceTranscriptResolver {
  const RealVoiceTranscriptResolver();

  @override
  Future<String> resolve(AiJob job) async {
    // TODO(storage): no route returns transcript text yet — see A2-storage MISSING.
    throw const VoiceUnavailableFailure();
  }
}

/// MOCK storage uploader — returns a canned, obviously-fake `storage_path` so the
/// pipeline is walkable offline. No real audio is ever uploaded.
class MockVoiceStorageUploader implements VoiceStorageUploader {
  const MockVoiceStorageUploader();

  @override
  Future<String> upload(RecordedClip clip) async =>
      'mock/voice-notes/mock-clip-0001.m4a';
}

/// MOCK transcript resolver — returns a generic, PII-FREE canned transcript so
/// the merge-into-chat step completes in mock mode.
class MockVoiceTranscriptResolver implements VoiceTranscriptResolver {
  const MockVoiceTranscriptResolver();

  @override
  Future<String> resolve(AiJob job) async =>
      'Main CNC machine par 4 saal se kaam kar raha hoon, Fanuc control aata hai.';
}
