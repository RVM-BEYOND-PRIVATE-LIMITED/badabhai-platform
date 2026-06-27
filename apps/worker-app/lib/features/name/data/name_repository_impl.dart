import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../domain/name_repository.dart';

/// Real name-capture repository (follows the auth/chat/resume real-repo pattern:
/// ctor takes the [ApiClient] + [SessionRepository], NOT a hardcoded mock).
///
/// Reads the worker's bearer token off the session and submits the name to the
/// API, which encrypts it at rest. The plaintext name passes through here once
/// and is never retained, logged, or placed in app state.
class NameRepositoryImpl implements NameRepository {
  NameRepositoryImpl(this._api, this._session);

  final ApiClient _api;
  final SessionRepository _session;

  @override
  Future<void> submitName(String fullName) async {
    final String? token = _session.sessionToken;
    if (token == null) {
      throw const UnauthorizedFailure();
    }
    try {
      await _api.updateName(fullName: fullName, authToken: token);
    } catch (error) {
      throw mapError(error);
    }
  }
}
