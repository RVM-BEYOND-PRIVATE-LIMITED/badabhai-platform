import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../domain/profile_repository.dart';

class ProfileRepositoryImpl implements ProfileRepository {
  ProfileRepositoryImpl(this._api, this._session);

  final ApiClient _api;
  final SessionRepository _session;

  @override
  Future<String> extractProfile() async {
    final String? token = _session.sessionToken;
    if (token == null) throw const UnauthorizedFailure();
    try {
      // ApiClient.extractProfile enqueues the job and polls until it yields a
      // profile id (or throws ProfileExtractionTimeout / ApiException).
      final String profileId = await _api.extractProfile(
        authToken: token,
        sessionId: _session.sessionId,
      );
      _session.setProfile(profileId);
      return profileId;
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<void> confirmProfile() async {
    final String? token = _session.sessionToken;
    final String? profileId = _session.profileId;
    if (token == null || profileId == null) throw const UnauthorizedFailure();
    try {
      await _api.confirmProfile(authToken: token, profileId: profileId);
    } catch (error) {
      throw mapError(error);
    }
  }
}
