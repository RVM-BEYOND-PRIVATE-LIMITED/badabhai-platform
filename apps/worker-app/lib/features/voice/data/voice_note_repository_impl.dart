import 'dart:io';

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
/// The record→`storage_path` leg is delegated to [VoiceStorageUploader] (REAL:
/// signed-url mint + PUT; MOCK: canned path) and the transcript text to
/// [VoiceTranscriptResolver] (REAL: GET /voice/:id; MOCK: canned). When voice
/// uploads are not enabled server-side (503), the uploader throws
/// [VoiceUnavailableFailure] BEFORE any audio leaves the device, so the honest
/// "not available yet" surfaces without a dead-end.
///
/// PII: the on-device clip path is never sent or logged; only the clip bytes
/// (to the signed url) and the server-side `storage_path` + opaque ids cross
/// the wire. The transcript is merged into chat exactly like a typed message
/// (via [ChatRepository.sendMessage]) and returned for display — never logged.
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
  Future<bool> ensureMicPermission() async {
    try {
      return await _recorder.ensurePermission();
    } catch (error) {
      throw mapError(error);
    }
  }

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
  Future<VoiceNoteOutcome> stopRecordingAndTranscribe() async {
    RecordedClip? clip;
    bool uploadStarted = false;
    try {
      // ALWAYS release the mic FIRST. If the session/auth legs below threw
      // while the plugin was still capturing, the error screen would sit over
      // a LIVE mic the cubit can no longer cancel (its state is Error, not
      // Recording), and a retry would call start() on an active plugin.
      clip = await _recorder.stop();

      // A chat session must exist to both register the clip and merge the
      // transcript back in.
      await _chat.ensureSession();
      final String? token = _session.sessionToken;
      final String? sessionId = _session.sessionId;
      if (token == null || sessionId == null) {
        throw const UnauthorizedFailure();
      }

      if (clip == null) {
        throw const VoiceUnavailableFailure(
          'Recording save nahi hui. Dobara try karein.',
        );
      }

      // record → storage_path: mint the signed slot + PUT the bytes (REAL) or
      // a canned path (MOCK). Registers EXACTLY the minted path below. From
      // here the UPLOADER owns the temp file — it deletes it in a `finally`
      // (success OR failure), so raw audio never outlives the attempt.
      uploadStarted = true;
      final String storagePath = await _uploader.upload(clip, authToken: token);

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

      // Transcript text: GET /voice/:id (REAL) / canned (MOCK).
      final String transcript = await _resolver.resolve(job, authToken: token);

      // Merge the transcript into the profiling chat like a typed message.
      final String reply = await _chat.sendMessage(transcript);
      return VoiceNoteOutcome(transcript: transcript, reply: reply);
    } catch (error) {
      // A clip that never reached the uploader is raw audio on disk with no
      // owner (the uploader's own `finally` only covers its leg) — delete it,
      // best-effort. A retry re-records.
      if (clip != null && !uploadStarted) {
        try {
          await File(clip.path).delete();
        } catch (_) {
          // Cleanup only — the cache dir is app-private and OS-evictable.
        }
      }
      throw mapError(error);
    }
  }
}
