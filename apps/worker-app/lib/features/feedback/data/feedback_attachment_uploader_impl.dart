import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/session/session_repository.dart';
import '../domain/feedback_attachment_uploader.dart';

/// REAL feedback-image upload: mint a signed slot on the API, then PUT the
/// resized JPEG directly to it. Mirrors RealPhotoUploader's discipline — the
/// signed url is never logged and no thrown message carries the url/token/body.
///
/// Fail-CLOSED on a missing session (no anonymous upload). Every failure is
/// thrown to the caller, which uploads best-effort and drops the image so the
/// worker's TEXT feedback still sends.
class RealFeedbackAttachmentUploader implements FeedbackAttachmentUploader {
  RealFeedbackAttachmentUploader({
    required ApiClient api,
    required SessionRepository session,
    http.Client? client,
    Duration putTimeout = defaultPutTimeout,
  })  : _api = api,
        _session = session,
        _client = client ?? http.Client(),
        _putTimeout = putTimeout;

  /// A 1600px JPEG at q80 is a few hundred KB; 30s covers a 2G/EDGE uplink
  /// without parking the worker forever (the photo/voice-leg rationale).
  static const Duration defaultPutTimeout = Duration(seconds: 30);

  final ApiClient _api;
  final SessionRepository _session;
  final http.Client _client;
  final Duration _putTimeout;

  @override
  Future<String> upload(Uint8List bytes) async {
    final String? token = _session.sessionToken;
    if (token == null) throw const UnauthorizedFailure();
    final PhotoUploadTicket ticket =
        await _api.mintFeedbackAttachmentUploadUrl(authToken: token);
    await _put(uploadUrl: ticket.uploadUrl, bytes: bytes);
    return ticket.storagePath;
  }

  Future<void> _put({
    required String uploadUrl,
    required Uint8List bytes,
  }) async {
    final http.Response res = await _client
        .put(
          Uri.parse(uploadUrl),
          headers: const <String, String>{'content-type': 'image/jpeg'},
          body: bytes,
        )
        .timeout(
          _putTimeout,
          onTimeout: () =>
              throw ApiException(408, 'feedback image upload timed out'),
        );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      // Generic on purpose: the signed url embeds a token and the storage body
      // could echo it — neither may reach a log or the UI.
      throw ApiException(res.statusCode, 'feedback image upload failed');
    }
  }
}

/// MOCK feedback-image upload: no network, no bytes stored — mock mode's
/// guarantee. Returns a canned path so the attach-then-submit flow is walkable.
class MockFeedbackAttachmentUploader implements FeedbackAttachmentUploader {
  const MockFeedbackAttachmentUploader();

  @override
  Future<String> upload(Uint8List bytes) async {
    await Future<void>.delayed(const Duration(milliseconds: 150));
    return 'feedback-attachments/mock-worker/mock-feedback-0001.jpg';
  }
}
