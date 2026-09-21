import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../api/api_client.dart';

/// THE signed-slot byte PUT. One implementation, four callers.
///
/// Every upload this app performs is the same two-step dance: ask the API to
/// mint a slot (`{storage_path, upload_url, expires_in}`), then PUT the bytes
/// straight to `upload_url`. The MINT differs per feature — different route,
/// different guards, a different thing registered afterwards — but the PUT does
/// not: same method, same single header, same bounded timeout, same
/// deliberately-generic failure text.
///
/// It lived inline in `RealVoiceStorageUploader`, `RealPhotoUploader` and
/// `RealFeedbackAttachmentUploader` as three byte-for-byte copies before #1499
/// asked for a fourth. This is that fourth copy not being written.
///
/// ── PRIVACY, AND WHY THE MESSAGES ARE VAGUE ──────────────────────────────────
///
/// [uploadUrl] IS A BEARER CREDENTIAL — it embeds a signing token. It is never
/// logged, never persisted, never put on an event, and no thrown message from
/// here carries it. The storage service's own error body can echo the url, so
/// that is not surfaced either: a caller gets a status code and a fixed string
/// naming only WHAT was being uploaded, which is enough to act on and carries
/// nothing worth leaking.
class SignedObjectPut {
  /// [client] and [timeout] are test seams; production takes the defaults.
  SignedObjectPut({http.Client? client, Duration timeout = defaultTimeout})
      : _client = client ?? http.Client(),
        _timeout = timeout;

  /// 30s, not the app's usual ~8s. A full 120s voice clip, a 1024px JPEG or a
  /// photographed résumé is hundreds of KB to a couple of MB, and our workers
  /// are often on 2G/EDGE uplinks — but a STALLED socket must not park them on
  /// a spinner forever.
  static const Duration defaultTimeout = Duration(seconds: 30);

  final http.Client _client;
  final Duration _timeout;

  /// PUTs [bytes] to [uploadUrl] with exactly [contentType].
  ///
  /// [what] names the thing being uploaded ('voice clip', 'photo', 'résumé') and
  /// appears in the thrown message. Keep it a STATIC, PII-free noun — it reaches
  /// logs and crash reports; a filename never may.
  ///
  /// Throws [ApiException] 408 on timeout and the storage status on any non-2xx.
  Future<void> send({
    required String uploadUrl,
    required Uint8List bytes,
    required String contentType,
    required String what,
  }) async {
    final http.Response res = await _client
        .put(
          Uri.parse(uploadUrl),
          headers: <String, String>{'content-type': contentType},
          body: bytes,
        )
        .timeout(
          _timeout,
          // mapError turns a 408 into an honest, retryable ServerFailure.
          onTimeout: () => throw ApiException(408, '$what upload timed out'),
        );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ApiException(res.statusCode, '$what upload failed');
    }
  }
}
