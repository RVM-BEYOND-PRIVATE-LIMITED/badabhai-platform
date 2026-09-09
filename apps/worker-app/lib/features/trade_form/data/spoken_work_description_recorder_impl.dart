import 'dart:io';

import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../../voice/domain/voice_models.dart';
import '../../voice/domain/voice_pipeline.dart';
import '../../voice/domain/voice_recorder.dart';
import '../domain/spoken_work_description.dart';

/// The real mic behind the work-history description (#1472).
///
/// Composes the pieces that already exist rather than adding a second
/// pipeline: the same [VoiceRecorder], the same [VoiceNoteRegistrar]
/// (upload-url → PUT → `POST /voice/upload`), the same transcribe-then-poll,
/// and the same [VoiceTranscriptResolver]. The ONE thing it does differently is
/// keep the `voice_note_id` instead of discarding it, because the employment
/// wire wants it beside the text.
class SpokenWorkDescriptionRecorderImpl
    implements SpokenWorkDescriptionRecorder {
  SpokenWorkDescriptionRecorderImpl({
    required VoiceRecorder recorder,
    required VoiceNoteRegistrar registrar,
    required VoiceTranscriptResolver resolver,
    required ApiClient api,
    required SessionRepository session,
  })  : _recorder = recorder,
        _registrar = registrar,
        _resolver = resolver,
        _api = api,
        _session = session;

  final VoiceRecorder _recorder;
  final VoiceNoteRegistrar _registrar;
  final VoiceTranscriptResolver _resolver;
  final ApiClient _api;
  final SessionRepository _session;

  @override
  Future<bool> ensurePermission() => _recorder.ensurePermission();

  @override
  Future<void> start() => _recorder.start();

  @override
  Future<void> cancel() => _recorder.cancel();

  @override
  Future<SpokenWorkDescription> stopAndTranscribe({
    required String sessionId,
  }) async {
    RecordedClip? clip;
    bool uploadStarted = false;
    try {
      // Release the mic FIRST, always. If a leg below threw while the plugin
      // was still capturing, the failure would sit over a LIVE mic that the
      // caller can no longer stop, and a retry would start an active plugin.
      clip = await _recorder.stop();

      final String? token = _session.sessionToken;
      if (token == null) throw const UnauthorizedFailure();
      if (clip == null) {
        throw const VoiceUnavailableFailure(
          'Recording save nahi hui. Dobara try karein.',
        );
      }

      // From here the UPLOADER owns the temp file — it deletes it in a
      // `finally`, success or failure, so raw audio never outlives the attempt.
      uploadStarted = true;
      final String voiceNoteId = await _registrar.register(
        clip,
        authToken: token,
        // The TRADE FORM's session, handed down from the schema response.
        // Never the chat session: that one is memory-only and empty after a
        // cold start, which would file the clip under nothing.
        sessionId: sessionId,
      );

      final TranscribeResult enqueued = await _api.transcribeVoiceNote(
        authToken: token,
        voiceNoteId: voiceNoteId,
      );
      // The same budget the chat path uses — transcription needs to outlast the
      // server's structural ceiling, not the short extraction default, or the
      // client gives up while the server finishes, bills and stores the work.
      final AiJob job = await _api.awaitAiJob(
        enqueued.aiJobId,
        authToken: token,
        maxAttempts: kVoiceTranscriptPollMaxAttempts,
      );
      if (job.isFailed) {
        // The server withholds the raw reason (it can carry infra detail).
        throw ApiException(502, 'transcription failed');
      }

      return SpokenWorkDescription(
        transcript: await _resolver.resolve(job, authToken: token),
        voiceNoteId: voiceNoteId,
      );
    } catch (error) {
      // A clip that never reached the uploader is raw audio on disk with no
      // owner — the uploader's own `finally` only covers its own leg.
      if (clip != null && !uploadStarted) {
        try {
          await File(clip.path).delete();
        } catch (_) {
          // Cleanup only; the cache dir is app-private and OS-evictable.
        }
      }
      throw mapError(error);
    }
  }
}
