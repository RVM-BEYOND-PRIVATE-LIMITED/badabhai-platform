import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../../chat/domain/chat_repository.dart';
import '../domain/voice_models.dart';
import '../domain/voice_note_repository.dart';
import '../domain/voice_pipeline.dart';
import '../domain/voice_recorder.dart';

/// Orchestrates the voice-note pipeline over the [ApiClient] + [ChatRepository].
///
/// The record→`storage_path` leg is delegated to [VoiceStorageUploader]; in REAL
/// mode that throws [VoiceUnavailableFailure] (A2-storage MISSING) BEFORE any
/// audio leaves the device, so the honest "not available yet" surfaces without a
/// dead-end. The transcript text (also route-less) comes from
/// [VoiceTranscriptResolver] — canned in MOCK, throws in REAL.
///
/// PII: the on-device clip path is never sent or logged; only the server-side
/// `storage_path` + opaque ids cross the wire. The transcript is merged into chat
/// exactly like a typed message (via [ChatRepository.sendMessage]).
class VoiceNoteRepositoryImpl implements VoiceNoteRepository {
  VoiceNoteRepositoryImpl({
    required VoiceRecorder recorder,
    required VoiceStorageUploader uploader,
    required VoiceTranscriptResolver resolver,
    required ApiClient api,
    required ChatRepository chat,
    required SessionRepository session,
  })  : _recorder = recorder,
        _uploader = uploader,
        _resolver = resolver,
        _api = api,
        _chat = chat,
        _session = session;

  final VoiceRecorder _recorder;
  final VoiceStorageUploader _uploader;
  final VoiceTranscriptResolver _resolver;
  final ApiClient _api;
  final ChatRepository _chat;
  final SessionRepository _session;

  @override
  Future<bool> ensureMicPermission() => _recorder.ensurePermission();

  @override
  Future<void> startRecording() async {
    try {
      await _recorder.start();
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<void> cancelRecording() async {
    try {
      await _recorder.cancel();
    } catch (_) {
      // Cancelling is best-effort — never surface an error for a discard.
    }
  }

  @override
  Future<String> stopRecordingAndTranscribe() async {
    try {
      // A chat session must exist to both register the clip and merge the
      // transcript back in.
      await _chat.ensureSession();
      final String? token = _session.sessionToken;
      final String? sessionId = _session.sessionId;
      if (token == null || sessionId == null) {
        throw const UnauthorizedFailure();
      }

      final RecordedClip? clip = await _recorder.stop();
      if (clip == null) {
        throw const VoiceUnavailableFailure(
          'Recording save nahi hui. Dobara try karein.',
        );
      }

      // record → storage_path. BLOCKED in REAL (throws VoiceUnavailableFailure).
      // TODO(storage): no backend upload route yet — see A2-storage MISSING.
      final String storagePath = await _uploader.upload(clip);

      final VoiceUploadResult uploaded = await _api.uploadVoiceNote(
        authToken: token,
        sessionId: sessionId,
        storagePath: storagePath,
        durationSeconds: clip.durationSeconds,
      );

      final TranscribeResult enqueued = await _api.transcribeVoiceNote(
        authToken: token,
        voiceNoteId: uploaded.voiceNoteId,
      );

      final AiJob job = await _api.awaitAiJob(enqueued.aiJobId);
      if (job.isFailed) {
        throw ApiException(502, job.errorMessage ?? 'transcription failed');
      }

      // No route returns transcript text; resolver is canned (MOCK) / throws (REAL).
      final String transcript = await _resolver.resolve(job);

      // Merge the transcript into the profiling chat like a typed message.
      return await _chat.sendMessage(transcript);
    } catch (error) {
      throw mapError(error);
    }
  }
}
