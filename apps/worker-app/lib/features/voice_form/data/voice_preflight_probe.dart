import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';

/// Pre-flight probe of the voice-upload bucket (#627). Mints a signed slot via
/// `POST /voice/upload-url` purely to learn whether uploads are LIVE right now —
/// far better to abort on the pre-flight screen than to lose nine spoken answers
/// to a dormant bucket nine questions in.
///
/// The minted ticket is discarded; the real session mints its own per-answer
/// slots. PRIVACY: the returned url is SIGNED — never logged here or anywhere.
class VoicePreflightProbe {
  VoicePreflightProbe(this._api, this._session);

  final ApiClient _api;
  final SessionRepository _session;

  /// Resolves if uploads are live; otherwise throws a [Failure] the cubit can
  /// render directly:
  ///  - [VoiceUnavailableFailure] on 503 (bucket dormant — the honest abort),
  ///  - [UnauthorizedFailure] when there is no session token,
  ///  - a mapped transport [Failure] on any other error.
  Future<void> probe() async {
    final String? token = _session.sessionToken;
    if (token == null) throw const UnauthorizedFailure();
    try {
      await _api.requestVoiceUploadUrl(authToken: token);
    } on ApiException catch (error) {
      if (error.statusCode == 503) throw const VoiceUnavailableFailure();
      throw mapError(error);
    }
  }
}
