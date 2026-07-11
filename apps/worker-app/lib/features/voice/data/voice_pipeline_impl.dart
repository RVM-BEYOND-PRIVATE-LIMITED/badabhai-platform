import 'dart:io';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../domain/voice_models.dart';
import '../domain/voice_pipeline.dart';

/// Honest copy for a transcript that is not (yet) available. A client-side
/// constant — safe to show; never a server body.
const String _kTranscriptNotReady =
    'Transcript ready nahi hua. Thodi der baad dobara try karein.';

/// REAL storage uploader: mints a signed slot (POST /voice/upload-url), PUTs
/// the clip bytes to the signed url (`Content-Type: audio/mp4`, bounded by
/// [defaultPutTimeout]), deletes the on-device temp file (success OR failure —
/// raw audio never outlives the attempt), and returns the minted
/// `storage_path` — exactly the path POST /voice/upload accepts (the API
/// rejects anything outside `voice-notes/<workerId>/`).
///
/// FAIL-CLOSED: a 503 from upload-url (voice not enabled server-side) surfaces
/// as [VoiceUnavailableFailure] BEFORE any audio leaves the device. PRIVACY:
/// the signed url and the on-device path are never logged; thrown messages
/// carry no url/path/body detail.
class RealVoiceStorageUploader implements VoiceStorageUploader {
  /// [putTimeout] is a test seam; production uses [defaultPutTimeout].
  RealVoiceStorageUploader({
    required ApiClient api,
    http.Client? client,
    Duration putTimeout = defaultPutTimeout,
  })  : _api = api,
        _client = client ?? http.Client(),
        _putTimeout = putTimeout;

  /// Cap on the signed-url PUT. 30s (not the usual ~8s): a full 120s AAC-LC
  /// mono clip is ~1–2MB, and our workers are often on 2G/EDGE uplinks — but a
  /// STALLED socket must not park them on the Processing spinner forever.
  static const Duration defaultPutTimeout = Duration(seconds: 30);

  final ApiClient _api;
  final http.Client _client;
  final Duration _putTimeout;

  @override
  Future<String> upload(RecordedClip clip, {required String authToken}) async {
    try {
      final VoiceUploadTicket ticket;
      try {
        ticket = await _api.requestVoiceUploadUrl(authToken: authToken);
      } on ApiException catch (error) {
        if (error.statusCode == 503) {
          // Voice uploads not enabled server-side — honest "not available yet".
          throw const VoiceUnavailableFailure();
        }
        rethrow;
      }

      final Uint8List bytes = await File(clip.path).readAsBytes();
      final http.Response res = await _client
          .put(
            Uri.parse(ticket.uploadUrl),
            headers: const <String, String>{'content-type': 'audio/mp4'},
            body: bytes,
          )
          // mapError turns the 408 into an honest, retryable ServerFailure —
          // no url/token in the message (the signed url must never leak).
          .timeout(
            _putTimeout,
            onTimeout: () =>
                throw ApiException(408, 'voice clip upload timed out'),
          );
      if (res.statusCode < 200 || res.statusCode >= 300) {
        // Generic message on purpose: the signed url embeds a token and the
        // storage body could echo it — neither may reach a log or the UI.
        throw ApiException(res.statusCode, 'voice clip upload failed');
      }
      return ticket.storagePath;
    } finally {
      // Success OR failure, raw audio never outlives the upload attempt: the
      // on-device temp copy is outside server-side DSAR, so a failed attempt
      // must not leave it behind (a retry re-records). Best-effort — the cache
      // dir is app-private and OS-evictable anyway.
      try {
        await File(clip.path).delete();
      } catch (_) {
        // Cleanup only.
      }
    }
  }
}

/// REAL transcript resolver: reads `voice_note_id` off the completed
/// transcription [AiJob] and fetches GET /voice/:id, preferring
/// `transcript_text` (source language) over `transcript_english`. Fails closed
/// with the honest "transcript ready nahi hua" copy when neither has landed.
class RealVoiceTranscriptResolver implements VoiceTranscriptResolver {
  const RealVoiceTranscriptResolver(this._api);

  final ApiClient _api;

  @override
  Future<String> resolve(AiJob job, {required String authToken}) async {
    final String? voiceNoteId = job.voiceNoteId;
    if (voiceNoteId == null || voiceNoteId.isEmpty) {
      throw const VoiceUnavailableFailure(_kTranscriptNotReady);
    }
    final VoiceNoteDetail note = await _api.fetchVoiceNote(
      authToken: authToken,
      voiceNoteId: voiceNoteId,
    );
    final String text = _firstNonEmpty(note.transcriptText) ??
        _firstNonEmpty(note.transcriptEnglish) ??
        (throw const VoiceUnavailableFailure(_kTranscriptNotReady));
    return text;
  }

  static String? _firstNonEmpty(String? value) {
    final String? trimmed = value?.trim();
    return (trimmed == null || trimmed.isEmpty) ? null : trimmed;
  }
}

/// MOCK storage uploader — returns a canned, obviously-fake `storage_path`
/// (mirroring the real `voice-notes/<workerId>/<uuid>.m4a` shape) so the
/// pipeline is walkable offline. No real audio is ever uploaded.
class MockVoiceStorageUploader implements VoiceStorageUploader {
  const MockVoiceStorageUploader();

  @override
  Future<String> upload(RecordedClip clip, {required String authToken}) async =>
      'voice-notes/mock-worker-0001/mock-clip-0001.m4a';
}

/// MOCK transcript resolver — returns a generic, PII-FREE canned transcript so
/// the merge-into-chat step completes in mock mode. KEEP IN SYNC with
/// MockApiClient.fetchVoiceNote's `transcript_text` (a parity test asserts it).
class MockVoiceTranscriptResolver implements VoiceTranscriptResolver {
  const MockVoiceTranscriptResolver();

  /// The canned transcript — also what MockApiClient.fetchVoiceNote returns.
  static const String cannedTranscript =
      'Main CNC machine par 4 saal se kaam kar raha hoon, Fanuc control aata hai.';

  @override
  Future<String> resolve(AiJob job, {required String authToken}) async =>
      cannedTranscript;
}
